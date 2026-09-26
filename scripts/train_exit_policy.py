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

def dataset(tokens, step):
    X, y = [], []
    for t in tokens:
        e = t.get('entry')
        if e is None: continue
        end = min(720, e + HOLD_S)
        for s in range(e + 1, end, step): X.append(features(t, e, s)); y.append(label(t, s, end))
    return np.array(X, dtype=np.float32), np.array(y)

net = lambda e, x: ((x * (1 - COST)) / (e * (1 + COST)) - 1) * 100

def simulate(t, policy, detail=False):
    e = t.get('entry')
    if e is None: return None
    p = t['p']; end = min(720, e + HOLD_S)
    for s in range(e + 1, end):
        if policy(t, e, s):
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
           'features': FEATURES, 'label': 'sell-right if rest-of-window max <= +10% from here, or next-60s min <= -25% before +20%', 'cost_per_side': COST, 'first_sight_s': FIRST_SIGHT_S, 'latency_s': a.latency,
           'test_launch_range': [te[0]['created'], te[-1]['created']] if te else None, 'model': 'GradientBoostingClassifier(n_estimators=150,max_depth=3,lr=0.1,subsample=0.8)'}
    try: cfg['git_sha'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    except Exception: pass
    cfg['config_sha256'] = hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:16]
    print(json.dumps(cfg), flush=True)
    model = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.1, subsample=0.8, random_state=0).fit(Xtr, ytr)
    print(f'trained in {time.time() - t0:.0f}s', flush=True)
    def model_policy(th):
        return lambda t, e, s: model.predict_proba(np.array([features(t, e, s)], dtype=np.float32))[0, 1] >= th or (t['p'][s] / t['p'][e] - 1) <= -0.25
    # choose the sell threshold on validation only (average P&L per trade)
    val_scores = {th: summary([simulate(t, model_policy(th)) for t in va]) for th in (0.5, 0.6, 0.7, 0.8, 0.9)}
    th = max(val_scores, key=lambda k: val_scores[k].get('avg_pct', -1e9))
    def filtered(g): return [t for t in g if t['tags'][0] or t['tags'][1]]
    def peak_of(t):
        e = t['entry']; end = min(720, e + HOLD_S); k = e + 1 + int(np.argmax(t['p'][e + 1:end + 1])); return k, min(k + LATENCY_S, end)
    oracle = lambda t: None if t.get('entry') is None else net(t['p'][t['entry']], t['p'][peak_of(t)[1]])
    res = {}
    for name, g in (('all_tokens', te), ('filtered_fee_or_mayhem', filtered(te))):
        res[name] = {'model': summary([simulate(t, model_policy(th)) for t in g]), 'rule_v2_take30': summary([simulate(t, rule_v2) for t in g]),
                     'rule_take50_120s': summary([simulate(t, lambda t, e, s: rule_v2(t, e, s, take=50, window=120)) for t in g]),
                     'hold_10min': summary([simulate(t, lambda t, e, s: False) for t in g]), 'hindsight_high_with_latency': summary([oracle(t) for t in g])}
    imp = sorted(zip(FEATURES, model.feature_importances_.round(3).tolist()), key=lambda x: -x[1])
    out = {'config': cfg, 'threshold_chosen_on_validation': th, 'validation': val_scores, 'test': res, 'feature_importance': imp}
    json.dump(out, open(os.path.join(a.out, 'results.json'), 'w'), indent=1, default=str)
    import pickle; pickle.dump(model, open(os.path.join(a.out, 'model.pkl'), 'wb'))
    print(json.dumps({'threshold': th, 'test': res, 'feature_importance': imp[:8]}, indent=1), flush=True)
    write_excel(os.path.join(a.out, 'exit_policy_review.xlsx'), te, model, th, res, cfg, imp, peak_of, model_policy)

def write_excel(path, tokens, model, th, res, cfg, imp, peak_of, model_policy):
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
        md, mf, mp = simulate(t, model_policy(th), detail=True); rd, rf, rp = simulate(t, rule_v2, detail=True)
        fd, ff, fp = simulate(t, lambda t, e, s: rule_v2(t, e, s, take=50, window=120), detail=True)
        tags = ', '.join(n for n, on in zip(('fee-routed', 'mayhem', 'terminal'), t['tags']) if on) or 'website'
        per.append([t['name'], t['mint'], time.strftime('%H:%M:%S', time.localtime(t['created'] / 1000)), tags, e, p[e],
                    k, p[k], round((p[k] / p[e] - 1) * 100, 1), kf, p[kf], round(net(p[e], p[kf]), 1),
                    md, mf, p[mf], round(mp, 1), round((p[mf] / p[k] - 1) * 100, 1),
                    rd, rf, round(rp, 1), fd, ff, round(fp, 1), round(net(p[e], p[end]), 1)])
        for s_ in range(e + 1, end, 5):
            pr = float(model.predict_proba(np.array([features(t, e, s_)], dtype=np.float32))[0, 1])
            secs.append([t['name'], t['mint'], s_, p[s_], round((p[s_] / p[e] - 1) * 100, 2), label(t, s_, end), round(pr, 3), 'SELL' if pr >= th else '', 'HIGH' if s_ <= k < s_ + 5 else ''])
    sheet(wb.create_sheet('Per token'), ['Token', 'Mint', 'Launched', 'Launch type', 'Entry sec after launch', 'Entry price',
        'Hindsight HIGH sec', 'HIGH price', 'HIGH % vs entry', 'Fill sec if sold at high (+latency)', 'Fill price', 'Best realistic P&L % (after costs)',
        'Model decided sec', 'Model fill sec', 'Model fill price', 'Model P&L %', 'Model fill vs HIGH %',
        'Rule v2 decided sec', 'Rule v2 fill sec', 'Rule v2 P&L %', '+50% rule decided sec', '+50% rule fill sec', '+50% rule P&L %', 'Hold 10 min P&L %'], per)
    sheet(wb.create_sheet('Every 5 seconds'), ['Token', 'Mint', 'Sec after launch', 'Price', '% vs entry', 'Label: sell was right (1) / hold (0)', 'Model sell probability', 'Model says', 'Hindsight high in this 5s'], secs)
    ws = wb.create_sheet('How to read')
    for r in [['Hindsight HIGH = the highest price between entry and the 10-minute exit: where we wanted to sell.'], [f'Every sale is filled {LATENCY_S} seconds after the decision, at that later price (realistic delay).'],
              ['Label = 1 when selling at that second was right: the price never rose more than 10% above it afterwards, or it fell 25% within 60 s without first rising 20%.'],
              ['The model only sees what was known at that second (price so far, momentum, volatility, trading activity, launch type). It never sees the future.'],
              ['Model fill vs HIGH % shows how close the model sold to the top (0% = sold exactly at the high).']]: ws.append(r)
    wb.save(path)

if __name__ == '__main__':
    main()
