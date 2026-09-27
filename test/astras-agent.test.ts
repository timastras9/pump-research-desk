import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSelect, safeDocKey, safeChange, runTool, agentTurn, openPullRequest, AGENT_CAP_USD } from '../src/astras-agent';

test('query_db guard: one read-only SELECT over the 5 study tables, row cap added', () => {
  assert.equal(safeSelect("SELECT json_extract(data,'$.name') FROM study_tokens WHERE campaign_id='x';"), "SELECT * FROM (SELECT json_extract(data,'$.name') FROM study_tokens WHERE campaign_id='x') LIMIT 200");
  assert.ok(safeSelect('WITH t AS (SELECT data FROM study_tokens) SELECT count(*) FROM t JOIN model_rows m ON 1'));
  assert.ok(safeSelect("SELECT s.value FROM study_tokens t, json_each(t.data,'$.series') s"));
  assert.ok(safeSelect("SELECT * FROM astra_log WHERE question LIKE '%delete%'"), 'keywords inside strings are fine');
  for (const bad of ['DELETE FROM study_tokens', 'SELECT 1; DROP TABLE study_tokens', 'SELECT * FROM study_chunks', 'SELECT * FROM study_tokens, study_chunks',
    'SELECT name FROM sqlite_master', 'SELECT * FROM _cf_KV', 'WITH x AS (SELECT 1) UPDATE study_tokens SET data=1', 'PRAGMA table_info(study_tokens)', 'SELECT * FROM unknown_table'])
    assert.throws(() => safeSelect(bad), Error, bad);
});

test('read_doc guard: rag/ only', () => {
  assert.equal(safeDocKey('/rag/index.json'), 'rag/index.json');
  for (const bad of ['studies/x/0.jpg', 'models/model-v3.json', 'rag/../models/model-v3.json', 'runs/a.json']) assert.throws(() => safeDocKey(bad), Error, bad);
});

test('propose_change guard: 1-5 files, allowed folders only, never CI, config or secrets', () => {
  assert.deepEqual(safeChange([{ path: 'research/engine.py', content: 'x = 1' }]), [{ path: 'research/engine.py', content: 'x = 1' }]);
  for (const bad of [[], [{ path: '.github/workflows/x.yml', content: 'a' }], [{ path: 'wrangler.jsonc', content: 'a' }], [{ path: 'package.json', content: 'a' }],
    [{ path: 'src/.env', content: 'a' }], [{ path: 'src/../wrangler.jsonc', content: 'a' }], [{ path: 'src/a.ts', content: '' }], Array(6).fill({ path: 'src/a.ts', content: 'a' })])
    assert.throws(() => safeChange(bad), Error, JSON.stringify(bad).slice(0, 60));
});

const env = (over: any = {}) => ({ AI: { run: async () => ({}) }, CRYPTO_STUDY: { prepare: (sql: string) => ({ all: async () => ({ results: [{ sql }] }) }) },
  CRYPTO_MEDIA: { get: async (k: string) => (k === 'rag/index.json' ? { text: async () => '{"studies":[]}' } : null) }, ...over });

test('tools: DB runs only the guarded SQL; blocked SQL never reaches D1; docs limited to rag/', async () => {
  let ran = 0; const e = env({ CRYPTO_STUDY: { prepare: (sql: string) => { ran++; return { all: async () => ({ results: [{ sql }] }) }; } } });
  const ok = await runTool(e as any, 'query_db', { sql: 'SELECT count(*) FROM study_tokens' });
  assert.equal(ok.ok, true); assert.match(ok.out, /LIMIT 200/);
  const bad = await runTool(e as any, 'query_db', { sql: 'DELETE FROM study_tokens' });
  assert.equal(bad.ok, false); assert.equal(ran, 1, 'blocked statement never prepared');
  assert.equal((await runTool(e as any, 'read_doc', { key: 'rag/index.json' })).out, '{"studies":[]}');
  assert.equal((await runTool(e as any, 'read_doc', { key: 'models/model-v3.json' })).ok, false);
  assert.equal((await runTool(e as any, 'propose_change', { title: 't', why: 'w', files: [{ path: 'src/a.ts', content: 'a' }] })).ok, false, 'no token -> refused');
});

test('pull request: new astras/* branch from the default branch, draft PR, never writes main', async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  const fake = (async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null; calls.push({ url, method, body });
    const j = url.endsWith('/pump-research-desk') ? { default_branch: 'main' } : url.includes('/git/ref/heads/main') ? { object: { sha: 'abc' } }
      : url.includes('/contents/') && method === 'GET' ? { message: 'Not Found' } : url.endsWith('/pulls') ? { html_url: 'https://github.com/timastras9/pump-research-desk/pull/7' } : {};
    return { ok: !(url.includes('/contents/') && method === 'GET'), status: url.includes('/contents/') && method === 'GET' ? 404 : 200, json: async () => j };
  }) as any;
  const url = await openPullRequest({ GITHUB_TOKEN: 't', GITHUB_REPO: 'timastras9/pump-research-desk' } as any, 'Tighter stop', 'Stops fill at -35%', [{ path: 'research/engine.py', content: 'x' }], fake, Date.UTC(2026, 8, 27, 3, 4, 5));
  assert.equal(url, 'https://github.com/timastras9/pump-research-desk/pull/7');
  const ref = calls.find(c => c.url.endsWith('/git/refs'))!; assert.equal(ref.body.ref, 'refs/heads/astras/2026-09-27T03-04-05'); assert.equal(ref.body.sha, 'abc');
  const put = calls.find(c => c.method === 'PUT')!; assert.equal(put.body.branch, 'astras/2026-09-27T03-04-05');
  const pr = calls.find(c => c.url.endsWith('/pulls'))!; assert.equal(pr.body.draft, true); assert.equal(pr.body.base, 'main'); assert.equal(pr.body.head, 'astras/2026-09-27T03-04-05');
  assert.ok(!calls.some(c => c.method !== 'GET' && /heads\/main|"branch":"main"/.test(c.url + JSON.stringify(c.body ?? {}))), 'nothing written to main');
});

test('agent loop: calls a tool, feeds the result back, answers; lists tools and sources', async () => {
  const seen: any[] = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_doc', arguments: '{"key":"rag/index.json"}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } },
    { choices: [{ message: { content: 'No studies yet.' } }], usage: { prompt_tokens: 1200, completion_tokens: 20 } },
  ];
  const e = env({ AI: { run: async (_m: string, i: any) => { seen.push(JSON.parse(JSON.stringify(i.messages))); return replies.shift(); } } });
  const r = await agentTurn(e as any, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'How many studies?');
  assert.equal(r.answer, 'No studies yet.'); assert.deepEqual(r.tools, [{ name: 'read_doc', ok: true, detail: 'rag/index.json' }]); assert.deepEqual(r.sources, ['rag/index.json']);
  assert.equal(seen[0][1].content, 'hi', 'session memory sent'); assert.match(seen[0][0].content, /Astras agent/);
  assert.equal(seen[1].at(-1).role, 'tool'); assert.equal(seen[1].at(-1).content, '{"studies":[]}');
  assert.equal(r.actualUsd, 0.03);
});

test('agent loop: stops before passing the cost cap and after 6 tool steps', async () => {
  const huge = [{ role: 'user', content: 'x'.repeat(200000) }];
  const capped = await agentTurn(env() as any, huge, 'q');
  assert.equal(capped.answer, null); assert.match(capped.error!, new RegExp(`\\$${AGENT_CAP_USD} cap`));
  const loop = { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'read_doc', arguments: '{"key":"rag/index.json"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  const r = await agentTurn(env({ AI: { run: async () => loop } }) as any, [], 'q');
  assert.match(r.error!, /after 6 tool steps/); assert.equal(r.tools.length, 6);
});
