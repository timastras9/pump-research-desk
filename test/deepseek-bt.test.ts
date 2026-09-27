import test from 'node:test';
import assert from 'node:assert/strict';
import { dsPrompt, netFrom, scoreToken, btSummary, askDeepSeek, resolveDeepSeekModel, validPrices, DECIDE_MS } from '../src/deepseek-bt';
import { paperTrade } from '../src/paper-trader';
// @ts-ignore browser module without types
import { dsHtml } from '../public/chat.js';

const T0 = 1_000_000;
const series = (pts: [number, number][]) => pts.map(([s, p]) => ({ time: T0 + s * 1000, priceUsd: p }));

test('prompt uses only data up to 30 s (no look-ahead)', () => {
  const v = series([[0, 1], [10, 1.1], [30, 1.2], [31, 99], [200, 0.1]]);
  const p = dsPrompt(v, T0, { mayhem: true }, 5000)!;
  assert.match(p, /first 30 s/); assert.match(p, /now: 20%/); assert.doesNotMatch(p, /9800|99|-90/);
  assert.equal(dsPrompt(series([[0, 1]]), T0, null, null), null, 'too little data');
});

test('scoring: DeepSeek fills after its answer time, buy-all at 2 s, both with rules v3 exits', () => {
  // flat to 32 s, then +35% by 33 s (early take +30% fires), holds
  const v = series([[0, 1], [31, 1], [32, 1], [32.4, 1], [33, 1.35], [34, 1.36], [300, 1.3], [599, 1.3]]);
  const fast = scoreToken(v, T0, { buy: true, answer: 'BUY', latencyMs: 300 }, { tokenId: 't', name: 'n', campaignId: 'c', finalPct: -50 });
  assert.ok(fast.netAll! > 20, 'buy-all catches the early pump'); assert.ok(fast.netDs! > 20);
  const slow = scoreToken(v, T0, { buy: true, answer: 'BUY', latencyMs: 4000 }, { tokenId: 't', name: 'n', campaignId: 'c', finalPct: -50 });
  assert.ok(slow.netDs! < fast.netDs!, 'a slow answer buys after the pump and does worse');
  assert.equal(scoreToken(v, T0, { buy: false, answer: 'SKIP', latencyMs: 300 }, { tokenId: 't', name: 'n', campaignId: 'c', finalPct: 0 }).netDs, null);
  assert.equal(netFrom(v, T0 + 10_000_000), null);
});

test('refactor parity: paperTrade still gives the same trades (exits moved to tradeFrom)', () => {
  const v = series([[0, 1], [1, 1], [2, 1.05], [3, 1.06], [20, 1.4], [21, 1.41], [100, 0.9], [599, 0.9]]);
  const p = paperTrade(v);
  assert.equal(p.status, 'closed'); assert.ok(p.pnlPct != null); assert.equal(validPrices(v).length, v.length);
});

test('summary + panel: latency, three strategies side by side, escaped errors', () => {
  const rows = [{ tokenId: 'a', name: 'a', campaignId: 'c', buy: true, answer: 'BUY', latencyMs: 400, netAll: 10, netDs: 8, finalPct: 1 },
    { tokenId: 'b', name: 'b', campaignId: 'c', buy: false, answer: 'SKIP', latencyMs: 600, netAll: -30, netDs: null, finalPct: -60 }];
  const s = btSummary(rows);
  assert.equal(s.buys, 1); assert.equal(s.buyEverything.n, 2); assert.equal(s.deepseekBuys.avgPct, 8); assert.equal(s.deepseekSkips.avgPct, -30); assert.equal(s.latencyMs!.median, 400);
  const html = dsHtml({ status: 'finished', done: 2, total: 2, errors: ['<b>x</b>'], summary: s });
  assert.match(html, /DeepSeek BUY picks/); assert.match(html, /&lt;b&gt;x/); assert.match(html, /median 0\.40 s/);
  assert.equal(DECIDE_MS, 30000);
});

test('model resolution: picks the DeepSeek id this account can call (V4 Pro > V4 Flash > V3.2 > V3.1), clear error otherwise', async () => {
  const list = (ids: string[], ok = true) => (async () => ({ ok, status: ok ? 200 : 401, json: async () => (ok ? { data: ids.map(id => ({ id })) } : { error: { message: 'bad key' } }) })) as any;
  assert.equal(await resolveDeepSeekModel('k', list(['accounts/fireworks/models/llama-4', 'accounts/fireworks/models/deepseek-v3p1', 'accounts/fireworks/models/deepseek-v4-flash'])), 'accounts/fireworks/models/deepseek-v4-flash');
  assert.equal(await resolveDeepSeekModel('k', list(['accounts/fireworks/models/deepseek-v4-pro-0813', 'accounts/fireworks/models/deepseek-v3p1'])), 'accounts/fireworks/models/deepseek-v4-pro-0813');
  await assert.rejects(resolveDeepSeekModel('k', list(['accounts/fireworks/models/llama-4'])), /no DeepSeek model/);
  await assert.rejects(resolveDeepSeekModel('k', list([], false)), /model list 401: bad key/);
});

test('deepseek call: thinking off, 5-token answer, key only in the header', async () => {
  let seen: any = null;
  const fake = (async (url: string, init: any) => { seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'BUY' } }], usage: { prompt_tokens: 300, completion_tokens: 1 } }) }; }) as any;
  const d = await askDeepSeek('fw_k', 'p', fake);
  assert.equal(d.buy, true); assert.equal(seen.body.reasoning_effort, 'none'); assert.equal(seen.body.max_tokens, 5);
  assert.equal(seen.body.model, 'accounts/fireworks/models/deepseek-v4p1-flash'); assert.equal(seen.body.service_tier, 'priority'); assert.equal(seen.auth, 'Bearer fw_k');
  assert.ok(!JSON.stringify(seen.body).includes('fw_k'));
});
