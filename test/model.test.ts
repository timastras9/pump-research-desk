import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Model, featureTable, buyDecisionTime, guardDecision, simulate, netReturnPct, type Launch, type ModelSpec } from '../src/model';

// Written by scripts/export_model.py from research/live_model.py (which matches the original PyTorch/sklearn models).
const fx = JSON.parse(readFileSync(new URL('./fixtures/model_parity.json', import.meta.url), 'utf8')) as { model: ModelSpec; launches: (Launch & { expect: any })[] };
const model = new Model(fx.model);
const close = (a: number, b: number, rel: number, abs: number) => Math.abs(a - b) <= abs + rel * Math.abs(b);

test('parity fixtures cover bought and skipped launches, with and without wallet data', () => {
  assert.ok(fx.launches.filter(l => l.expect.bought).length >= 4 && fx.launches.filter(l => !l.expect.bought).length >= 2);
  assert.ok(fx.launches.some(l => l.trades));
});

test('features at the buy decision match Python', () => {
  for (const l of fx.launches) {
    const row = model.row(l, l.expect.decision_t);
    l.expect.row_at_decision.forEach((want: number | null, i: number) => {
      if (want === null) assert.ok(Number.isNaN(row[i]), `${l.mint} feature ${fx.model.features[i]} should be missing`);
      else assert.ok(close(row[i], want, 1e-5, 1e-5), `${l.mint} feature ${fx.model.features[i]}: ${row[i]} vs ${want}`);
    });
  }
});

test('buy score, entry-crash risk and per-second crash risk match Python', () => {
  for (const l of fx.launches) {
    const d = l.expect.decision_t;
    assert.equal(buyDecisionTime(l.price, fx.model.engine), d);
    assert.ok(close(model.buyProb(l, d), l.expect.buy_prob, 0, 1e-4), `${l.mint} buy ${model.buyProb(l, d)} vs ${l.expect.buy_prob}`);
    assert.ok(close(model.entryCrashProb(l, d), l.expect.entry_crash_prob, 0, 1e-4), `${l.mint} entry crash`);
    const e = d + fx.model.engine.latency_s;
    for (const [t, want] of Object.entries(l.expect.crash_prob)) assert.ok(close(model.crashProb(l, e, Number(t)), want as number, 0, 1e-4), `${l.mint} crash at ${t}`);
  }
});

test('whole trade (buy, every fill, net after costs) matches Python exactly', () => {
  for (const l of fx.launches) {
    const tr = model.trade(l);
    assert.equal(tr.bought, l.expect.bought, l.mint);
    if (!tr.bought) continue;
    assert.deepEqual(tr.fills!.map(f => f.slice(0, 2)), l.expect.fills.map((f: number[]) => f.slice(0, 2)), `${l.mint} fill seconds`);
    tr.fills!.forEach((f, i) => { assert.ok(close(f[2], l.expect.fills[i][2], 1e-9, 1e-12)); assert.equal(f[3], l.expect.fills[i][3]); });
    assert.ok(close(tr.netPct!, l.expect.net_pct, 1e-9, 1e-9), `${l.mint} net ${tr.netPct} vs ${l.expect.net_pct}`);
  }
});

test('engine rules: guard order, ride the climb, delayed fills, costs', () => {
  const g = { base: 'rules_v3' as const, early_exit_5s: true, stop_pct: 5, crash_threshold: 0.5, ride_trail_pct: 10, ride_arm_pct: 10, early_s: 5 };
  const p = [1.0, 1.05, 1.2, 1.5, 2.0, 1.9, 1.75];
  assert.equal(guardDecision(p, 0, 1, g, () => 0), 'base');
  assert.deepEqual([2, 3, 4, 5].map(t => guardDecision(p, 0, t, g, () => 0)), ['hold', 'hold', 'hold', 'hold']);
  assert.equal(guardDecision(p, 0, 6, g, () => 0), 'sell');
  assert.equal(guardDecision(p, 0, 3, g, () => 0.9), 'sell', 'a predicted crash exits even while climbing');
  assert.equal(guardDecision([1, 0.99], 0, 1, g, () => 0), 'sell', 'below entry inside 5 s');
  const eng = fx.model.engine, price = Array.from({ length: eng.window_s + 1 }, (_, t) => (t < 14 ? 1 : 2));
  const { entryT, fills } = simulate(price, eng, (e, t, held) => (t === 13 ? held : 0), 10);
  assert.deepEqual([entryT, fills[0][0], fills[0][1], fills[0][3]], [12, 13, 15, 2], 'decided at 13 (first second after entry), filled 2 s later');
  assert.ok(close(netReturnPct(1, [[13, 15, 1, 2]], eng.cost_per_side), ((2 * (1 - 0.0325)) / (1 + 0.0325) - 1) * 100, 1e-12, 1e-12));
});

test('a launch with no wallet data gets missing wallet features, not zeros', () => {
  const l = fx.launches.find(x => !x.trades) ?? { ...fx.launches[0], trades: null };
  const row = featureTable({ ...l, trades: null }, fx.model.engine.window_s)[10];
  assert.ok(row.slice(11, 23).every(Number.isNaN));
});
