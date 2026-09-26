import test from 'node:test';
import assert from 'node:assert/strict';
import { buy, close, defaults, equity, initialState, processTick, rejectionReasons, validateRules, type Quote } from '../src/engine';
import { normalize } from '../src/market';
const now = Date.UTC(2026, 8, 26, 12);
const mint = 'So11111111111111111111111111111111111111112';
function setup() {
  const s = initialState(); s.watchlist = [mint];
  s.quotes[mint] = { mint, symbol: 'TEST', name: 'Test', pair: mint, dex: 'pumpswap', price: 1, liquidity: 1000000,
    volume1h: 50000, momentum: 5, createdAt: now - 3600000, fetchedAt: now };
  s.day = new Date(now).toISOString().slice(0, 10); return s;
}
test('a flat round trip loses estimated fees and slippage, never creates profit', () => {
  const s = setup(); buy(s, mint, now); assert.equal(s.cash, 975); assert.ok(s.positions[0].quantity < 25);
  close(s, s.positions[0].id, 'Manual exit', now + 1000);
  assert.equal(s.positions.length, 0); assert.ok(s.cash < 1000); assert.ok(s.trades[0].pnl < -0.9);
  assert.equal(s.trades[0].entryMomentum, 5); assert.equal(s.trades[0].ruleVersion, 1);
});
test('missing liquidity and stale quotes block entries', () => {
  const s = setup(); s.quotes[mint].liquidity = null;
  assert.throws(() => buy(s, mint, now), /Liquidity/);
  s.quotes[mint].liquidity = 1000000; s.quotes[mint].fetchedAt = now - 120001;
  assert.throws(() => buy(s, mint, now), /stale/); assert.equal(s.cash, 1000);
});
test('price gaps exit at the observed price, not at the stop target', () => {
  const s = setup(); buy(s, mint, now); s.quotes[mint].price = 0.5;
  processTick(s, now + 60000); assert.equal(s.trades[0].reason, 'Stop loss'); assert.ok(s.trades[0].pnl < -12.5);
});
test('disappearing liquidity keeps the position open and records a blocked exit', () => {
  const s = setup(); buy(s, mint, now); s.quotes[mint].liquidity = null;
  processTick(s, now + 60000); assert.equal(s.positions.length, 1); assert.equal(s.trades.length, 0);
  assert.match(s.positions[0].exitBlocked!, /blocked/); assert.equal(equity(s), 975);
  s.quotes[mint].liquidity = 1000000; processTick(s, now + 61000); assert.equal(s.positions.length, 0);
});
test('a requested exit retries after a fresh quote arrives', () => {
  const s = setup(); buy(s, mint, now); s.quotes[mint].fetchedAt = 0;
  assert.equal(close(s, s.positions[0].id, 'Manual exit', now + 1000), false);
  s.quotes[mint].fetchedAt = now + 2000; processTick(s, now + 2000);
  assert.equal(s.trades[0].reason, 'Manual exit');
});
test('time exit runs even when new entries are paused', () => {
  const s = setup(); buy(s, mint, now); s.enabled = false;
  s.quotes[mint].fetchedAt = now + 300001; processTick(s, now + 300001);
  assert.equal(s.trades[0].reason, 'Time exit');
});
test('open positions retain the rules at entry', () => {
  const s = setup(); buy(s, mint, now); s.rules.stopLossPct = 90; s.quotes[mint].price = 0.8;
  processTick(s, now + 60000); assert.equal(s.trades[0].rules.stopLossPct, 5); assert.equal(s.trades[0].reason, 'Stop loss');
});
test('daily loss halts auto entries and persists until the next UTC day', () => {
  const s = setup(); s.rules.dailyLossUsd = 10; buy(s, mint, now); s.enabled = true; s.quotes[mint].price = 0.3;
  processTick(s, now + 60000); assert.equal(s.enabled, false); assert.equal(s.halted, true);
  processTick(s, now + 90000); assert.equal(s.halted, true);
  processTick(s, now + 86400000); assert.equal(s.halted, false); assert.equal(s.enabled, false);
});
test('position limits and cooldown prevent duplicate and rapid re-entry', () => {
  const s = setup(); buy(s, mint, now); assert.throws(() => buy(s, mint, now), /already open/);
  close(s, s.positions[0].id, 'Manual', now); assert.throws(() => buy(s, mint, now + 60000), /cooldown/);
});
test('invalid and impossible rules are rejected', () => {
  assert.throws(() => validateRules({ ...defaults, positionUsd: NaN }));
  assert.throws(() => validateRules({ ...defaults, maxPositions: 1.5 }));
  assert.throws(() => validateRules({ ...defaults, minMomentumPct: 20, maxMomentumPct: 10 }));
  assert.throws(() => validateRules({ ...defaults, feePct: -1 }));
  assert.deepEqual(validateRules(defaults), defaults);
});
test('no automatic entry without explicit enable and no entry during feed failure', () => {
  const s = setup(); processTick(s, now); assert.equal(s.positions.length, 0);
  s.enabled = true; s.feedError = 'outage'; processTick(s, now + 1000); assert.equal(s.positions.length, 0);
  s.feedError = null; processTick(s, now + 2000); assert.equal(s.positions.length, 1);
});
test('market normalization rejects invalid prices and non-Pump venues', () => {
  const pair = { chainId: 'solana', dexId: 'pumpfun', pairAddress: mint, baseToken: { address: mint }, priceUsd: '1' };
  assert.equal(normalize({ ...pair, priceUsd: 'NaN' }, now), null);
  assert.equal(normalize({ ...pair, dexId: 'other' }, now), null);
  const q = normalize(pair, now) as Quote; assert.equal(q.liquidity, null); assert.equal(q.momentum, null);
  assert.ok(rejectionReasons(setup(), q, now).length > 0);
});
