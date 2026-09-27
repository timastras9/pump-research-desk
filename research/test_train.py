"""Training helper checks: purged chronological split, sigmoid calibration, partial-sell mapping, stress context.
Run: python -m unittest research/test_train.py"""
import unittest
import numpy as np
from research import engine as E, train as T

class Ep:
    def __init__(self, created): self.created = created

class TrainHelpersTest(unittest.TestCase):
    def test_split_is_chronological_and_purged(self):
        eps = [Ep(i * 300_000) for i in range(100)]           # one launch per 5 min; windows last 12 minutes
        blocks = T.split_purged(eps)
        for a, b in zip(blocks, blocks[1:]):
            self.assertTrue(all(e.created + E.WINDOW_S * 1000 <= b[0].created for e in a))   # no window reaches the next block
            self.assertLess(a[-1].created, b[0].created)
        self.assertEqual(len(blocks[-1]), 20)                # test block is never purged

    def test_platt_recovers_known_calibration(self):
        rng = np.random.default_rng(0); s = rng.normal(0, 2, 20000); y = (rng.random(20000) < 1 / (1 + np.exp(-(0.5 * s - 1)))).astype(float)
        a, b = T.platt(s, y)
        self.assertAlmostEqual(a, 0.5, delta=0.05); self.assertAlmostEqual(b, -1.0, delta=0.08)

    def test_votes_map_to_hold_25_50_100(self):
        self.assertEqual([T.FRACTION(v, 4) for v in range(5)], [0.0, 0.25, 0.5, 1.0, 1.0])

    def test_market_context_restores_assumptions(self):
        with T.market(5, 0.05): self.assertEqual((E.LATENCY_S, E.COST_PER_SIDE), (5, 0.05))
        self.assertEqual((E.LATENCY_S, E.COST_PER_SIDE), (2, 0.0325))

    def test_crash_label_window_and_depth(self):
        p = np.array([1.0] * 5 + [0.79] + [1.0] * 30)            # 21% drop 5 s after t=0
        self.assertEqual(T.crash_label(p, 0, 35), 1.0)            # inside latency (2) + 10 s
        self.assertEqual(T.crash_label(p, 0, 35, h=2), 0.0)       # window ends at t+4, drop at 5 is outside
        self.assertEqual(T.crash_label(np.array([1.0] * 5 + [0.81] + [1.0] * 30), 0, 35), 0.0)   # 19% is not a crash
        self.assertEqual(T.crash_label(p, 0, 4), 0.0)             # window never passes the horizon end

    def test_crash_label_ignores_the_past(self):
        p = np.array([2.0, 0.5] + [1.0] * 30)                     # a crash before t=2 must not count
        self.assertEqual(T.crash_label(p, 2, 31), 0.0)

    def test_entry_crash_label(self):
        p = np.array([1.0] * 10 + [0.69] + [1.0] * 20)
        self.assertEqual(T.entry_crash_label(p, 0, 30), 1.0); self.assertEqual(T.entry_crash_label(p, 1, 30), 1.0)
        self.assertEqual(T.entry_crash_label(p, 0, 30, h=9), 0.0)

    def test_guard_rides_the_climb_and_exits_on_drop_from_high(self):
        p = np.array([1.0, 1.05, 1.2, 1.5, 2.0, 1.9, 1.75, 1.6])
        g = lambda t, ride=0.10, th_c=9, cp=0.0: T.guard_decision(p, 0, t, True, 0.05, lambda: cp, th_c, ride)
        self.assertEqual(g(1), 'base')                     # +5%: not armed yet, base seller decides
        self.assertEqual([g(t) for t in (2, 3, 4, 5)], ['hold'] * 4)   # climbing or within 10% of the 2.0 high: hold
        self.assertEqual(g(6), 'sell')                     # 1.75 is 12.5% below the high
        self.assertEqual(g(3, th_c=0.5, cp=0.9), 'sell')   # a predicted crash still exits during the climb
        self.assertEqual(g(3, ride=None), 'base')          # ride off: base seller decides

    def test_guard_loss_protection_comes_first(self):
        p = np.array([1.0, 0.99, 1.3, 0.94])
        self.assertEqual(T.guard_decision(p, 0, 1, True, 0.05, lambda: 0, 9, 0.1), 'sell')    # below entry inside 5 s
        self.assertEqual(T.guard_decision(p, 0, 1, False, 0.05, lambda: 0, 9, 0.1), 'base')   # early rule off
        self.assertEqual(T.guard_decision(p, 0, 3, False, 0.05, lambda: 0, 9, None), 'sell')  # -6% hits the 5% stop

    def test_buy_report(self):
        r = T.buy_report([1, 1, 0, 0], [1, 0, 1, 0])
        self.assertEqual((r['coverage'], r['winner_retention'], r['loser_rejection'], r['precision']), (0.5, 0.5, 0.5, 0.5))

if __name__ == '__main__':
    unittest.main()
