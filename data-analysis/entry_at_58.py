"""Tim's entry idea (2026-09-26): start watching at 50 s, buy at 58 s if the coin is trending up, fill at 60 s (2 s latency).

Uses research/engine.py for every number (delayed fills, 3.25% cost per side, 10-minute forced exit).
Usage: python data-analysis/entry_at_58.py artifacts/corpus/launches.db
"""
import sys

import numpy as np

from research import engine as E

WATCH_S, DECIDE_S = 50, 58  # start watching at 50 s, decide at 58 s (fills at 60 s)

eps = [e for e in E.load_episodes(sys.argv[1], min_traded=1) if not e.anomaly]
print(f"{len(eps)} launches (anomalies removed)")


def traded_between(ep, a, b):  # seconds with volume in (a, b]: is anyone still trading?
    return int((ep.volume[a + 1:b + 1] > 0).sum())


# Entry filters, all using only data up to 58 s.
FILTERS = {
    "every token still trading 50-58 s": lambda ep, p: traded_between(ep, WATCH_S, DECIDE_S) > 0,
    "trending up: price 58 s > 50 s": lambda ep, p: p[DECIDE_S] > p[WATCH_S],
    "trending up + above launch price": lambda ep, p: p[DECIDE_S] > p[WATCH_S] and p[DECIDE_S] > p[0],
    "trending up + above launch + 3+ active secs": lambda ep, p: p[DECIDE_S] > p[WATCH_S] and p[DECIDE_S] > p[0] and traded_between(ep, WATCH_S, DECIDE_S) >= 3,
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
        rets = [E.simulate(ep, policy, decision_t=DECIDE_S).net_return_pct() for ep in picked]
        line(xname, rets)
        half = len(picked) // 2  # older half vs newer half: does it hold up over time?
        if xname == "rules v3" and half:
            line("  older half", rets[:half]); line("  newer half", rets[half:])
