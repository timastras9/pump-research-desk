// Test config for end-to-end checks before a deploy: local Worker + Durable Objects, but the REAL
// Workers AI, D1, R2 and AI Search (remote: true). Writes artifacts/wrangler-e2e.json (git-ignored).
// Usage: node scripts/e2e-config.mjs && npx wrangler dev -c artifacts/wrangler-e2e.json --port 8799
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const c = JSON.parse(src);
c.main = '../src/worker.ts';
c.assets.directory = '../public';
c.ai.remote = true;
for (const d of c.d1_databases) d.remote = true;
for (const b of c.r2_buckets) b.remote = true;
for (const s of c.ai_search_namespaces ?? []) s.remote = true;
delete c.triggers;   // no cron in tests
mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
writeFileSync(new URL('../artifacts/wrangler-e2e.json', import.meta.url), JSON.stringify(c, null, 2));
console.log('artifacts/wrangler-e2e.json written (remote AI, D1, R2, AI Search; local Durable Objects)');
