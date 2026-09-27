"""Backtest: skip a trade if the token already had chat comments before the buy decision.

Causal: a comment counts only if it first appeared on screen at or before the paper trade's entry second
(recording doc keyMoments.paperEntry.sec vs chat[].sec, both seconds after launch). Trades and their P&L are the
live paper trader's own (rules v3, $2, 6.5% round-trip costs), read from the RAG export (scripts/rag-dump.ts).
Usage: python data-analysis/early_chat_rule.py artifacts/rag-dump/rag
"""
import glob, json, math, os, sys

root = sys.argv[1] if len(sys.argv) > 1 else 'artifacts/rag-dump/rag'
rows = []
for f in glob.glob(os.path.join(root, 'recordings', '*', '*.json')):
    rec = json.load(open(f))
    tok = json.load(open(os.path.join(root, rec['tokenDoc'][len('rag/'):])))
    p = tok.get('paperAllTokens') or {}
    if tok.get('excluded') or p.get('status') != 'closed' or p.get('netPct') is None: continue
    entry = (rec.get('keyMoments') or {}).get('paperEntry') or {}
    if entry.get('sec') is None: continue
    early = [c for c in rec.get('chat') or [] if c.get('sec') is not None and c['sec'] <= entry['sec']]
    rows.append({'name': tok['name'], 'study': tok['study']['id'][:8], 'net': p['netPct'], 'usd': p.get('netUsd') or 0,
                 'final': tok.get('finalChangePct'), 'chat_before_entry': len(early)})


def line(label, g):
    n = len(g)
    if not n: print(f'{label:34s} n=0'); return
    avg = sum(r['net'] for r in g) / n; usd = sum(r['usd'] for r in g)
    sd = math.sqrt(sum((r['net'] - avg) ** 2 for r in g) / max(1, n - 1)); se = sd / math.sqrt(n)
    tanked = sum(1 for r in g if (r['final'] or 0) <= -50)
    print(f'{label:34s} n={n:4d}  avg {avg:6.1f}% (±{1.96*se:4.1f})  total ${usd:+7.2f}  won {sum(r["net"] > 0 for r in g)/n*100:3.0f}%  tanked {tanked}')


skip = [r for r in rows if r['chat_before_entry'] > 0]; keep = [r for r in rows if r['chat_before_entry'] == 0]
print(f'{len(rows)} closed paper trades with a recording')
line('all trades (current rules v3)', rows)
line('had chat before entry -> SKIP', skip)
line('no chat before entry  -> KEEP', keep)
print('\nskipped trades:')
for r in sorted(skip, key=lambda r: r['net']): print(f"  {r['study']} {r['name'][:28]:28s} net {r['net']:6.1f}%  chat before entry {r['chat_before_entry']}  final {r['final']}")
