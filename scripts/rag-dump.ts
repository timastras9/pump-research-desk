// Dump the whole study database (D1) into the R2 bucket as the indexed RAG export, without a deploy.
// Same documents the Worker writes after each study (src/rag-export.ts): index, glossary, studies, tokens, recordings.
// Read-only on D1; writes only under rag/.
// Usage: npx tsx scripts/rag-dump.ts [--out artifacts/rag-dump] [--no-upload] [--no-recordings]
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CHUNK_SELECT, GLOSSARY, TOKEN_SELECT, mergeIndex, studyFiles } from '../src/rag-export';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', 'artifacts/rag-dump'), UPLOAD = !process.argv.includes('--no-upload'), RECORDINGS = !process.argv.includes('--no-recordings');
const BUCKET = 'crypto-study-media', DB = 'crypto-study', PARALLEL = 8;

const run = promisify(execFile);
const d1Args = (sql: string) => ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql];
const parse = <T>(out: string) => (JSON.parse(out) as { results: T[] }[])[0].results;
const query = <T>(sql: string): T[] => parse<T>(execFileSync('npx', d1Args(sql), { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] }));
const queryAsync = async <T>(sql: string): Promise<T[]> => parse<T>((await run('npx', d1Args(sql), { encoding: 'utf8', maxBuffer: 1 << 30 })).stdout);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Frames, prices and vision verdicts for every token, PARALLEL wrangler queries at a time. */
async function chunksFor(tokens: { id: string }[]) {
  const out = new Map<string, any[]>(); let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < tokens.length) {
      const t = tokens[next++];
      for (let attempt = 1; ; attempt++) {
        try { out.set(t.id, (await queryAsync<{ data: string }>(`SELECT ${CHUNK_SELECT} FROM study_chunks WHERE token_id=${q(t.id)}`)).map(r => JSON.parse(r.data))); break; }
        catch (e) { if (attempt >= 3) { console.log(`  recording skipped for ${t.id}: ${(e as Error).message.slice(0, 120)}`); break; } }
      }
    }
  }));
  return out;
}

const campaigns = query<{ id: string; data: string }>('SELECT id, data FROM study_campaigns ORDER BY started_at');
const hasModel = query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='model_runs'")[0].n > 0;
console.log(`${campaigns.length} studies · model tables: ${hasModel} · recordings: ${RECORDINGS}`);

const pairs: { key: string; file: string }[] = [];
let index = { updatedAt: '', studies: [] as Record<string, unknown>[] };
for (const row of campaigns) {
  const c = JSON.parse(row.data);
  const tokens = query<{ data: string }>(`SELECT ${TOKEN_SELECT} FROM study_tokens WHERE campaign_id=${q(row.id)} ORDER BY started_at`).map(r => JSON.parse(r.data));
  let runs: Record<string, any>[] = [], modelRows = new Map<string, any>();
  if (hasModel) {
    runs = query(`SELECT model_sha, created_at, summary, review FROM model_runs WHERE campaign_id=${q(row.id)} ORDER BY created_at`);
    const latest = runs.at(-1);
    if (latest) modelRows = new Map(query<{ token_id: string; data: string }>(`SELECT token_id, data FROM model_rows WHERE campaign_id=${q(row.id)} AND model_sha=${q(latest.model_sha)}`).map(r => [r.token_id, JSON.parse(r.data)]));
  }
  const chunks = RECORDINGS ? await chunksFor(tokens) : new Map();
  const { files, line } = studyFiles(c, tokens, runs, modelRows, chunks);
  for (const f of files) { const file = join(OUT, f.key); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, f.body); pairs.push({ key: f.key, file }); }
  index = mergeIndex(index.studies, line);
  console.log(`  ${line.startedAt} ${row.id}: ${tokens.length} tokens, ${chunks.size} recordings, ${runs.length} model runs`);
}
writeFileSync(join(OUT, 'rag/index.json'), JSON.stringify(index)); pairs.push({ key: 'rag/index.json', file: join(OUT, 'rag/index.json') });
writeFileSync(join(OUT, 'rag/glossary.md'), GLOSSARY);
writeFileSync(join(OUT, 'pairs.json'), JSON.stringify(pairs));
console.log(`${pairs.length + 1} files written to ${OUT}`);

if (UPLOAD) {
  execFileSync('npx', ['wrangler', 'r2', 'bulk', 'put', BUCKET, '--remote', '--filename', join(OUT, 'pairs.json'), '--content-type', 'application/json', '--concurrency', '20'], { stdio: 'inherit' });
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/rag/glossary.md`, '--remote', '--file', join(OUT, 'rag/glossary.md'), '--content-type', 'text/markdown'], { stdio: 'inherit' });
  console.log(`uploaded to r2://${BUCKET}/rag/`);
}
