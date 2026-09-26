import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperExecutor, LiveExecutor, riskCheck, executorFor, positionReturnPct, DEFAULT_EXEC, type Order} from '../src/execution';

const order = (side: 'buy' | 'sell', refPrice = 1, fraction = 1): Order => ({id: 'o1', mint: 'M', side, fraction, decidedAt: 1000, refPrice, reason: 'test', strategy: 'rules'});

test('paper executor fills at the price after the latency and charges the per-side cost', async () => {
  const seen: number[] = [];
  const ex = new PaperExecutor(async (_m, at) => { seen.push(at); return 1.03; });
  const f = await ex.submit(order('buy'));
  assert.equal(seen[0], 3000); assert.equal(f.status, 'filled'); assert.equal(f.price, 1.03); assert.ok(Math.abs(f.feesUsd - 2 * 0.0325) < 1e-9); assert.equal(f.mode, 'paper');
});
test('buy-price cap rejects buys that would fill into a spike', async () => {
  const f = await new PaperExecutor(async () => 1.2).submit(order('buy', 1));
  assert.equal(f.status, 'rejected'); assert.match(f.note!, /20\.0% above the decision price/);
  assert.equal((await new PaperExecutor(async () => 1.2).submit(order('sell', 1))).status, 'filled', 'sells are never capped');
});
test('live mode refuses to trade without the owner signer, and records real fills with one', async () => {
  await assert.rejects(new LiveExecutor(undefined, {...DEFAULT_EXEC, mode: 'live'}).submit(order('buy')), /not configured/);
  const live = executorFor({...DEFAULT_EXEC, mode: 'live'}, {priceAt: async () => 1, signer: {swap: async () => ({price: 1.01, filledAt: 3500, feesUsd: 0.05, txSignature: 'sig'})}});
  const f = await live.submit(order('buy'));
  assert.equal(f.mode, 'live'); assert.equal(f.latencyMs, 2500); assert.equal(f.txSignature, 'sig');
  assert.equal(executorFor(DEFAULT_EXEC, {priceAt: async () => 1}).mode, 'paper');
});
test('risk gate blocks new buys at the approved limits and always allows sells', () => {
  const ok = {openPositions: 0, realizedTodayUsd: 0, equityUsd: 11, equityHighUsd: 11};
  assert.equal(riskCheck(order('buy'), ok).ok, true);
  assert.match(riskCheck(order('buy'), {...ok, realizedTodayUsd: -3}).reason!, /daily loss/);
  assert.match(riskCheck(order('buy'), {...ok, equityUsd: 7, equityHighUsd: 11}).reason!, /drawdown/);
  assert.match(riskCheck(order('buy'), {...ok, openPositions: 5}).reason!, /open positions/);
  assert.match(riskCheck(order('buy'), {...ok, halted: 'stale feed'}).reason!, /halted/);
  assert.equal(riskCheck(order('sell'), {...ok, realizedTodayUsd: -10}).ok, true);
});
test('position return is identical for paper and live fills', () => {
  const buy = {orderId: 'b', mint: 'M', side: 'buy' as const, fraction: 1, price: 1, filledAt: 0, latencyMs: 2000, feesUsd: 0.065, status: 'filled' as const, mode: 'paper' as const};
  const sells = [{...buy, orderId: 's1', side: 'sell' as const, fraction: 0.5, price: 1.4}, {...buy, orderId: 's2', side: 'sell' as const, fraction: 0.5, price: 1.0}];
  const r = positionReturnPct(buy, sells, 2)!;
  assert.ok(Math.abs(r - (((1 * 1.4 - 0.065) + (1 * 1.0 - 0.065)) / 2.065 - 1) * 100) < 1e-9);
  assert.equal(positionReturnPct({...buy, status: 'rejected'}, sells, 2), null);
});
