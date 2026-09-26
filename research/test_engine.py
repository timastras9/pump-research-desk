"""Engine checks: delayed fills, costs, partial sells, forced exit, causal features. Run: python -m unittest research/test_engine.py"""
import unittest
import numpy as np
from research import engine as E

def ep_from(prices, trades=None):
    p = np.array(prices + [prices[-1]] * (E.WINDOW_S + 1 - len(prices)), dtype=float)
    return E.Episode('m', 't', 0, 'dev', {'fee_routed': False, 'mayhem': False, 'terminal': True}, p, np.ones(E.WINDOW_S + 1), trades, False, trades is not None)

class EngineTest(unittest.TestCase):
    def test_entry_waits_for_first_trade_after_first_sight_and_fills_later(self):
        prices = [1.0] * 8 + [1.1] + [1.2] * 5
        ep = ep_from(prices)
        self.assertEqual(E.buy_decision_time(ep), 8)
        tr = E.simulate(ep, E.hold_policy)
        self.assertEqual(tr.entry_t, 10); self.assertAlmostEqual(tr.entry_price, 1.2)

    def test_costs_both_sides_and_forced_exit(self):
        ep = ep_from([1.0] * 8 + [1.1] + [1.2] * 5)
        tr = E.simulate(ep, E.hold_policy)
        expected = ((1.2 / 1.2) * (1 - E.COST_PER_SIDE) / (1 + E.COST_PER_SIDE) - 1) * 100
        self.assertAlmostEqual(tr.net_return_pct(), expected, places=6)
        self.assertEqual(tr.fills[-1][1], min(E.WINDOW_S, tr.entry_t + E.HOLD_S))

    def test_sell_decision_fills_latency_later_at_the_later_price(self):
        prices = [1.0] * 8 + [1.1] + [1.0, 1.0, 1.0, 2.0, 2.0, 0.5, 0.5]
        ep = ep_from(prices)
        tr = E.simulate(ep, lambda ep, e, t, held, tr: held if t == 12 else 0.0)
        self.assertEqual(tr.fills[0][:2], (12, 14)); self.assertAlmostEqual(tr.fills[0][3], 0.5)   # decided at the top, filled after the crash

    def test_partial_sell_blends_both_legs(self):
        prices = [1.0] * 8 + [1.1] + [1.0] * 3 + [1.5] * 3 + [2.0] * 4
        ep = ep_from(prices)
        tr = E.simulate(ep, lambda ep, e, t, held, tr: 0.5 if t == 12 else (held if t == 16 else 0.0))
        self.assertEqual([round(f[2], 2) for f in tr.fills], [0.5, 0.5])
        expected = ((0.5 * 1.5 + 0.5 * 2.0) * (1 - E.COST_PER_SIDE) / (1 + E.COST_PER_SIDE) - 1) * 100
        self.assertAlmostEqual(tr.net_return_pct(), expected, places=6)

    def test_features_do_not_look_ahead(self):
        prices = [1.0] * 10 + [5.0] * 5
        ep = ep_from(prices)
        a = E.features(ep, 9); ep.price[10:] = 100.0; b = E.features(ep, 9)
        self.assertEqual(a, b)

    def test_wallet_features_count_buyers_sellers_dev_and_snipers(self):
        n = E.WINDOW_S + 1; z = lambda: np.zeros(n)
        tr = {'buy_sol': z(), 'sell_sol': z(), 'buys': z(), 'sells': z(), 'dev_buy': z(), 'dev_sell': z(),
              'first_buy_sec': {'dev': 0, 'a': 2, 'b': 6}, 'seller_first': {'a': 7}, 'buy_by_sec': [[] for _ in range(n)]}
        tr['buy_by_sec'][0] = [('dev', 1.0)]; tr['buy_by_sec'][2] = [('a', 0.5)]; tr['buy_by_sec'][6] = [('b', 0.2)]
        tr['buy_sol'][0] = 1.0; tr['buy_sol'][2] = 0.5; tr['buy_sol'][6] = 0.2; tr['sell_sol'][7] = 0.4; tr['dev_buy'][0] = 1.0
        ep = ep_from([1.0] * 20, tr)
        f = E.features(ep, 7)
        self.assertEqual((f['buyers'], f['sellers'], f['snipers'], f['dev_bought_sol']), (3.0, 1.0, 1.0, 1.0))
        self.assertAlmostEqual(f['net_sol'], 1.3); self.assertAlmostEqual(f['churn_share'], 1 / 3)
        self.assertEqual(E.features(ep, 5)['sellers'], 0.0)

if __name__ == '__main__':
    unittest.main()
