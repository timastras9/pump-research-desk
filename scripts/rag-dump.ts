// Dump the whole study database (D1) into the R2 bucket as the indexed RAG export, without a deploy.
// Same documents the Worker writes after each study (src/rag-export.ts). Read-only on D1; writes only under rag/.
// Usage: npx tsx scripts/rag-dump.ts [--out artifacts/rag-dump] [--no-upload]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GLOSSARY, TOKEN_SELECT, mergeIndex, studyFiles } from '../src/rag-export';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', 'artifacts/rag-dump'), UPLOAD = !process.argv.includes('--no-upload');
const BUCKET = 'crypto-study-media', DB = 'crypto-study';

const wrangler = (args: string[]) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });
const query = <T>(sql: string): T[] => (JSON.parse(wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', sql])) as { results: T[] }[])[0].results;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const campaigns = query<{ id: string; data: string }>('SELECT id, data FROM study_campaigns ORDER BY started_at');
const hasModel = query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='model_runs'")[0].n > 0;
console.log(`${campaigns.length} studies · model tables: ${hasModel}`);

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
  const { files, line } = studyFiles(c, tokens, runs, modelRows);
  for (const f of files) { const file = join(OUT, f.key); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, f.body); pairs.push({ key: f.key, file }); }
  index = mergeIndex(index.studies, line);
  console.log(`  ${line.startedAt} ${row.id}: ${tokens.length} tokens, ${runs.length} model runs`);
}
writeFileSync(join(OUT, 'rag/index.json'), JSON.stringify(index)); pairs.push({ key: 'rag/index.json', file: join(OUT, 'rag/index.json') });
writeFileSync(join(OUT, 'rag/glossary.md'), GLOSSARY);
writeFileSync(join(OUT, 'pairs.json'), JSON.stringify(pairs));
console.log(`${pairs.length + 1} files written to ${OUT}`);

if (UPLOAD) {
  wrangler(['r2', 'bulk', 'put', BUCKET, '--remote', '--filename', join(OUT, 'pairs.json'), '--content-type', 'application/json', '--concurrency', '20']);
  wrangler(['r2', 'object', 'put', `${BUCKET}/rag/glossary.md`, '--remote', '--file', join(OUT, 'rag/glossary.md'), '--content-type', 'text/markdown']);
  console.log(`uploaded to r2://${BUCKET}/rag/`);
}
