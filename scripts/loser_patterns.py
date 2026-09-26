#!/usr/bin/env python3
"""Entry KPIs known at the buy decision, for every traded launch, split winner vs loser; code-computed comparison;
payload for Kimi; and a validator that scores 'do not buy' rules on all tokens.

  python scripts/loser_patterns.py build --db artifacts/corpus/launches.db --out data-analysis/entry_kpis.csv --payload /tmp/kimi_payload.json
  python scripts/loser_patterns.py validate --kpis data-analysis/entry_kpis.csv --rules rules.json
"""
import argparse, collections, csv, json, math, os, re, sqlite3, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import train_exit_policy as tp

KPIS = ['secs_since_launch', 'price_change_since_launch_pct', 'active_secs', 'active_share', 'volume_log', 'volume_last5_vs_before', 'volatility_pct',
        'max_rise_so_far_pct', 'drop_from_high_pct', 'first_move_up', 'fee_routed', 'mayhem', 'terminal', 'copycat_name', 'name_len']

def build(a):
    tokens = tp.load(a.db, 20)
    seen_names = collections.Counter()   # copycat as of the decision: only launches created earlier (Astra: no future leak)
    lab = {m: (r, loss, why, pnl) for m, r, loss, why, pnl in sqlite3.connect(a.db).execute("SELECT mint, result, target_exit_pnl_pct, loser_reason, best_pnl_pct FROM exit_labels")}
    rows = []
    for t in tokens:
        key = (t['name'] or '').strip().lower(); prior = seen_names[key]; seen_names[key] += 1
        if t['mint'] not in lab: continue
        e = tp.entry_of(t)
        if e is None: continue
        d = e - tp.LATENCY_S; p, v = t['p'], t['v']; lp = np.log(p); r = np.diff(lp[:d + 1])
        first = next((i for i in range(1, d + 1) if p[i] != p[0]), None)
        kp = [d, (p[d] / p[0] - 1) * 100, float((v[:d + 1] > 0).sum()), float((v[:d + 1] > 0).mean()), math.log1p(v[:d + 1].sum()),
              (v[max(0, d - 4):d + 1].sum() + 1) / (v[:max(1, d - 4)].sum() / max(1, d - 4) * 5 + 1), float(r.std() * 100) if len(r) > 1 else 0.0,
              (p[:d + 1].max() / p[0] - 1) * 100, (p[d] / p[:d + 1].max() - 1) * 100, int(first is not None and p[first] > p[0]), *[int(x) for x in t['tags']],
              int(prior > 0), len(t['name'] or '')]
        res, loss, why, pnl = lab[t['mint']]
        if t.get('anomaly'): continue
        rows.append([t['name'], t['mint'], 'loser' if res == 'loser' else 'winner', (why or '').split(':')[0], round(pnl, 1)] + [round(float(x), 3) for x in kp])
    with open(a.out, 'w', newline='') as fh: w = csv.writer(fh); w.writerow(['token', 'mint', 'result', 'loser_reason', 'best_pnl_pct'] + KPIS); w.writerows(rows)
    from sklearn.metrics import roc_auc_score
    y = np.array([1 if r[2] == 'loser' else 0 for r in rows]); X = np.array([r[5:] for r in rows], dtype=float)
    comp = []
    for j, k in enumerate(KPIS):
        L, W = X[y == 1, j], X[y == 0, j]; auc = roc_auc_score(y, X[:, j]) if len(set(X[:, j])) > 1 else 0.5
        comp.append({'kpi': k, 'loser_median': round(float(np.median(L)), 3), 'winner_median': round(float(np.median(W)), 3), 'loser_mean': round(float(L.mean()), 3), 'winner_mean': round(float(W.mean()), 3),
                     'auc_for_loser': round(float(auc), 3)})
    comp.sort(key=lambda c: -abs(c['auc_for_loser'] - 0.5))
    rng = np.random.default_rng(0); losers = [r for r in rows if r[2] == 'loser']; winners = [r for r in rows if r[2] == 'winner']
    sample = [dict(zip(['result', 'reason', 'best_pnl'] + KPIS, [r[2], r[3], r[4]] + r[5:])) for r in losers] + \
             [dict(zip(['result', 'reason', 'best_pnl'] + KPIS, [r[2], r[3], r[4]] + r[5:])) for r in (rng.choice(np.array(winners, dtype=object), size=min(len(winners), len(losers)), replace=False).tolist())]
    payload = {'n_traded': len(rows), 'n_losers': len(losers), 'n_winners': len(winners), 'kpi_definitions': {
        'secs_since_launch': 'seconds from launch to our buy decision', 'price_change_since_launch_pct': 'price change from launch to decision',
        'active_secs': 'seconds with at least one trade before the decision', 'active_share': 'share of seconds with trades', 'volume_log': 'log(1+total volume before decision)',
        'volume_last5_vs_before': 'volume in the last 5 s vs the average 5 s before', 'volatility_pct': 'std of 1 s log returns x100', 'max_rise_so_far_pct': 'highest price so far vs launch',
        'drop_from_high_pct': 'current price vs the high so far', 'first_move_up': '1 if the first trade moved the price up', 'fee_routed': 'creator fees routed to an X account',
        'mayhem': 'pump.fun Mayhem mode', 'terminal': 'launched from a trading terminal', 'copycat_name': 'another launch in the data had the same name', 'name_len': 'name length'},
        'comparison_computed_in_code': comp, 'rows': sample}
    json.dump(payload, open(a.payload, 'w'))
    print(f'{len(rows)} traded ({len(losers)} losers, {len(winners)} winners); payload {len(json.dumps(payload))} bytes')
    for c in comp[:8]: print(f"  {c['kpi']:32} loser median {c['loser_median']:>9} · winner median {c['winner_median']:>9} · AUC {c['auc_for_loser']}")

def validate(a):
    rows = list(csv.DictReader(open(a.kpis))); rules = json.load(open(a.rules))
    tot_l = sum(r['result'] == 'loser' for r in rows); tot_w = len(rows) - tot_l
    base = sum(float(r['best_pnl_pct']) if r['result'] == 'winner' else float(r['best_pnl_pct']) for r in rows)
    out = []
    for rule in rules:
        hit = [r for r in rows if eval(rule['expr'], {'__builtins__': {}}, {k: float(r[k]) for k in KPIS})]
        l = sum(r['result'] == 'loser' for r in hit); w = len(hit) - l
        saved = -sum(float(r['best_pnl_pct']) for r in hit if r['result'] == 'loser'); lost = sum(float(r['best_pnl_pct']) for r in hit if r['result'] == 'winner')
        out.append({**rule, 'tokens_skipped': len(hit), 'losers_avoided': l, 'losers_avoided_share': round(l / tot_l, 3), 'winners_lost': w, 'winners_lost_share': round(w / tot_w, 3),
                    'precision_loser': round(l / len(hit), 3) if hit else None, 'pnl_pts_saved_on_losers': round(saved, 1), 'pnl_pts_given_up_on_winners': round(lost, 1)})
    json.dump(out, open(a.out, 'w'), indent=1) if a.out else None
    for o in out: print(json.dumps(o))

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd')
    b = sub.add_parser('build'); b.add_argument('--db', required=True); b.add_argument('--out', required=True); b.add_argument('--payload', required=True)
    v = sub.add_parser('validate'); v.add_argument('--kpis', required=True); v.add_argument('--rules', required=True); v.add_argument('--out')
    a = ap.parse_args(); build(a) if a.cmd == 'build' else validate(a)
