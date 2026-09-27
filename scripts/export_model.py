#!/usr/bin/env python3
"""Export a trained run (research/train.py output) to the JSON the Cloudflare Worker runs, then prove it matches.

  python scripts/export_model.py --run artifacts/corpus/train-v3 --db artifacts/corpus/launches.db \
      --out artifacts/models/model-v3.json --fixtures test/fixtures

Checks (the export fails if any is off):
  1. research/live_model.py (numpy, from the JSON) matches the original sklearn/PyTorch models on every test launch.
  2. Writes test/fixtures/model_parity.json (sample launches + expected features, probabilities, trades) for src/model.ts.
Training is not run here.
"""
import argparse, datetime as dt, hashlib, json, os, pickle, sqlite3, sys, time
import numpy as np, torch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from research import engine as E, train as T, feedback as F
from research.live_model import LiveModel

def layers(state):
    idx = sorted({int(k.split('.')[0]) for k in state})
    return [[state[f'{i}.weight'].tolist(), state[f'{i}.bias'].tolist()] for i in idx]

def trees(gbt):
    out = []
    for (pred,) in gbt._predictors:
        out.append([[int(n['feature_idx']), float(n['num_threshold']), int(n['left']), int(n['right']), bool(n['is_leaf']), float(n['value']), bool(n['missing_go_to_left'])] for n in pred.nodes])
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', required=True); ap.add_argument('--db', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--fixtures', default='test/fixtures'); ap.add_argument('--n-fixtures', type=int, default=12); a = ap.parse_args()
    m = torch.load(os.path.join(a.run, 'models.pt'), weights_only=False); gbt = pickle.load(open(os.path.join(a.run, 'buy_gbt.pkl'), 'rb'))
    res = json.load(open(os.path.join(a.run, 'results.json')))
    if res['validation_choices']['best_buy'] != 'gbt' or res['validation_choices']['best_seller'] != 'guarded' or m['guard']['base'] != 'rules_v3':
        sys.exit(f"export supports buy=gbt + guarded(rules_v3); this run chose {res['validation_choices']['best_buy']} + {res['validation_choices']['best_seller']}")
    th, cth = m['buy_thresholds']['gbt']
    spec = {'format': 'pump-model-v1', 'name': os.path.basename(a.run.rstrip('/')), 'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'source_git': m['config'].get('git'), 'features': m['features'],
            'engine': {'latency_s': E.LATENCY_S, 'cost_per_side': E.COST_PER_SIDE, 'first_sight_s': E.FIRST_SIGHT_S, 'dead_after_s': E.DEAD_AFTER_S,
                       'no_chase': E.NO_CHASE, 'hold_s': E.HOLD_S, 'window_s': E.WINDOW_S},
            'buy': {'kind': 'gbt', 'baseline': float(np.ravel(gbt._baseline_prediction)[0]), 'trees': trees(gbt), 'calibration': list(m['calibration']['gbt']), 'threshold': float(th)},
            'entry_crash': {'scaler': m['buy_scaler'], 'layers': layers(m['entry_crash']), 'threshold': None if cth > 1 else float(cth)},
            'crash': {'scaler': m['stop_scaler'], 'layers': layers(m['crash'])},
            'guard': {**{k: m['guard'][k] for k in ('base', 'early_exit_5s', 'stop_pct', 'crash_threshold', 'ride_trail_pct', 'ride_arm_pct')}, 'early_s': T.EARLY_S},
            'rules_v3': {'take': 30, 'window': 60, 'part': 0.5, 'check_at': 60, 'check_min': 5, 'stop': 25, 'trail': 30, 'arm': 20},
            'test_result': res['test'][res['chosen_system']]}
    assert spec['guard']['ride_arm_pct'] == T.RIDE_ARM * 100
    spec['sha256'] = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True); json.dump(spec, open(a.out, 'w'))
    lm = LiveModel(spec)

    # ---- check 1: numpy-from-JSON vs the original models, on the test block ----
    eps = [e for e in E.load_episodes(a.db, 20) if not e.anomaly and E.buy_decision_time(e) is not None]
    lo, hi = m['config']['test_launch_range']; test = [e for e in eps if lo <= e.created <= hi]   # the run's own test block (corpus keeps growing)
    sc = T.Scaler(); sc.m = np.array(m['buy_scaler']['mean']); sc.s = np.array(m['buy_scaler']['std'])
    ss = T.Scaler(); ss.m = np.array(m['stop_scaler']['mean']); ss.s = np.array(m['stop_scaler']['std'])
    crash = T.mlp(len(m['features']) + 3, (64, 32)); crash.load_state_dict(m['crash']); crash.eval()
    ecr = T.mlp(len(m['features'])); ecr.load_state_dict(m['entry_crash']); ecr.eval()
    a_, b_ = m['calibration']['gbt']; worst = {'buy': 0.0, 'entry_crash': 0.0, 'crash': 0.0}; decisions_differ = 0
    for ep in test:
        d = E.buy_decision_time(ep); e = d + E.LATENCY_S; x = lm.row(ep, d)
        p = np.clip(gbt.predict_proba(np.nan_to_num(x)[None, :])[0, 1], 1e-6, 1 - 1e-6); orig_buy = 1 / (1 + np.exp(-(a_ * np.log(p / (1 - p)) + b_)))
        with torch.no_grad():
            orig_ec = float(torch.sigmoid(ecr(sc(x[None, :])).squeeze())); orig_cr = [float(torch.sigmoid(crash(ss(lm.sell_state(ep, e, t)[None, :])).squeeze())) for t in range(e + 1, min(e + 30, E.WINDOW_S))]
        worst['buy'] = max(worst['buy'], abs(orig_buy - lm.buy_prob(ep, d))); worst['entry_crash'] = max(worst['entry_crash'], abs(orig_ec - lm.entry_crash_prob(ep, d)))
        worst['crash'] = max([worst['crash']] + [abs(o - lm.crash_prob(ep, e, t)) for o, t in zip(orig_cr, range(e + 1, e + 30))])
        decisions_differ += (orig_buy >= th and (cth > 1 or orig_ec < cth)) != lm.buy_ok(ep, d)
    print('max |numpy - original|:', {k: f'{v:.2e}' for k, v in worst.items()}, '· buy decisions that differ:', decisions_differ, 'of', len(test))
    if max(worst.values()) > 1e-4 or decisions_differ: sys.exit('EXPORT CHECK FAILED')

    # ---- check 2: engine result from the JSON model equals the training run's chosen test result ----
    rets = [tr.net_return_pct() for d, bought, tr in (lm.trade(ep) for ep in test) if bought]
    got = E.summarize(rets); want = res['test'][res['chosen_system']]
    print('test result from JSON model:', {k: got[k] for k in ('trades', 'avg_pct', 'median_pct')}, 'training run:', {k: want[k] for k in ('trades', 'avg_pct', 'median_pct')})
    if (got['trades'], got['avg_pct'], got['median_pct']) != (want['trades'], want['avg_pct'], want['median_pct']): sys.exit('EXPORT CHECK FAILED: trade results differ')

    # ---- fixtures for src/model.ts: raw inputs + expected outputs ----
    db = sqlite3.connect(a.db); rng = np.random.default_rng(0)
    bought = [ep for ep in test if lm.trade(ep)[1]]; skipped = [ep for ep in test if not lm.trade(ep)[1]]
    pick = list(rng.choice(bought, min(len(bought), a.n_fixtures // 2 + 2), replace=False)) + list(rng.choice(skipped, min(len(skipped), a.n_fixtures // 2 - 2), replace=False))
    fx = []
    for ep in pick:
        d, b, tr = lm.trade(ep); e = d + E.LATENCY_S; end = min(E.WINDOW_S, e + E.HOLD_S)
        raw = db.execute('SELECT sec, wallet, side, sol FROM trades WHERE mint=? ORDER BY ts', (ep.mint,)).fetchall() if ep.trades is not None else None
        # API-shaped raw data (as the Worker receives it) so src/launch-data.ts can be checked against load_episodes
        desc, img, mayhem = db.execute('SELECT description, image_uri, mayhem FROM tokens WHERE mint=?', (ep.mint,)).fetchone()
        iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{ms % 1000:03d}Z'
        api = {'created': ep.created, 'coin': {'name': ep.name, 'creator': ep.creator, 'description': desc, 'image_uri': img, 'mayhem_state': bool(mayhem)},
               'candles': [{'timestamp': ep.created + s * 1000, 'close': c, 'volume': v} for s, c, v in db.execute('SELECT sec, close, volume FROM candles WHERE mint=?', (ep.mint,))],
               'trades': None if ep.trades is None else [{'timestamp': iso(ts), 'userAddress': w, 'type': side, 'amountSol': sol, 'tx': tx}
                                                           for ts, w, side, sol, tx in db.execute('SELECT ts, wallet, side, sol, tx FROM trades WHERE mint=? ORDER BY ts', (ep.mint,))]}
        fx.append({'mint': ep.mint, 'creator': ep.creator, 'tags': ep.tags, 'price': ep.price.tolist(), 'volume': ep.volume.tolist(), 'trades': raw, 'api': api,
                   'expect': {'decision_t': d, 'row_at_decision': [None if np.isnan(v) else float(v) for v in lm.row(ep, d)], 'buy_prob': lm.buy_prob(ep, d),
                              'entry_crash_prob': lm.entry_crash_prob(ep, d), 'crash_prob': {str(t): lm.crash_prob(ep, e, t) for t in range(e + 1, min(e + 40, end))},
                              'bought': b, 'fills': tr.fills if tr else None, 'net_pct': tr.net_return_pct() if tr else None,
                              'feedback': F.label_trade(ep, d, b, trade=tr, seller=lm.seller())}})
    os.makedirs(a.fixtures, exist_ok=True)
    json.dump({'model': spec, 'launches': fx}, open(os.path.join(a.fixtures, 'model_parity.json'), 'w'))
    print(f'wrote {a.out} (sha {spec["sha256"]}, {os.path.getsize(a.out)//1024} KB) and {len(fx)} parity launches ({sum(f["expect"]["bought"] for f in fx)} bought)')

if __name__ == '__main__':
    main()
