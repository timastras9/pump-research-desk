"""Reference implementation of the deployed model, driven only by the exported JSON (numpy, no torch/sklearn).

scripts/export_model.py writes the JSON and checks this file against the original PyTorch/sklearn models.
src/model.ts (the Cloudflare Worker) must match this file on the fixtures in test/fixtures/model_parity.json.
"""
import json
import numpy as np
from research import engine as E

def mlp_forward(layers, x):
    for i, (W, b) in enumerate(layers):
        x = x @ np.asarray(W).T + np.asarray(b)
        if i < len(layers) - 1: x = np.maximum(x, 0.0)
    return x

def scale(scaler, x):
    z = (np.nan_to_num(np.asarray(x, dtype=float), nan=0.0) - np.asarray(scaler['mean'])) / np.asarray(scaler['std'])
    return np.clip(z, -8, 8)

sigmoid = lambda z: 1 / (1 + np.exp(-z))

def gbt_raw(buy, x):
    """Sum of tree leaf values plus the baseline. Nodes: [feature, threshold, left, right, is_leaf, value, missing_left]."""
    raw = buy['baseline']
    for tree in buy['trees']:
        i = 0
        while not tree[i][4]:
            f, th, left, right, _, _, miss_left = tree[i]
            v = x[f]
            i = (left if miss_left else right) if np.isnan(v) else (left if v <= th else right)
        raw += tree[i][5]
    return raw

class LiveModel:
    def __init__(self, spec):
        self.spec = spec if isinstance(spec, dict) else json.load(open(spec))
        s = self.spec; self.g = s['guard']

    def row(self, ep, t):
        return np.append(E.feature_table(ep)[t].astype(float), float(ep.trades is not None))

    def buy_prob(self, ep, d):
        b = self.spec['buy']; p = sigmoid(gbt_raw(b, np.nan_to_num(self.row(ep, d))))
        p = min(max(p, 1e-6), 1 - 1e-6); a, c = b['calibration']
        return float(sigmoid(a * np.log(p / (1 - p)) + c))

    def entry_crash_prob(self, ep, d):
        m = self.spec['entry_crash']; return float(sigmoid(mlp_forward(m['layers'], scale(m['scaler'], self.row(ep, d)))[0]))

    def sell_state(self, ep, e, t):
        pe = ep.price[e]; return np.append(self.row(ep, t), [(ep.price[t] / pe - 1) * 100, (ep.price[e:t + 1].max() / pe - 1) * 100, t - e])

    def crash_prob(self, ep, e, t):
        m = self.spec['crash']; return float(sigmoid(mlp_forward(m['layers'], scale(m['scaler'], self.sell_state(ep, e, t)))[0]))

    def buy_ok(self, ep, d):
        b, ec = self.spec['buy'], self.spec['entry_crash']
        return self.buy_prob(ep, d) >= b['threshold'] and (ec['threshold'] is None or self.entry_crash_prob(ep, d) < ec['threshold'])

    def seller(self):
        from research.train import guard_decision   # the exact guard used in training
        g = self.g; base = E.rules_v3(**self.spec['rules_v3'])
        stop = g['stop_pct'] / 100; th_c = 9 if g['crash_threshold'] is None else g['crash_threshold']; ride = None if g['ride_trail_pct'] is None else g['ride_trail_pct'] / 100
        def pol(ep, e, t, held, tr):
            dec = guard_decision(ep.price, e, t, g['early_exit_5s'], stop, lambda: self.crash_prob(ep, e, t), th_c, ride)
            return held if dec == 'sell' else 0.0 if dec == 'hold' else base(ep, e, t, held, tr)
        return pol

    def trade(self, ep):
        """(decision_t, bought, Trade or None) for one launch, with the engine's delayed fills and costs."""
        d = E.buy_decision_time(ep)
        if d is None: return None, False, None
        if not self.buy_ok(ep, d): return d, False, None
        return d, True, E.simulate(ep, self.seller(), decision_t=d)
