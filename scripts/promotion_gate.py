#!/usr/bin/env python3
"""Feedback loop, part 3: promotion gate (approved by Tim, 2026-09-26). Reports only; it never promotes anything.

A challenger strategy passes when, on its paper trades:
  - at least 200 trades spanning at least 3 distinct UTC days
  - max drawdown >= -$4 and worst UTC day >= -$3, at $2 per position
  - the lower bound of the 95% bootstrap CI of profit per trade is above the champion's mean profit per trade over the
    same days. Bootstrap resamples whole UTC days (2,000 resamples, fixed seed), not single trades.

Input: CSV or JSON rows with closed_at (ISO time), strategy, net_pct.

  python scripts/promotion_gate.py --trades paper_trades.csv --challenger model-v1 --champion paper-v3
Exit code 0 = passed, 1 = failed.
"""
import argparse, csv, datetime as dt, json, sys
import numpy as np

GATE = {'min_trades': 200, 'min_days': 3, 'max_drawdown_usd': -4.0, 'max_day_loss_usd': -3.0, 'size_usd': 2.0, 'resamples': 2000, 'seed': 0}

def _day(ts: str) -> str:
    t = dt.datetime.fromisoformat(ts.replace('Z', '+00:00'))
    if t.tzinfo is None: t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(dt.timezone.utc).date().isoformat()

def _utc(ts: str) -> dt.datetime:
    t = dt.datetime.fromisoformat(ts.replace('Z', '+00:00'))
    return (t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)).astimezone(dt.timezone.utc)

def evaluate(trades, challenger: str, champion: str, **overrides) -> dict:
    g = {**GATE, **overrides}
    mine = sorted((r for r in trades if r['strategy'] == challenger), key=lambda r: _utc(r['closed_at']))
    pct = np.array([float(r['net_pct']) for r in mine]); usd = pct / 100 * g['size_usd']
    days = [_day(r['closed_at']) for r in mine]; day_set = sorted(set(days))
    checks = []
    def check(name, value, threshold, passed): checks.append({'name': name, 'value': value, 'threshold': threshold, 'passed': bool(passed)})

    check('trades', len(mine), f">= {g['min_trades']}", len(mine) >= g['min_trades'])
    check('utc_days', len(day_set), f">= {g['min_days']}", len(day_set) >= g['min_days'])
    eq = np.concatenate([[0.0], np.cumsum(usd)]); dd = float((eq - np.maximum.accumulate(eq)).min())
    check('max_drawdown_usd', round(dd, 2), f">= {g['max_drawdown_usd']}", dd >= g['max_drawdown_usd'])
    by_day = {d: 0.0 for d in day_set}
    for d, u in zip(days, usd): by_day[d] += u
    worst = min(by_day.values()) if by_day else 0.0
    check('worst_day_usd', round(worst, 2), f">= {g['max_day_loss_usd']}", worst >= g['max_day_loss_usd'])

    champ = [float(r['net_pct']) for r in trades if r['strategy'] == champion and _day(r['closed_at']) in by_day]
    champ_mean = float(np.mean(champ)) if champ else None
    if len(mine) and len(day_set):
        groups = [pct[[i for i, d in enumerate(days) if d == day]] for day in day_set]; rng = np.random.default_rng(g['seed'])
        boot = [np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))]).mean() for _ in range(g['resamples'])]
        lower = float(np.percentile(boot, 2.5))
    else: lower = None
    check('profit_per_trade_lower95_vs_champion', None if lower is None else round(lower, 3),
          f"> champion mean ({'none' if champ_mean is None else round(champ_mean, 3)})", lower is not None and champ_mean is not None and lower > champ_mean)

    return {'passed': all(c['passed'] for c in checks), 'challenger': challenger, 'champion': champion, 'checks': checks,
            'challenger_mean_pct': round(float(pct.mean()), 3) if len(pct) else None, 'champion_mean_pct': None if champ_mean is None else round(champ_mean, 3),
            'champion_trades_same_days': len(champ), 'days': day_set, 'gate': g, 'note': 'Report only. Promotion needs the owner.'}

def load(path):
    if path.endswith('.json'):
        with open(path) as f: return json.load(f)
    with open(path, newline='') as f: return list(csv.DictReader(f))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--trades', required=True); ap.add_argument('--challenger', required=True); ap.add_argument('--champion', required=True)
    a = ap.parse_args(); r = evaluate(load(a.trades), a.challenger, a.champion)
    print(json.dumps(r, indent=1)); sys.exit(0 if r['passed'] else 1)

if __name__ == '__main__':
    main()
