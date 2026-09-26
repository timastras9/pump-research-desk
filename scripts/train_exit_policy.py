#!/usr/bin/env python3
"""Learn when to sell from hindsight: label every second 'selling here was right' (it was near the top, or a crash
was coming), train a gradient-boosted model on features known at that second, and replay it as a sell policy.

Split by launch time: oldest 70% train, next 15% choose the sell threshold, newest 15% scored once.
Scored as paper P&L after 1.25% fee + 2% slippage per side against the rule baselines and a perfect-hindsight seller.

  python scripts/train_exit_policy.py --db artifacts/corpus/launches.db --out artifacts/corpus/exit-policy-v1
"""
import argparse, hashlib, json, math, os, re, sqlite3, subprocess, time
import numpy as np

COST = 0.0325
FIRST_SIGHT_S = 5          # launch feed sees tokens ~3-8 s after creation
DEAD_AFTER_S = 30          # no trade within 30 s of first sight: skip
NO_CHASE = 1.30            # already +30% when trading starts: skip
HOLD_S = 600
LATENCY_S = 2          # decision -> fill delay (seconds); overridden by --latency
FEATURES = ['ret_entry', 'max_ret', 'dd_high', 'mom5', 'mom15', 'mom30', 'vol30', 'active30', 'volume30', 'vol_ratio', 'since_entry', 'since_launch', 'fee_routed', 'mayhem', 'terminal']

def load(db_path, min_traded):
    db = sqlite3.connect(db_path)
    rows = db.execute("SELECT mint, created_ts, description, image_uri, mayhem, name FROM tokens WHERE candles_status='done' AND candles_n>=? ORDER BY created_ts", (min_traded,)).fetchall()
    out = []
    for mint, created, desc, img, mayhem, name in rows:
        p = np.full(721, np.nan); v = np.zeros(721)
        for sec, close, vol in db.execute('SELECT sec, close, volume FROM candles WHERE mint=?', (mint,)):
            if close and close > 0: p[sec] = close; v[sec] = vol or 0
        k = np.where(~np.isnan(p))[0]
        if not len(k): continue
        p[:k[0]] = p[k[0]]
        for i in range(1, 721):
            if np.isnan(p[i]): p[i] = p[i - 1]
        tags = [1.0 if re.search(r'fees? to @\w+', desc or '', re.I) else 0.0, float(mayhem or 0), 0.0 if (not img or re.search('ipfs|pinata', img)) else 1.0]
        out.append(dict(mint=mint, name=name or '', created=created, p=p, v=v, tags=tags))
    return out

def entry_of(t):
    p = t['p']; s0 = FIRST_SIGHT_S
    for i in range(s0 + 1, min(s0 + DEAD_AFTER_S, 719) + 1):
        if p[i] != p[s0]:
            if p[i] >= p[s0] * NO_CHASE: return None
            return i + LATENCY_S   # filled after the execution delay
    return None

def features(t, e, s):
    p, v = t['p'], t['v']; lp = np.log(p)
    hi = p[e:s + 1].max(); r = np.diff(lp[max(0, s - 30):s + 1])
    v30 = v[max(0, s - 29):s + 1]; v10, v20 = v[max(0, s - 9):s + 1].sum(), v[max(0, s - 29):max(0, s - 9)].sum()
    return [lp[s] - lp[e], math.log(hi / p[e]), lp[s] - math.log(hi), lp[s] - lp[max(0, s - 5)], lp[s] - lp[max(0, s - 15)], lp[s] - lp[max(0, s - 30)],
            float(r.std()) if len(r) > 1 else 0.0, float((v30 > 0).sum()), math.log1p(v30.sum()), (v10 + 1) / (v20 / 2 + 1), s - e, s, *t['tags']]

def label(t, s, end):
    p = t['p']; fut = p[s + 1:end + 1]
    if not len(fut): return 1
    near_top = fut.max() <= p[s] * 1.10
    nxt = p[s + 1:min(end, s + 60) + 1]
    crash = nxt.min() <= p[s] * 0.75 and nxt.max() < p[s] * 1.20
    return int(near_top or crash)

# Target exit v3 (reviewed by Tim 2026-09-26): peak % minus target-exit % must be <= 10 percentage points and the
# target must be positive. Percentages are vs the entry price; the target is filled LATENCY_S after the decision.
#  Winner: earliest decision second on the run into the best fill whose fill % >= peak % - 10 (and > 0). If even the best
#          fill is more than 10 points below the raw peak (a 1-2 s spike already gone by the delayed fill), the target is
#          the best fill itself: the closest reachable point (flagged as a latency gap).
#  Loser (best fill never beats costs): no trade; the model is taught to sell at once (minimum loss).
TARGET_POINTS = 10.0
def fills_of(t):
    e = t['entry']; p = t['p']; end = min(720, e + HOLD_S)
    return {s: p[min(s + LATENCY_S, end)] for s in range(e + 1, end + 1)}, end

def target_exit(t):
    e = t['entry']; p = t['p']; f, end = fills_of(t)
    pct = lambda x: (x / p[e] - 1) * 100
    best = max(f, key=lambda s: (f[s], -s))
    if net(p[e], f[best]) <= 0: return best, best, 'loser'
    peak_pct = pct(p[e + 1:end + 1].max())
    floor = max(peak_pct - TARGET_POINTS, 1e-6)
    if pct(f[best]) < floor: return best, best, 'winner-latency-gap'
    tgt = best
    while tgt - 1 > e and pct(f[tgt - 1]) >= floor: tgt -= 1
    return tgt, best, 'winner'

def label_v2(t, s, end, tgt=None):
    # 1 = sell (at or after the target exit, or any time on a loser), 0 = hold
    tgt = tgt or target_exit(t)
    return int(tgt[2] == 'loser' or s >= tgt[0])

def dataset(tokens, step):
    X, y = [], []
    for t in tokens:
        e = t.get('entry')
        if e is None: continue
        end = min(720, e + HOLD_S)
        tgt = target_exit(t)
        for s in range(e + 1, end, step): X.append(features(t, e, s)); y.append(label_v2(t, s, end, tgt))
    return np.array(X, dtype=np.float32), np.array(y)

net = lambda e, x: ((x * (1 - COST)) / (e * (1 + COST)) - 1) * 100

def simulate(t, policy, detail=False):
    e = t.get('entry')
    if e is None: return None
    p = t['p']; end = min(720, e + HOLD_S)
    if hasattr(policy, 'batch'):   # score every second of this token in one model call (same decisions, much faster)
        secs = np.arange(e + 1, end); hits = np.nonzero(policy.batch(t, e, secs))[0]
        sell_at = [int(secs[hits[0]])] if len(hits) else []
    else:
        sell_at = None
    for s in (sell_at if sell_at is not None else range(e + 1, end)):
        if sell_at is not None or policy(t, e, s):
            f = min(s + LATENCY_S, end)   # realistic fill: price LATENCY_S seconds after the decision
            return (s, f, net(p[e], p[f])) if detail else net(p[e], p[f])
    return (end, end, net(p[e], p[end])) if detail else net(p[e], p[end])

def rule_v2(t, e, s, take=30, window=60):
    p = t['p']; pct = (p[s] / p[e] - 1) * 100; hi = p[e:s + 1].max(); el = s - e
    if pct <= -25: return True
    if el <= window and pct >= take: return True
    if el == 60 and hi < p[e] * 1.05: return True
    if hi >= p[e] * 1.2 and p[s] <= hi * 0.7: return True
    return False

def rl_transitions(tokens, step):
    # One row per decision second: features now, the reward for selling now (filled LATENCY_S later), and the next state.
    rows = []
    for t in tokens:
        e = t.get('entry')
        if e is None: continue
        p = t['p']; end = min(720, e + HOLD_S); secs = list(range(e + 1, end, step))
        for i, s_ in enumerate(secs):
            rows.append((features(t, e, s_), net(p[e], p[min(s_ + LATENCY_S, end)]), i + 1 < len(secs), net(p[e], p[end])))
    X = np.array([r[0] for r in rows], dtype=np.float32); sell = np.array([r[1] for r in rows]); has_next = np.array([r[2] for r in rows]); final = np.array([r[3] for r in rows])
    return X, sell, has_next, final

def fit_q_hold(X, sell, has_next, final, iters=8):
    # Q_hold(s) = best achievable value from the next decision: max(sell there, hold there). Rows are ordered per token,
    # so the next state of row i is row i+1 whenever has_next[i]. At the 10-minute mark the position is sold.
    from sklearn.ensemble import HistGradientBoostingRegressor
    q_hold = np.where(has_next, 0.0, final)
    model = None
    for _ in range(iters):
        nxt_sell = np.append(sell[1:], 0.0); nxt_hold = np.append(q_hold[1:], 0.0)
        target = np.where(has_next, np.maximum(nxt_sell, nxt_hold), final)
        model = HistGradientBoostingRegressor(max_iter=200, max_depth=4, learning_rate=0.08, random_state=0).fit(X, target)
        q_hold = model.predict(X)
    return model

def summary(pnls):
    a = np.array([x for x in pnls if x is not None])
    if not len(a): return {'trades': 0}
    boot = [np.random.default_rng(i).choice(a, len(a)).mean() for i in range(300)]
    return {'trades': int(len(a)), 'avg_pct': round(float(a.mean()), 2), 'median_pct': round(float(np.median(a)), 2), 'win_rate': round(float((a > 0).mean()), 3),
            'total_usd_on_2': round(float(a.sum() * 0.02), 2), 'avg_ci95': [round(float(np.percentile(boot, 2.5)), 2), round(float(np.percentile(boot, 97.5)), 2)]}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True); ap.add_argument('--out', required=True); ap.add_argument('--min_traded', type=int, default=20); ap.add_argument('--step', type=int, default=2); ap.add_argument('--latency', type=int, default=2)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    global LATENCY_S; LATENCY_S = a.latency
    from sklearn.ensemble import GradientBoostingClassifier
    t0 = time.time(); tokens = load(a.db, a.min_traded)
    for t in tokens: t['entry'] = entry_of(t)
    n = len(tokens); tr, va, te = tokens[:int(n * .7)], tokens[int(n * .7):int(n * .85)], tokens[int(n * .85):]
    Xtr, ytr = dataset(tr, a.step)
    cfg = {'db_tokens': n, 'traded_entries': {k: sum(1 for t in g if t['entry'] is not None) for k, g in (('train', tr), ('val', va), ('test', te))}, 'train_rows': int(len(Xtr)), 'positive_rate': round(float(ytr.mean()), 3),
           'features': FEATURES, 'label': 'target exit v3: winner = earliest fill within 10 percentage points of the peak and positive (hold before, sell from it); latency-gap winner = best fill; loser = sell at once', 'cost_per_side': COST, 'first_sight_s': FIRST_SIGHT_S, 'latency_s': a.latency,
           'test_launch_range': [te[0]['created'], te[-1]['created']] if te else None, 'model': 'GradientBoostingClassifier(n_estimators=150,max_depth=3,lr=0.1,subsample=0.8)'}
    try: cfg['git_sha'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    except Exception: pass
    cfg['config_sha256'] = hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:16]
    print(json.dumps(cfg), flush=True)
    model = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.1, subsample=0.8, random_state=0).fit(Xtr, ytr)
    print(f'imitation model trained in {time.time() - t0:.0f}s', flush=True)
    class Batched:
        def __init__(self, fn): self.fn = fn
        def __call__(self, t, e, s): return bool(self.fn(t, e, np.array([s]))[0])
        def batch(self, t, e, secs): return self.fn(t, e, secs)
    def feats(t, e, secs): return np.array([features(t, e, int(x)) for x in secs], dtype=np.float32)
    Xr, sell_r, next_r, final_r = rl_transitions(tr, a.step)
    q_model = fit_q_hold(Xr, sell_r, next_r, final_r)
    print(f'RL (fitted Q-iteration) trained in {time.time() - t0:.0f}s on {len(Xr)} transitions', flush=True)
    def rl_policy(margin):
        # sell when selling now (after latency and costs) is worth at least the learned value of holding, minus a margin
        def fn(t, e, secs):
            end = min(720, e + HOLD_S); sell_now = net(t['p'][e], t['p'][np.minimum(secs + LATENCY_S, end)])
            return sell_now >= q_model.predict(feats(t, e, secs)) - margin
        return Batched(fn)
    def model_policy(th):
        return Batched(lambda t, e, secs: (model.predict_proba(feats(t, e, secs))[:, 1] >= th) | (t['p'][secs] / t['p'][e] - 1 <= -0.25))
    # choose the sell threshold on validation only (average P&L per trade)
    val_scores = {th: summary([simulate(t, model_policy(th)) for t in va]) for th in (0.5, 0.6, 0.7, 0.8, 0.9)}
    th = max(val_scores, key=lambda k: val_scores[k].get('avg_pct', -1e9))
    rl_val = {m: summary([simulate(t, rl_policy(m)) for t in va]) for m in (0.0, 2.0, 5.0)}
    margin = max(rl_val, key=lambda k: rl_val[k].get('avg_pct', -1e9))
    def filtered(g): return [t for t in g if t['tags'][0] or t['tags'][1]]
    def peak_of(t):
        e = t['entry']; end = min(720, e + HOLD_S); k = e + 1 + int(np.argmax(t['p'][e + 1:end + 1])); return k, min(k + LATENCY_S, end)
    oracle = lambda t: None if t.get('entry') is None else net(t['p'][t['entry']], t['p'][peak_of(t)[1]])
    res = {}
    for name, g in (('all_tokens', te), ('filtered_fee_or_mayhem', filtered(te))):
        res[name] = {'rl_q_learning': summary([simulate(t, rl_policy(margin)) for t in g]), 'imitation_model': summary([simulate(t, model_policy(th)) for t in g]), 'rule_v2_take30': summary([simulate(t, rule_v2) for t in g]),
                     'rule_take50_120s': summary([simulate(t, lambda t, e, s: rule_v2(t, e, s, take=50, window=120)) for t in g]),
                     'hold_10min': summary([simulate(t, lambda t, e, s: False) for t in g]), 'hindsight_high_with_latency': summary([oracle(t) for t in g])}
    imp = sorted(zip(FEATURES, model.feature_importances_.round(3).tolist()), key=lambda x: -x[1])
    out = {'config': cfg, 'threshold_chosen_on_validation': th, 'validation': val_scores, 'rl_margin_chosen_on_validation': margin, 'rl_validation': rl_val, 'test': res, 'feature_importance': imp}
    json.dump(out, open(os.path.join(a.out, 'results.json'), 'w'), indent=1, default=str)
    import pickle; pickle.dump(model, open(os.path.join(a.out, 'model.pkl'), 'wb')); pickle.dump(q_model, open(os.path.join(a.out, 'rl_q_hold.pkl'), 'wb'))
    print(json.dumps({'threshold': th, 'rl_margin': margin, 'test': res, 'feature_importance': imp[:8]}, indent=1), flush=True)
    write_excel(os.path.join(a.out, 'exit_policy_review.xlsx'), te, model, th, res, cfg, imp, peak_of, model_policy, rl_policy(margin))

def write_excel(path, tokens, model, th, res, cfg, imp, peak_of, model_policy, rl_pol):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    wb = Workbook(); bold = Font(bold=True); head = PatternFill('solid', fgColor='DDEBF7')
    def sheet(ws, header, rows):
        ws.append(header)
        for c in ws[1]: c.font = bold; c.fill = head
        for r in rows: ws.append(r)
        ws.freeze_panes = 'A2'
        for col in ws.columns: ws.column_dimensions[col[0].column_letter].width = max(10, min(40, max(len(str(c.value or '')) for c in col) + 2))
    ws = wb.active; ws.title = 'Summary'
    rows = [[f'Test set = newest {len(tokens)} tokens (launched after all training tokens). Latency {LATENCY_S}s on every fill; 1.25% fee + 2% slippage per side; $2 per trade.'], [],
            ['Group', 'Strategy', 'Trades', 'Avg P&L %', 'Median %', 'Win rate', 'Total $ on $2', 'Avg 95% range']]
    for g, strat in res.items():
        for k, v in strat.items(): rows.append([g, k, v.get('trades'), v.get('avg_pct'), v.get('median_pct'), v.get('win_rate'), v.get('total_usd_on_2'), str(v.get('avg_ci95'))])
    rows += [[], ['Model sell threshold (chosen on validation)', th], ['Config hash', cfg.get('config_sha256')], ['Label', cfg['label']], [], ['Feature', 'Importance']] + [[f, w] for f, w in imp]
    for r in rows: ws.append(r)
    for c in ws[3]: c.font = bold; c.fill = head
    per, secs = [], []
    for t in tokens:
        e = t.get('entry')
        if e is None: continue
        p = t['p']; end = min(720, e + HOLD_S); k, kf = peak_of(t)
        md, mf, mp = simulate(t, model_policy(th), detail=True); rd, rf, rp = simulate(t, rule_v2, detail=True); qd, qf, qp = simulate(t, rl_pol, detail=True)
        fd, ff, fp = simulate(t, lambda t, e, s: rule_v2(t, e, s, take=50, window=120), detail=True)
        tags = ', '.join(n for n, on in zip(('fee-routed', 'mayhem', 'terminal'), t['tags']) if on) or 'website'
        per.append([t['name'], t['mint'], time.strftime('%H:%M:%S', time.localtime(t['created'] / 1000)), tags, e, p[e],
                    k, p[k], round((p[k] / p[e] - 1) * 100, 1), kf, p[kf], round(net(p[e], p[kf]), 1),
                    qd, qf, p[qf], round(qp, 1), round((p[qf] / p[k] - 1) * 100, 1), md, mf, p[mf], round(mp, 1), round((p[mf] / p[k] - 1) * 100, 1),
                    rd, rf, round(rp, 1), fd, ff, round(fp, 1), round(net(p[e], p[end]), 1)])
        for s_ in range(e + 1, end, 5):
            pr = float(model.predict_proba(np.array([features(t, e, s_)], dtype=np.float32))[0, 1])
            secs.append([t['name'], t['mint'], s_, p[s_], round((p[s_] / p[e] - 1) * 100, 2), label(t, s_, end), round(pr, 3), 'SELL' if pr >= th else '', 'HIGH' if s_ <= k < s_ + 5 else ''])
    sheet(wb.create_sheet('Per token'), ['Token', 'Mint', 'Launched', 'Launch type', 'Entry sec after launch', 'Entry price',
        'Hindsight HIGH sec', 'HIGH price', 'HIGH % vs entry', 'Fill sec if sold at high (+latency)', 'Fill price', 'Best realistic P&L % (after costs)',
        'RL decided sec', 'RL fill sec', 'RL fill price', 'RL P&L %', 'RL fill vs HIGH %', 'Imitation decided sec', 'Imitation fill sec', 'Imitation fill price', 'Imitation P&L %', 'Imitation fill vs HIGH %',
        'Rule v2 decided sec', 'Rule v2 fill sec', 'Rule v2 P&L %', '+50% rule decided sec', '+50% rule fill sec', '+50% rule P&L %', 'Hold 10 min P&L %'], per)
    sheet(wb.create_sheet('Every 5 seconds'), ['Token', 'Mint', 'Sec after launch', 'Price', '% vs entry', 'Label: sell was right (1) / hold (0)', 'Model sell probability', 'Model says', 'Hindsight high in this 5s'], secs)
    ws = wb.create_sheet('How to read')
    for r in [['Hindsight HIGH = the highest price between entry and the 10-minute exit: where we wanted to sell.'], [f'Every sale is filled {LATENCY_S} seconds after the decision, at that later price (realistic delay).'],
              ['Label = 1 when selling at that second was right: the price never rose more than 10% above it afterwards, or it fell 25% within 60 s without first rising 20%.'],
              ['The model only sees what was known at that second (price so far, momentum, volatility, trading activity, launch type). It never sees the future.'],
              ['RL (fitted Q-learning): reward = realized P&L after the delay and costs; it sells when selling now beats its learned value of holding.'], ['Imitation: copies the hindsight labels (sell was right / hold).'],
              ['Fill vs HIGH % shows how close each method sold to the top (0% = exactly at the high).']]: ws.append(r)
    wb.save(path)

if __name__ == '__main__':
    main()
