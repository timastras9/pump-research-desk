// Astras agent on Cloudflare: one Durable Object per chat session (its own SQLite memory), persona from
// Open Astras prompts/astras.md, gpt-oss-120b (Groq, or Workers AI without a Groq key) with tools. Zero trust -
// each tool reaches only what it needs:
//   search_data     AI Search instance (study export)        read
//   query_db        D1, 4 study tables, one SELECT, 200 rows  read
//   read_doc        R2, keys under rag/ only                 read
//   read_code       public repo timastras9/pump-research-desk only, no token   read
// No writes anywhere. The Groq key is used only by the model call, never by a tool. Code suggestions go in the answer.
import { ASTRAS_PERSONA } from './astras-prompt';

export const AGENT_CAP_USD = 2;   // Tim: cost is not the concern

// ---------------- model (injected, so tools never hold the key) ----------------
// gpt-oss uses NATIVE tool calling (verified against the real model): with tools described only in text it
// routes the call to a hidden channel and returns content: null.
type ChatMsg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
export type ToolCall = { id: string; name: string; arguments: string; raw: any };
export type ModelResult = { text: string; toolCalls: ToolCall[]; inTok: number | null; outTok: number | null };
export type Model = { name: string; inPerM: number; outPerM: number; capUsd?: number; call(messages: ChatMsg[], maxOut: number, useTools?: boolean): Promise<ModelResult> };
const toolCalls = (r: any): ToolCall[] => (r?.choices?.[0]?.message?.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments ?? '{}', raw: c }));
const usage = (u: any): Pick<ModelResult, 'inTok' | 'outTok'> => ({ inTok: u?.prompt_tokens ?? u?.input_tokens ?? null, outTok: u?.completion_tokens ?? u?.output_tokens ?? null });
/** The answer text from any reply shape: Chat Completions, Responses API (output_text / output[].content[].text) or legacy `response`. */
export function replyText(r: any): string {
  const c = r?.choices?.[0]?.message?.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) { const t = c.map((p: any) => p?.text ?? '').join(''); if (t.trim()) return t; }
  if (typeof r?.output_text === 'string' && r.output_text.trim()) return r.output_text;
  if (Array.isArray(r?.output)) { const t = r.output.filter((o: any) => o?.type === 'message').flatMap((o: any) => o.content ?? []).map((p: any) => p?.text ?? '').join(''); if (t.trim()) return t; }
  return typeof r?.response === 'string' ? r.response : '';
}
/** gpt-oss-120b on Groq (OpenAI-compatible API). List price used for the cap: $0.15 in / $0.60 out per 1M tokens. */
export function groqModel(key: string, doFetch: typeof fetch = fetch): Model {
  return { name: 'groq/openai/gpt-oss-120b', inPerM: 0.15, outPerM: 0.6, async call(messages, maxOut, useTools = true) {
    const r = await doFetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, ...(useTools ? { tools: TOOLS } : {}), max_completion_tokens: maxOut }) });
    const j = await r.json() as any;
    if (!r.ok) throw Error(`Groq ${r.status}: ${j?.error?.message ?? 'request failed'}`);
    return { text: replyText(j), toolCalls: toolCalls(j), ...usage(j?.usage) };
  } };
}
/** DeepSeek V4 Pro on Fireworks (OpenAI-compatible, native tools, 1M context). Price not published on the model page:
 *  the cap uses a conservative $2 in / $8 out per 1M tokens. */
export const FIREWORKS_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';   // Tim's Fireworks example
export function fireworksModel(key: string, doFetch: typeof fetch = fetch, model = FIREWORKS_MODEL): Model {
  return { name: 'fireworks/deepseek-v4p1-flash', inPerM: 2, outPerM: 8, capUsd: 2, async call(messages, maxOut, useTools = true) {
    const r = await doFetch('https://api.fireworks.ai/inference/v1/chat/completions', { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, messages, ...(useTools ? { tools: TOOLS } : {}), max_tokens: maxOut, reasoning_effort: 'none', service_tier: 'priority' }) });   // Tim: thinking off (speed)
    const j = await r.json() as any;
    if (!r.ok) throw Error(`Fireworks ${r.status}: ${j?.error?.message ?? j?.message ?? 'request failed'}`);
    return { text: replyText(j), toolCalls: toolCalls(j), ...usage(j?.usage) };
  } };
}
/** Same model on Workers AI (fallback when no Groq key): $0.35 in / $0.75 out per 1M tokens. */
export function workersAiModel(ai: Pick<Ai, 'run'>): Model {
  return { name: '@cf/openai/gpt-oss-120b', inPerM: 0.35, outPerM: 0.75, async call(messages, maxOut, useTools = true) {
    const r = await (ai.run as (m: string, i: unknown) => Promise<any>)('@cf/openai/gpt-oss-120b', { messages, ...(useTools ? { tools: TOOLS } : {}), max_completion_tokens: maxOut });
    return { text: replyText(r), toolCalls: toolCalls(r), ...usage(r?.usage) };
  } };
}
/** Tim's model: openai/gpt-6-astra on Workers AI. It rejects the native `tools` parameter (7003) but handles tools as
 *  plain chat (verified end to end), so this adapter converts: tool calls <-> one JSON line; tool results -> a user
 *  message. List price used for the cap: $12 in (cache-write rate, never below the bill) / $50 out per 1M tokens. */
export const ASTRA_TOOL_PROTOCOL = () => `## Calling a tool
To use a tool, reply with ONLY one line of JSON and nothing else: {"tool":"<name>","args":{...}}
${TOOLS.map(t => `- ${t.function.name}: ${t.function.description} Args: ${JSON.stringify(t.function.parameters.properties)}`).join('\n')}
The result comes back as a message starting with TOOL RESULT. When you have what you need, answer in normal text (no JSON line).`;
/** A tool request written as one JSON line {"tool": name, "args": {...}}, else null. */
export function parseToolCall(text: string): { name: string; args: any } | null {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try { const j = JSON.parse(t); return typeof j?.tool === 'string' ? { name: j.tool, args: j.args ?? {} } : null; } catch { return null; }
}
export function astraModel(ai: Pick<Ai, 'run'>): Model {
  let n = 0;
  return { name: 'openai/gpt-6-astra', inPerM: 12, outPerM: 50, capUsd: 2, async call(messages, maxOut, useTools = true) {
    const plain: ChatMsg[] = messages.map(m => m.role === 'tool' ? { role: 'user', content: `TOOL RESULT:\n${m.content ?? ''}` }
      : m.tool_calls?.length ? { role: 'assistant', content: m.tool_calls.map((c: any) => JSON.stringify({ tool: c.function?.name, args: JSON.parse(c.function?.arguments || '{}') })).join('\n') }
      : { role: m.role, content: m.content ?? '' });
    if (useTools) plain.splice(1, 0, { role: 'system', content: ASTRA_TOOL_PROTOCOL() });
    const r = await (ai.run as (m: string, i: unknown) => Promise<any>)('openai/gpt-6-astra', { messages: plain, max_completion_tokens: maxOut });
    const text = replyText(r), call = useTools ? parseToolCall(text) : null;
    if (!call) return { text, toolCalls: [], ...usage(r?.usage) };
    const id = `astra-${++n}`, args = JSON.stringify(call.args);
    return { text: '', toolCalls: [{ id, name: call.name, arguments: args, raw: { id, type: 'function', function: { name: call.name, arguments: args } } }], ...usage(r?.usage) };
  } };
}
/** Primary first; if a primary call fails, the same step runs on the backup, priced at its rates. */
export function withFallback(primary: Model, backup: Model): Model {
  let active = primary;
  return { get name() { return active.name; }, get inPerM() { return active.inPerM; }, get outPerM() { return active.outPerM; }, get capUsd() { return active.capUsd; },
    async call(messages, maxOut, useTools = true) {
      if (active === primary) { try { return await primary.call(messages, maxOut, useTools); } catch (e) { console.error(JSON.stringify({ message: "model_fallback", from: primary.name, to: backup.name, error: e instanceof Error ? e.message.slice(0, 500) : String(e) })); active = backup; } }
      return backup.call(messages, maxOut, useTools);
    } } as Model;
}
export const MAX_STEPS = 12;   // the last step has tools switched off, so there is always a final answer
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
  // Layer 1 (re-audit R1): every other table in this database is refused wherever it appears.
  const other = bare.match(/\b(study_chunks|astra_log|sqlite_\w+|_cf_\w+|d1_\w+)\b/i);
  if (other) throw Error(`table "${other[1]}" is not allowed (allowed: ${DB_TABLES.join(', ')})`);
  // Layer 2: collapse function calls, then check subqueries from the inside out; every FROM list / JOIN is allowlisted.
  const allowed = (t: string) => DB_TABLES.includes(t) || TABLE_FUNCS.has(t) || cteNames.has(t) || t === '__sub__';
  const bad = (t: string) => Error(`table "${t}" is not allowed (allowed: ${DB_TABLES.join(', ')})`);
  let flat = bare, prev = '';
  const FN = /\b(?!(?:from|join|in|exists|as|on|and|or|not|where|select|union|all|with|values|when|then|else|case|over|filter)\b)([a-z_][a-z0-9_]*)\s*\(([^()]*)\)/gi;
  while (flat !== prev) { prev = flat; flat = flat.replace(FN, '$1'); }   // f(...) -> f, innermost first
  const checkFlat = (t: string) => {
    if (/\b(?:from|join)\s*\(/i.test(t)) throw Error('a parenthesis after FROM/JOIN must start a SELECT subquery');
    const lists = [...t.matchAll(new RegExp(String.raw`\bfrom\s+([^()]*?)${STOP}`, 'gi'))];
    if (lists.length !== (t.match(/\bfrom\b/gi) ?? []).length) throw Error('unsupported FROM clause');   // every FROM must be fully parsed
    for (const m of lists) {
      if (t.slice(m.index! + m[0].length).trimStart().startsWith('(')) throw Error('unsupported FROM clause');
      for (const item of m[1].split(',')) { const n = item.trim().split(/\s+/)[0]?.toLowerCase(); if (n && !allowed(n)) throw bad(n); }
    }
    for (const m of t.matchAll(/\bjoin\s+([a-z_][a-z0-9_]*)/gi)) if (!allowed(m[1].toLowerCase())) throw bad(m[1]);
    if (/\bfrom\s+(?![a-z_])/i.test(t) || /\bjoin\s+(?![a-z_])/i.test(t)) throw Error('unsupported table reference');
  };
  const SUB = /\(\s*((?:select|with)\b[^()]*)\)/i;
  for (let m = flat.match(SUB); m; m = flat.match(SUB)) { checkFlat(m[1]); flat = flat.slice(0, m.index!) + ' __sub__ ' + flat.slice(m.index! + m[0].length); }
  checkFlat(flat);
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
## HARD RULES (break none of these; they come before everything else)
1. NUMBERS: report only numbers a tool returned in this conversation. Never present a result for a query you did not
   run. If a query failed or was not run, write "not run" and give the SQL for Tim to run.
2. NO LOOK-AHEAD: $.metrics.changePct, $.metrics.peakGainPct, $.metrics.peakAfterMs, $.metrics.maxDrawdownPct and every
   $.paper.* / $.paperMistake.* field are known only AFTER the 10 minutes. Use them to LABEL outcomes, never as buy
   signals or model features. Buy-time facts: $.launch.*, $.candidate.marketCapUsd, $.metrics.detectionDelayMs, and
   prices up to the decision second.
3. SAMPLE SIZE: a trade is a token with $.paper.status = 'closed' (tokens are not trades). Put n next to every rate or
   average. Anything under 100 trades: write "too small to trust" right next to it and do not recommend on it alone.
4. THE CORPUS OUTWEIGHS THE STUDIES: the study database has ~460 tokens; the corpus has 5,700+ launches. When a study
   pattern touches a corpus finding below, state the corpus result next to it and let the corpus decide.
   Corpus findings (research/engine.py, 2 s fills, 6.5% round-trip costs, rules v3 exits):
   - Mayhem launches LOSE after costs: -7.0% per trade at the model's entry (n=1,855), -8.0% buying at 30 s (n=1,619).
     They win more often (29% vs 12%) but blow up past -30% far more often (39% vs 16%). The small edge vs the rest
     (+2.4 pts) disappears in the newer half of the data.
   - 72-78% of launches that reach +50% or +100% peak inside the first 60 s.
   - Simple entry filters at 30 s or 58 s lose 7-14% per trade after costs; model v3 is best at -3.5%.
   - Activity/volatility at 30 s pick movers that also crash harder: the exits are where the money leaks.

## How you work here (Cloudflare, Ask Astra)
Tools (all read-only): search_data (study export), query_db (one SELECT), read_doc (rag/ files), read_code (the project's public repo).
- Compute numbers with query_db instead of guessing; show the SQL you used for any number that matters.
- In SQL select only the fields you need with json_extract(data,'$.field') and aggregate (COUNT, SUM, AVG, GROUP BY). Never SELECT the whole data column: it is huge and each result is cut at 6,000 characters. Array items: json_extract(data,'$.arr[2]').
- Schema (go straight to the query; do not explore the schema):
  study_campaigns(id, started_at ms, data): $.status, $.tokens, $.startedAt, $.paperResult.all.totalUsd, $.paperResult.filtered.totalUsd, $.paperMistakes
  study_tokens(id, campaign_id, started_at ms, data): $.name, $.mint, $.excluded, $.metrics.changePct (final %), $.metrics.peakGainPct, $.metrics.peakAfterMs,
    $.metrics.detectionDelayMs, $.paper.status, $.paper.exitReason, $.paper.skipReason, $.paper.pnlPct, $.paper.pnlUsd, $.paper.holdMs, $.paperMistake.label,
    $.launch.feeRouted, $.launch.mayhem, $.candidate.marketCapUsd
    Token chat (pump.fun comments, buy-time safe when the window ends before the decision): $.chatWindows[] = one entry per
    window with $.seconds (e.g. 30, 60, 120 after recording start), $.uniqueComments, $.sentiment.positiveComments /
    negativeComments / mixedComments, $.repeatedTerms. Query with json_each(data,'$.chatWindows'). Every comment with the
    second, price and screenshot when it appeared is in rag/recordings/<study>/<token>.json ("chat"); search_data finds it.
    Only 65 of 460 tokens had visible comments: give n.
  model_runs(campaign_id, model_sha, created_at, summary JSON, review JSON); model_rows(campaign_id, model_sha, token_id, data JSON)
  Outcome: winner = changePct > 7; tanked = changePct <= -50; loser = the rest; leave out excluded = 1. Newest study = MAX(started_at).
- rag/index.json lists every study; rag/glossary.md explains every field.
- Broad questions ("analyze everything", "plan the models"): start from rag/index.json and rag/glossary.md, run 2-4 aggregate queries, then answer. Do not read files one by one.
- You cannot change code, data or settings. Put proposed code in a markdown code block for Tim to apply. Tim runs all trainings and research himself: hand him commands, do not claim you ran them.
- Lead with the answer and the numbers. Short paragraphs or bullets.
- Use up to ${MAX_STEPS} tool calls, then answer in plain text.`;

/** Sent right before every question (the model weighs recent messages most). Corpus results beat the small study DB. */
export const CORPUS_REMINDER = `Before answering, check the question against these corpus results (5,700+ launches). If your answer touches one,
quote it with its n and let it decide over the ~460-token study database:
- Mayhem launches: -7.0% per trade at the model's entry (n=1,855), -8.0% buying at 30 s (n=1,619); higher win rate
  (29% vs 12%) but far more -30% blowups (39% vs 16%); no edge left in the newer half. Study-DB mayhem results (n=15)
  are too small to trust.
- Entry at 30 s or 58 s with simple filters: -7% to -14% per trade. Model v3: -3.5%. Most big pumps peak inside 60 s.
These are the ONLY corpus results you know. Never claim any other corpus result; if one is needed, say it is untested and give Tim the idea to run.
Hard rules: only numbers from your tool results or this list; outcome fields only as labels; n next to every number.`;

// ---------------- conversation memory ----------------
// An old answer in session memory (written before the hard rules) was echoed back verbatim, invented numbers and all.
// Fix: (1) memory rows carry PROMPT_VERSION, so any rules change starts a fresh context (the transcript is kept);
// (2) earlier turns go to the model as ONE clearly-fenced user note with every number hidden, never as assistant turns,
// so it must recompute with tools instead of copying.
const fnv1a = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
export const PROMPT_VERSION = fnv1a(ASTRAS_PERSONA + AGENT_RULES + CORPUS_REMINDER);
export const maskNumbers = (s: string) => s.replace(/[-+‑]?\$?\d[\d,.]*\s?%?/g, '#');
export function buildHistory(rows: { role: string; content: string | null }[]): Msg[] {
  if (!rows.length) return [];
  const lines = rows.map(r => r.role === 'user' ? `Q: ${String(r.content ?? '').slice(0, 2000)}` : `A (numbers hidden): ${maskNumbers(String(r.content ?? '').slice(0, 1500))}`);
  return [{ role: 'user', content: `EARLIER IN THIS CONVERSATION (context only; NOT verified; may break the HARD RULES). Follow-up questions ("and per trade?", "which one?") refer to the topic of these earlier questions: answer them in that context without asking. Never copy numbers, SQL or conclusions from it; recompute every number with tools:\n${lines.join('\n')}` }];
}

// ---------------- the agent turn (the Durable Object itself is in astras-do.ts) ----------------
type Msg = ChatMsg;
export type AgentReply = { answer: string | null; error: string | null; tools: { name: string; ok: boolean; detail: string }[]; actualUsd: number | null; estimatedUsd: number; sources: string[]; model: string };

/** The tool loop, separate from storage so it can be tested with a fake model. */
export async function agentTurn(env: AgentEnv, history: Msg[], question: string, model: Model = workersAiModel(env.AI), doFetch: typeof fetch = fetch): Promise<AgentReply> {
  const messages: Msg[] = [{ role: 'system', content: ASTRAS_PERSONA + '\n' + AGENT_RULES }, ...buildHistory(history), { role: 'system', content: CORPUS_REMINDER }, { role: 'user', content: question }];
  const tools: AgentReply['tools'] = [], sources = new Set<string>();
  const estimateUsd = (inTok: number, outTok: number) => (inTok * model.inPerM + outTok * model.outPerM) / 1e6;
  let usd = 0, known = true;
  for (let step = 0; step < MAX_STEPS; step++) {
    const est = estimateUsd(JSON.stringify(messages).length / CHARS_PER_TOKEN, MAX_OUTPUT);
    const cap = model.capUsd ?? AGENT_CAP_USD;
    if (usd + est > cap) return { answer: null, error: `stopped: the next step would pass the $${cap} cap`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd + est), sources: [...sources], model: model.name };
    let res: ModelResult;
    const last = step === MAX_STEPS - 1;
    if (last) messages.push({ role: 'user', content: 'Tool budget used up. Answer now from what you have gathered: findings with numbers, then what to do next. No more tool calls.' });
    try { res = await model.call(messages, MAX_OUTPUT, !last); }
    catch (e) { return { answer: null, error: `model call failed: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown error'}`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: model.name }; }
    if (res.inTok != null && res.outTok != null) usd += estimateUsd(res.inTok, res.outTok); else { known = false; usd += est; }
    const text = res.text;
    if (!res.toolCalls.length || last) return text.trim()
      ? { answer: text, error: null, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: model.name }
      : { answer: null, error: 'the model returned an empty reply', tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: model.name };
    messages.push({ role: 'assistant', content: text || '', tool_calls: res.toolCalls.map(c => c.raw) });
    for (const c of res.toolCalls) {
      let args: any = {}; try { args = JSON.parse(c.arguments || '{}'); } catch { /* bad JSON -> the tool reports it */ }
      const name = c.name, r = await runTool(env, name, args, doFetch);
      if (name === 'read_code' && r.ok && args.path) sources.add(`${CODE_REPO}/${args.branch ?? 'main'}/${args.path}`);
      if (name === 'read_doc' && r.ok) sources.add(String(args.key));
      if (name === 'search_data' && r.ok) for (const m of r.out.matchAll(/^--- (\S+)/gm)) sources.add(m[1]);
      tools.push({ name, ok: r.ok, detail: name === 'query_db' ? String(args.sql ?? '').slice(0, 300) : String(args.query ?? args.key ?? (args.path ? `${args.branch ?? 'main'}:${args.path}` : `list ${args.branch ?? 'main'}`)).slice(0, 200) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.out });
    }
  }
  return { answer: null, error: `stopped after ${MAX_STEPS} tool steps without a final answer`, tools, actualUsd: known ? r3(usd) : null, estimatedUsd: r3(usd), sources: [...sources], model: model.name };
}
const r3 = (x: number) => Math.round(x * 10000) / 10000;   // 4 decimals: cheap models cost fractions of a cent
export { HISTORY_TURNS };
