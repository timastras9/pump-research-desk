import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSelect, safeDocKey, safeCodeRef, runTool, agentTurn, groqModel, workersAiModel, withFallback, TOOLS, AGENT_CAP_USD } from '../src/astras-agent';

test('query_db guard: one read-only SELECT over the 5 study tables, row cap added', () => {
  assert.equal(safeSelect("SELECT json_extract(data,'$.name') FROM study_tokens WHERE campaign_id='x';"), "SELECT * FROM (SELECT json_extract(data,'$.name') FROM study_tokens WHERE campaign_id='x') LIMIT 200");
  assert.ok(safeSelect('WITH t AS (SELECT data FROM study_tokens) SELECT count(*) FROM t JOIN model_rows m ON 1'));
  assert.ok(safeSelect("SELECT s.value FROM study_tokens t, json_each(t.data,'$.series') s"));
  assert.ok(safeSelect("SELECT data FROM study_tokens WHERE data LIKE '%delete%'"), 'keywords inside strings are fine');
  for (const bad of ['DELETE FROM study_tokens', 'SELECT 1; DROP TABLE study_tokens', 'SELECT * FROM study_chunks', 'SELECT * FROM study_tokens, study_chunks',
    'SELECT name FROM sqlite_master', 'SELECT * FROM _cf_KV', 'WITH x AS (SELECT 1) UPDATE study_tokens SET data=1', 'PRAGMA table_info(study_tokens)', 'SELECT * FROM unknown_table'])
    assert.throws(() => safeSelect(bad), Error, bad);
});

test('red-team audit bypasses are all blocked (F1, F2, F5)', () => {
  for (const bad of ['SELECT * FROM "secret_tbl"', 'SELECT * FROM/**/secret_tbl', 'SELECT * FROM [secret_tbl]', 'SELECT * FROM `secret_tbl`',
    'SELECT * FROM study_tokens, secret_tbl', 'SELECT * FROM study_tokens t, secret_tbl s WHERE 1', 'SELECT * FROM study_tokens, pragma_table_list',
    'SELECT * FROM pragma_table_info(\'study_tokens\')', 'SELECT 1 -- x\nFROM secret_tbl', 'WITH c AS (SELECT 1 x UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c',
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c', 'SELECT * FROM astra_log', 'SELECT * FROM study_tokens JOIN secret_tbl ON 1',
    'SELECT * FROM study_tokens LEFT JOIN "secret_tbl" ON 1', 'SELECT (SELECT count(*) FROM secret_tbl) FROM study_tokens',
    // re-audit R1: a parenthesis in a FROM list
    'SELECT * FROM (astra_log)', 'SELECT * FROM sqlite_master, (SELECT 1)', 'SELECT * FROM study_tokens, study_chunks, (SELECT 1)',
    'SELECT * FROM _cf_KV, (SELECT 1) t', 'SELECT * FROM study_tokens JOIN (study_chunks) ON 1', 'SELECT * FROM (secret_tbl) t',
    'SELECT * FROM study_tokens, (secret_tbl)', 'SELECT * FROM (SELECT * FROM secret_tbl)', 'SELECT * FROM study_tokens WHERE id IN (SELECT id FROM secret_tbl)',
    'SELECT * FROM (SELECT count(*) FROM (SELECT data FROM secret_tbl))'])
    assert.throws(() => safeSelect(bad), Error, bad);
  // The exact query the agent wrote in the live end-to-end test still runs.
  assert.ok(safeSelect(`SELECT t.campaign_id, json_extract(t.data, '$.paper.exitReason') AS exit_reason, COUNT(*) AS trades, SUM(json_extract(t.data, '$.paper.pnlUsd')) AS net_pnl_usd
    FROM study_tokens AS t WHERE t.campaign_id IN (SELECT id FROM study_campaigns WHERE started_at = (SELECT MAX(started_at) FROM study_campaigns))
    AND json_extract(t.data, '$.paper.exitReason') IS NOT NULL GROUP BY t.campaign_id, json_extract(t.data, '$.paper.exitReason') ORDER BY net_pnl_usd ASC;`));
  assert.ok(safeSelect('WITH a AS (SELECT data FROM study_tokens), b AS (SELECT data FROM a) SELECT count(*) FROM b'), 'CTEs that use earlier CTEs are fine');
});

test('read_code: fixed branches only, no PR refs (F3)', () => {
  assert.throws(() => safeCodeRef('refs/pull/1/head', 'src/a.ts'), Error);
  assert.throws(() => safeCodeRef('some-branch', 'src/a.ts'), Error);
  assert.deepEqual(safeCodeRef('worktree-deploy-10min-studies', 'src/a.ts'), { branch: 'worktree-deploy-10min-studies', path: 'src/a.ts' });
});

test('read_doc guard: rag/ only', () => {
  assert.equal(safeDocKey('/rag/index.json'), 'rag/index.json');
  for (const bad of ['studies/x/0.jpg', 'models/model-v3.json', 'rag/../models/model-v3.json', 'runs/a.json']) assert.throws(() => safeDocKey(bad), Error, bad);
});

test('zero trust: only the four read tools exist', () => {
  assert.deepEqual(TOOLS.map(t => t.function.name), ['search_data', 'query_db', 'read_doc', 'read_code']);
});

test('read_code: only the public project repo, no traversal, no token', async () => {
  assert.deepEqual(safeCodeRef(undefined, '/src/worker.ts'), { branch: 'main', path: 'src/worker.ts' });
  for (const [b, p] of [['main', '../x'], ['../main', 'a'], ['main;rm', 'a'], ['main', 'a?b=1']]) assert.throws(() => safeCodeRef(b, p), Error, `${b} ${p}`);
  const urls: { url: string; auth: unknown }[] = [];
  const fake = (async (url: string, init: any) => { urls.push({ url, auth: init?.headers?.Authorization }); return url.includes('/git/trees/')
    ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'src/worker.ts', type: 'blob', size: 10 }, { path: 'node_modules/x.js', type: 'blob' }, { path: 'src', type: 'tree' }] }) }
    : { ok: true, status: 200, text: async () => 'export {}' }; }) as any;
  const list = await runTool(env() as any, 'read_code', {}, fake);
  assert.equal(list.out, 'src/worker.ts (10 B)');
  const file = await runTool(env() as any, 'read_code', { path: 'src/worker.ts', branch: 'worktree-deploy-10min-studies' }, fake);
  assert.equal(file.out, 'export {}');
  assert.deepEqual(urls.map(u => u.url), ['https://api.github.com/repos/timastras9/pump-research-desk/git/trees/main?recursive=1',
    'https://raw.githubusercontent.com/timastras9/pump-research-desk/worktree-deploy-10min-studies/src/worker.ts']);
  assert.ok(urls.every(u => u.auth === undefined), 'no credentials sent');
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
  assert.equal((await runTool(e as any, 'propose_change', { title: 't' })).ok, false, 'no write tool');
});

test('agent loop: calls a tool, feeds the result back, answers; lists tools and sources', async () => {
  const seen: any[] = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_doc', arguments: '{"key":"rag/index.json"}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } },
    { choices: [{ message: { content: 'No studies yet.' } }], usage: { prompt_tokens: 1200, completion_tokens: 20 } },
  ];
  const e = env({ AI: { run: async (_m: string, i: any) => { seen.push(JSON.parse(JSON.stringify(i.messages))); return replies.shift(); } } });
  const r = await agentTurn(e as any, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'How many studies?');
  assert.equal(r.answer, 'No studies yet.'); assert.deepEqual(r.tools, [{ name: 'read_doc', ok: true, detail: 'rag/index.json' }]); assert.deepEqual(r.sources, ['rag/index.json']);
  assert.equal(seen[0][1].content, 'hi', 'session memory sent'); assert.match(seen[0][0].content, /Astras agent/);
  assert.equal(seen[1].at(-1).role, 'tool'); assert.equal(seen[1].at(-1).tool_call_id, 'c1'); assert.equal(seen[1].at(-1).content, '{"studies":[]}');
  assert.equal(r.actualUsd, 0.0008, 'gpt-oss-120b on Workers AI'); assert.equal(r.model, '@cf/openai/gpt-oss-120b');
});

test('agent loop: stops before passing the cost cap and after 6 tool steps', async () => {
  const huge = [{ role: 'user', content: 'x'.repeat(1_000_000) }];
  const capped = await agentTurn(env() as any, huge, 'q');
  assert.equal(capped.answer, null); assert.match(capped.error!, new RegExp(`\\$${AGENT_CAP_USD} cap`));
  const loop = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_doc', arguments: '{"key":"rag/index.json"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  const r = await agentTurn(env({ AI: { run: async () => loop } }) as any, [], 'q');
  assert.match(r.error!, /after 6 tool steps/); assert.equal(r.tools.length, 6);
});

test('fallback: a failing Groq call moves the step to Workers AI and reports that model', async () => {
  const badGroq = (async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) })) as any;
  const e = env({ AI: { run: async () => ({ choices: [{ message: { content: 'from workers ai' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) } });
  const r = await agentTurn(e as any, [], 'q', withFallback(groqModel('bad', badGroq), workersAiModel(e.AI as any)));
  assert.equal(r.answer, 'from workers ai'); assert.equal(r.model, '@cf/openai/gpt-oss-120b'); assert.equal(r.error, null);
});

test('groq model: gpt-oss-120b at Groq, key only in the Authorization header, priced at Groq rates', async () => {
  const seen: any[] = [];
  const fake = (async (url: string, init: any) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10000, completion_tokens: 1000 } }) }; }) as any;
  const r = await agentTurn(env() as any, [], 'q', groqModel('gsk_test', fake));
  assert.equal(r.answer, 'hi'); assert.equal(r.model, 'groq/openai/gpt-oss-120b');
  assert.equal(r.actualUsd, 0.0021, '(10000 x $0.15 + 1000 x $0.60) / 1M');
  assert.equal(seen[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer gsk_test'); assert.equal(JSON.parse(seen[0].init.body).model, 'openai/gpt-oss-120b');
  assert.ok(!JSON.parse(seen[0].init.body).messages.some((m: any) => m.content.includes('gsk_test')), 'key never in the prompt');
  const failing = (async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) })) as any;
  assert.match((await agentTurn(env() as any, [], 'q', groqModel('bad', failing))).error!, /Groq 401: Invalid API Key/);
});
