import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLaunch, fetchTrades, getJson, fetchLaunch, TRADES_URL } from '../src/launch-data';
import { Model } from '../src/model';

const fx = JSON.parse(readFileSync(new URL('./fixtures/model_parity.json', import.meta.url), 'utf8'));
const model = new Model(fx.model);

test('raw API data rebuilds exactly the launch the research engine loads (price, volume, trades, tags)', () => {
  for (const l of fx.launches) {
    const b = buildLaunch(l.mint, l.api.created, l.api.coin, l.api.candles, l.api.trades)!;
    assert.deepEqual(b.price, l.price, `${l.mint} price`); assert.deepEqual(b.volume, l.volume, `${l.mint} volume`);
    assert.deepEqual(b.tags, l.tags, `${l.mint} tags`);
    assert.deepEqual(b.trades, l.trades, `${l.mint} trades`);
  }
});

test('the model trades a launch rebuilt from raw API data exactly as Python did', () => {
  for (const l of fx.launches) {
    const b = buildLaunch(l.mint, l.api.created, l.api.coin, l.api.candles, l.api.trades)!;
    const tr = new Model(fx.model).trade(b);
    assert.equal(tr.bought, l.expect.bought, l.mint);
    if (tr.bought) assert.ok(Math.abs(tr.netPct! - l.expect.net_pct) < 1e-9, `${l.mint} ${tr.netPct} vs ${l.expect.net_pct}`);
  }
});

test('cleaning rules: skip non-positive closes and out-of-window rows, backfill, forward-fill, dedupe trades', () => {
  const c = 1_000_000;
  const b = buildLaunch('m', c, { description: 'Fees to @someone', image_uri: 'https://ipfs.io/x', mayhem_state: 1 },
    [{ timestamp: c + 3000, close: 2 }, { timestamp: c + 5000, close: 0 }, { timestamp: c + 7000, close: '4', volume: '1.5' }, { timestamp: c + 900_000, close: 9 }],
    [{ timestamp: new Date(c + 4500).toISOString(), userAddress: 'a', type: 'buy', amountSol: 1, tx: 't1' },
     { timestamp: new Date(c + 4500).toISOString(), userAddress: 'a', type: 'buy', amountSol: 1, tx: 't1' },
     { timestamp: new Date(c - 2000).toISOString(), userAddress: 'b', type: 'buy', amountSol: 1, tx: 't0' }], 10)!;
  assert.deepEqual(b.price, [2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4]);
  assert.equal(b.volume[7], 1.5); assert.equal(b.candlesN, 2);
  assert.deepEqual(b.trades, [[4, 'a', 'buy', 1]]);
  assert.deepEqual(b.tags, { fee_routed: true, mayhem: true, terminal: false });
  assert.equal(buildLaunch('m', c, {}, [{ timestamp: c + 1000, close: 0 }], null), null, 'no usable candle');
});

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('getJson backs off on rate limits and gives up on other errors', async () => {
  let calls = 0;
  const ok = await getJson<{ x: number }>('u', async () => (++calls < 3 ? res(429, {}) : res(200, { x: 1 })), 5, 1);
  assert.deepEqual(ok, { x: 1 }); assert.equal(calls, 3);
  assert.equal(await getJson('u', async () => res(404, {}), 5, 1), null);
});

test('trade pages are walked back until they pass the launch', async () => {
  const c = 1_000_000, t = (s: number) => new Date(c + s * 1000).toISOString();
  const pages: Record<string, unknown> = {
    '0': { trades: [{ timestamp: t(800) }, { timestamp: t(700), tx: 'b' }], pagination: { hasMore: true, nextCursor: 'p2' } },
    p2: { trades: [{ timestamp: t(5), tx: 'a' }, { timestamp: t(-1) }], pagination: { hasMore: true, nextCursor: 'p3' } },
  };
  const seen: string[] = [];
  const out = await fetchTrades('m', c, async url => { const cur = new URL(url).searchParams.get('cursor')!; seen.push(cur); return res(200, pages[cur]); }, 720, 0);
  assert.deepEqual(seen, ['0', 'p2'], 'stops once a page reaches before launch');
  assert.equal(out.status, 'done'); assert.deepEqual(out.trades!.map(x => x.tx), ['b', 'a']);
  assert.equal(TRADES_URL('m', 1, 'a b').includes('cursor=a%20b'), true);
});

test('fetchLaunch assembles coin, candles and trades', async () => {
  const l = fx.launches.find((x: any) => x.api.trades);
  const launch = await fetchLaunch(l.mint, l.api.created, async url =>
    url.includes('/coins-v2/') ? res(200, l.api.coin) : url.includes('/candles') ? res(200, l.api.candles) : res(200, { trades: l.api.trades ?? [], pagination: { hasMore: false } }));
  assert.deepEqual(launch!.price, l.price); assert.equal(launch!.tradesStatus, 'done');
  assert.equal(model.trade(launch!).bought, l.expect.bought);
});
