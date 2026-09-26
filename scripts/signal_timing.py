#!/usr/bin/env python3
"""When do launch signals become readable? For checkpoints 5-60 s after launch, score how well each signal known
at that moment predicts the rest of the window: 'runner' (+50% or more above the checkpoint price later) and
'tanker' (ends 50%+ below it). AUC 0.5 = no signal. Also a combined model per checkpoint (train oldest 70%, test newest 30%).

  python scripts/signal_timing.py --db artifacts/corpus/launches.db
"""
import argparse, math, re, sqlite3, json
import numpy as np

CHECKPOINTS = (5, 10, 15, 20, 30, 60)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); a = ap.parse_args()
    from sklearn.metrics import roc_auc_score
    from sklearn.ensemble import HistGradientBoostingClassifier
    db = sqlite3.connect(a.db)
    toks = db.execute("SELECT mint, created_ts, description, image_uri, mayhem, cap_at_seen_usd FROM tokens WHERE candles_status='done' ORDER BY created_ts").fetchall()
    data = []
    for mint, created, desc, img, mayhem, cap in toks:
        p = np.full(721, np.nan); v = np.zeros(721); tr = np.zeros(721)
        for sec, o, h, l, c, vol in db.execute('SELECT sec, open, high, low, close, volume FROM candles WHERE mint=?', (mint,)):
            if c and c > 0: p[sec] = c; v[sec] = vol or 0; tr[sec] = 1
        k = np.where(~np.isnan(p))[0]
        if not len(k): continue
        p[:k[0]] = p[k[0]]
        for i in range(1, 721):
            if np.isnan(p[i]): p[i] = p[i - 1]
        data.append(dict(p=p, v=v, tr=tr, fee=1.0 if re.search(r'fees? to @\w+', desc or '', re.I) else 0.0, mayhem=float(mayhem or 0), terminal=0.0 if (not img or re.search('ipfs|pinata', img)) else 1.0))
    print(f'{len(data)} launches with candles')
    names = ['price change since launch', 'active seconds (trades happening)', 'volume (log)', 'volume last 5s vs before', 'max rise so far', 'drop from high so far', 'volatility', 'fee-routed', 'mayhem', 'terminal launch']
    out = {}
    for T in CHECKPOINTS:
        X, run, tank = [], [], []
        for d in data:
            p, v, tr = d['p'], d['v'], d['tr']; lp = np.log(p)
            fut = p[T + 1:]
            r = np.diff(lp[:T + 1])
            X.append([lp[T] - lp[0], tr[:T + 1].sum(), math.log1p(v[:T + 1].sum()), (v[max(0, T - 4):T + 1].sum() + 1) / (v[:max(1, T - 4)].sum() / max(1, T - 4) * 5 + 1),
                      math.log(p[:T + 1].max() / p[0]), lp[T] - math.log(p[:T + 1].max()), float(r.std()) if len(r) > 1 else 0.0, d['fee'], d['mayhem'], d['terminal']])
            run.append(int(fut.max() >= p[T] * 1.5)); tank.append(int(p[720] <= p[T] * 0.5))
        X = np.array(X); run = np.array(run); tank = np.array(tank)
        row = {'runner_rate': round(float(run.mean()), 3), 'tanker_rate': round(float(tank.mean()), 3), 'signals': {}}
        for j, n in enumerate(names):
            if len(set(X[:, j])) < 2: continue
            ar, at = roc_auc_score(run, X[:, j]), roc_auc_score(tank, X[:, j])
            row['signals'][n] = {'runner_auc': round(max(ar, 1 - ar), 3), 'runner_dir': '+' if ar >= 0.5 else '-', 'tanker_auc': round(max(at, 1 - at), 3), 'tanker_dir': '+' if at >= 0.5 else '-'}
        cut = int(len(X) * 0.7)
        for lab, y in (('runner', run), ('tanker', tank)):
            m = HistGradientBoostingClassifier(max_iter=150, max_depth=3, random_state=0).fit(X[:cut], y[:cut])
            row[f'combined_{lab}_auc_test'] = round(float(roc_auc_score(y[cut:], m.predict_proba(X[cut:])[:, 1])), 3) if len(set(y[cut:])) > 1 else None
        out[T] = row
        top = sorted(row['signals'].items(), key=lambda kv: -max(kv[1]['runner_auc'], kv[1]['tanker_auc']))[:4]
        print(f"\n@{T:2}s after launch · runners {row['runner_rate']*100:.0f}% · tankers {row['tanker_rate']*100:.0f}% · combined model AUC (newest 30%): runner {row['combined_runner_auc_test']} · tanker {row['combined_tanker_auc_test']}")
        for n, s in top: print(f"   {n:36} runner AUC {s['runner_auc']} ({s['runner_dir']}) · tanker AUC {s['tanker_auc']} ({s['tanker_dir']})")
    json.dump(out, open('/Users/tim/Documents/ChatGPT/pump.fun/artifacts/corpus/signal_timing.json', 'w'), indent=1)

if __name__ == '__main__':
    main()
