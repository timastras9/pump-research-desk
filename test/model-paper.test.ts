import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Model, type Launch } from '../src/model';
import { modelRow, labelTrade, summarizeRows, feasibleFills } from '../src/model-paper';

const fx = JSON.parse(readFileSync(new URL('./fixtures/model_parity.json', import.meta.url), 'utf8'));
const model = new Model(fx.model), eng = fx.model.engine;

test('feedback labels match research/feedback.py on every parity launch', () => {
  for (const l of fx.launches) {
    const r = modelRow(model, l), want = l.expect.feedback;
    assert.equal(r.feedback!.buyLabel, want.buy_label, `${l.mint} buy label`);
    assert.deepEqual(r.feedback!.sellLabels, want.sell_labels, `${l.mint} sell labels`);
    assert.equal(r.feedback!.loserReason, want.loser_reason, `${l.mint} loser reason`);
    assert.ok(Math.abs(r.feedback!.netPct - want.net_pct) < 1e-3, `${l.mint} net`);
    assert.ok(Math.abs(r.feedback!.bestFeasibleGrossPct - want.best_feasible_gross_pct) < 1e-3, `${l.mint} best`);
    if (want.bought) assert.ok(Math.abs(r.feedback!.regretPp - want.regret_pp) < 1e-3, `${l.mint} regret`);
  }
});

test('row: trade matches the model, skipped launches get a shadow outcome not a trade', () => {
  for (const l of fx.launches) {
    const r = modelRow(model, l);
    assert.equal(r.bought, l.expect.bought);
    if (r.bought) { assert.ok(Math.abs(r.trade!.netPct - l.expect.net_pct) < 1e-9); assert.equal(r.shadow, null); assert.equal(r.trade!.reasons.length, r.trade!.fills.length); }
    else { assert.equal(r.trade, null); assert.ok(r.shadow); }
    assert.ok(r.rulesV3 && r.actual && r.predictedVsActual);
  }
});

const flat = (n: number, v: number) => new Array(n).fill(v);
const launch = (price: number[]): Launch => {
  const p = [...price, ...flat(eng.window_s + 1 - price.length, price[price.length - 1])];
  return { mint: 'x', creator: null, tags: { fee_routed: false, mayhem: false, terminal: true }, price: p, volume: p.map(() => 1), trades: null };
};

test('peak, best reachable exit and timing differences are measured from entry', () => {
  // decision at 8 s (first move after first sight at 5 s), entry fills at 10 s at 1.1; peak 2.2 at 40 s; drops to 1.3 later
  const l = launch([...flat(8, 1), ...flat(32, 1.1), 2.2, ...flat(30, 1.3)]);
  const r = modelRow(model, l);
  assert.equal(r.decisionT, 8); assert.equal(r.entryT, 10);
  assert.equal(r.actual!.peakSec, 40); assert.ok(Math.abs(r.actual!.peakPct - 100) < 1e-9);
  assert.deepEqual([r.actual!.best.decisionSec, r.actual!.best.fillSec], [38, 40], 'best exit: decide 2 s before the peak');
  assert.equal(r.actual!.winner, true);
  if (r.trade) {
    assert.equal(r.predictedVsActual!.exitVsBestSec, r.trade.exitDecisionSec - 38);
    assert.ok(Math.abs(r.predictedVsActual!.missVsPeakPts! - (100 - r.trade.exitGrossPct)) < 1e-9);
  }
});

test('crash start is the first second a 20% drop from there begins within latency + 10 s', () => {
  const l = launch([...flat(8, 1), ...flat(22, 1.1), ...flat(10, 1.0), 0.75, ...flat(20, 0.75)]);   // 1.0 -> 0.75 at 40 s
  const r = modelRow(model, l);
  assert.equal(r.actual!.crashStartSec, 28, '1.1 at 28 s is 31.8% above 0.75 at 40 s = 12 s later (the window limit)');
});

test('labelTrade: skipped launch with no profitable exit is a correct skip; flat bought is dead after entry', () => {
  const p = launch([...flat(8, 1), ...flat(5, 1.1)]).price;
  const end = Math.min(eng.window_s, 10 + eng.hold_s);
  assert.equal(labelTrade(p, 8, false, [[end, end, 1, p[end]]], eng).buyLabel, 'correct_skip');
  const b = labelTrade(p, 8, true, [[end, end, 1, p[end]]], eng);
  assert.deepEqual([b.buyLabel, b.loserReason, b.sellLabels], ['bought_no_opportunity', 'dead_after_entry', ['deadline_breach']]);
  assert.equal(feasibleFills(p, 10, eng).length, end - 10);
});

test('live feasibility: a buy decision before our feed saw the token is flagged and counted', () => {
  const l = fx.launches.find((x: any) => x.expect.bought)!, d = l.expect.decision_t;
  assert.equal(modelRow(model, l, d - 3).liveFeasible, true, 'seen 3 s before the decision');
  assert.equal(modelRow(model, l, d + 20).liveFeasible, false, 'seen 20 s after the decision: not tradable live');
  assert.equal(modelRow(model, l).liveFeasible, null, 'unknown when the seen time is missing');
  const s = summarizeRows([modelRow(model, l, d - 3), modelRow(model, l, d + 20)]);
  assert.equal(s.latency.tradesLiveFeasible, 0.5); assert.equal(s.latency.tradesWithSeenTime, 2); assert.equal(s.latency.seenAgeS.n, 2);
});

test('run summary: model vs rules v3, label counts, timing stats', () => {
  const rows = fx.launches.map((l: any) => modelRow(model, l));
  const s = summarizeRows(rows);
  assert.equal(s.tokens, 12); assert.equal(s.model.trades, rows.filter((r: any) => r.trade).length);
  assert.equal(s.rulesV3.trades, 12, 'rules v3 trades every launch with a buy decision');
  assert.equal(Object.values(s.labels).length > 0, true);
  assert.equal(s.timing.exitVsBestSec.n, s.model.trades);
});
