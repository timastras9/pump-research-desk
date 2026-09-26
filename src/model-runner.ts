// Runs the active model over a finished study run: waits until every token's 12-minute candle window is complete, fetches
// each token's candles + wallet trades, paper-trades it with the model (and rules v3 side by side), labels every exit,
// then writes one run JSON (summary + a row per token) for the dashboard and for Astra's review.
import { Model, type ModelSpec } from './model';
import { fetchLaunch, type LaunchData } from './launch-data';
import { modelRow, summarizeRows, type ModelRow } from './model-paper';

export const READY_AFTER_MS = 13 * 60 * 1000;   // candles cover the first 12 minutes; +1 minute for the API to settle
export const BATCH = 3;                          // tokens per alarm step (each fetch can wait on rate limits)

export type ModelPointer = { key: string; name: string; sha: string; activatedAt: number; by: string };
export type ModelJob = { campaignId: string; model: ModelPointer; dueAt: number; queuedAt: number; done: number; total: number | null; errors: string[] };
export type RunToken = { id: string; mint: string; name: string; createdAt: number | null };
export type RunFile = { format: 'pump-model-run-v1'; campaignId: string; model: { name: string; sha: string }; engine: ModelSpec['engine']; guard: ModelSpec['guard']; createdAt: number; summary: ReturnType<typeof summarizeRows>; rows: (ModelRow & { tokenId: string })[] };

export type RunnerDeps = {
  tokens: (campaignId: string) => Promise<RunToken[]>;
  existingRows: (campaignId: string, sha: string) => Promise<Map<string, ModelRow & { tokenId: string }>>;
  saveRow: (campaignId: string, sha: string, tokenId: string, row: ModelRow & { tokenId: string }) => Promise<void>;
  saveRun: (run: RunFile) => Promise<void>;
  loadModel: (p: ModelPointer) => Promise<ModelSpec>;
  fetch: (mint: string, createdMs: number) => Promise<LaunchData | null>;
  now: () => number;
};

export function newJob(campaignId: string, model: ModelPointer, tokens: RunToken[], now: number): ModelJob {
  const latest = Math.max(0, ...tokens.map(t => t.createdAt ?? 0));
  return { campaignId, model, dueAt: Math.max(now, latest + READY_AFTER_MS), queuedAt: now, done: 0, total: tokens.length, errors: [] };
}

const models = new Map<string, Model>();

/** One step: evaluate up to BATCH tokens. Returns 'wait' (not due yet), 'more' (call again) or 'finished' (run file written). */
export async function stepJob(job: ModelJob, d: RunnerDeps, batch = BATCH): Promise<'wait' | 'more' | 'finished'> {
  if (d.now() < job.dueAt) return 'wait';
  let model = models.get(job.model.sha);
  if (!model) { model = new Model(await d.loadModel(job.model)); if (model.spec.sha256 !== job.model.sha) throw Error(`model file ${job.model.key} does not match sha ${job.model.sha}`); models.set(job.model.sha, model); }
  const tokens = await d.tokens(job.campaignId), have = await d.existingRows(job.campaignId, job.model.sha);
  job.total = tokens.length;
  const todo = tokens.filter(t => !have.has(t.id)).slice(0, batch);
  for (const t of todo) {
    let row: ModelRow & { tokenId: string };
    if (t.createdAt == null) row = { ...emptyRow(model, t), tokenId: t.id };
    else {
      const launch = await d.fetch(t.mint, t.createdAt);
      if (!launch) { job.errors = [...job.errors, `${t.name || t.mint}: candles unavailable`].slice(-20); row = { ...emptyRow(model, t), tokenId: t.id }; }
      else row = { ...modelRow(model, { ...launch, name: t.name || launch.name }), tokenId: t.id };
    }
    await d.saveRow(job.campaignId, job.model.sha, t.id, row); have.set(t.id, row);
  }
  job.done = have.size;
  if (tokens.some(t => !have.has(t.id))) return 'more';
  const rows = tokens.map(t => have.get(t.id)!);
  await d.saveRun({ format: 'pump-model-run-v1', campaignId: job.campaignId, model: { name: model.spec.name, sha: model.spec.sha256 }, engine: model.spec.engine, guard: model.spec.guard,
    createdAt: d.now(), summary: summarizeRows(rows), rows });
  return 'finished';
}

function emptyRow(model: Model, t: RunToken): ModelRow {
  return { mint: t.mint, name: t.name, model: model.spec.name, modelSha: model.spec.sha256, labeler: 'feedback-v1', decisionT: null, bought: false, buyProb: null, entryCrashProb: null, entryT: null,
    trade: null, shadow: null, actual: null, predictedVsActual: null, feedback: null, rulesV3: null };
}

/** D1 + R2 wiring used by the coordinator. */
export const MODEL_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS model_rows (campaign_id TEXT NOT NULL, model_sha TEXT NOT NULL, token_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (campaign_id, model_sha, token_id))',
  'CREATE TABLE IF NOT EXISTS model_runs (campaign_id TEXT NOT NULL, model_sha TEXT NOT NULL, created_at INTEGER NOT NULL, summary TEXT NOT NULL, review TEXT, PRIMARY KEY (campaign_id, model_sha))',
];
export function d1Deps(db: D1Database, media: R2Bucket, tokens: RunnerDeps['tokens']): RunnerDeps {
  return {
    tokens,
    existingRows: async (c, sha) => new Map((await db.prepare('SELECT token_id, data FROM model_rows WHERE campaign_id=? AND model_sha=?').bind(c, sha).all<{ token_id: string; data: string }>()).results.map(r => [r.token_id, JSON.parse(r.data)])),
    saveRow: async (c, sha, id, row) => { await db.prepare('INSERT OR REPLACE INTO model_rows VALUES (?,?,?,?)').bind(c, sha, id, JSON.stringify(row)).run(); },
    saveRun: async run => {
      await media.put(runKey(run.campaignId, run.model.sha), JSON.stringify(run), { httpMetadata: { contentType: 'application/json' } });
      await db.prepare('INSERT OR REPLACE INTO model_runs (campaign_id, model_sha, created_at, summary, review) VALUES (?,?,?,?,NULL)').bind(run.campaignId, run.model.sha, run.createdAt, JSON.stringify(run.summary)).run();
    },
    loadModel: async p => { const o = await media.get(p.key); if (!o) throw Error(`model file ${p.key} missing`); return JSON.parse(await o.text()) as ModelSpec; },
    fetch: (mint, created) => fetchLaunch(mint, created),
    now: () => Date.now(),
  };
}
export const runKey = (campaignId: string, sha: string) => `runs/${campaignId}/${sha}.json`;
