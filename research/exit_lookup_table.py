"""Exit lookup table for DeepSeek: situations at the decision second -> what happened after entry + the best exit plan.

Situation (known at the decision second t, same definition as the live recorder): price change over the 30 s before t,
seconds with a price change in that window (activity), mayhem flag. Entry fills at t+2 s (engine.LATENCY_S).
Per bucket, from the OLDER 70% of launches: after-entry stats (peak, seconds to peak, drop before peak) and the
take-profit / stop / time limit that maximised average net return after costs (3.25% per side, exit fills 2 s after
the trigger). The NEWER 30% scores that plan honestly (test avg). Small buckets fall back to coarser ones.
Output: artifacts/exit-lookup.json (uploaded to R2 rag/exit-lookup.json for the Worker).
Usage: PYTHONPATH=. python -m research.exit_lookup_table --db artifacts/corpus/launches.db [--t 45]
"""
from __future__ import annotations
import argparse, json, os
import numpy as np
from research import engine as E

CHG = [(-1e9, -20, 'down >20%'), (-20, -5, 'down 5-20%'), (-5, 5, 'flat ±5%'), (5, 20, 'up 5-20%'), (20, 50, 'up 20-50%'), (50, 1e9, 'up >50%')]
ACT = [(0, 5, 'quiet (0-5 s active)'), (6, 15, 'active (6-15 s)'), (16, 10**9, 'busy (16+ s)')]
TPS, SLS, TMAX = [5, 10, 15, 20, 30, 50, 100], [5, 10, 15, 25], [60, 180, 600]
C = E.COST_PER_SIDE


def situation(ep, t):
    p, v = ep.price, ep.volume
    chg = (p[t] / p[t - 30] - 1) * 100
    act = int((np.diff(p[t - 30:t + 1]) != 0).sum())   # seconds with a price change (the recorder sees prices, not volume)
    return next(n for lo, hi, n in CHG if lo <= chg < hi), next(n for lo, hi, n in ACT if lo <= act <= hi), bool(ep.tags['mayhem'])


def plan_returns(rel_path, prices, e, TPS=TPS, SLS=SLS, TMAX=TMAX):
    """Net % for every (tp, sl, tmax) plan on one trade; exits fill 2 s after the trigger."""
    out = {}
    for T in TMAX:
        seg = rel_path[:T + 1]
        for tp in TPS:
            hit_tp = np.argmax(seg >= tp) if (seg >= tp).any() else None
            for sl in SLS:
                hit_sl = np.argmax(seg <= -sl) if (seg <= -sl).any() else None
                cands = [h for h in (hit_tp, hit_sl) if h is not None]
                k = min(cands) if cands else min(T, len(seg) - 1)
                fill = prices[min(e + k + E.LATENCY_S, len(prices) - 1)]
                out[(tp, sl, T)] = (fill / prices[e] * (1 - C) / (1 + C) - 1) * 100
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--t', type=int, default=45)
    ap.add_argument('--out', default='artifacts/exit-lookup.json')
    # The window to optimise over (Tim): take-profit %, stop % (positive numbers) and time limits in seconds.
    ap.add_argument('--tp', default=','.join(map(str, TPS)), help='take-profit grid, e.g. 5,10,15,20,30,50,100')
    ap.add_argument('--sl', default=','.join(map(str, SLS)), help='stop grid (positive), e.g. 3,5,10,15,25')
    ap.add_argument('--tmax', default=','.join(map(str, TMAX)), help='time-limit grid in seconds, e.g. 30,60,120,180,600')
    a = ap.parse_args(); t = a.t
    tps, sls, tms = ([float(x) for x in g.split(',')] for g in (a.tp, a.sl, a.tmax)); tms = [int(x) for x in tms]
    eps = sorted((ep for ep in E.load_episodes(a.db, min_traded=1) if not ep.anomaly and (ep.volume[t - 29:t + 1] > 0).any()), key=lambda ep: ep.created)
    rows = []
    for ep in eps:
        e = t + E.LATENCY_S; end = min(E.WINDOW_S, e + E.HOLD_S); pe = ep.price[e]
        rel = (ep.price[e:end + 1] / pe - 1) * 100; k = int(np.argmax(rel))
        rows.append({'key': situation(ep, t), 'peak': rel[k], 'secs': k, 'drop': rel[:k + 1].min(),
                     'v3': E.simulate(ep, E.rules_v3(), decision_t=t).net_return_pct(), 'plans': plan_returns(rel, ep.price, e, tps, sls, tms)})
    cut = int(len(rows) * 0.7); train, test = rows[:cut], rows[cut:]

    def group(sel, keyf):
        g = {}
        for r in sel: g.setdefault(keyf(r['key']), []).append(r)
        return g
    levels = [(lambda k: k, 'change+activity+mayhem'), (lambda k: k[:2], 'change+activity'), (lambda k: k[:1], 'change')]
    table = []
    for keyf, level in levels:
        tr, te = group(train, keyf), group(test, keyf)
        for key, g in tr.items():
            if len(g) < 30: continue
            best = max(g[0]['plans'], key=lambda pl: np.mean([r['plans'][pl] for r in g]))
            tg = te.get(key, [])
            table.append({'level': level, 'change_30s': key[0], 'activity_30s': key[1] if len(key) > 1 else 'any',
                          'mayhem': key[2] if len(key) > 2 else 'any', 'n_train': len(g), 'n_test': len(tg),
                          'median_peak_pct': round(float(np.median([r['peak'] for r in g])), 1),
                          'p75_peak_pct': round(float(np.percentile([r['peak'] for r in g], 75)), 1),
                          'median_secs_to_peak': int(np.median([r['secs'] for r in g])),
                          'median_drop_before_peak_pct': round(float(np.median([r['drop'] for r in g])), 1),
                          'rules_v3_avg_pct': round(float(np.mean([r['v3'] for r in g])), 1),
                          'best_plan': {'take_profit_pct': best[0], 'stop_pct': -best[1], 'time_limit_s': best[2]},
                          'best_plan_train_avg_pct': round(float(np.mean([r['plans'][best] for r in g])), 1),
                          'best_plan_test_avg_pct': round(float(np.mean([r['plans'][best] for r in tg])), 1) if tg else None,
                          'rules_v3_test_avg_pct': round(float(np.mean([r['v3'] for r in tg])), 1) if tg else None})
    doc = {'what': 'Exit lookup: situation at the decision second -> after-entry outcomes and the best take-profit/stop/time plan',
           'decision_second_after_launch': t, 'fill_delay_s': E.LATENCY_S, 'cost_round_trip_pct': round(2 * C * 100, 2),
           'grid': {'take_profit_pct': tps, 'stop_pct': [-x for x in sls], 'time_limit_s': tms}, 'launches': len(rows), 'train': len(train), 'test': len(test), 'rows': table}
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True); json.dump(doc, open(a.out, 'w'), indent=1)
    print(f'{len(rows)} launches · {len(table)} lookup rows -> {a.out}')
    for r in [x for x in table if x['level'] == 'change'][:8]:
        print(f"  {r['change_30s']:12s} n={r['n_train']:5d}  v3 test {r['rules_v3_test_avg_pct']}%  best {r['best_plan']} test {r['best_plan_test_avg_pct']}%")


if __name__ == '__main__':
    main()
