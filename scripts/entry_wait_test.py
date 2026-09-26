#!/usr/bin/env python3
"""Does waiting before buying avoid losers? Re-run every launch with first sight at W seconds after launch, buy on
the first trade after that (filled after the latency, same no-chase rule), and score with the v3 target exit.

  python scripts/entry_wait_test.py --db artifacts/corpus/launches.db
"""
import argparse, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import train_exit_policy as tp

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out', default=None); a = ap.parse_args()
    tokens = tp.load(a.db, 20); rows = []
    print(f"{'wait before buy':>15} {'bought':>7} {'losers':>13} {'winners':>8} {'avg best P&L':>12} {'avg target P&L':>14} {'avg loser loss':>14} {'losers worse than -30%':>22} {'sum target P&L pts':>18}")
    for W in (5, 10, 15, 20, 30, 45, 60):
        tp.FIRST_SIGHT_S = W
        bought = losers = worse30 = 0; best, target, loss = [], [], []
        for t in tokens:
            t['entry'] = tp.entry_of(t)
            if t['entry'] is None: continue
            zone, k, kind = tp.target_exit(t); p = t['p']; e = t['entry']; end = min(720, e + tp.HOLD_S)
            b = tp.net(p[e], p[min(k + tp.LATENCY_S, end)]); tg = tp.net(p[e], p[min(zone + tp.LATENCY_S, end)])
            bought += 1; best.append(b); target.append(tg if kind != 'loser' else b)
            if kind == 'loser': losers += 1; loss.append(b); worse30 += b <= -30
        r = dict(wait_s=W, bought=bought, losers=losers, loser_share=round(losers / bought, 3), avg_best=round(float(np.mean(best)), 1), avg_target=round(float(np.mean(target)), 1),
                 avg_loser_loss=round(float(np.mean(loss)), 1), losers_worse_30=int(worse30), sum_target=round(float(np.sum(target)), 0))
        rows.append(r)
        print(f"{str(W)+' s':>15} {bought:>7} {losers:>6} ({r['loser_share']*100:4.1f}%) {bought-losers:>8} {r['avg_best']:>11}% {r['avg_target']:>13}% {r['avg_loser_loss']:>13}% {worse30:>22} {r['sum_target']:>18}")
    if a.out: json.dump(rows, open(a.out, 'w'), indent=1)

if __name__ == '__main__':
    main()
