#!/usr/bin/env python3
"""Human sign-off workbook for the sell labels BEFORE training: one row per launch with the peak, the realistic
peak sale (after latency), where the label first says 'sell', and blank Initials / Approved / Notes columns.

  python scripts/export_label_review.py --db artifacts/corpus/launches.db --out artifacts/corpus/label_review_v1.xlsx
"""
import argparse, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import train_exit_policy as tp

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--latency', type=int, default=2); ap.add_argument('--min_traded', type=int, default=20)
    a = ap.parse_args(); tp.LATENCY_S = a.latency
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.worksheet.datavalidation import DataValidation
    tokens = tp.load(a.db, a.min_traded)
    review, every5 = [], []
    exact = {}   # exact target fill prices (the sheet rounds percentages)
    loser_info = {}
    anomalies = []
    for t in tokens:
        if t.get('anomaly'):   # off-curve / corrupted prices: audited separately, never labeled or trained on
            anomalies.append([t['name'], t['mint'], time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t['created'] / 1000)), round(float(t['p'].max() / t['p'][0]), 1)]); continue
        t['entry'] = tp.entry_of(t); e = t['entry']; p = t['p']
        launched = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t['created'] / 1000))
        tags = ', '.join(n for n, on in zip(('fee-routed', 'mayhem', 'terminal'), t['tags']) if on) or 'website'
        if e is None:
            review.append([t['name'], t['mint'], launched, tags, 'NO ENTRY', 'no trade within 30 s of first sight, or already +30% (skipped)'] + [None] * 14 + ['', '', '']); continue
        end = min(720, e + tp.HOLD_S)
        zone, k, kind0 = tp.target_exit(t); kf = min(k + tp.LATENCY_S, end); zf = min(zone + tp.LATENCY_S, end)
        raw_peak = e + 1 + int(np.argmax(p[e + 1:end + 1]))
        tgt = (zone, k, kind0); labels = [tp.label_v2(t, s_, end, tgt) for s_ in range(e + 1, end)]
        peak_pct = (p[raw_peak] / p[e] - 1) * 100; best = tp.net(p[e], p[kf]); zone_pnl = tp.net(p[e], p[zf])
        early_drop = bool((p[e + 1:min(e + 6, end) + 1] < p[e]).any())
        exact[t['mint']] = float(p[zf])
        # Why a loser never offered a positive exit: compare the buy decision, the delayed fill and what came next.
        d = e - tp.LATENCY_S; slip = (p[e] / p[d] - 1) * 100; after = p[e + 1:end + 1]
        max_gain = (after.max() / p[e] - 1) * 100; below = np.nonzero(after < p[e])[0]; secs_below = int(below[0]) + 1 if len(below) else None
        if kind0 != 'loser': why = ''
        elif (after == p[e]).all(): why = 'dead after entry: no trades once we were in'
        elif slip >= 10 and max_gain <= 0: why = f'bought the spike: the 2 s buy delay filled {slip:.0f}% above the decision price, then it only fell'
        elif secs_below is not None and secs_below <= tp.LATENCY_S and max_gain <= 0: why = 'dropped immediately: below entry before any sale could fill'
        elif max_gain <= 0: why = 'never traded above entry after we were in'
        elif max_gain >= 6.7: why = f'spike shorter than the 2 s sell delay: touched +{max_gain:.1f}% but was gone before any sale could fill'
        else: why = f'rose too little: best +{max_gain:.1f}%, under the ~6.7% round-trip costs'
        loser_info[t['mint']] = (round(p[d], 12), round(slip, 1), round(max_gain, 1), secs_below, why)
        kind = {'winner':'WINNER','winner-latency-gap':'WINNER (latency gap: raw top gone before a 2 s fill)'}.get(kind0) or ('LOSER: do not enter / exit at once' + (' (dropped below entry within 5 s)' if early_drop else ''))
        review.append([t['name'], t['mint'], launched, tags, kind, '',
                       e, p[e], raw_peak, p[raw_peak], round(peak_pct, 1), kf, p[kf], round(best, 1), round(0.02 * best, 2),
                       zone, zf, round((p[zf] / p[kf] - 1) * 100, 1), round(zone_pnl, 1), round(0.02 * zone_pnl, 2), '', '', ''])
        for s in range(e + 1, end, 5):
            every5.append([t['name'], t['mint'], s, p[s], round((p[s] / p[e] - 1) * 100, 1), 'SELL' if labels[s - e - 1] else 'hold', 'PEAK' if s <= k < s + 5 else ''])
    wb = Workbook(); bold = Font(bold=True); head = PatternFill('solid', fgColor='DDEBF7'); sign = PatternFill('solid', fgColor='FFF2CC')
    ws = wb.active; ws.title = 'Review'
    header = ['Token', 'Mint', 'Launched', 'Launch type', 'Result type', 'Why skipped',
              'Entry sec after launch', 'Entry price', 'PEAK sec', 'PEAK price', 'PEAK % vs entry', f'Best realistic fill sec (+{a.latency}s)', 'Best realistic fill price', 'Best realistic P&L % (after costs)', 'Best realistic $ on $2',
              'TARGET EXIT sec (pull-out point taught to the model)', f'Target exit fill sec (+{a.latency}s)', 'PEAK minus TARGET EXIT (% below best realistic fill)', 'Target exit P&L %', 'Target exit $ on $2',
              'Reviewer initials', 'Approved (Y/N)', 'Notes']
    ws.append(header)
    for c in ws[1]: c.font = bold; c.fill = head; c.alignment = Alignment(wrap_text=True, vertical='top')
    for c in ws[1][-3:]: c.fill = sign
    for r in review: ws.append(r)
    dv = DataValidation(type='list', formula1='"Y,N"', allow_blank=True); ws.add_data_validation(dv); dv.add(f'V2:V{len(review) + 1}')
    ws.freeze_panes = 'C2'; ws.auto_filter.ref = ws.dimensions; ws.row_dimensions[1].height = 45
    widths = [22, 14, 19, 22, 30, 28, 10, 13, 9, 13, 10, 12, 13, 12, 11, 12, 12, 11, 11, 11, 10, 10, 30]
    for i, w in enumerate(widths): ws.column_dimensions[ws.cell(1, i + 1).column_letter].width = w
    w2 = wb.create_sheet('Every 5 seconds'); w2.append(['Token', 'Mint', 'Sec after launch', 'Price', '% vs entry', 'Label', 'Peak in this 5s'])
    for c in w2[1]: c.font = bold; c.fill = head
    for r in every5: w2.append(r)
    w2.freeze_panes = 'A2'; w2.auto_filter.ref = w2.dimensions
    w3 = wb.create_sheet('Rules')
    traded = [r for r in review if r[4] != 'NO ENTRY']; winners = [r for r in traded if r[4].startswith('WINNER')]
    for r in [['What you are verifying', 'Whether the label says SELL close to the peak (winners) and early enough to keep losses small (losers).'],
              ['Data', f'{len(review)} launches with at least {a.min_traded} traded seconds, 1-second pump.fun candles; {len(traded)} had an entry; {len(winners)} winners, {len(traded) - len(winners)} losers.'],
              ['Entry', 'First sight 5 s after launch (live feed delay); buy on the first trade within 30 s after that, filled 2 s later. Skip if already +30%.'],
              ['Latency', f'Every sale fills {a.latency} seconds after the decision, at the later price.'],
              ['Costs', '1.25% fee + 2% slippage on each side; $2 per trade.'],
              ['PEAK', 'Highest 1-second closing price between entry and the 10-minute exit (pump.fun API candles; can differ from screenshot readings).'],
              ['Best realistic fill', 'The highest price you could actually have been filled at: the best decision second, filled 2 s later.'],
              ['Label SELL', 'A second is SELL when the price never rises more than 10% above it for the rest of the window, or it falls 25% within 60 s without first rising 20%. Otherwise HOLD.'],
              ['TARGET EXIT', 'The pull-out point taught to the model: start of the SELL stretch that contains the peak.'],
              ['PEAK minus TARGET EXIT', 'How far below the peak the target exit fills, in %, after the 2 s delay (0% = at the peak).'],
              ['Losers', 'When the price never beats costs, the label says SELL right away: that is the minimum-loss exit.'],
              ['Sign-off', 'Fill Reviewer initials, Approved Y/N and Notes on the Review sheet. Training waits for your approval.']]: w3.append(r)
    w3.column_dimensions['A'].width = 24; w3.column_dimensions['B'].width = 130
    for c in w3['A']: c.font = bold
    wb.save(a.out)
    import csv as _csv
    with open(os.path.join(os.path.dirname(a.out) or '.', 'price_anomalies.csv'), 'w', newline='') as fh:
        w = _csv.writer(fh); w.writerow(['token', 'mint', 'launched', 'max_price_vs_launch_x']); w.writerows(anomalies)
    print(f'excluded {len(anomalies)} price-anomaly launches (see price_anomalies.csv)')
    import sqlite3
    db = sqlite3.connect(a.db)
    db.execute('DROP TABLE IF EXISTS exit_labels')
    db.execute('''CREATE TABLE exit_labels(token TEXT, mint TEXT PRIMARY KEY, launched TEXT, launch_type TEXT, result TEXT, entry_sec INTEGER, entry_price REAL,
      peak_sec INTEGER, peak_price REAL, peak_pct REAL, best_fill_sec INTEGER, best_fill_price REAL, best_pnl_pct REAL,
      target_exit_sec INTEGER, target_exit_fill_sec INTEGER, target_exit_fill_price REAL, target_exit_pct REAL, peak_minus_target_pct REAL, seconds_before_peak INTEGER, target_exit_pnl_pct REAL, latency_s INTEGER, decision_price REAL, entry_slippage_pct REAL, max_gain_after_entry_pct REAL, secs_to_below_entry INTEGER, loser_reason TEXT)''')
    for r in review:
        if r[4] == 'NO ENTRY': continue
        name, mint, launched, tags, kind, _, e, ep, k, kp, kpct, kf, kfp, best, _, zone, zf, gap, zpnl, _ = r[:20]
        zfp = exact[mint]
        db.execute('INSERT OR REPLACE INTO exit_labels VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (name, mint, launched, tags, ('winner-latency-gap' if 'latency gap' in kind else 'winner') if kind.startswith('WINNER') else 'loser', e, ep, k, kp, kpct, kf, kfp, best,
                   zone, zf, zfp, round((zfp / ep - 1) * 100, 1), round(-gap, 1), (kf - tp.LATENCY_S) - zone, zpnl, a.latency, *loser_info[mint]))
    db.commit(); print('wrote table exit_labels in', a.db)
    zone_gap = [r[17] for r in winners if isinstance(r[17], (int, float))]
    print(f'wrote {a.out}: {len(review)} launches, {len(traded)} traded, {len(winners)} winners; label fill vs peak median {np.median(zone_gap):.1f}% (winners)' if zone_gap else f'wrote {a.out}')

if __name__ == '__main__':
    main()
