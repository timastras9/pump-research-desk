import test from 'node:test';
import assert from 'node:assert/strict';
import { outcome, studyFiles, mergeIndex, tokenKey, tokenDoc } from '../src/rag-export';
import { buildChat, askAstra, CHAT_CAP_USD } from '../src/astra-chat';
// @ts-ignore browser module without types
import { turnHtml, ragStatusText } from '../public/chat.js';

const c = { id: 'c1', startedAt: Date.UTC(2026, 8, 26, 21), status: 'finished', paperResult: { rules: { version: 'paper-v3' }, all: { totalUsd: -9.98, trades: 51 }, filtered: { totalUsd: 0.4 } } };
const toks = [
  { id: 'c1:m1', name: 'Holder', mint: 'M1abc', metrics: { changePct: 264.3, peakGainPct: 264.3 }, paper: { status: 'closed', pnlPct: 51.2, holdMs: 74600, exitReason: 'sold 50% at +30%' },
    mediaPrefix: 'studies/c1/M1abc', frameCount: 338, latestFrame: { key: 'studies/c1/M1abc/f.webp', capturedAt: 1 }, series: [[10, 0], [60, 20]] },
  { id: 'c1:m2', name: 'Dump/Coin', mint: 'M2', metrics: { changePct: -80, peakGainPct: 2 } },
  { id: 'c1:m3', name: 'Catecoin', mint: 'M3', excluded: true, exclusionReason: 'insider', metrics: { changePct: 900, peakGainPct: 5000 } },
];

test('rag export: outcome lines, keys, study totals leave excluded tokens out, recording link kept', () => {
  assert.equal(outcome(8), 'winner'); assert.equal(outcome(7), 'loser'); assert.equal(outcome(-50), 'tanked'); assert.equal(outcome(null), 'unscored');
  assert.equal(tokenKey(c, toks[1]), 'rag/tokens/2026-09-26_c1/Dump-Coin_M2.json');
  const { files, line } = studyFiles(c, toks);
  assert.equal(files.length, 4); assert.equal(line.doc, 'rag/studies/2026-09-26_c1.json');
  const study = JSON.parse(files.at(-1)!.body);
  assert.deepEqual(study.outcomes, { winners: 1, losers: 1, tanked: 1 }); assert.equal(study.highestPeak.name, 'Holder'); assert.equal(study.excluded[0].name, 'Catecoin');
  assert.equal(line.paperAllTokensUsd, -9.98);
  const d = tokenDoc(c, toks[0]);
  assert.equal(d.paperAllTokens!.heldSeconds, 74.6); assert.equal(d.recording.frames, 338); assert.match(d.recording.latestFrameUrl!, /^\/api\/studies\/media\?key=studies%2Fc1/);
  assert.deepEqual(d.priceEvery5s, [[10, 0], [60, 20]]);
});

test('rag export: index replaces a study in place and stays newest first', () => {
  const a = { id: 'a', startedAt: '2026-09-25T00:00:00Z' }, b = { id: 'b', startedAt: '2026-09-26T00:00:00Z' };
  const i = mergeIndex(mergeIndex([a], b).studies, { ...a, tokensRecorded: 5 });
  assert.deepEqual(i.studies.map(s => s.id), ['b', 'a']); assert.equal(i.studies[1].tokensRecorded, 5);
});

test('chat: retrieved chunks trimmed lowest score first to stay under the cap', () => {
  const big = 'x'.repeat(200000);
  const p = buildChat('why?', [], { studies: [] }, [{ key: 'low', score: 0.1, text: big }, { key: 'high', score: 0.9, text: 'short' }]);
  assert.ok(p.estimatedUsd <= CHAT_CAP_USD); assert.deepEqual(p.sources, ['high']);
});

test('chat: works without AI Search (index only) and reports cost', async () => {
  let sent: any = null;
  const env = { AI: { run: async (_m: string, i: unknown) => { sent = i; return { choices: [{ message: { content: 'Study c1 lost $9.98.' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }; } },
    CRYPTO_MEDIA: { get: async () => ({ json: async () => ({ studies: [{ id: 'c1' }] }) }) } } as any;
  const r = await askAstra(env, 'Which study lost most?');
  assert.equal(r.answer, 'Study c1 lost $9.98.'); assert.equal(r.ragConnected, false); assert.equal(r.indexLoaded, true); assert.equal(r.actualUsd, 0.017);
  assert.match(JSON.stringify(sent.messages), /LIVE STUDY INDEX/);
});

test('chat page: answers and questions are escaped; status explains a missing search instance', () => {
  assert.match(turnHtml({ role: 'user', content: '<img onerror=x>' }), /&lt;img onerror=x&gt;/);
  assert.match(turnHtml({ role: 'assistant', content: 'ok', sources: ['rag/<b>'], actualUsd: 0.02 }), /rag\/&lt;b&gt;.*/s);
  assert.match(ragStatusText({ studies: [{}, {}], index: null, aiSearchInstance: null }), /not written yet.*not connected/);
});
