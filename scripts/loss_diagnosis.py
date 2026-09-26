#!/usr/bin/env python3
"""Where do the big losses come from? For every tradable launch (entry after the 2 s buy delay):
  - how fast and how deep the price falls after entry,
  - what the best possible early exit would have been (sell decided at e+1, filled 2 s later),
  - how a fixed stop at each level actually fills after the delay (trigger vs fill gap).

  python scripts/loss_diagnosis.py --db artifacts/corpus/launches.db
"""
import argparse, json, os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from research import engine as E

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out'); a = ap.parse_args()
    eps = [e for e in E.load_episodes(a.db, 20) if not e.anomaly and E.buy_decision_time(e) is not None]
    rows = []
    for ep in eps:
        d = E.buy_decision_time(ep); e = d + E.LATENCY_S; p = ep.price; pe = p[e]; end = min(E.WINDOW_S, e + E.HOLD_S)
        rel = lambda t: (p[t] / pe - 1) * 100
        first_below = next((t - e for t in range(e + 1, end + 1) if p[t] < pe), None)
        min10 = min(rel(t) for t in range(e + 1, min(e + 10, end) + 1)); min30 = min(rel(t) for t in range(e + 1, min(e + 30, end) + 1))
        fastest_exit = rel(min(e + 1 + E.LATENCY_S, end))                     # decide at e+1, fill at e+3
        crash30 = next((t - e for t in range(e + 1, end + 1) if rel(t) <= -30), None)
        rows.append({'first_below_s': first_below, 'min10': min10, 'min30': min30, 'fastest_exit': fastest_exit, 'crash30_s': crash30,
                     'buy_slip': (pe / p[d] - 1) * 100})
    n = len(rows); pct = lambda k, th: np.mean([r[k] <= th for r in rows])
    out = {'launches': n,
           'share_down_30pct_within_10s': round(float(pct('min10', -30)), 3), 'share_down_30pct_within_30s': round(float(pct('min30', -30)), 3),
           'share_fastest_exit_worse_than_-30': round(float(pct('fastest_exit', -30)), 3),
           'median_fastest_exit_gross_pct': round(float(np.median([r['fastest_exit'] for r in rows])), 1),
           'crash30_seconds_after_entry_quartiles': [float(x) for x in np.percentile([r['crash30_s'] for r in rows if r['crash30_s'] is not None], [25, 50, 75])],
           'share_below_entry_within_5s': round(float(np.mean([r['first_below_s'] is not None and r['first_below_s'] <= 5 for r in rows])), 3)}
    # Fixed stop: trigger on the observed price, fill 2 s later. How much worse than the trigger level is the fill?
    stops = {}
    for lvl in (5, 10, 15, 20, 25):
        fills = []
        for ep in eps:
            d = E.buy_decision_time(ep); e = d + E.LATENCY_S; p = ep.price; end = min(E.WINDOW_S, e + E.HOLD_S)
            t = next((t for t in range(e + 1, end) if p[t] <= p[e] * (1 - lvl / 100)), None)
            if t is not None: fills.append((p[min(t + E.LATENCY_S, end)] / p[e] - 1) * 100)
        f = np.array(fills)
        stops[f'-{lvl}%'] = {'triggered_share': round(len(f) / n, 3), 'median_fill_gross': round(float(np.median(f)), 1), 'p10_fill_gross': round(float(np.percentile(f, 10)), 1),
                             'share_fill_worse_than_-30': round(float((f <= -30).mean()), 3)}
    out['fixed_stop_fills'] = stops
    # When the price is below entry in the first 5 s, what happens next?
    early = [r for r in rows if r['first_below_s'] is not None and r['first_below_s'] <= 5]
    out['below_entry_within_5s'] = {'n': len(early), 'share_later_down_30_within_30s': round(float(np.mean([r['min30'] <= -30 for r in early])), 3) if early else None}
    late = [r for r in rows if not (r['first_below_s'] is not None and r['first_below_s'] <= 5)]
    out['not_below_entry_within_5s'] = {'n': len(late), 'share_later_down_30_within_30s': round(float(np.mean([r['min30'] <= -30 for r in late])), 3) if late else None}
    print(json.dumps(out, indent=1))
    if a.out: json.dump(out, open(a.out, 'w'), indent=1)

if __name__ == '__main__':
    main()
