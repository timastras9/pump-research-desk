"""Every metric at 30 s: which ones separate winners from losers? (Tim, 2026-09-26)

Trade: decide at 30 s, fill at 32 s, sell with rules v3, 3.25% cost per side (research/engine.py).
Winner = that trade made money after costs.
Honesty check: buckets are chosen on the OLDER half of launches and scored on the NEWER half.
Usage: PYTHONPATH=. python data-analysis/metrics_at_30.py artifacts/corpus/launches.db [--decide 30]
"""
import argparse

import numpy as np
from sklearn.metrics import roc_auc_score

from research import engine as E

ap = argparse.ArgumentParser(); ap.add_argument("db"); ap.add_argument("--decide", type=int, default=30); a = ap.parse_args()
D = a.decide

eps = [e for e in E.load_episodes(a.db, min_traded=1) if not e.anomaly]
eps = [e for e in eps if (e.volume[D - 9:D + 1] > 0).any()]  # still trading in the 10 s before the decision
eps.sort(key=lambda e: e.created)


def extra(ep):  # activity in the last 10 s only (the standard features are cumulative since launch)
    f = {}
    if ep.trades is not None:
        tr, lo = ep.trades, D - 9
        f["new_buyers_last10s"] = float(sum(1 for s in tr["first_buy_sec"].values() if lo <= s <= D))
        f["net_sol_last10s"] = float(tr["buy_sol"][lo:D + 1].sum() - tr["sell_sol"][lo:D + 1].sum())
        f["sell_share_last10s"] = float(tr["sell_sol"][lo:D + 1].sum() / max(1e-9, tr["buy_sol"][lo:D + 1].sum() + tr["sell_sol"][lo:D + 1].sum()))
    return f


rules = E.rules_v3()
rows, ret = [], []
for ep in eps:
    f = E.features(ep, D); f.update(extra(ep)); rows.append(f)
    ret.append(E.simulate(ep, rules, decision_t=D).net_return_pct())
ret = np.array(ret); win = ret > 0
half = len(eps) // 2; old, new = np.arange(half), np.arange(half, len(eps))
print(f"{len(eps)} launches trading at {D} s · wallet data on {sum(e.trades is not None for e in eps)} · "
      f"buy-all avg {ret.mean():.1f}%, win {win.mean()*100:.0f}% · older half {ret[old].mean():.1f}% · newer half {ret[new].mean():.1f}%\n")

names = sorted({k for r in rows for k in r} - {"since_launch"})
out = []
for k in names:
    x = np.array([r.get(k, np.nan) for r in rows], dtype=float); ok = ~np.isnan(x)
    o, n = old[ok[old]], new[ok[new]]
    if len(o) < 100 or len(set(x[o])) < 2 or len(set(win[o])) < 2 or len(set(win[n])) < 2:
        continue
    auc_o, auc_n = roc_auc_score(win[o], x[o]), roc_auc_score(win[n], x[n])
    # Quintile cut points from the older half; pick the best bucket there, then score it on the newer half.
    cuts = np.unique(np.quantile(x[o], [0.2, 0.4, 0.6, 0.8]))
    bo, bn = np.digitize(x[o], cuts), np.digitize(x[n], cuts)
    best = max(set(bo), key=lambda b: ret[o][bo == b].mean() if (bo == b).sum() >= 30 else -1e9)
    lo_edge = -np.inf if best == 0 else cuts[best - 1]; hi_edge = np.inf if best == len(cuts) else cuts[best]
    sel_n = ret[n][bn == best]
    out.append((k, auc_o, auc_n, lo_edge, hi_edge, ret[o][bo == best].mean(), len(sel_n), sel_n.mean() if len(sel_n) else np.nan,
                (sel_n > 0).mean() * 100 if len(sel_n) else np.nan, ret[n].mean()))

# Rank by how far the newer-half AUC is from 0.5 (either direction is a signal).
out.sort(key=lambda r: -abs(r[2] - 0.5))
print(f"{'metric':22s} {'AUC old':>7s} {'AUC new':>7s}   best bucket (from older half)   older avg | NEWER: n   avg    win   (newer buy-all)")
for k, ao, an, lo, hi, ro, nn, rn, wn, base in out:
    rng = f"{lo:9.3g} .. {hi:<9.3g}"
    print(f"{k:22s} {ao:7.3f} {an:7.3f}   {rng:30s} {ro:7.1f}% | {nn:5d} {rn:6.1f}% {wn:4.0f}%   ({base:.1f}%)")
