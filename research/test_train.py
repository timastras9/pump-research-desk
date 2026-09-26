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

    def test_buy_report(self):
        r = T.buy_report([1, 1, 0, 0], [1, 0, 1, 0])
        self.assertEqual((r['coverage'], r['winner_retention'], r['loser_rejection'], r['precision']), (0.5, 0.5, 0.5, 0.5))

if __name__ == '__main__':
    unittest.main()
