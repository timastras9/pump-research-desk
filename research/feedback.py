"""Feedback loop, part 1: mistake labels (Astra design, section 4).

Every candidate launch gets one BUY label; every bought position also gets SELL labels and, when no profitable exit
existed, a loser reason. Labels are deterministic evidence from the price path and the ONE accounting engine: no LLM
calls, no hand edits. A relabel is a new run; old rows are never changed. Skipped launches get shadow outcomes
(bought=0), never presented as real trades.

  from research import feedback as F, engine as E
  F.label_corpus('artifacts/corpus/launches.db', lambda ep, d: True, E.rules_v3(), 'artifacts/corpus/feedback.db')
"""
import hashlib, json, sqlite3, time, uuid
import numpy as np
from research import engine as E

LABELER_VERSION = 'feedback-v1'
MIN_FEASIBLE_NET = 0.5      # a feasible opportunity must clear +0.5% net after both costs (same bar as the exit labels)
BIG_MISS_PP = 10.0          # premature exit / giveback: a feasible fill at least 10 points better than what we got
PARTIAL_MISS_PP = 5.0       # bad partial sizing: selling 100% at the first partial beats the result by 5+ points
MAX_FILLS = 3               # more fills than this is excessive turnover
DEAD_PRICE = 0.01           # a fill at or below 1% of entry is treated as unsellable

BUY_LABELS = ('bought_no_opportunity', 'bought_opportunity', 'skipped_policy_profitable', 'skipped_feasible_opportunity', 'correct_skip')
SELL_LABELS = ('premature_exit', 'giveback', 'bad_partial_sizing', 'excessive_turnover', 'deadline_breach', 'failed_liquidation', 'good_exit')

def _net(ep, d, e, fills) -> float:
    """Net return through the engine's own formula (never a second P&L formula)."""
    return E.Trade(ep.mint, d, e, float(ep.price[e]), list(fills)).net_return_pct()

def feasible_fills(ep, e) -> list[tuple[int, int, float]]:
    """Every sell-all the delayed market allowed: (decision second, fill second, fill price). Decisions run from the second
    after entry; holding to the horizon is the last option."""
    p = ep.price; end = min(E.WINDOW_S, e + E.HOLD_S)
    return [(s, min(s + E.LATENCY_S, end), float(p[min(s + E.LATENCY_S, end)])) for s in range(e + 1, end)] + [(end, end, float(p[end]))]

def loser_reason(ep, e) -> str:
    """Why a bought position never offered a profitable exit. Same order and thresholds as scripts/export_label_review.py."""
    p = ep.price; end = min(E.WINDOW_S, e + E.HOLD_S); d = e - E.LATENCY_S
    slip = (p[e] / p[d] - 1) * 100; after = p[e + 1:end + 1]; max_gain = (after.max() / p[e] - 1) * 100
    below = np.nonzero(after < p[e])[0]; secs_below = int(below[0]) + 1 if len(below) else None
    if (after == p[e]).all(): return 'dead_after_entry'
    if slip >= 10 and max_gain <= 0: return 'bought_the_spike'
    if secs_below is not None and secs_below <= E.LATENCY_S and max_gain <= 0: return 'dropped_immediately'
    if max_gain <= 0: return 'never_above_entry'
    if max_gain >= 6.7: return 'spike_shorter_than_delay'
    return 'rose_too_little'

def label_trade(ep, decision_t, bought: bool, trade=None, seller=None) -> dict:
    """Labels for one candidate. decision_t is the buy decision second; entry fills LATENCY_S later."""
    seller = seller or E.rules_v3(); d = decision_t; e = d + E.LATENCY_S; entry = float(ep.price[e])
    gross = lambda px: (px / entry - 1) * 100
    options = feasible_fills(ep, e)
    best = max(options, key=lambda o: (o[2], -o[0]))
    best_net = _net(ep, d, e, [(best[0], best[1], 1.0, best[2])])
    feasible = best_net > MIN_FEASIBLE_NET
    out = {'mint': ep.mint, 'created': ep.created, 'decision_t': d, 'bought': int(bool(bought)), 'best_feasible_gross_pct': round(gross(best[2]), 4),
           'sell_labels': [], 'loser_reason': None}
    if not bought:
        shadow = E.simulate(ep, seller, decision_t=d)
        out['buy_label'] = ('skipped_policy_profitable' if shadow.net_return_pct() > 0 else 'skipped_feasible_opportunity') if feasible else 'correct_skip'
        out.update(net_pct=round(shadow.net_return_pct(), 4), realized_exit_gross_pct=None, regret_pp=0.0)   # shadow outcome, not a trade
        return out

    trade = trade or E.simulate(ep, seller, decision_t=d)
    fills = trade.fills; net = trade.net_return_pct()
    realized = sum(f * gross(px) for _, _, f, px in fills)
    first_dec, last_dec = fills[0][0], fills[-1][0]
    labels = []
    good = lambda o: _net(ep, d, e, [(o[0], o[1], 1.0, o[2])]) > MIN_FEASIBLE_NET
    if any(o[0] > last_dec and gross(o[2]) >= realized + BIG_MISS_PP and good(o) for o in options): labels.append('premature_exit')
    if any(o[0] < first_dec and gross(o[2]) >= realized + BIG_MISS_PP and good(o) for o in options): labels.append('giveback')
    if fills[0][2] < 1 - 1e-9:
        s0, f0, _, px0 = fills[0]
        if _net(ep, d, e, [(s0, f0, 1.0, px0)]) >= net + PARTIAL_MISS_PP: labels.append('bad_partial_sizing')
    if len(fills) > MAX_FILLS: labels.append('excessive_turnover')
    end = min(E.WINDOW_S, e + E.HOLD_S)
    if fills[-1][0] == fills[-1][1] == end: labels.append('deadline_breach')
    if any(px <= DEAD_PRICE * entry for _, _, _, px in fills): labels.append('failed_liquidation')
    if not labels and net > 0: labels.append('good_exit')
    out.update(buy_label='bought_opportunity' if feasible else 'bought_no_opportunity', sell_labels=labels, loser_reason=None if feasible else loser_reason(ep, e),
               net_pct=round(net, 4), realized_exit_gross_pct=round(realized, 4), regret_pp=round(gross(best[2]) - realized, 4))
    return out

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, policy_version TEXT, labeler_version TEXT, db_sha256_of_mint_list TEXT,
    n INTEGER, counts_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS mistakes(run_id TEXT, mint TEXT, created INTEGER, decision_t INTEGER, bought INTEGER, buy_label TEXT,
    sell_labels_json TEXT, loser_reason TEXT, net_pct REAL, realized_exit_gross_pct REAL, best_feasible_gross_pct REAL, regret_pp REAL,
    policy_version TEXT, labeler_version TEXT, labeled_at TEXT, PRIMARY KEY(run_id, mint));
"""

def label_corpus(source, buy_gate, seller, out_db, policy_version='rules_v3') -> dict:
    """Label every tradable, non-anomalous launch. source is a corpus db path or a list of episodes. Returns counts;
    writes one new run (never touches earlier runs)."""
    eps = E.load_episodes(source, 20) if isinstance(source, str) else list(source)
    eps = [ep for ep in eps if not ep.anomaly and E.buy_decision_time(ep) is not None]
    run_id = uuid.uuid4().hex[:12]; now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()); rows, counts = [], {}
    for ep in eps:
        d = E.buy_decision_time(ep); r = label_trade(ep, d, bool(buy_gate(ep, d)), seller=seller)
        for k in [r['buy_label']] + r['sell_labels'] + ([r['loser_reason']] if r['loser_reason'] else []): counts[k] = counts.get(k, 0) + 1
        rows.append((run_id, r['mint'], r['created'], d, r['bought'], r['buy_label'], json.dumps(r['sell_labels']), r['loser_reason'], r['net_pct'],
                     r['realized_exit_gross_pct'], r['best_feasible_gross_pct'], r['regret_pp'], policy_version, LABELER_VERSION, now))
    mint_hash = hashlib.sha256('\n'.join(sorted(ep.mint for ep in eps)).encode()).hexdigest()
    db = sqlite3.connect(out_db)
    with db:
        db.executescript(SCHEMA)
        db.executemany('INSERT INTO mistakes VALUES(' + ','.join('?' * 15) + ')', rows)
        db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?)', (run_id, policy_version, LABELER_VERSION, mint_hash, len(rows), json.dumps(counts, sort_keys=True), now))
    db.close()
    return {'run_id': run_id, 'n': len(rows), 'counts': counts}
