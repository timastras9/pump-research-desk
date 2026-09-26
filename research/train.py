#!/usr/bin/env python3
"""First training run (Astra design, approved 2026-09-26): BUY model + SELL models (supervised stopping and RL), all in
PyTorch, all scored by the single accounting engine with 2 s delayed fills and costs.

Split by launch time: oldest 60% train, next 20% validation (thresholds/margins), newest 20% test (scored once).

  python -m research.train --db artifacts/corpus/launches.db --out artifacts/corpus/train-v1
"""
import argparse, hashlib, json, os, subprocess, time
import numpy as np, torch, torch.nn as nn
from research import engine as E

torch.manual_seed(0); np.random.seed(0)
NET = lambda e, x: ((x * (1 - E.COST_PER_SIDE)) / (e * (1 + E.COST_PER_SIDE)) - 1) * 100
BREAKEVEN = ((1 + E.COST_PER_SIDE) / (1 - E.COST_PER_SIDE) - 1) * 100

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

# ---------------- small PyTorch models ----------------
class Scaler:
    def fit(self, X): self.m = np.nanmean(X, 0); self.s = np.nanstd(X, 0) + 1e-6; return self
    def __call__(self, X): Z = (np.nan_to_num(X, nan=0.0) - np.nan_to_num(self.m)) / self.s; return torch.tensor(np.clip(Z, -8, 8), dtype=torch.float32)

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

# ---------------- evaluation helpers ----------------
def run(eps, buy_ok, sell_policy):
    out = []
    for ep in eps:
        d = E.buy_decision_time(ep)
        if d is None or not buy_ok(ep, d): continue
        tr = E.simulate(ep, sell_policy, decision_t=d)
        if tr: out.append(tr.net_return_pct())
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out', required=True); ap.add_argument('--require-trades', action='store_true')
    ap.add_argument('--step', type=int, default=2); a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); t0 = time.time()
    eps = [e for e in E.load_episodes(a.db, 20, require_trades=a.require_trades) if not e.anomaly]
    eps = [e for e in eps if E.buy_decision_time(e) is not None]
    n = len(eps); tr_eps, va_eps, te_eps = eps[:int(n * .6)], eps[int(n * .6):int(n * .8)], eps[int(n * .8):]
    names = E.ALL_FEATURES + ['has_wallet']
    def row(ep, t):
        f = E.feature_table(ep)[t]; return np.append(f, float(ep.trades is not None))
    print(f'{n} tradable launches · train {len(tr_eps)} · val {len(va_eps)} · test {len(te_eps)} · with wallet data {sum(e.trades is not None for e in eps)} · load {time.time()-t0:.0f}s', flush=True)

    # ---------- BUY: target = a winner exists (approved labels), inputs = features at the buy decision ----------
    def buy_xy(E_):
        X, y = [], []
        for ep in E_:
            d = E.buy_decision_time(ep); e = d + E.LATENCY_S; X.append(row(ep, d)); y.append(float(target_exit(ep, e)[1] == 'winner'))
        return np.array(X), np.array(y, dtype=np.float32)
    Xb, yb = buy_xy(tr_eps); Xbv, ybv = buy_xy(va_eps); Xbt, ybt = buy_xy(te_eps)
    sc = Scaler().fit(Xb); pos = float(yb.mean())
    bce = nn.BCEWithLogitsLoss(pos_weight=torch.tensor((1 - pos) / max(pos, 1e-6)))
    buy_models = {}
    for name, m in (('logistic', nn.Sequential(nn.Linear(len(names), 1))), ('mlp', mlp(len(names)))):
        buy_models[name], vloss = fit(m, sc(Xb), torch.tensor(yb), sc(Xbv), torch.tensor(ybv), bce)
    from sklearn.ensemble import HistGradientBoostingClassifier
    gbt = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.05, l2_regularization=1.0, early_stopping=True, random_state=0).fit(np.nan_to_num(Xb), yb)
    def prob(name, X):
        if name == 'gbt': return gbt.predict_proba(np.nan_to_num(X))[:, 1]
        with torch.no_grad(): return torch.sigmoid(buy_models[name](sc(X)).squeeze(-1)).numpy()
    from sklearn.metrics import roc_auc_score
    buy_auc = {k: {'val': round(float(roc_auc_score(ybv, prob(k, Xbv))), 3), 'test': round(float(roc_auc_score(ybt, prob(k, Xbt))), 3)} for k in ('logistic', 'mlp', 'gbt')}
    print('BUY AUC', buy_auc, flush=True)

    # ---------- SELL 1: supervised stopping on the approved target exits ----------
    def sell_xy(E_):
        X, y = [], []
        for ep in E_:
            d = E.buy_decision_time(ep); e = d + E.LATENCY_S; end = min(E.WINDOW_S, e + E.HOLD_S); tgt, kind = target_exit(ep, e)
            for t in range(e + 1, end, a.step):
                f = row(ep, t); pe = ep.price[e]
                X.append(np.append(f, [(ep.price[t] / pe - 1) * 100, (ep.price[e:t + 1].max() / pe - 1) * 100, t - e])); y.append(float(kind == 'loser' or t >= tgt))
        return np.array(X), np.array(y, dtype=np.float32)
    Xs, ys = sell_xy(tr_eps); Xsv, ysv = sell_xy(va_eps); ss = Scaler().fit(Xs)
    stop_model, _ = fit(mlp(Xs.shape[1], (64, 32)), ss(Xs), torch.tensor(ys), ss(Xsv), torch.tensor(ysv), nn.BCEWithLogitsLoss(), epochs=25)
    def sell_state(ep, e, t):
        pe = ep.price[e]; return np.append(row(ep, t), [(ep.price[t] / pe - 1) * 100, (ep.price[e:t + 1].max() / pe - 1) * 100, t - e])
    def stop_policy(th):
        def pol(ep, e, t, held, trd):
            with torch.no_grad(): pr = float(torch.sigmoid(stop_model(ss(sell_state(ep, e, t)[None, :])).squeeze()))
            return held if pr >= th or (ep.price[t] / ep.price[e] - 1) <= -0.25 else 0.0
        return pol

    # ---------- SELL 2: RL, fitted Q-iteration with a PyTorch Q-network; reward = realized P&L after delay and costs ----------
    def transitions(E_):
        X, sell, nxt, final = [], [], [], []
        for ep in E_:
            d = E.buy_decision_time(ep); e = d + E.LATENCY_S; end = min(E.WINDOW_S, e + E.HOLD_S); secs = list(range(e + 1, end, a.step)); pe = ep.price[e]
            for i, t in enumerate(secs):
                X.append(sell_state(ep, e, t)); sell.append(NET(pe, ep.price[min(t + E.LATENCY_S, end)])); nxt.append(i + 1 < len(secs)); final.append(NET(pe, ep.price[end]))
        return np.array(X), np.array(sell), np.array(nxt), np.array(final)
    Xq, sq, nq, fq = transitions(tr_eps); Xqv, sqv, nqv, fqv = transitions(va_eps); qs = Scaler().fit(Xq)
    Xq_t, Xqv_t = qs(Xq), qs(Xqv); q_hold = np.where(nq, 0.0, fq); qv_hold = np.where(nqv, 0.0, fqv); qnet = None
    clip = lambda x: np.clip(x, -100, 500)   # bounded targets keep the regression stable on heavy-tailed returns
    for it in range(6):
        tgt = np.where(nq, np.maximum(np.append(sq[1:], 0), np.append(q_hold[1:], 0)), fq); tgtv = np.where(nqv, np.maximum(np.append(sqv[1:], 0), np.append(qv_hold[1:], 0)), fqv)
        qnet, _ = fit(mlp(Xq.shape[1], (64, 32)), Xq_t, torch.tensor(clip(tgt), dtype=torch.float32), Xqv_t, torch.tensor(clip(tgtv), dtype=torch.float32), nn.SmoothL1Loss(beta=5.0), epochs=15, lr=2e-3)
        with torch.no_grad(): q_hold = qnet(Xq_t).squeeze(-1).numpy(); qv_hold = qnet(Xqv_t).squeeze(-1).numpy()
    def rl_policy(margin):
        def pol(ep, e, t, held, trd):
            end = min(E.WINDOW_S, e + E.HOLD_S); sell_now = NET(ep.price[e], ep.price[min(t + E.LATENCY_S, end)])
            with torch.no_grad(): hold = float(qnet(qs(sell_state(ep, e, t)[None, :])).squeeze())
            return held if sell_now >= hold - margin else 0.0
        return pol
    print(f'models trained {time.time()-t0:.0f}s · RL transitions {len(Xq)}', flush=True)

    # ---------- choose thresholds on VALIDATION with the accounting engine ----------
    rules = E.rules_v3(); allbuy = lambda ep, d: True
    pick = lambda cands, f: max(cands, key=lambda c: sum(f(c)))   # maximise total validation P&L (Astra: utility, not accuracy)
    th_stop = pick((0.5, 0.6, 0.7, 0.8, 0.9), lambda th: run(va_eps, allbuy, stop_policy(th)))
    margin = pick((0.0, 2.0, 5.0, 10.0), lambda m: run(va_eps, allbuy, rl_policy(m)))
    best_seller = max((('rules_v3', rules), ('stop_model', stop_policy(th_stop)), ('rl', rl_policy(margin))), key=lambda kv: sum(run(va_eps, allbuy, kv[1])))
    buy_th = {}
    for k in ('logistic', 'mlp', 'gbt'):
        buy_th[k] = pick((0.3, 0.4, 0.5, 0.6, 0.7), lambda th, k=k: run(va_eps, lambda ep, d: prob(k, row(ep, d)[None, :])[0] >= th, best_seller[1]))
    print(f'validation choices: stop th {th_stop} · RL margin {margin} · best seller {best_seller[0]} · buy thresholds {buy_th}', flush=True)

    # ---------- TEST (newest 20%), scored once ----------
    res = {}
    for sname, spol in (('rules_v3', rules), ('hold_10min', E.hold_policy), ('stop_model', stop_policy(th_stop)), ('rl', rl_policy(margin))):
        res[f'buy_all + {sname}'] = E.summarize(run(te_eps, allbuy, spol))
    for k in ('logistic', 'mlp', 'gbt'):
        gate = lambda ep, d, k=k: prob(k, row(ep, d)[None, :])[0] >= buy_th[k]
        res[f'buy_{k} + rules_v3'] = E.summarize(run(te_eps, gate, rules))
        res[f'buy_{k} + {best_seller[0]}'] = E.summarize(run(te_eps, gate, best_seller[1]))
    cfg = {'db_launches': n, 'split': [len(tr_eps), len(va_eps), len(te_eps)], 'with_wallet': sum(e.trades is not None for e in eps), 'features': names, 'latency_s': E.LATENCY_S,
           'cost_per_side': E.COST_PER_SIDE, 'first_sight_s': E.FIRST_SIGHT_S, 'require_trades': a.require_trades, 'test_launch_range': [te_eps[0].created, te_eps[-1].created]}
    try: cfg['git'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    except Exception: pass
    cfg['config_sha256'] = hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:16]
    out = {'config': cfg, 'buy_auc': buy_auc, 'validation_choices': {'stop_threshold': th_stop, 'rl_margin': margin, 'best_seller': best_seller[0], 'buy_thresholds': buy_th}, 'test': res, 'seconds': round(time.time() - t0)}
    json.dump(out, open(os.path.join(a.out, 'results.json'), 'w'), indent=1, default=str)
    torch.save({'buy': {k: m.state_dict() for k, m in buy_models.items()}, 'stop': stop_model.state_dict(), 'q': qnet.state_dict()}, os.path.join(a.out, 'models.pt'))
    print(json.dumps(out['test'], indent=1), flush=True)

if __name__ == '__main__':
    main()
