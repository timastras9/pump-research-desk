"""Is the mayhem edge real? (Astras found +9.4% per paper trade on 15 live mayhem trades vs -10.9% on the rest.)

Scope (no look-ahead, one accounting engine):
  * Data: artifacts/corpus/launches.db, launches with 1 s candles, anomalies removed (research/engine.py).
  * Trades: research/engine.py only - decision at second t fills at t+2 s, 3.25% cost per side, rules v3 exits,
    forced exit 10 min after entry. Features/filters use data up to the decision second only.
  * Entry A: the model's standard entry (first trade after first sight, no chase) = engine.buy_decision_time.
  * Entry B: decide at 30 s (Tim's idea), only if the token traded in the 10 s before.
  * Groups: mayhem = 1 vs mayhem = 0 (a launch fact known at creation, so not look-ahead).
  * Honesty: bootstrap 95% CI of the mean, Wilson 95% CI of the win rate, older vs newer half (chronological),
    and the mayhem-minus-rest difference with its own bootstrap CI.
Usage: PYTHONPATH=. python data-analysis/mayhem_test.py artifacts/corpus/launches.db
"""
import math
import sys

import numpy as np

from research import engine as E

rng = np.random.default_rng(0)
eps = sorted((e for e in E.load_episodes(sys.argv[1], min_traded=1) if not e.anomaly), key=lambda e: e.created)
print(f"{len(eps)} launches (anomalies removed); mayhem {sum(e.tags['mayhem'] for e in eps)}")


def boot_ci(x, n=4000):
    if len(x) < 2: return (float('nan'), float('nan'))
    m = rng.choice(x, (n, len(x))).mean(axis=1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def wilson(k, n, z=1.96):
    if not n: return (float('nan'), float('nan'))
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d * 100, (c + h) / d * 100


def row(name, r):
    r = np.array(r)
    if not len(r): print(f"  {name:28s} no trades"); return
    lo, hi = boot_ci(r); wl, wh = wilson(int((r > 0).sum()), len(r))
    print(f"  {name:28s} n={len(r):5d}  avg {r.mean():6.1f}% [{lo:6.1f}, {hi:6.1f}]  win {(r > 0).mean()*100:4.0f}% [{wl:3.0f}-{wh:3.0f}]  "
          f"< -30%: {(r < -30).mean()*100:3.0f}%  $2 trades: {r.sum()*0.02:+8.2f}")


def entry_a(ep): return E.buy_decision_time(ep)
def entry_b(ep): return 30 if (ep.volume[21:31] > 0).any() else None


rules = E.rules_v3()
for label, entry in (("A: model's standard entry", entry_a), ("B: decide at 30 s", entry_b)):
    trades = []   # (created, mayhem, net %)
    for ep in eps:
        d = entry(ep)
        if d is None: continue
        trades.append((ep.created, ep.tags['mayhem'], E.simulate(ep, rules, decision_t=d).net_return_pct()))
    print(f"\n{label}: {len(trades)} trades")
    half = len(trades) // 2
    for part, sl in (("all", slice(None)), ("older half", slice(0, half)), ("newer half", slice(half, None))):
        t = trades[sl]
        may = [r for _, m, r in t if m]; rest = [r for _, m, r in t if not m]
        print(f" {part}")
        row("mayhem", may); row("not mayhem", rest)
        if len(may) > 1 and len(rest) > 1:
            diff = [rng.choice(may, len(may)).mean() - rng.choice(rest, len(rest)).mean() for _ in range(4000)]
            print(f"  {'mayhem minus rest':28s} {np.mean(may) - np.mean(rest):+6.1f} pts [{np.percentile(diff, 2.5):+.1f}, {np.percentile(diff, 97.5):+.1f}]")
