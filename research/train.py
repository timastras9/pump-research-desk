#!/usr/bin/env python3
"""Training run v1 (Astra design, approved 2026-09-26). BUY model + SELL models, all PyTorch, all scored by the single
accounting engine with 2 s delayed fills and costs.

Chronological blocks by launch time, purged so no training episode's 12-minute window overlaps the next block:
  train 55% · calibration 10% (sigmoid calibration of BUY probabilities) · validation 15% (thresholds, margins, seller
  choice) · test 20% (scored once, then stress-tested at 3-5 s latency and 1.5x costs).

BUY:  logistic (baseline), gradient-boosted trees (challenger), small MLP. Calibrated; threshold chosen on validation by
      total net P&L with the SELL policy fixed, subject to a minimum coverage.
SELL: supervised stopping model (imitation of the approved target exits, winners AND losers) and conservative offline RL:
      a bootstrap ensemble of fitted-Q networks. Each member votes sell/hold; the share of sell votes sets the action
      HOLD / SELL 25% / 50% / 100% of the remaining position. The -25% stop and the 10-minute deadline stay as guardrails.

  python -m research.train --db artifacts/corpus/launches.db --out artifacts/corpus/train-v1
"""
import argparse, contextlib, hashlib, json, os, subprocess, time
import numpy as np, torch, torch.nn as nn
from research import engine as E

torch.manual_seed(0); np.random.seed(0)
NET = lambda e, x: ((x * (1 - E.COST_PER_SIDE)) / (e * (1 + E.COST_PER_SIDE)) - 1) * 100
BREAKEVEN = ((1 + E.COST_PER_SIDE) / (1 - E.COST_PER_SIDE) - 1) * 100
STOP = -0.25                 # guardrail on every learned seller
MIN_COVERAGE = 0.10          # a BUY threshold must still take at least 10% of validation launches

def FRACTION(votes, members):
    """Share of ensemble members voting sell -> HOLD / SELL 25% / 50% / 100% of the remaining position."""
    return 0.0 if votes == 0 else 1.0 if votes >= 0.75 * members else 0.5 if votes >= 0.5 * members else 0.25

# ---------------- labels from the approved target-exit rules (v4) ----------------
def target_exit(ep, e):
    """(target decision second, kind). Winner: earliest decision whose delayed fill is within 10 pts of the peak and
    net-positive after costs; the best realistic net must clear +0.5%. Loser: sell at once."""
    p = ep.price; end = min(E.WINDOW_S, e + E.HOLD_S)
    fills = {s: p[min(s + E.LATENCY_S, end)] for s in range(e + 1, end + 1)}
    best = max(fills, key=lambda s: (fills[s], -s))
    if NET(p[e], fills[best]) <= 0.5: return e + 1, 'loser'
    peak_pct = (p[e + 1:end + 1].max() / p[e] - 1) * 100; floor = max(peak_pct - 10, BREAKEVEN + 1e-6); pct = lambda x: (x / p[e] - 1) * 100
    if pct(fills[best]) < floor: return best, 'winner'
    tgt = best
    while tgt - 1 > e and pct(fills[tgt - 1]) >= floor: tgt -= 1
    return tgt, 'winner'

# ---------------- chronological blocks ----------------
def split_purged(eps, fracs=(.55, .10, .15, .20)):
    """Consecutive blocks by launch time. An episode is dropped from a block when its window reaches into the next
    block's first launch (Astra: purge overlapping outcome windows)."""
    n = len(eps); cuts = np.cumsum([0] + [int(round(f * n)) for f in fracs[:-1]] + [n])[:len(fracs) + 1]; cuts[-1] = n
    blocks = [eps[cuts[i]:cuts[i + 1]] for i in range(len(fracs))]
    for i in range(len(blocks) - 1):
        if blocks[i + 1]: nxt = blocks[i + 1][0].created; blocks[i] = [e for e in blocks[i] if e.created + E.WINDOW_S * 1000 <= nxt]
    return blocks

# ---------------- small PyTorch models ----------------
class Scaler:
    def fit(self, X): self.m = np.nanmean(X, 0); self.s = np.nanstd(X, 0) + 1e-6; return self
    def __call__(self, X): Z = (np.nan_to_num(X, nan=0.0) - np.nan_to_num(self.m)) / self.s; return torch.tensor(np.clip(Z, -8, 8), dtype=torch.float32)
    def state(self): return {'mean': np.nan_to_num(self.m).tolist(), 'std': self.s.tolist()}

def mlp(d, hidden=(32, 16), drop=0.1, out=1):
    layers, k = [], d
    for h in hidden: layers += [nn.Linear(k, h), nn.ReLU(), nn.Dropout(drop)]; k = h
    return nn.Sequential(*layers, nn.Linear(k, out))

def fit(model, Xtr, ytr, Xva, yva, loss_fn, epochs=60, lr=3e-3, wd=1e-3, batch=512, patience=6):
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=wd); best, state, bad = 1e18, None, 0
    for ep in range(epochs):
        model.train(); perm = torch.randperm(len(Xtr))
        for i in range(0, len(Xtr), batch):
            idx = perm[i:i + batch]; opt.zero_grad(); loss_fn(model(Xtr[idx]).squeeze(-1), ytr[idx]).backward(); opt.step()
        model.eval()
        with torch.no_grad(): v = float(loss_fn(model(Xva).squeeze(-1), yva))
        if v < best - 1e-5: best, state, bad = v, {k: t.clone() for k, t in model.state_dict().items()}, 0
        else:
            bad += 1
            if bad >= patience: break
    model.load_state_dict(state); model.eval(); return model, best

def platt(scores, y):
    """Sigmoid calibration p = sigmoid(a*score + b), fitted on the calibration block only (Astra: simple over flexible)."""
    s = torch.tensor(scores, dtype=torch.float64); t = torch.tensor(y, dtype=torch.float64); ab = torch.tensor([1.0, 0.0], dtype=torch.float64, requires_grad=True)
    opt = torch.optim.LBFGS([ab], max_iter=200)
    def closure():
        opt.zero_grad(); loss = nn.functional.binary_cross_entropy_with_logits(ab[0] * s + ab[1], t); loss.backward(); return loss
    opt.step(closure); return [float(ab[0]), float(ab[1])]

def calibration_report(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1); idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    ece = sum(abs(p[idx == b].mean() - y[idx == b].mean()) * (idx == b).mean() for b in range(bins) if (idx == b).any())
    return {'brier': round(float(((p - y) ** 2).mean()), 4), 'ece': round(float(ece), 4)}

def buy_report(take, y):
    take = np.asarray(take, bool); y = np.asarray(y, bool)
    return {'coverage': round(float(take.mean()), 3), 'winner_retention': round(float(take[y].mean()) if y.any() else 0.0, 3),
            'loser_rejection': round(float((~take[~y]).mean()) if (~y).any() else 0.0, 3), 'precision': round(float(y[take].mean()) if take.any() else 0.0, 3)}

# ---------------- evaluation helpers ----------------
def run(eps, buy_ok, sell_policy):
    out = []
    for ep in eps:
        d = E.buy_decision_time(ep)
        if d is None or not buy_ok(ep, d): continue
        tr = E.simulate(ep, sell_policy, decision_t=d)
        if tr: out.append((ep, tr))
    return out

total = lambda trades: sum(tr.net_return_pct() for _, tr in trades)

def report(trades, candidates, blocks=10, seed=0):
    """Engine summary + per-candidate P&L, time-block bootstrap CI, holding time and exit quality vs the peak."""
    r = [tr.net_return_pct() for _, tr in trades]; s = E.summarize(r)
    if not trades: return s
    s['pnl_per_candidate_pct'] = round(sum(r) / max(1, candidates), 2)
    k = min(blocks, len(r)); groups = np.array_split(np.array(r), k); rng = np.random.default_rng(seed)
    boot = [np.concatenate([groups[i] for i in rng.integers(0, k, k)]).mean() for _ in range(1000)]
    s['block_ci95'] = [round(float(np.percentile(boot, 2.5)), 2), round(float(np.percentile(boot, 97.5)), 2)]
    holds, gaps = [], []
    for ep, tr in trades:
        end = min(E.WINDOW_S, tr.entry_t + E.HOLD_S); peak = (ep.price[tr.entry_t + 1:end + 1].max() / tr.entry_price - 1) * 100
        exit_gross = sum(f * (px / tr.entry_price - 1) * 100 for _, _, f, px in tr.fills)
        holds.append(sum(f * (ft - tr.entry_t) for _, ft, f, _ in tr.fills)); gaps.append(peak - exit_gross)
    s['median_hold_s'] = round(float(np.median(holds)), 1); s['median_gap_to_peak_pp'] = round(float(np.median(gaps)), 1)
    s['share_within_10pp_of_peak'] = round(float((np.array(gaps) <= 10).mean()), 3)
    return s

@contextlib.contextmanager
def market(latency=None, cost=None):
    """Temporarily change the engine's execution assumptions (stress tests)."""
    old = (E.LATENCY_S, E.COST_PER_SIDE)
    if latency is not None: E.LATENCY_S = latency
    if cost is not None: E.COST_PER_SIDE = cost
    try: yield
    finally: E.LATENCY_S, E.COST_PER_SIDE = old

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out', required=True); ap.add_argument('--require-trades', action='store_true')
    ap.add_argument('--step', type=int, default=2); ap.add_argument('--members', type=int, default=4); a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); t0 = time.time()
    eps = [e for e in E.load_episodes(a.db, 20, require_trades=a.require_trades) if not e.anomaly]
    eps = [e for e in eps if E.buy_decision_time(e) is not None]
    tr_eps, ca_eps, va_eps, te_eps = split_purged(eps); n = len(eps)
    names = E.ALL_FEATURES + ['has_wallet']
    def row(ep, t):
        f = E.feature_table(ep)[t]; return np.append(f, float(ep.trades is not None))
    print(f'{n} tradable launches · train {len(tr_eps)} · calib {len(ca_eps)} · val {len(va_eps)} · test {len(te_eps)} (after purge) · '
          f'with wallet data {sum(e.trades is not None for e in eps)} · load {time.time()-t0:.0f}s', flush=True)

    # ---------- BUY: target = a feasible winner exists (approved labels), inputs = features at the buy decision ----------
    def buy_xy(E_):
        X, y = [], []
        for ep in E_:
            d = E.buy_decision_time(ep); X.append(row(ep, d)); y.append(float(target_exit(ep, d + E.LATENCY_S)[1] == 'winner'))
        return np.array(X), np.array(y, dtype=np.float32)
    Xb, yb = buy_xy(tr_eps); Xbc, ybc = buy_xy(ca_eps); Xbv, ybv = buy_xy(va_eps); Xbt, ybt = buy_xy(te_eps)
    sc = Scaler().fit(Xb); pos = float(yb.mean())
    bce = nn.BCEWithLogitsLoss(pos_weight=torch.tensor((1 - pos) / max(pos, 1e-6)))
    buy_models = {}
    for name, m in (('logistic', nn.Sequential(nn.Linear(len(names), 1))), ('mlp', mlp(len(names)))):
        buy_models[name], _ = fit(m, sc(Xb), torch.tensor(yb), sc(Xbc), torch.tensor(ybc), bce)
    from sklearn.ensemble import HistGradientBoostingClassifier
    gbt = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.05, l2_regularization=1.0, early_stopping=True, random_state=0).fit(np.nan_to_num(Xb), yb)
    def score(name, X):   # uncalibrated logit
        if name == 'gbt': p = np.clip(gbt.predict_proba(np.nan_to_num(X))[:, 1], 1e-6, 1 - 1e-6); return np.log(p / (1 - p))
        with torch.no_grad(): return buy_models[name](sc(X)).squeeze(-1).numpy().astype(float)
    cal = {k: platt(score(k, Xbc), ybc) for k in ('logistic', 'mlp', 'gbt')}
    prob = lambda k, X: 1 / (1 + np.exp(-(cal[k][0] * score(k, X) + cal[k][1])))
    from sklearn.metrics import roc_auc_score
    buy_quality = {k: {'auc_val': round(float(roc_auc_score(ybv, prob(k, Xbv))), 3), 'auc_test': round(float(roc_auc_score(ybt, prob(k, Xbt))), 3),
                       **calibration_report(prob(k, Xbt), ybt)} for k in ('logistic', 'mlp', 'gbt')}
    print('BUY', buy_quality, flush=True)

    # ---------- SELL 1: supervised stopping on the approved target exits (winners and losers) ----------
    def sell_state(ep, e, t):
        pe = ep.price[e]; return np.append(row(ep, t), [(ep.price[t] / pe - 1) * 100, (ep.price[e:t + 1].max() / pe - 1) * 100, t - e])
    def sell_xy(E_):
        X, y = [], []
        for ep in E_:
            e = E.buy_decision_time(ep) + E.LATENCY_S; end = min(E.WINDOW_S, e + E.HOLD_S); tgt, kind = target_exit(ep, e)
            for t in range(e + 1, end, a.step): X.append(sell_state(ep, e, t)); y.append(float(kind == 'loser' or t >= tgt))
        return np.array(X), np.array(y, dtype=np.float32)
    Xs, ys = sell_xy(tr_eps); Xsv, ysv = sell_xy(ca_eps); ss = Scaler().fit(Xs)
    stop_model, _ = fit(mlp(Xs.shape[1], (64, 32)), ss(Xs), torch.tensor(ys), ss(Xsv), torch.tensor(ysv), nn.BCEWithLogitsLoss(), epochs=25)
    cache = {}
    def batch(kind, ep, e):
        """All model outputs for one position at once (states depend only on the launch and the entry second)."""
        key = (kind, ep.mint, e)
        if key not in cache:
            end = min(E.WINDOW_S, e + E.HOLD_S); X = np.array([sell_state(ep, e, t) for t in range(e + 1, end)])
            with torch.no_grad():
                cache[key] = torch.sigmoid(stop_model(ss(X)).squeeze(-1)).numpy() if kind == 'stop' else np.stack([q(qs(X)).squeeze(-1).numpy() for q in qnets])
        return cache[key]
    def stop_policy(th):
        def pol(ep, e, t, held, trd):
            if ep.price[t] / ep.price[e] - 1 <= STOP: return held
            return held if batch('stop', ep, e)[t - e - 1] >= th else 0.0
        return pol

    # ---------- SELL 2: conservative offline RL - bootstrap ensemble of fitted-Q networks ----------
    # Reward = realized net P&L after the delayed fill and costs, per unit of the position. With no price impact the value
    # is linear in inventory, so each member learns Q_hold for one unit; members disagree where data is thin.
    def transitions(ep):
        e = E.buy_decision_time(ep) + E.LATENCY_S; end = min(E.WINDOW_S, e + E.HOLD_S); secs = list(range(e + 1, end, a.step)); pe = ep.price[e]
        X = np.array([sell_state(ep, e, t) for t in secs]); sell = np.array([NET(pe, ep.price[min(t + E.LATENCY_S, end)]) for t in secs])
        return X, sell, np.arange(len(secs)) + 1 < len(secs), np.full(len(secs), NET(pe, ep.price[end]))
    T_tr = [transitions(ep) for ep in tr_eps]; T_ca = [transitions(ep) for ep in ca_eps]
    qs = Scaler().fit(np.concatenate([t[0] for t in T_tr]))
    stack = lambda T: [np.concatenate([t[i] for t in T]) for i in range(4)]
    Xqv, sqv, nqv, fqv = stack(T_ca); Xqv_t = qs(Xqv)
    clip = lambda x: np.clip(x, -100, 500)   # bounded targets keep the regression stable on heavy-tailed returns
    rng = np.random.default_rng(0); qnets = []
    for k in range(a.members):
        pick_ = rng.integers(0, len(T_tr), len(T_tr)) if a.members > 1 else np.arange(len(T_tr))   # resample whole episodes
        Xq, sq, nq, fq = stack([T_tr[i] for i in pick_]); Xq_t = qs(Xq)
        q_hold = np.where(nq, 0.0, fq); qv_hold = np.where(nqv, 0.0, fqv); qnet = None
        for it in range(6):
            tgt = np.where(nq, np.maximum(np.append(sq[1:], 0), np.append(q_hold[1:], 0)), fq)
            tgtv = np.where(nqv, np.maximum(np.append(sqv[1:], 0), np.append(qv_hold[1:], 0)), fqv)
            qnet, _ = fit(mlp(Xq.shape[1], (64, 32)), Xq_t, torch.tensor(clip(tgt), dtype=torch.float32), Xqv_t, torch.tensor(clip(tgtv), dtype=torch.float32), nn.SmoothL1Loss(beta=5.0), epochs=15, lr=2e-3)
            with torch.no_grad(): q_hold = qnet(Xq_t).squeeze(-1).numpy(); qv_hold = qnet(Xqv_t).squeeze(-1).numpy()
        qnets.append(qnet)
    def votes(ep, e, t, margin):
        end = min(E.WINDOW_S, e + E.HOLD_S); sell_now = NET(ep.price[e], ep.price[min(t + E.LATENCY_S, end)])
        return int((sell_now >= batch('q', ep, e)[:, t - e - 1] - margin).sum())
    def rl_partial(margin):
        def pol(ep, e, t, held, trd):
            if ep.price[t] / ep.price[e] - 1 <= STOP: return held
            return FRACTION(votes(ep, e, t, margin), len(qnets)) * held
        return pol
    def rl_all(margin):
        def pol(ep, e, t, held, trd):
            if ep.price[t] / ep.price[e] - 1 <= STOP: return held
            return held if votes(ep, e, t, margin) * 2 >= len(qnets) else 0.0
        return pol
    print(f'models trained {time.time()-t0:.0f}s · RL members {len(qnets)} · transitions/member ~{sum(len(t[0]) for t in T_tr)}', flush=True)

    # ---------- choose on VALIDATION with the accounting engine (Astra: net utility, not accuracy) ----------
    rules = E.rules_v3(); allbuy = lambda ep, d: True
    pick = lambda cands, f: max(cands, key=lambda c: total(f(c)))
    th_stop = pick((0.5, 0.6, 0.7, 0.8, 0.9), lambda th: run(va_eps, allbuy, stop_policy(th)))
    m_part = pick((0.0, 2.0, 5.0, 10.0), lambda m: run(va_eps, allbuy, rl_partial(m)))
    m_all = pick((0.0, 2.0, 5.0, 10.0), lambda m: run(va_eps, allbuy, rl_all(m)))
    sellers = {'rules_v3': rules, 'stop_model': stop_policy(th_stop), 'rl_partial': rl_partial(m_part), 'rl_all': rl_all(m_all)}
    val_sell = {k: round(total(run(va_eps, allbuy, p)) / max(1, len(va_eps)), 2) for k, p in sellers.items()}
    best_seller = max(val_sell, key=val_sell.get)
    ths = [round(x, 2) for x in np.arange(0.2, 0.85, 0.05)]; buy_th = {}
    for k in ('logistic', 'mlp', 'gbt'):
        pv = prob(k, Xbv); ok = [th for th in ths if (pv >= th).mean() >= MIN_COVERAGE] or [ths[0]]
        gate_th = lambda th, k=k: (lambda ep, d: prob(k, row(ep, d)[None, :])[0] >= th)
        buy_th[k] = pick(ok, lambda th: run(va_eps, gate_th(th), sellers[best_seller]))
    best_buy = max(('all',) + ('logistic', 'mlp', 'gbt'), key=lambda k: total(run(va_eps, allbuy if k == 'all' else (lambda ep, d, k=k: prob(k, row(ep, d)[None, :])[0] >= buy_th[k]), sellers[best_seller])))
    choices = {'stop_threshold': th_stop, 'rl_partial_margin': m_part, 'rl_all_margin': m_all, 'val_pnl_per_launch_by_seller': val_sell,
               'best_seller': best_seller, 'buy_thresholds': buy_th, 'best_buy': best_buy}
    print('validation choices', choices, flush=True)

    # ---------- TEST (newest block), scored once ----------
    gates = {'all': allbuy, **{k: (lambda ep, d, k=k: prob(k, row(ep, d)[None, :])[0] >= buy_th[k]) for k in ('logistic', 'mlp', 'gbt')}}
    res = {f'buy_all + {s}': report(run(te_eps, allbuy, p), len(te_eps)) for s, p in {**sellers, 'hold_10min': E.hold_policy}.items()}
    buy_metrics = {}
    for k in ('logistic', 'mlp', 'gbt'):
        res[f'buy_{k} + rules_v3'] = report(run(te_eps, gates[k], rules), len(te_eps))
        res[f'buy_{k} + {best_seller}'] = report(run(te_eps, gates[k], sellers[best_seller]), len(te_eps))
        buy_metrics[k] = buy_report(prob(k, Xbt) >= buy_th[k], ybt == 1)
    chosen = f'buy_{best_buy} + {best_seller}'
    if chosen not in res: res[chosen] = report(run(te_eps, gates[best_buy], sellers[best_seller]), len(te_eps))

    # ---------- STRESS (Tim: keep 2 s, stress 3-5 s): same trained models, harsher market ----------
    stress = {}
    for label, lat, cost in (('latency_3s', 3, None), ('latency_4s', 4, None), ('latency_5s', 5, None), ('cost_x1.5', None, E.COST_PER_SIDE * 1.5)):
        with market(lat, cost):
            stress[label] = {'chosen': report(run(te_eps, gates[best_buy], sellers[best_seller]), len(te_eps)),
                             'baseline buy_all + rules_v3': report(run(te_eps, allbuy, rules), len(te_eps))}
    print('stress', {k: {s: v[s].get('avg_pct') for s in v} for k, v in stress.items()}, flush=True)

    cfg = {'db_launches': n, 'split': [len(tr_eps), len(ca_eps), len(va_eps), len(te_eps)], 'with_wallet': sum(e.trades is not None for e in eps), 'features': names,
           'latency_s': E.LATENCY_S, 'cost_per_side': E.COST_PER_SIDE, 'first_sight_s': E.FIRST_SIGHT_S, 'hold_s': E.HOLD_S, 'stop': STOP, 'rl_members': len(qnets),
           'require_trades': a.require_trades, 'test_launch_range': [te_eps[0].created, te_eps[-1].created]}
    try:
        cfg['git'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        cfg['git_dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain', '--', 'research'], text=True).strip())
    except Exception: pass
    cfg['config_sha256'] = hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:16]
    out = {'config': cfg, 'buy_quality': buy_quality, 'buy_metrics_test': buy_metrics, 'validation_choices': choices, 'chosen_system': chosen,
           'test': res, 'stress': stress, 'seconds': round(time.time() - t0)}
    json.dump(out, open(os.path.join(a.out, 'results.json'), 'w'), indent=1, default=str)
    torch.save({'buy': {k: m.state_dict() for k, m in buy_models.items()}, 'buy_scaler': sc.state(), 'calibration': cal, 'buy_thresholds': buy_th,
                'stop': stop_model.state_dict(), 'stop_scaler': ss.state(), 'stop_threshold': th_stop,
                'q_members': [q.state_dict() for q in qnets], 'q_scaler': qs.state(), 'rl_margins': {'partial': m_part, 'all': m_all},
                'features': names, 'config': cfg}, os.path.join(a.out, 'models.pt'))
    import pickle; pickle.dump(gbt, open(os.path.join(a.out, 'buy_gbt.pkl'), 'wb'))
    print(json.dumps({'chosen': chosen, 'chosen_test': res[chosen], 'baseline': res['buy_all + rules_v3']}, indent=1), flush=True)

if __name__ == '__main__':
    main()
