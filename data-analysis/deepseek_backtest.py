"""Can DeepSeek (thinking OFF) pick pump.fun launches in real time? Backtest on the corpus.

For each launch: DeepSeek V4 Pro on Fireworks (reasoning_effort='none') sees ONLY what was known at the decision second
(price every second, volume, buyers/sellers, launch flags) and answers BUY or SKIP. Its latency is measured per call
and added to the fill delay (decision at t, answer after L s, fill at t + L + 2 s). Trades are scored with
research/engine.py (3.25% cost per side, rules v3 exits, 10 min forced exit), same as every other study.
Compared on the SAME launches: buy everything, and DeepSeek's picks. Bootstrap 95% CI on the mean.

Usage (Tim runs; key read from the environment, never printed):
  FIREWORKS_API_KEY=... PYTHONPATH=. python data-analysis/deepseek_backtest.py artifacts/corpus/launches.db --n 300 --decide 30
  --dry prints 2 prompts and exits (no API calls, no key needed).
"""
import argparse, json, math, os, sys, time, urllib.request

import numpy as np

from research import engine as E

ap = argparse.ArgumentParser(); ap.add_argument('db'); ap.add_argument('--n', type=int, default=300); ap.add_argument('--decide', type=int, default=30)
ap.add_argument('--dry', action='store_true'); ap.add_argument('--model', default='accounts/fireworks/models/deepseek-v4-pro'); a = ap.parse_args()
D, KEY = a.decide, os.environ.get('FIREWORKS_API_KEY', '')
if not a.dry and not KEY: sys.exit('Set FIREWORKS_API_KEY in the environment (it is never printed).')

eps = sorted((e for e in E.load_episodes(a.db, min_traded=1) if not e.anomaly and (e.volume[D - 9:D + 1] > 0).any()), key=lambda e: e.created)
eps = eps[-a.n:]   # the newest launches (least likely to be in any model's training data)
print(f'{len(eps)} launches still trading at {D} s (newest {a.n})')

SYSTEM = ('You screen brand-new pump.fun token launches for a 10-minute paper trade. Costs are 6.5% round trip and the '
          'order fills a few seconds after you answer. Most launches lose; big pumps usually peak inside 60 s. '
          'Answer with exactly one word: BUY or SKIP.')


def prompt(ep):
    p, v = ep.price[:D + 1], ep.volume[:D + 1]
    pct = [float(round((x / p[0] - 1) * 100, 1)) for x in p]
    f = E.features(ep, D)
    facts = {k: (round(float(f[k]), 3) if f[k] == f[k] else None) for k in f}   # NaN -> None
    return (f'Launch facts at {D} s (everything known so far):\n'
            f'price change from launch, one value per second 0..{D}: {pct}\n'
            f'seconds with trades: {int((v > 0).sum())} of {D + 1}\n'
            f'features: {json.dumps(facts)}\n'
            f'mayhem: {bool(ep.tags["mayhem"])}, fee-routed: {bool(ep.tags["fee_routed"])}\n'
            'BUY or SKIP?')


def ask(text):
    body = json.dumps({'model': a.model, 'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': text}],
                       'max_tokens': 5, 'temperature': 0, 'reasoning_effort': 'none'}).encode()
    req = urllib.request.Request('https://api.fireworks.ai/inference/v1/chat/completions', data=body, method='POST',
                                 headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as r: j = json.load(r)
    lat = time.time() - t0
    return (j['choices'][0]['message'].get('content') or '').strip().upper(), lat, j.get('usage', {})


if a.dry:
    for ep in eps[:2]: print('---', ep.mint, '\n', SYSTEM, '\n', prompt(ep)[:1500])
    sys.exit(0)

rules = E.rules_v3(); rows = []; tok_in = tok_out = 0
for i, ep in enumerate(eps):
    try: ans, lat, u = ask(prompt(ep))
    except Exception as e: print(f'  call failed on {ep.mint}: {str(e)[:120]}'); continue
    tok_in += u.get('prompt_tokens', 0); tok_out += u.get('completion_tokens', 0)
    delay = D + max(0, math.ceil(lat))                               # the decision is only known after DeepSeek answers
    if delay > E.WINDOW_S - E.LATENCY_S - 1: continue
    rows.append({'buy': ans.startswith('BUY'), 'lat': lat,
                 'net_now': E.simulate(ep, rules, decision_t=D).net_return_pct(),          # buy-all baseline, no model delay
                 'net_ds': E.simulate(ep, rules, decision_t=delay).net_return_pct()})      # DeepSeek's fill, after its latency
    if (i + 1) % 25 == 0: print(f'  {i + 1}/{len(eps)} done, buys so far {sum(r["buy"] for r in rows)}')

rng = np.random.default_rng(0)
def summary(name, x):
    x = np.array(x)
    if not len(x): print(f'{name:40s} n=0'); return
    m = rng.choice(x, (4000, len(x))).mean(axis=1)
    print(f'{name:40s} n={len(x):4d}  avg {x.mean():6.1f}% [{np.percentile(m, 2.5):6.1f}, {np.percentile(m, 97.5):6.1f}]  win {(x > 0).mean()*100:3.0f}%  $2 trades {x.sum()*0.02:+7.2f}')

lats = np.array([r['lat'] for r in rows])
print(f'\nDeepSeek latency (thinking off): median {np.median(lats):.2f} s, p90 {np.percentile(lats, 90):.2f} s, max {lats.max():.2f} s')
print(f'tokens: {tok_in} in / {tok_out} out\n')
summary('buy everything (decide at %d s)' % D, [r['net_now'] for r in rows])
summary('DeepSeek BUY picks (fill after its latency)', [r['net_ds'] for r in rows if r['buy']])
summary('DeepSeek SKIPs (what it avoided)', [r['net_now'] for r in rows if not r['buy']])
