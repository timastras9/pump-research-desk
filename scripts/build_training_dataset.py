#!/usr/bin/env python3
"""Clean training dataset (per Astra's review, 2026-09-26): one row per traded launch, winners AND losers, every
column tagged by role so hindsight never leaks into model inputs.

  roles: id | feature (known at the buy decision) | label (training target) | eval_only (hindsight; never an input)

  python scripts/build_training_dataset.py --db artifacts/corpus/launches.db --out data-analysis/training_dataset_v1.csv
"""
import argparse, csv, json, os, sqlite3

ROLES = {
    'token': 'id', 'mint': 'id', 'launched': 'id',
    'decision_sec': 'feature', 'price_change_since_launch_pct': 'feature', 'active_secs': 'feature', 'active_share': 'feature',
    'volume_log': 'feature', 'volume_last5_vs_before': 'feature', 'volatility_pct': 'feature', 'max_rise_so_far_pct': 'feature', 'drop_from_high_pct': 'feature',
    'first_move_up': 'feature', 'fee_routed': 'feature', 'mayhem': 'feature', 'terminal': 'feature', 'copycat_name': 'feature', 'name_len': 'feature',
    'label_buy': 'label', 'target_exit_sec': 'label', 'target_exit_pct': 'label',
    'entry_fill_sec': 'eval_only', 'decision_price': 'eval_only', 'entry_price': 'eval_only', 'entry_slippage_pct': 'eval_only', 'peak_sec': 'eval_only', 'peak_pct': 'eval_only',
    'best_fill_sec': 'eval_only', 'best_pnl_pct': 'eval_only', 'target_exit_pnl_pct': 'eval_only', 'min_loss_pct': 'eval_only', 
    'secs_to_below_entry': 'eval_only', 'crossed_below_entry': 'eval_only', 'observation_end_sec': 'eval_only', 'loser_reason': 'eval_only', 'result': 'eval_only', 'latency_s': 'eval_only'}
DEFS = {
    'decision_sec': 'second after launch when we decided to buy (fill happens latency_s later)', 'secs_since_launch': 'same as decision_sec',
    'price_change_since_launch_pct': 'price change launch -> decision', 'active_secs': 'seconds with >=1 trade before the decision', 'active_share': 'share of seconds with trades before the decision',
    'volume_log': 'log(1+volume) before the decision', 'volume_last5_vs_before': 'last-5 s volume vs earlier 5 s average', 'volatility_pct': 'std of 1 s log returns x100 before the decision',
    'max_rise_so_far_pct': 'highest price so far vs launch', 'drop_from_high_pct': 'price at decision vs high so far', 'first_move_up': '1 if the first trade moved price up',
    'fee_routed': 'creator fees routed to an X account', 'mayhem': 'pump.fun Mayhem mode', 'terminal': 'launched from a trading terminal', 'copycat_name': 'an EARLIER launch had the same name (as of the decision)', 'name_len': 'token name length',
    'label_buy': '1 = a positive exit existed after the 2 s delay and costs (winner); 0 = no-trade (loser)', 'target_exit_sec': 'pull-out DECISION second taught to the sell model (fills latency_s later); earliest sell decision = entry_fill_sec + 1',
    'target_exit_pct': 'target exit fill vs entry %: within 10 pts of the peak AND net-positive after costs (winners)', 'crossed_below_entry': '1 if price fell below entry before observation_end_sec, else 0 (censored at the end)', 'observation_end_sec': 'last second observed for this trade (entry + 600 s, max 720)', 'entry_fill_sec': 'second the buy filled', 'entry_slippage_pct': 'fill vs decision price (outcome of the delay)',
    'peak_pct': 'highest price after entry vs entry %', 'best_pnl_pct': 'best realistic P&L after the delay and costs', 'target_exit_pnl_pct': 'P&L at the target exit after costs',
    'min_loss_pct': 'least-bad exit for losers', 'loser_reason': 'code-computed cause of a loser', 'result': 'winner / winner-latency-gap / loser'}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--kpis', default='data-analysis/entry_kpis.csv'); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    k = {r['mint']: r for r in csv.DictReader(open(a.kpis))}
    db = sqlite3.connect(a.db); db.row_factory = sqlite3.Row
    rows = []
    for r in db.execute('SELECT * FROM exit_labels ORDER BY launched'):
        f = k.get(r['mint'])
        if not f: continue
        win = r['result'] != 'loser'
        row = {'token': r['token'], 'mint': r['mint'], 'launched': r['launched'], 'decision_sec': r['entry_sec'] - r['latency_s'],
               **{c: f[c] for c in ROLES if ROLES[c] == 'feature' and c in f}, 'label_buy': int(win),
               'target_exit_sec': r['target_exit_sec'] if win else '', 'target_exit_pct': r['target_exit_pct'] if win else '',
               'entry_fill_sec': r['entry_sec'], 'decision_price': r['decision_price'], 'entry_price': r['entry_price'], 'entry_slippage_pct': r['entry_slippage_pct'],
               'peak_sec': r['peak_sec'], 'peak_pct': r['peak_pct'], 'best_fill_sec': r['best_fill_sec'], 'best_pnl_pct': r['best_pnl_pct'],
               'target_exit_pnl_pct': r['target_exit_pnl_pct'] if win else '', 'min_loss_pct': '' if win else r['target_exit_pnl_pct'],
               'secs_to_below_entry': r['secs_to_below_entry'], 'crossed_below_entry': int(r['secs_to_below_entry'] is not None), 'observation_end_sec': min(720, r['entry_sec'] + 600), 'loser_reason': r['loser_reason'] or '', 'result': r['result'], 'latency_s': r['latency_s']}
        rows.append(row)
    cols = list(ROLES)
    with open(a.out, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore'); w.writeheader(); w.writerows(rows)
    dictionary = [{'column': c, 'role': ROLES[c], 'definition': DEFS.get(c, '')} for c in cols]
    json.dump(dictionary, open(os.path.splitext(a.out)[0] + '_dictionary.json', 'w'), indent=1)
    print(f'{len(rows)} rows ({sum(r["label_buy"] for r in rows)} winners, {sum(1 - r["label_buy"] for r in rows)} losers) · {len(cols)} columns: '
          f'{sum(v == "feature" for v in ROLES.values())} features, {sum(v == "label" for v in ROLES.values())} labels, {sum(v == "eval_only" for v in ROLES.values())} eval-only')

if __name__ == '__main__':
    main()
