"""Promotion gate checks. Run: python -m unittest research/test_promotion_gate.py"""
import importlib.util, os, unittest
import numpy as np

_spec = importlib.util.spec_from_file_location('promotion_gate', os.path.join(os.path.dirname(__file__), '..', 'scripts', 'promotion_gate.py'))
G = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(G)

def trades(strategy, pcts, days, start_day=1):
    """Spread pcts evenly across `days` UTC days, in order."""
    out = []; per = int(np.ceil(len(pcts) / days))
    for i, p in enumerate(pcts):
        d = start_day + i // per; sec = (i % per) * 60
        out.append({'closed_at': f'2026-10-{d:02d}T{sec // 3600:02d}:{sec // 60 % 60:02d}:{sec % 60:02d}Z', 'strategy': strategy, 'net_pct': p})
    return out

rng = np.random.default_rng(0)
champion = trades('paper-v3', list(rng.normal(-5, 10, 300)), 4)
failed = lambda r: sorted(c['name'] for c in r['checks'] if not c['passed'])

class GateTest(unittest.TestCase):
    def test_good_challenger_passes(self):
        r = G.evaluate(trades('model', list(rng.normal(10, 5, 250)), 4) + champion, 'model', 'paper-v3')
        self.assertTrue(r['passed'], r['checks']); self.assertEqual(r['champion_trades_same_days'], 300)

    def test_too_few_trades(self):
        self.assertEqual(failed(G.evaluate(trades('model', [10.0] * 150, 4) + champion, 'model', 'paper-v3')), ['trades'])

    def test_too_few_days(self):
        self.assertEqual(failed(G.evaluate(trades('model', [10.0] * 250, 2) + champion, 'model', 'paper-v3')), ['utc_days'])

    def test_drawdown_across_midnight(self):
        p = [10.0] * 250; p[120:130] = [-25.0] * 10            # -$5 run straddling day 2/3, each day loses only -$2.50 net of wins
        r = G.evaluate(trades('model', p, 4, start_day=1) + champion, 'model', 'paper-v3')
        self.assertIn('max_drawdown_usd', failed(r)); self.assertNotIn('worst_day_usd', failed(r))

    def test_bad_day(self):
        p = [1.0] * 250; p[63:126] = [0.0] * 63; p[70:77] = [-23.0] * 7   # day 2 loses -$3.22; drawdown stays above -$4
        r = G.evaluate(trades('model', p, 4) + champion, 'model', 'paper-v3')
        self.assertEqual(failed(r), ['worst_day_usd'])

    def test_not_clearly_better_than_champion(self):
        champ0 = trades('paper-v3', [0.0] * 300, 4)
        r = G.evaluate(trades('model', list(rng.normal(0.2, 5, 250)), 4) + champ0, 'model', 'paper-v3')
        self.assertIn('profit_per_trade_lower95_vs_champion', failed(r)); self.assertFalse(r['passed'])

    def test_no_champion_trades_fails_instead_of_passing(self):
        r = G.evaluate(trades('model', [10.0] * 250, 4), 'model', 'paper-v3')
        self.assertEqual(failed(r), ['profit_per_trade_lower95_vs_champion'])

if __name__ == '__main__':
    unittest.main()
