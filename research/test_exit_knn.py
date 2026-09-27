"""kNN exit lookup checks. Run: PYTHONPATH=. python -m unittest research/test_exit_knn.py"""
import unittest
import numpy as np
from research import engine as E
from research import exit_knn as K


def ep_from(prices):
    p = np.array(prices + [prices[-1]] * (E.WINDOW_S + 1 - len(prices)), dtype=float)
    return E.Episode('m', 't', 0, 'dev', {'fee_routed': False, 'mayhem': False, 'terminal': True}, p, np.ones(E.WINDOW_S + 1), None, False, False)


class ExitKnnTest(unittest.TestCase):
    def test_outcome_is_after_entry_only(self):
        ep = ep_from([1.0] * 10 + [2.0] + [1.5] * 5)   # pump at 10 s, entry at 12 s is after it
        peak, secs, drop = K.outcome(ep, 12)
        self.assertAlmostEqual(peak, 0.0); self.assertEqual(secs, 0); self.assertAlmostEqual(drop, 0.0)
        peak, secs, _ = K.outcome(ep, 9)
        self.assertAlmostEqual(peak, 100.0); self.assertEqual(secs, 1)

    def test_plan_follows_neighbours_and_policy_exits(self):
        eps = [ep_from([1.0] * 8 + [1.01] + [1.0 + 0.01 * i for i in range(1, 40)]) for _ in range(30)]
        X, Y = K.build_table(eps)
        self.assertEqual(len(X), 30)
        make = K.knn_policy(X, Y, k=5)
        pol, (tp, sl, tmax) = make(eps[0], E.buy_decision_time(eps[0]))
        self.assertGreaterEqual(tp, 5.0); self.assertLessEqual(sl, -5.0); self.assertGreater(tmax, 0)
        tr = E.simulate(eps[0], pol)
        self.assertTrue(tr.fills, 'the plan closes the position')


if __name__ == '__main__':
    unittest.main()
