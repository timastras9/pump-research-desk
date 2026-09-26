#!/usr/bin/env python3
"""Tim's review layout for exit labels: same columns as his reviewed sheet, column R = J - Q (peak % minus target
exit %), conditional formatting that highlights Q < 0 or R > 10. A correct label set shows nothing highlighted
except rows explained in the note columns (latency gap).

  python scripts/export_label_check.py --db artifacts/corpus/launches.db --out data-analysis/exit_labels_v3.xlsx
"""
import argparse, sqlite3

COLS = ['token', 'mint', 'launched', 'launch_type', 'result', 'entry_sec', 'entry_price', 'peak_sec', 'peak_price', 'peak_pct',
        'best_fill_sec', 'best_fill_price', 'best_pnl_pct', 'target_exit_sec', 'target_exit_fill_sec', 'target_exit_fill_price', 'target_exit_pct',
        'target_percent_diff', 'peak_minus_target_pct', 'seconds_before_peak', 'target_exit_pnl_pct', 'latency_s', 'min_loss_pct', 'latency_gap_pts', 'note', 'decision_price', 'entry_slippage_pct', 'max_gain_after_entry_pct', 'secs_to_below_entry', 'loser_reason']

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out', required=True); ap.add_argument('--csv')
    a = ap.parse_args()
    from openpyxl import Workbook
    from openpyxl.formatting.rule import FormulaRule
    from openpyxl.styles import Font, PatternFill
    rows = sqlite3.connect(a.db).execute('''SELECT token, mint, launched, launch_type, result, entry_sec, entry_price, peak_sec, peak_price, peak_pct,
        best_fill_sec, best_fill_price, best_pnl_pct, target_exit_sec, target_exit_fill_sec, target_exit_fill_price, target_exit_pct,
        peak_minus_target_pct, seconds_before_peak, target_exit_pnl_pct, latency_s, decision_price, entry_slippage_pct, max_gain_after_entry_pct, secs_to_below_entry, loser_reason FROM exit_labels ORDER BY launched''').fetchall()
    wb = Workbook(); ws = wb.active; ws.title = 'exit_labels'; ws.append(COLS)
    for c in ws[1]: c.font = Font(bold=True); c.fill = PatternFill('solid', fgColor='DDEBF7')
    out_csv = []
    for n, r in enumerate(rows, start=2):
        token, mint, launched, ltype, result, e, ep, k, kp, kpct, bf, bfp, bpnl, tsec, tfs, tfp, tpct, pmt, sbp, tpnl, lat, dp, slip, mg, sbe, why = r
        extra = [dp, slip, mg, sbe, why]
        best_fill_pct = round((bfp / ep - 1) * 100, 1)
        if result == 'loser':   # no trade: target left blank, least-bad exit shown separately
            vals = [token, mint, launched, ltype, result, e, ep, k, kp, kpct, bf, bfp, bpnl, None, None, None, None, None, None, None, None, lat, tpnl, None,
                    'no trade: price never beats costs after the 2 s delay; model taught to sell at once'] + extra
        else:
            gap = round(kpct - best_fill_pct, 1)
            note = f'latency gap: raw top was a spike gone before a 2 s fill; best reachable is {gap} pts below it' if result == 'winner-latency-gap' else ''
            vals = [token, mint, launched, ltype, result, e, ep, k, kp, kpct, bf, bfp, bpnl, tsec, tfs, tfp, tpct, None, pmt, sbp, tpnl, lat, None, gap, note] + extra
        ws.append(vals)
        ws.cell(n, 18).value = f'=IF(Q{n}="","",J{n}-Q{n})'   # Tim's column R: peak % minus target exit %
        out_csv.append(vals[:17] + [None if vals[16] is None else round(vals[9] - vals[16], 1)] + vals[18:])
    last = len(rows) + 1; red = PatternFill('solid', fgColor='FFC7CE')
    ws.conditional_formatting.add(f'Q2:Q{last}', FormulaRule(formula=[f'AND(ISNUMBER(Q2),Q2<0)'], fill=red))
    ws.conditional_formatting.add(f'R2:R{last}', FormulaRule(formula=[f'AND(ISNUMBER(R2),R2>10)'], fill=red))
    ws.freeze_panes = 'C2'; ws.auto_filter.ref = f'A1:AD{last}'
    for i, w in enumerate([22, 14, 19, 20, 20, 9, 13, 9, 13, 9, 10, 13, 10, 10, 10, 13, 10, 11, 11, 10, 10, 8, 10, 10, 60, 13, 10, 10, 10, 70]): ws.column_dimensions[ws.cell(1, i + 1).column_letter].width = w
    wb.save(a.out)
    if a.csv:
        import csv
        with open(a.csv, 'w', newline='') as fh: w = csv.writer(fh); w.writerow(COLS); w.writerows(out_csv)
    q_neg = sum(1 for v in out_csv if v[16] is not None and v[16] < 0); r_big = [v for v in out_csv if v[17] is not None and v[17] > 10]
    import collections
    reasons = collections.Counter((v[-1] or '').split(':')[0] for v in out_csv if v[4] == 'loser')
    loss = collections.defaultdict(list)
    for v in out_csv:
        if v[4] == 'loser': loss[(v[-1] or '').split(':')[0]].append(v[22])
    print('loser reasons (count, avg least-bad loss %):', {k: (n, round(sum(loss[k]) / len(loss[k]), 1)) for k, n in reasons.most_common()})
    print(f'wrote {a.out}: {len(rows)} traded launches · would highlight: Q<0 {q_neg} · R>10 {len(r_big)} (latency-gap rows {sum(1 for v in r_big if v[4]=="winner-latency-gap")}, other {sum(1 for v in r_big if v[4]!="winner-latency-gap")})')

if __name__ == '__main__':
    main()
