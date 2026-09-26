import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stepJob, newJob, READY_AFTER_MS, type RunnerDeps, type RunFile, type ModelPointer } from '../src/model-runner';
import { buildLaunch } from '../src/launch-data';

const fx = JSON.parse(readFileSync(new URL('./fixtures/model_parity.json', import.meta.url), 'utf8'));
const pointer: ModelPointer = { key: 'models/v3.json', name: fx.model.name, sha: fx.model.sha256, activatedAt: 0, by: 'Tim' };
const tokens = fx.launches.slice(0, 5).map((l: any, i: number) => ({ id: `t${i}`, mint: l.mint, name: `Token ${i}`, createdAt: l.api.created }));

function fakes(now: number, fail: Set<string> = new Set()) {
  const rows = new Map<string, any>(); const runs: RunFile[] = []; let fetches = 0;
  const deps: RunnerDeps = {
    tokens: async () => [...tokens, { id: 'nocreated', mint: 'zzz', name: 'No time', createdAt: null }],
    existingRows: async () => new Map(rows),
    saveRow: async (_c, _s, id, row) => { rows.set(id, row); },
    saveRun: async r => { runs.push(r); },
    loadModel: async () => fx.model,
    fetch: async (mint, created) => { fetches++; if (fail.has(mint)) return null; const l = fx.launches.find((x: any) => x.mint === mint); return buildLaunch(mint, created, l.api.coin, l.api.candles, l.api.trades); },
    now: () => now,
  };
  return { deps, rows, runs, fetches: () => fetches };
}

test('waits until the newest token has a complete candle window', async () => {
  const latest = Math.max(...tokens.map((t: any) => t.createdAt));
  const job = newJob('c1', pointer, tokens, latest + 60_000);
  assert.equal(job.dueAt, latest + READY_AFTER_MS);
  const f = fakes(latest + 60_000);
  assert.equal(await stepJob(job, f.deps), 'wait'); assert.equal(f.fetches(), 0);
});

test('evaluates in batches, then writes one run file with a row per token and a summary', async () => {
  const f = fakes(Date.now()), job = newJob('c1', pointer, tokens, 0); job.dueAt = 0;
  assert.equal(await stepJob(job, f.deps, 2), 'more'); assert.equal(f.rows.size, 2);
  let s; do s = await stepJob(job, f.deps, 2); while (s === 'more');
  assert.equal(s, 'finished'); assert.equal(f.runs.length, 1); assert.equal(job.done, 6);
  const run = f.runs[0];
  assert.equal(run.rows.length, 6); assert.equal(run.summary.tokens, 6); assert.equal(run.model.sha, fx.model.sha256);
  const r0 = run.rows.find(r => r.tokenId === 't0')!, want = fx.launches[0].expect;
  assert.equal(r0.bought, want.bought); assert.equal(r0.name, 'Token 0');
  assert.equal(run.rows.find(r => r.tokenId === 'nocreated')!.decisionT, null, 'token without a launch time is kept as an empty row');
});

test('the feed seen time is passed through as seconds after launch', async () => {
  const f = fakes(Date.now()), job = newJob('c1', pointer, tokens, 0); job.dueAt = 0;
  f.deps.tokens = async () => [{ ...tokens[0], seenAt: tokens[0].createdAt + 7500 }];
  await stepJob(job, f.deps, 5);
  assert.equal(f.rows.get('t0').seenAgeS, 7.5);
});

test('a failed fetch is recorded, never retried forever, and never blocks the run', async () => {
  const f = fakes(Date.now(), new Set([tokens[1].mint])), job = newJob('c1', pointer, tokens, 0); job.dueAt = 0;
  let s; do s = await stepJob(job, f.deps, 10); while (s === 'more');
  assert.equal(s, 'finished'); assert.ok(job.errors[0].includes('candles unavailable'));
  assert.equal(f.runs[0].rows.find(r => r.tokenId === 't1')!.feedback, null);
});

test('a model file that does not match its pointer is refused', async () => {
  const f = fakes(Date.now()), job = newJob('c1', { ...pointer, sha: 'other-sha' }, tokens, 0); job.dueAt = 0;
  await assert.rejects(stepJob(job, f.deps), /does not match/);
});
