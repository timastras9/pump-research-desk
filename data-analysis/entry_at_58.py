"""Tim's entry ideas (2026-09-26), tested on the corpus with research/engine.py
(delayed fills, 3.25% cost per side, 10-minute forced exit).

  1) watch from 50 s, buy at 58 s if trending up, fill at 60 s:   --watch 50 --decide 58
  2) no buys before 30 s; a token losing at 30 s will likely fail:  --watch 20 --decide 30

Usage: PYTHONPATH=. python data-analysis/entry_at_58.py artifacts/corpus/launches.db [--watch 50 --decide 58]
"""
import argparse

import numpy as np

from research import engine as E

ap = argparse.ArgumentParser(); ap.add_argument("db"); ap.add_argument("--watch", type=int, default=50); ap.add_argument("--decide", type=int, default=58)
a = ap.parse_args()
W, D = a.watch, a.decide  # trend window start and decision second (fill at D + 2)

eps = [e for e in E.load_episodes(a.db, min_traded=1) if not e.anomaly]
print(f"{len(eps)} launches (anomalies removed) · watch {W} s · decide {D} s · fill {D + E.LATENCY_S} s")


def traded_between(ep, lo, hi):  # seconds with volume in (lo, hi]: is anyone still trading?
    return int((ep.volume[lo + 1:hi + 1] > 0).sum())


# Is "losing at the decision second" a failure signal? Final (10 min) vs the price at the decision second.
alive = [ep for ep in eps if traded_between(ep, 0, D) > 0]
for name, grp in (("losing at decision (below launch)", [e for e in alive if e.price[D] < e.price[0]]),
                  ("not losing at decision", [e for e in alive if e.price[D] >= e.price[0]])):
    later = np.array([(e.price[min(E.WINDOW_S, D + 600)] / e.price[D] - 1) * 100 for e in grp])
    up = np.array([(e.price[D + 1:].max() / e.price[D] - 1) * 100 for e in grp])
    print(f"{name:36s} n={len(grp):5d}  ends higher than at {D} s: {(later > 0).mean()*100:3.0f}%  "
          f"ever +30% above it: {(up >= 30).mean()*100:3.0f}%  median end {np.median(later):6.1f}%")

# Entry filters, all using only data up to the decision second.
FILTERS = {
    f"every token still trading {W}-{D} s": lambda ep, p: traded_between(ep, W, D) > 0,
    f"not losing: price {D} s >= launch": lambda ep, p: traded_between(ep, W, D) > 0 and p[D] >= p[0],
    f"trending up: price {D} s > {W} s": lambda ep, p: p[D] > p[W],
    "trending up + above launch price": lambda ep, p: p[D] > p[W] and p[D] > p[0],
    "trending up + above launch + 3+ active secs": lambda ep, p: p[D] > p[W] and p[D] > p[0] and traded_between(ep, W, D) >= 3,
}
EXITS = {"rules v3": E.rules_v3(), "hold 10 min": E.hold_policy}


def line(name, r):
    r = np.array(r)
    if not len(r):
        print(f"  {name:22s} no trades"); return
    print(f"  {name:22s} n={len(r):5d} avg {r.mean():6.1f}%  median {np.median(r):6.1f}%  win {(r > 0).mean()*100:3.0f}%  "
          f"worse than -30%: {(r < -30).mean()*100:3.0f}%  $ per $2 trade total {r.sum()*0.02:+8.2f}")


for fname, keep in FILTERS.items():
    picked = [ep for ep in eps if keep(ep, ep.price)]
    print(f"\n{fname}: {len(picked)} buys ({len(picked)/len(eps)*100:.0f}% of launches)")
    for xname, policy in EXITS.items():
        rets = [E.simulate(ep, policy, decision_t=D).net_return_pct() for ep in picked]
        line(xname, rets)
        half = len(picked) // 2  # older half vs newer half: does it hold up over time?
        if xname == "rules v3" and half:
            line("  older half", rets[:half]); line("  newer half", rets[half:])
