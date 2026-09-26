"""Summary for data-analysis/sql/when_do_pumps_happen.sql.

Question: should we wait 60 s after launch before buying?
Input:  the CSV that the SQL writes (one row per token).
Usage:  python data-analysis/when_do_pumps_happen.py pumps.csv
"""
import sys

import pandas as pd

d = pd.read_csv(sys.argv[1])
K = (1 - 0.0325) / (1 + 0.0325)  # round trip after 3.25% cost per side (research/engine.py)

d["peak_pct"] = (d.peak_high / d.p0 - 1) * 100  # peak gain from launch price
d["alive60"] = d.last_sec > 62  # still trading after our 62 s fill
n = len(d)
print("tokens", n, "| no trades after 62s:", (~d.alive60).sum(), f"({(~d.alive60).mean()*100:.0f}%)")

# 1) When does the peak happen? Share of all tokens by peak second.
bins = [-1, 5, 10, 30, 60, 120, 300, 720]
print("\nPEAK TIME (all tokens, % of tokens):")
print((pd.cut(d.peak_sec, bins).value_counts(sort=False) / n * 100).round(1).to_string())

# 2) For real pumps (+50/+100/+300% from launch): how many peak in minute 1,
#    and how much of the move is still available after a 62 s entry?
for th in [50, 100, 300]:
    s = d[d.peak_pct >= th]
    print(f"\npeak >= +{th}% : {len(s)} tokens; peak within 60s: {(s.peak_sec <= 60).mean()*100:.0f}%; "
          f"median peak sec {s.peak_sec.median():.0f}")
    print("   median gain still available after 62s entry:", f"{((s.max_after / s.p62 - 1) * 100).median():.0f}%")

# 3) The strategy itself: buy at 62 s (tokens still trading), after costs.
a = d[d.alive60].copy()
a["hold"] = (a.p600 / a.p62 * K - 1) * 100  # hold to 10 minutes
a["ceiling"] = (a.max_after / a.p62 * K - 1) * 100  # perfect exit in hindsight (upper bound)
a["up60"] = (a.p62 / a.p0 - 1) * 100  # how far it had already moved when we buy


def line(x, name):
    print(f"{name:45s} n={len(x):5d} avg {x.mean():7.1f}%  median {x.median():6.1f}%  win {(x > 0).mean()*100:4.0f}%")


print("\nBUY AT 62s (tokens still trading), after 6.5% round-trip costs:")
line(a.hold, "hold to 10 min")
line(a.ceiling, "perfect exit (hindsight ceiling)")
print("share whose perfect exit is < +10%:", f"{(a.ceiling < 10).mean()*100:.0f}%")

# 4) Split by the move before entry: does "already up at 60 s" help?
for lo, hi in [(-100, 0), (0, 50), (50, 200), (200, 1e9)]:
    x = a[(a.up60 > lo) & (a.up60 <= hi)]
    line(x.hold, f"hold, if move by 62s was {lo}..{hi:g}%")
    line(x.ceiling, "   ceiling, same group")
