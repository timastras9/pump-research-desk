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
// astra_log is NOT readable: an injected answer could otherwise travel into later sessions (audit F5).
export const DB_TABLES = ['study_campaigns', 'study_tokens', 'model_runs', 'model_rows'];
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|recursive|load_extension)\b/i;
const TABLE_FUNCS = new Set(['json_each', 'json_tree']);
const STOP = String.raw`(?=\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|\bunion\b|\bintersect\b|\bexcept\b|\bwindow\b|\b(?:left|right|full|inner|outer|cross|natural)\b|\bjoin\b|\bon\b|\)|$)`;

/** Body of the parenthesised group that opens at s[open] (naive paren matching; strings already blanked). */
function group(s: string, open: number) { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return s.slice(open + 1, i); } return s.slice(open + 1); }

/** One read-only statement over the allowed tables, wrapped with a row cap. Throws with the reason otherwise.
 *  Hardened after the red-team audit (F1/F2): no quoted/bracketed identifiers or comments, every table in every
 *  FROM list and JOIN checked against the allowlist, table-valued pragma functions refused, no self-calling CTEs. */
export function safeSelect(sql: string, maxRows = 200) {
  const s = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw Error('only one SELECT (or WITH ... SELECT) statement is allowed');
  const bare = s.replace(/'(?:[^']|'')*'/g, "''");   // string literals blanked; everything below checks code only
  if (bare.includes(';')) throw Error('only one statement is allowed');
  if (/["`\[\]]|\/\*|--/.test(bare)) throw Error('quoted identifiers, brackets and comments are not allowed');
  if (WRITE_WORDS.test(bare) || /\bpragma_\w+/i.test(bare)) throw Error('write, schema or pragma keywords are not allowed');
  const ctes = [...bare.matchAll(/(?:\bwith|,)\s+([a-z_][a-z0-9_]*)\s*(?:\([^()]*\))?\s+as\s*\(/gi)];
  const cteNames = new Set(ctes.map(m => m[1].toLowerCase()));
  for (const m of ctes) if (new RegExp(`\\b${m[1]}\\b`, 'i').test(group(bare, m.index! + m[0].length - 1))) throw Error(`CTE "${m[1]}" refers to itself (recursion is not allowed)`);
  const allowed = (t: string) => DB_TABLES.includes(t) || TABLE_FUNCS.has(t) || cteNames.has(t);
  const flat = bare.replace(/\b(json_each|json_tree)\s*\([^()]*\)/gi, '$1');   // table functions -> their name
  for (const m of flat.matchAll(new RegExp(String.raw`\bfrom\s+([^()]*?)${STOP}`, 'gi')))
    for (const item of m[1].split(',')) { const t = item.trim().split(/\s+/)[0]?.toLowerCase(); if (t && !allowed(t)) throw Error(`table "${t}" is not allowed (allowed: ${DB_TABLES.join(', ')})`); }
  for (const m of flat.matchAll(/\bjoin\s+([a-z_][a-z0-9_]*)/gi)) if (!allowed(m[1].toLowerCase())) throw Error(`table "${m[1]}" is not allowed (allowed: ${DB_TABLES.join(', ')})`);
  if (/\bfrom\s+(?![a-z_(])/i.test(flat) || /\bjoin\s+(?![a-z_(])/i.test(flat)) throw Error('unsupported table reference');
  return `SELECT * FROM (${s}) LIMIT ${maxRows}`;
}

export const safeDocKey = (key: string) => {
  const k = String(key ?? '').trim().replace(/^\/+/, '');
  if (!k.startsWith('rag/') || k.includes('..') || k.length > 300) throw Error('only keys under rag/ can be read');
  return k;
};

export const CODE_REPO = 'timastras9/pump-research-desk';   // public; read without a token
/** Branch and path for read_code, or throws. Only this one repo; no traversal. */
// Fixed branches only: anyone can open a PR on a public repo, so PR refs could show attacker code as "ours" (audit F3).
export const CODE_BRANCHES = ['main', 'worktree-deploy-10min-studies'];
export function safeCodeRef(branch: unknown, path: unknown) {
  const b = String(branch ?? 'main').trim() || 'main', p = String(path ?? '').trim().replace(/^\/+/, '');
  if (!CODE_BRANCHES.includes(b)) throw Error(`branch must be one of: ${CODE_BRANCHES.join(', ')}`);
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
      return { ok: true, out: (r.chunks ?? []).map(c => `--- ${c.item?.key} (score ${(c.score ?? 0).toFixed(2)})\n${clip(String(c.text ?? ''), 1500)}`).join('\n') || 'no matches' };
    }
    if (name === 'query_db') {
      const rows = (await env.CRYPTO_STUDY.prepare(safeSelect(String(args?.sql ?? ''))).all()).results;
      return { ok: true, out: clip(JSON.stringify(rows), 6000) };
    }
    if (name === 'read_doc') {
      const o = await env.CRYPTO_MEDIA.get(safeDocKey(args?.key));
      return o ? { ok: true, out: clip(await o.text(), 15000) } : { ok: false, out: 'document not found' };
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
      return r.ok ? { ok: true, out: clip(await r.text(), 15000) } : { ok: false, out: `GitHub ${r.status}: ${path} not found on ${branch}` };
    }
    return { ok: false, out: `unknown tool ${name}` };
  } catch (e) { return { ok: false, out: e instanceof Error ? e.message.slice(0, 500) : 'tool failed' }; }
}

export const AGENT_RULES = `
## How you work here (Cloudflare, Ask Astra)
Tools (all read-only): search_data (study export), query_db (one SELECT), read_doc (rag/ files), read_code (the project's public repo).
- Compute numbers with query_db instead of guessing; show the SQL you used for any number that matters.
- In SQL select only the fields you need with json_extract(data,'$.field') and aggregate (COUNT, SUM, AVG, GROUP BY). Never SELECT the whole data column: it is huge and each result is cut at 6,000 characters.
- Schema (go straight to the query; do not explore the schema):
  study_campaigns(id, started_at ms, data): $.status, $.tokens, $.startedAt, $.paperResult.all.totalUsd, $.paperResult.filtered.totalUsd, $.paperMistakes
  study_tokens(id, campaign_id, started_at ms, data): $.name, $.mint, $.excluded, $.metrics.changePct (final %), $.metrics.peakGainPct, $.metrics.peakAfterMs,
    $.metrics.detectionDelayMs, $.paper.status, $.paper.exitReason, $.paper.skipReason, $.paper.pnlPct, $.paper.pnlUsd, $.paper.holdMs, $.paperMistake.label,
    $.launch.feeRouted, $.launch.mayhem, $.candidate.marketCapUsd
  model_runs(campaign_id, model_sha, created_at, summary JSON, review JSON); model_rows(campaign_id, model_sha, token_id, data JSON)
  Outcome: winner = changePct > 7; tanked = changePct <= -50; loser = the rest; leave out excluded = 1. Newest study = MAX(started_at).
- rag/index.json lists every study; rag/glossary.md explains every field.
- You cannot change code, data or settings. Put proposed code in a markdown code block for Tim to apply.
- Lead with the answer and the numbers. Short paragraphs or bullets.

## Calling a tool
To use a tool, reply with ONLY one line of JSON and nothing else:
{"tool":"<name>","args":{...}}
${TOOLS.map(t => `- ${t.function.name}: ${t.function.description} Args: ${JSON.stringify(t.function.parameters.properties)}`).join('\n')}
The result comes back in the next message as TOOL RESULT. Use as many tools as you need (up to ${MAX_STEPS}), then give your final answer as normal text (no JSON line).`;

/** A tool request from the model: one JSON line {"tool": name, "args": {...}}, else null (a final answer). */
export function parseToolCall(text: string): { name: string; args: any } | null {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try { const j = JSON.parse(t); return typeof j?.tool === 'string' ? { name: j.tool, args: j.args ?? {} } : null; } catch { return null; }
}

// ---------------- the agent turn (the Durable Object itself is in astras-do.ts) ----------------
// Tools are called through plain chat messages (the JSON line above): the model's native `tools`
// parameter was rejected by Workers AI (7003 User Input Error), plain messages work.
type Msg = { role: string; content: string };
export type AgentReply = { answer: string | null; error: string | null; tools: { name: string; ok: boolean; detail: string }[]; actualUsd: number | null; estimatedUsd: number; sources: string[]; model: string };

/** The tool loop, separate from storage so it can be tested with a fake model. */
export async function agentTurn(env: AgentEnv, history: Msg[], question: string, doFetch: typeof fetch = fetch): Promise<AgentReply> {
  const messages: Msg[] = [{ role: 'system', content: ASTRAS_PERSONA + '\n' + AGENT_RULES }, ...history, { role: 'user', content: question }];
  const tools: AgentReply['tools'] = [], sources = new Set<string>();
  let usd = 0, known = true;
  for (let step = 0; step < MAX_STEPS; step++) {
    const est = estimateUsd(JSON.stringify(messages).length / CHARS_PER_TOKEN, MAX_OUTPUT);
    if (usd + est > AGENT_CAP_USD) return { answer: null, error: `stopped: the next step would pass the $${AGENT_CAP_USD} cap`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd + est), sources: [...sources], model: ASTRA_MODEL };
    let res: any;
    try { res = await (env.AI.run as (m: string, i: unknown) => Promise<any>)(ASTRA_MODEL, { messages, max_completion_tokens: MAX_OUTPUT }); }
    catch (e) { return { answer: null, error: `model call failed: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown error'}`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL }; }
    const u = res?.usage; if (u?.prompt_tokens != null && u?.completion_tokens != null) usd += estimateUsd(u.prompt_tokens, u.completion_tokens); else { known = false; usd += est; }
    const text: string = res?.choices?.[0]?.message?.content ?? '', call = parseToolCall(text);
    if (!call) return { answer: text, error: null, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL };
    const { name, args } = call, r = await runTool(env, name, args, doFetch);
    if (name === 'read_code' && r.ok && args.path) sources.add(`${CODE_REPO}/${args.branch ?? 'main'}/${args.path}`);
    if (name === 'read_doc' && r.ok) sources.add(String(args.key));
    if (name === 'search_data' && r.ok) for (const m of r.out.matchAll(/^--- (\S+)/gm)) sources.add(m[1]);
    tools.push({ name, ok: r.ok, detail: name === 'query_db' ? String(args.sql ?? '').slice(0, 300) : String(args.query ?? args.key ?? (args.path ? `${args.branch ?? 'main'}:${args.path}` : `list ${args.branch ?? 'main'}`)).slice(0, 200) });
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `TOOL RESULT (${name}, ${r.ok ? 'ok' : 'error'}):\n${r.out}` });
  }
  return { answer: null, error: `stopped after ${MAX_STEPS} tool steps without a final answer`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: ASTRA_MODEL };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
export { HISTORY_TURNS };
