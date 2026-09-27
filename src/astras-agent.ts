// Astras agent on Cloudflare: one Durable Object per chat session (its own SQLite memory), persona from
// Open Astras prompts/astras.md, Workers AI model with tools. Zero trust - each tool reaches only what it needs:
//   search_data     AI Search instance (study export)        read
//   query_db        D1, 5 study tables, one SELECT, 200 rows  read
//   read_doc        R2, keys under rag/ only                 read
//   read_code       public repo timastras9/pump-research-desk only, no token   read
// No writes anywhere, no credentials, no network beyond these. Code suggestions go in the answer for Tim to apply.
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

export const CODE_REPO = 'timastras9/pump-research-desk';   // public; read without a token
/** Branch and path for read_code, or throws. Only this one repo; no traversal. */
export function safeCodeRef(branch: unknown, path: unknown) {
  const b = String(branch ?? 'main').trim() || 'main', p = String(path ?? '').trim().replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(b) || b.includes('..')) throw Error('invalid branch name');
  if (p && (!/^[A-Za-z0-9._\/ -]{1,300}$/.test(p) || p.includes('..'))) throw Error('invalid file path');
  return { branch: b, path: p };
}

// ---------------- tools ----------------
export const TOOLS = [
  { type: 'function', function: { name: 'search_data', description: 'Search the study export (studies, tokens, recordings with every frame priced, vision notes, token chat, glossary). Returns matching chunks with their document keys.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'query_db', description: `Run ONE read-only SELECT on the study database (SQLite/D1). Tables: ${DB_TABLES.join(', ')}. Rows hold JSON in a "data" column; use json_extract(data,'$.field'). Max 200 rows.`,
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } } },
  { type: 'function', function: { name: 'read_doc', description: 'Read one export document by key, e.g. rag/index.json, rag/glossary.md, rag/studies/..., rag/tokens/..., rag/recordings/...',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'read_code', description: `Read the project's code (public repo ${CODE_REPO}). Without path: list the files. With path: read that file. branch defaults to main; the newest work is on worktree-deploy-10min-studies.`,
    parameters: { type: 'object', properties: { path: { type: 'string' }, branch: { type: 'string' } } } } },
];

type SearchNs = { get(name: string): { search(q: unknown): Promise<{ chunks?: { score?: number; text?: string; item?: { key?: string } }[] }> } };
export type AgentEnv = { AI: Pick<Ai, 'run'>; CRYPTO_STUDY: Pick<D1Database, 'prepare'>; CRYPTO_MEDIA: Pick<R2Bucket, 'get'>;
  AI_SEARCH?: SearchNs; AI_SEARCH_INSTANCE?: string };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

export async function runTool(env: AgentEnv, name: string, args: any, doFetch: typeof fetch = fetch): Promise<{ ok: boolean; out: string }> {
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
    if (name === 'read_code') {
      const { branch, path } = safeCodeRef(args?.branch, args?.path), headers = { 'User-Agent': 'astras-agent' };
      if (!path) {
        const r = await doFetch(`https://api.github.com/repos/${CODE_REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: { ...headers, Accept: 'application/vnd.github+json' } });
        if (!r.ok) return { ok: false, out: `GitHub ${r.status} listing ${branch}` };
        const tree = ((await r.json()) as { tree?: { path: string; type: string; size?: number }[] }).tree ?? [];
        return { ok: true, out: clip(tree.filter(f => f.type === 'blob' && !/(^|\/)node_modules\//.test(f.path)).map(f => `${f.path} (${f.size ?? 0} B)`).join('\n'), 30000) };
      }
      const r = await doFetch(`https://raw.githubusercontent.com/${CODE_REPO}/${branch.split('/').map(encodeURIComponent).join('/')}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers });
      return r.ok ? { ok: true, out: clip(await r.text(), 60000) } : { ok: false, out: `GitHub ${r.status}: ${path} not found on ${branch}` };
    }
    return { ok: false, out: `unknown tool ${name}` };
  } catch (e) { return { ok: false, out: e instanceof Error ? e.message.slice(0, 500) : 'tool failed' }; }
}

export const AGENT_RULES = `
## How you work here (Cloudflare, Ask Astra)
Tools (all read-only): search_data (study export), query_db (one SELECT), read_doc (rag/ files), read_code (the project's public repo).
- Compute numbers with query_db instead of guessing; show the SQL you used for any number that matters.
- rag/index.json lists every study; rag/glossary.md explains every field.
- You cannot change code, data or settings. Put proposed code in a markdown code block for Tim to apply.
- Lead with the answer and the numbers. Short paragraphs or bullets.`;

// ---------------- the agent turn (the Durable Object itself is in astras-do.ts) ----------------
type Msg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
export type AgentReply = { answer: string | null; error: string | null; tools: { name: string; ok: boolean; detail: string }[]; actualUsd: number | null; estimatedUsd: number; sources: string[]; model: string };

/** The tool loop, separate from storage so it can be tested with a fake model. */
export async function agentTurn(env: AgentEnv, history: Msg[], question: string, doFetch: typeof fetch = fetch): Promise<AgentReply> {
  const messages: Msg[] = [{ role: 'system', content: ASTRAS_PERSONA + '\n' + AGENT_RULES }, ...history, { role: 'user', content: question }];
  const tools: AgentReply['tools'] = [], sources = new Set<string>();
  let usd = 0, known = true;
  for (let step = 0; step < MAX_STEPS; step++) {
    const est = estimateUsd(JSON.stringify(messages).length / CHARS_PER_TOKEN, MAX_OUTPUT);
    if (usd + est > AGENT_CAP_USD) return { answer: null, error: `stopped: the next step would pass the $${AGENT_CAP_USD} cap`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd + est), sources: [...sources], model: ASTRA_MODEL };
    const res = await (env.AI.run as (m: string, i: unknown) => Promise<any>)(ASTRA_MODEL, { messages, tools: TOOLS, max_completion_tokens: MAX_OUTPUT });
    const u = res?.usage; if (u?.prompt_tokens != null && u?.completion_tokens != null) usd += estimateUsd(u.prompt_tokens, u.completion_tokens); else { known = false; usd += est; }
    const msg = res?.choices?.[0]?.message ?? {}, calls = msg.tool_calls ?? [];
    if (!calls.length) return { answer: msg.content ?? '', error: null, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL };
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let args: any = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* bad JSON -> tool reports the error */ }
      const r = await runTool(env, c.function?.name, args, doFetch);
      if (c.function?.name === 'read_code' && r.ok && args.path) sources.add(`${CODE_REPO}/${args.branch ?? 'main'}/${args.path}`);
      if (c.function?.name === 'read_doc' && r.ok) sources.add(String(args.key));
      if (c.function?.name === 'search_data' && r.ok) for (const m of r.out.matchAll(/^--- (\S+)/gm)) sources.add(m[1]);
      tools.push({ name: c.function?.name, ok: r.ok, detail: c.function?.name === 'query_db' ? String(args.sql ?? '').slice(0, 300) : String(args.query ?? args.key ?? (args.path ? `${args.branch ?? 'main'}:${args.path}` : `list ${args.branch ?? 'main'}`)).slice(0, 200) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.out });
    }
  }
  return { answer: null, error: `stopped after ${MAX_STEPS} tool steps without a final answer`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
export { HISTORY_TURNS };
