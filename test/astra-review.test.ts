import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Model } from '../src/model';
import { modelRow, summarizeRows } from '../src/model-paper';
import { buildPayload, reviewRun, compactRow, estimateUsd, ASTRA_MODEL, MAX_OUTPUT_TOKENS, REVIEW_CAP_USD } from '../src/astra-review';
import type { RunFile } from '../src/model-runner';

const fx = JSON.parse(readFileSync(new URL('./fixtures/model_parity.json', import.meta.url), 'utf8'));
const model = new Model(fx.model);
const rows = fx.launches.map((l: any, i: number) => ({ ...modelRow(model, { ...l, name: `Tok${i}` }), tokenId: `t${i}` }));
const run: RunFile = { format: 'pump-model-run-v1', campaignId: 'c1', model: { name: fx.model.name, sha: fx.model.sha256 }, engine: fx.model.engine, guard: fx.model.guard, createdAt: 0, summary: summarizeRows(rows), rows };

test('each row carries prediction, actual (peak, best exit, crash), the differences, labels and rules v3', () => {
  const bought = rows.find((x: any) => x.bought)!, c = compactRow(bought) as any;
  assert.ok(c.pred.net != null && c.pred.exitSec != null && c.pred.why.length);
  assert.ok(c.act.peak != null && c.act.peakSec != null && c.act.best != null && c.act.bestSec != null);
  assert.equal(c.act.peakSec, bought.actual.peakSec - bought.entryT, 'seconds are relative to entry');
  assert.equal(c.diff.exitVsBest, bought.predictedVsActual.exitVsBestSec);
  assert.ok(Array.isArray(c.fb) && c.v3 != null);
  const skipped = compactRow(rows.find((x: any) => !x.bought)!) as any;
  assert.ok(skipped.pred.shadowNet != null, 'skipped tokens show the shadow outcome, not a trade');
});

test('a normal run is sent whole and costs well under $1', () => {
  const p = buildPayload(run);
  assert.equal(p.rowsSent, p.rowsTotal); assert.ok(p.estimatedUsd < 0.5, `estimate ${p.estimatedUsd}`);
  const sent = JSON.parse(p.text); assert.equal(sent.rows.length, 12); assert.ok(sent.summary.timing);
});

test('a huge run is trimmed under the cap, keeping bought rows first', () => {
  const big = { ...run, rows: Array.from({ length: 1000 }, (_, k) => rows[k % rows.length]) };
  const p = buildPayload(big);
  assert.ok(p.rowsSent < p.rowsTotal); assert.ok(p.estimatedUsd <= REVIEW_CAP_USD);
  const sent = JSON.parse(p.text).rows; assert.ok(sent.slice(0, 50).every((x: any) => x.bought));
});

test('calls Astra with max_completion_tokens, parses JSON, prices the real usage', async () => {
  let call: any;
  const ai = { run: async (m: string, i: any) => { call = { m, i }; return { choices: [{ message: { content: '```json\n{"summary":"ok","adjustments":[]}\n```' } }], usage: { prompt_tokens: 20000, completion_tokens: 1000 } }; } };
  const r = await reviewRun(ai as any, run, 5);
  assert.equal(call.m, ASTRA_MODEL); assert.equal(call.i.max_completion_tokens, MAX_OUTPUT_TOKENS); assert.equal(call.i.max_tokens, undefined);
  assert.deepEqual(r.review, { summary: 'ok', adjustments: [] }); assert.equal(r.actualUsd, Math.round(estimateUsd(20000, 1000) * 1000) / 1000);
  assert.equal(r.error, undefined);
});

test('bad reply or failed call is stored as an error, never thrown', async () => {
  const bad = await reviewRun({ run: async () => ({ choices: [{ message: { content: 'not json' } }] }) } as any, run);
  assert.equal(bad.review, null); assert.equal(bad.raw, 'not json'); assert.match(bad.error!, /not valid JSON/);
  const down = await reviewRun({ run: async () => { throw new Error('7003 bad request'); } } as any, run);
  assert.match(down.error!, /7003/);
});
