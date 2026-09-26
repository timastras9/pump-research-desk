#!/usr/bin/env python3
"""Wait W seconds, read the entry KPIs, and only buy if a model trained on older launches says 'not a loser'.
Split by launch time (oldest 70% train, newest 30% test). Reports test-set results with and without the filter.

  python scripts/entry_filter_test.py --db artifacts/corpus/launches.db
"""
import argparse, collections, json, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import train_exit_policy as tp

def kpis(t, d, names):
    p, v = t['p'], t['v']; lp = np.log(p); r = np.diff(lp[:d + 1]); first = next((i for i in range(1, d + 1) if p[i] != p[0]), None)
    return [d, (p[d] / p[0] - 1) * 100, float((v[:d + 1] > 0).sum()), float((v[:d + 1] > 0).mean()), math.log1p(v[:d + 1].sum()),
            (v[max(0, d - 4):d + 1].sum() + 1) / (v[:max(1, d - 4)].sum() / max(1, d - 4) * 5 + 1), float(r.std() * 100) if len(r) > 1 else 0.0,
            (p[:d + 1].max() / p[0] - 1) * 100, (p[d] / p[:d + 1].max() - 1) * 100, int(first is not None and p[first] > p[0]),
            (p[d] / p[max(0, d - 5)] - 1) * 100, (p[d] / p[max(0, d - 10)] - 1) * 100, *[float(x) for x in t['tags']], int(names[(t['name'] or '').strip().lower()] > 1)]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out'); a = ap.parse_args()
    from sklearn.ensemble import HistGradientBoostingClassifier
    tokens = tp.load(a.db, 20); names = collections.Counter((t['name'] or '').strip().lower() for t in tokens)
    results = []
    print(f"{'wait':>5} | {'test bought':>11} {'losers':>7} {'P&L pts':>9} | {'with filter: bought':>19} {'losers':>7} {'winners kept':>12} {'P&L pts':>9} {'avg/trade':>9} | {'no-filter avg/trade':>19}")
    for W in (5, 10, 15, 20, 30):
        tp.FIRST_SIGHT_S = W; data = []
        for t in tokens:
            t['entry'] = tp.entry_of(t)
            if t['entry'] is None: continue
            zone, k, kind = tp.target_exit(t); p = t['p']; e = t['entry']; end = min(720, e + tp.HOLD_S)
            pnl = tp.net(p[e], p[min((zone if kind != 'loser' else k) + tp.LATENCY_S, end)])
            data.append((kpis(t, e - tp.LATENCY_S, names), int(kind == 'loser'), pnl))
        X = np.array([d[0] for d in data]); y = np.array([d[1] for d in data]); pnl = np.array([d[2] for d in data]); cut = int(len(X) * 0.7)
        m = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.06, random_state=0).fit(X[:cut], y[:cut])
        pr = m.predict_proba(X[cut:])[:, 1]; yt, pt = y[cut:], pnl[cut:]
        # threshold chosen on the last 20% of TRAIN (never on test): maximise summed P&L of the trades kept
        v0 = int(cut * 0.8); mv = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.06, random_state=0).fit(X[:v0], y[:v0]); pv = mv.predict_proba(X[v0:cut])[:, 1]
        th = max((0.3, 0.4, 0.5, 0.6, 0.7), key=lambda h: pnl[v0:cut][pv < h].sum())
        keep = pr < th
        r = dict(wait_s=W, threshold=th, test_bought=int(len(yt)), test_losers=int(yt.sum()), test_pnl_pts=round(float(pt.sum())), filt_bought=int(keep.sum()), filt_losers=int(yt[keep].sum()),
                 filt_winners=int((1 - yt[keep]).sum()), winners_total=int((1 - yt).sum()), filt_pnl_pts=round(float(pt[keep].sum())), filt_avg=round(float(pt[keep].mean()), 1) if keep.any() else None, nofilt_avg=round(float(pt.mean()), 1))
        results.append(r)
        print(f"{str(W)+'s':>5} | {r['test_bought']:>11} {r['test_losers']:>7} {r['test_pnl_pts']:>9} | {r['filt_bought']:>19} {r['filt_losers']:>7} {str(r['filt_winners'])+'/'+str(r['winners_total']):>12} {r['filt_pnl_pts']:>9} {str(r['filt_avg'])+'%':>9} | {str(r['nofilt_avg'])+'%':>19}")
    if a.out: json.dump(results, open(a.out, 'w'), indent=1)

if __name__ == '__main__':
    main()
