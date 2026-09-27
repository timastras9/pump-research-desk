// Astras agent on Cloudflare: one Durable Object per chat session (its own SQLite memory), persona from
// Open Astras prompts/astras.md, Workers AI model with tools. Zero trust - each tool reaches only what it needs:
//   search_data     AI Search instance (study export)        read
//   query_db        D1, 5 study tables, one SELECT, 200 rows  read
//   read_doc        R2, keys under rag/ only                 read
//   propose_change  GITHUB_REPO only: new astras/* branch + DRAFT pull request; never main; Tim merges
import { ASTRAS_PERSONA } from './astras-prompt';
import { ASTRA_MODEL, estimateUsd } from './astra-review';

export const AGENT_CAP_USD = 0.5;
export const MAX_STEPS = 6;
const MAX_OUTPUT = 4000, HISTORY_TURNS = 30, CHARS_PER_TOKEN = 3;

// ---------------- guards (pure) ----------------
export const DB_TABLES = ['study_campaigns', 'study_tokens', 'model_runs', 'model_rows', 'astra_log'];
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;
const TABLE_FUNCS = new Set(['json_each', 'json_tree']);

/** One read-only statement over the allowed tables, wrapped with a row cap. Throws with the reason otherwise. */
export function safeSelect(sql: string, maxRows = 200) {
  const s = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw Error('only one SELECT (or WITH ... SELECT) statement is allowed');
  if (s.includes(';')) throw Error('only one statement is allowed');
  if (WRITE_WORDS.test(s.replace(/'(?:[^']|'')*'/g, "''"))) throw Error('write or schema keywords are not allowed');
  const other = s.match(/\b(study_chunks|sqlite_\w+|_cf_\w+|d1_\w+)\b/i);   // catches comma joins and subqueries too
  if (other) throw Error(`table "${other[1]}" is not allowed (allowed: ${DB_TABLES.join(', ')})`);
  const ctes = new Set([...s.matchAll(/(?:\bwith|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map(m => m[1].toLowerCase()));
  for (const m of s.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const t = m[1].toLowerCase();
    if (!DB_TABLES.includes(t) && !TABLE_FUNCS.has(t) && !ctes.has(t)) throw Error(`table "${m[1]}" is not allowed (allowed: ${DB_TABLES.join(', ')})`);
  }
  return `SELECT * FROM (${s}) LIMIT ${maxRows}`;
}

export const safeDocKey = (key: string) => {
  const k = String(key ?? '').trim().replace(/^\/+/, '');
  if (!k.startsWith('rag/') || k.includes('..') || k.length > 300) throw Error('only keys under rag/ can be read');
  return k;
};

export const CHANGE_PATHS = /^(src|public|research|scripts|test|data-analysis|docs|tasks)\/[A-Za-z0-9._\/-]+$/;
export type FileChange = { path: string; content: string };
export function safeChange(files: unknown): FileChange[] {
  if (!Array.isArray(files) || !files.length || files.length > 5) throw Error('propose 1 to 5 files');
  return files.map((f: any) => {
    const path = String(f?.path ?? '').replace(/^\/+/, ''), content = String(f?.content ?? '');
    if (!CHANGE_PATHS.test(path) || path.includes('..') || /(^|\/)\.|\.env|secret|credential/i.test(path))
      throw Error(`path "${path}" is not allowed (src/, public/, research/, scripts/, test/, data-analysis/, docs/, tasks/)`);
    if (!content.trim() || content.length > 200_000) throw Error(`content for ${path} must be 1 to 200,000 characters`);
    return { path, content };
  });
}

// ---------------- tools ----------------
export const TOOLS = [
  { type: 'function', function: { name: 'search_data', description: 'Search the study export (studies, tokens, recordings with every frame priced, vision notes, token chat, glossary). Returns matching chunks with their document keys.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'query_db', description: `Run ONE read-only SELECT on the study database (SQLite/D1). Tables: ${DB_TABLES.join(', ')}. Rows hold JSON in a "data" column; use json_extract(data,'$.field'). Max 200 rows.`,
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } } },
  { type: 'function', function: { name: 'read_doc', description: 'Read one export document by key, e.g. rag/index.json, rag/glossary.md, rag/studies/..., rag/tokens/..., rag/recordings/...',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'propose_change', description: 'Propose a code change to the pump-research-desk repo: commits the files to a new branch and opens a DRAFT pull request for Tim to review and merge. Only when Tim asks for a change. Full file contents, 1-5 files, under src/, public/, research/, scripts/, test/, data-analysis/, docs/ or tasks/.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' },
      files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      required: ['title', 'why', 'files'] } } },
];

type SearchNs = { get(name: string): { search(q: unknown): Promise<{ chunks?: { score?: number; text?: string; item?: { key?: string } }[] }> } };
export type AgentEnv = { AI: Pick<Ai, 'run'>; CRYPTO_STUDY: Pick<D1Database, 'prepare'>; CRYPTO_MEDIA: Pick<R2Bucket, 'get'>;
  AI_SEARCH?: SearchNs; AI_SEARCH_INSTANCE?: string; GITHUB_TOKEN?: string; GITHUB_REPO?: string };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

export async function runTool(env: AgentEnv, name: string, args: any, doFetch: typeof fetch = fetch): Promise<{ ok: boolean; out: string; pr?: string }> {
  try {
    if (name === 'search_data') {
      if (!env.AI_SEARCH || !env.AI_SEARCH_INSTANCE) return { ok: false, out: 'document search is not connected' };
      const r = await env.AI_SEARCH.get(env.AI_SEARCH_INSTANCE).search({ messages: [{ role: 'user', content: String(args?.query ?? '') }], ai_search_options: { retrieval: { max_num_results: 8 } } });
      return { ok: true, out: (r.chunks ?? []).map(c => `--- ${c.item?.key} (score ${(c.score ?? 0).toFixed(2)})\n${clip(String(c.text ?? ''), 3000)}`).join('\n') || 'no matches' };
    }
    if (name === 'query_db') {
      const rows = (await env.CRYPTO_STUDY.prepare(safeSelect(String(args?.sql ?? ''))).all()).results;
      return { ok: true, out: clip(JSON.stringify(rows), 30000) };
    }
    if (name === 'read_doc') {
      const o = await env.CRYPTO_MEDIA.get(safeDocKey(args?.key));
      return o ? { ok: true, out: clip(await o.text(), 60000) } : { ok: false, out: 'document not found' };
    }
    if (name === 'propose_change') {
      const pr = await openPullRequest(env, String(args?.title ?? 'Astras change'), String(args?.why ?? ''), safeChange(args?.files), doFetch);
      return { ok: true, out: `Draft pull request opened: ${pr}`, pr };
    }
    return { ok: false, out: `unknown tool ${name}` };
  } catch (e) { return { ok: false, out: e instanceof Error ? e.message.slice(0, 500) : 'tool failed' }; }
}

const b64 = (s: string) => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };

/** New branch astras/<time> from the default branch, one commit per file, then a DRAFT pull request. Never writes main. */
export async function openPullRequest(env: AgentEnv, title: string, why: string, files: FileChange[], doFetch: typeof fetch = fetch, now = Date.now()) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO)) throw Error('GITHUB_TOKEN / GITHUB_REPO not set');
  const api = `https://api.github.com/repos/${env.GITHUB_REPO}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'astras-agent', 'Content-Type': 'application/json' };
  const gh = async (path: string, init: RequestInit = {}) => {
    const r = await doFetch(api + path, { ...init, headers }); const j = await r.json() as any;
    if (!r.ok && r.status !== 404) throw Error(`GitHub ${r.status}: ${j?.message ?? 'request failed'}`);
    return { status: r.status, j };
  };
  const base = (await gh('')).j.default_branch as string;
  const head = (await gh(`/git/ref/heads/${base}`)).j.object.sha as string;
  const branch = `astras/${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head }) });
  for (const f of files) {
    const cur = await gh(`/contents/${f.path}?ref=${branch}`);
    await gh(`/contents/${f.path}`, { method: 'PUT', body: JSON.stringify({ message: `Astras: ${title} (${f.path})`, content: b64(f.content), branch, ...(cur.status === 200 ? { sha: cur.j.sha } : {}) }) });
  }
  const pr = await gh('/pulls', { method: 'POST', body: JSON.stringify({ title: `Astras: ${title}`, head: branch, base, draft: true,
    body: `${why}\n\nFiles: ${files.map(f => '`' + f.path + '`').join(', ')}\n\nProposed by the Astras agent from Ask Astra. Review before merging.` }) });
  return pr.j.html_url as string;
}

export const AGENT_RULES = `
## How you work here (Cloudflare, Ask Astra)
Tools: search_data (study export), query_db (one read-only SELECT), read_doc (rag/ files), propose_change (draft pull request only).
- Compute numbers with query_db instead of guessing; show the SQL you used for any number that matters.
- rag/index.json lists every study; rag/glossary.md explains every field.
- propose_change only when Tim asks for a change. It opens a DRAFT pull request; Tim reviews and merges. Never claim a change is live.
- Lead with the answer and the numbers. Short paragraphs or bullets.`;

// ---------------- the agent turn (the Durable Object itself is in astras-do.ts) ----------------
type Msg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
export type AgentReply = { answer: string | null; error: string | null; tools: { name: string; ok: boolean; detail: string }[]; pullRequests: string[]; actualUsd: number | null; estimatedUsd: number; sources: string[]; model: string };

/** The tool loop, separate from storage so it can be tested with a fake model. */
export async function agentTurn(env: AgentEnv, history: Msg[], question: string, doFetch: typeof fetch = fetch): Promise<AgentReply> {
  const messages: Msg[] = [{ role: 'system', content: ASTRAS_PERSONA + '\n' + AGENT_RULES }, ...history, { role: 'user', content: question }];
  const tools: AgentReply['tools'] = [], prs: string[] = [], sources = new Set<string>();
  let usd = 0, known = true;
  for (let step = 0; step < MAX_STEPS; step++) {
    const est = estimateUsd(JSON.stringify(messages).length / CHARS_PER_TOKEN, MAX_OUTPUT);
    if (usd + est > AGENT_CAP_USD) return { answer: null, error: `stopped: the next step would pass the $${AGENT_CAP_USD} cap`, tools, pullRequests: prs, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd + est), sources: [...sources], model: ASTRA_MODEL };
    const res = await (env.AI.run as (m: string, i: unknown) => Promise<any>)(ASTRA_MODEL, { messages, tools: TOOLS, max_completion_tokens: MAX_OUTPUT });
    const u = res?.usage; if (u?.prompt_tokens != null && u?.completion_tokens != null) usd += estimateUsd(u.prompt_tokens, u.completion_tokens); else { known = false; usd += est; }
    const msg = res?.choices?.[0]?.message ?? {}, calls = msg.tool_calls ?? [];
    if (!calls.length) return { answer: msg.content ?? '', error: null, tools, pullRequests: prs, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL };
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let args: any = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* bad JSON -> tool reports the error */ }
      const r = await runTool(env, c.function?.name, args, doFetch);
      if (r.pr) prs.push(r.pr);
      if (c.function?.name === 'read_doc' && r.ok) sources.add(String(args.key));
      if (c.function?.name === 'search_data' && r.ok) for (const m of r.out.matchAll(/^--- (\S+)/gm)) sources.add(m[1]);
      tools.push({ name: c.function?.name, ok: r.ok, detail: c.function?.name === 'query_db' ? String(args.sql ?? '').slice(0, 300) : c.function?.name === 'propose_change' ? (r.pr ?? r.out) : String(args.query ?? args.key ?? '').slice(0, 200) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.out });
    }
  }
  return { answer: null, error: `stopped after ${MAX_STEPS} tool steps without a final answer`, tools, pullRequests: prs, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
export { HISTORY_TURNS };
