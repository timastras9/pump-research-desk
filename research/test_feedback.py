"""Mistake-label checks on synthetic launches. Buy decision is at 8 s, entry fills at 10 s (price 1.1).
Run: python -m unittest research/test_feedback.py"""
import json, os, sqlite3, tempfile, unittest
from research import engine as E, feedback as F
from research.test_engine import ep_from

HOLD = E.hold_policy
sell_at_gain = lambda g: (lambda ep, e, t, held, tr: held if ep.price[t] / ep.price[e] - 1 >= g else 0.0)

def ep(prices, mint='m'):
    x = ep_from(prices); x.mint = mint; return x

class FeedbackTest(unittest.TestCase):
    def test_flat_bought_is_no_opportunity_dead_and_skip_is_correct(self):
        x = ep([1.0] * 8 + [1.1] * 5)
        b = F.label_trade(x, 8, True)
        self.assertEqual((b['buy_label'], b['loser_reason']), ('bought_no_opportunity', 'dead_after_entry'))
        self.assertEqual(F.label_trade(x, 8, False)['buy_label'], 'correct_skip')

    def test_skipped_riser_is_policy_profitable(self):
        x = ep([1.0] * 8 + [1.1] * 12 + [1.65] * 5)            # +50% from 20 s and stays
        r = F.label_trade(x, 8, False, seller=E.rules_v3())
        self.assertEqual(r['buy_label'], 'skipped_policy_profitable'); self.assertEqual(r['bought'], 0); self.assertEqual(r['sell_labels'], [])

    def test_one_second_spike_inside_the_delay_is_unreachable(self):
        x = ep([1.0] * 8 + [1.1] * 3 + [1.54] + [1.1] * 5)     # +40% only at 11 s; the earliest sale fills at 13 s
        r = F.label_trade(x, 8, True)
        self.assertEqual((r['buy_label'], r['loser_reason']), ('bought_no_opportunity', 'spike_shorter_than_delay'))

    def test_selling_at_plus_10_before_plus_80_is_premature(self):
        x = ep([1.0] * 8 + [1.1] * 10 + [1.1 * 1.12] * 10 + [1.1 * 1.8] * 5)
        r = F.label_trade(x, 8, True, seller=sell_at_gain(0.10))
        self.assertIn('premature_exit', r['sell_labels']); self.assertNotIn('giveback', r['sell_labels'])
        self.assertEqual(r['buy_label'], 'bought_opportunity'); self.assertAlmostEqual(r['regret_pp'], 80 - 12, places=3)

    def test_holding_from_plus_100_down_to_plus_5_is_giveback_and_deadline(self):
        x = ep([1.0] * 8 + [1.1] * 10 + [2.2] * 20 + [1.155] * 5)
        r = F.label_trade(x, 8, True, seller=HOLD)
        self.assertIn('giveback', r['sell_labels']); self.assertIn('deadline_breach', r['sell_labels'])

    def test_hold_forever_is_deadline_breach(self):
        r = F.label_trade(ep([1.0] * 8 + [1.1] * 5), 8, True, seller=HOLD)
        self.assertIn('deadline_breach', r['sell_labels'])

    def test_partial_sale_before_a_collapse_is_bad_sizing(self):
        half_then_hold = lambda ep, e, t, held, tr: 0.5 if (not tr.fills and ep.price[t] / ep.price[e] >= 1.49) else 0.0
        x = ep([1.0] * 8 + [1.1] * 10 + [1.65] * 10 + [0.55] * 5)
        r = F.label_trade(x, 8, True, seller=half_then_hold)
        self.assertIn('bad_partial_sizing', r['sell_labels'])

    def test_fill_at_dust_price_is_failed_liquidation(self):
        x = ep([1.0] * 8 + [1.1] * 10 + [0.005] * 5)
        r = F.label_trade(x, 8, True, seller=E.rules_v3())
        self.assertIn('failed_liquidation', r['sell_labels'])

    def test_net_matches_the_engine_exactly(self):
        import numpy as np
        rng = np.random.default_rng(3); prices = [1.0] * 8 + list(1.1 * np.exp(np.cumsum(rng.normal(0, 0.08, 200))))
        x = ep(prices); r = F.label_trade(x, 8, True, seller=E.rules_v3())
        self.assertAlmostEqual(r['net_pct'], round(E.simulate(x, E.rules_v3(), decision_t=8).net_return_pct(), 4), places=9)

    def test_relabel_is_a_new_run_and_never_changes_old_rows(self):
        eps = [ep([1.0] * 8 + [1.1] * 12 + [1.65] * 5, 'a'), ep([1.0] * 8 + [1.1] * 5, 'b')]
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, 'fb.db')
            r1 = F.label_corpus(eps, lambda ep, t: True, E.rules_v3(), db)
            before = sqlite3.connect(db).execute('SELECT * FROM mistakes WHERE run_id=? ORDER BY mint', (r1['run_id'],)).fetchall()
            r2 = F.label_corpus(eps, lambda ep, t: False, E.rules_v3(), db)
            con = sqlite3.connect(db)
            self.assertNotEqual(r1['run_id'], r2['run_id'])
            self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0], 2)
            self.assertEqual(con.execute('SELECT * FROM mistakes WHERE run_id=? ORDER BY mint', (r1['run_id'],)).fetchall(), before)
            self.assertEqual(json.loads(con.execute('SELECT counts_json FROM runs WHERE run_id=?', (r2['run_id'],)).fetchone()[0]),
                             {'skipped_policy_profitable': 1, 'correct_skip': 1})

if __name__ == '__main__':
    unittest.main()
