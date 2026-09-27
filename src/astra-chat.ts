// Ask Astra: questions about the study data. Context = the live study index (rag/index.json, read from R2 on every
// question) + the documents AI Search retrieves for the question (rag/ in the crypto-study-media bucket).
// Answers only; Astra cannot change rules, models or studies. Hard cap per question at list prices.
import { ASTRA_MODEL, estimateUsd } from './astra-review';

export const CHAT_CAP_USD = 0.5;
export const CHAT_MAX_OUTPUT = 4000;
const CHARS_PER_TOKEN = 3;

export const CHAT_PROMPT = `You are the Astras agent, named after Tim Astras and as versatile as he is, working Tim's pump.fun research desk (paper trading only, no real money).
Pick the hat the question needs and say which in a few words:
- Crypto financial analyst (Hundahl's discipline): losers first, risk before upside; every view ends in a sized, testable rule or threshold change.
- AI/ML engineer: features, labels, leakage, chronological splits, calibration, RL reward and model parameters, honest evaluation.
- Software architect: the smallest design that solves it, one named trade-off.
- Software developer: code that fits the codebase, in a clean markdown code block for Tim to apply.
- Cloudflare architect: Workers, Durable Objects, D1, R2, Workers AI, AI Search, and their limits.
Use the data provided (the RAG) to find ways to improve the pump.fun short-term trading bot.
You get: (1) the live study index, one line per study; (2) documents retrieved from the study export (study, token and recording JSON with chat, glossary).
Answer Tim's question from that data only. Lead with the answer and the numbers. Name tokens and studies as evidence.
If the data given cannot answer it, say exactly what is missing (for example: "no token documents for that study were retrieved").
Costs are ~6.5% round trip; a result "after costs" is net. Winner: final > +7%. Tanked: final <= -50%.
Suggestions are fine; Tim decides. Plain text, short paragraphs or bullets, no JSON.`;

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type Chunk = { key: string; score: number; text: string };

/** Build the messages sent to Astra; trims retrieved chunks (lowest score first) to stay under the cap. */
export function buildChat(question: string, history: ChatTurn[], index: unknown, chunks: Chunk[], capUsd = CHAT_CAP_USD) {
  const hist = history.slice(-6).map(t => ({ role: t.role, content: String(t.content).slice(0, 4000) }));
  const kept = [...chunks].sort((a, b) => b.score - a.score);
  const make = () => {
    const ctx = `LIVE STUDY INDEX:\n${JSON.stringify(index ?? 'not exported yet')}\n\nRETRIEVED DOCUMENTS (${kept.length}):\n` +
      (kept.map(c => `--- ${c.key} (score ${c.score.toFixed(2)})\n${c.text}`).join('\n') || 'none (AI Search not connected or nothing matched)');
    return [{ role: 'system', content: CHAT_PROMPT }, { role: 'system', content: ctx }, ...hist, { role: 'user', content: question }];
  };
  let messages = make();
  const cost = () => estimateUsd(JSON.stringify(messages).length / CHARS_PER_TOKEN, CHAT_MAX_OUTPUT);
  while (cost() > capUsd && kept.length) { kept.pop(); messages = make(); }
  return { messages, sources: [...new Set(kept.map(c => c.key))], estimatedUsd: Math.round(cost() * 1000) / 1000, overCap: cost() > capUsd };
}

// Astra history: every question and answer, readable with
//   npx wrangler d1 execute crypto-study --remote --command "SELECT datetime(at/1000,'unixepoch') AS at, question, answer FROM astra_log ORDER BY at DESC LIMIT 20"
export const ASTRA_LOG_SCHEMA = 'CREATE TABLE IF NOT EXISTS astra_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT, error TEXT, sources TEXT, usd REAL, model TEXT)';
export async function logChat(db: Pick<D1Database, 'prepare'>, question: string, r: { answer: string | null; error: string | null; sources: string[]; actualUsd: number | null; estimatedUsd: number; model: string }, now = Date.now()) {
  await db.prepare(ASTRA_LOG_SCHEMA).run();
  await db.prepare('INSERT INTO astra_log (at, question, answer, error, sources, usd, model) VALUES (?,?,?,?,?,?,?)')
    .bind(now, question, r.answer, r.error, JSON.stringify(r.sources), r.actualUsd ?? r.estimatedUsd, r.model).run();
}

type SearchNs = { get(name: string): { search(q: unknown): Promise<{ chunks?: { score?: number; text?: string; item?: { key?: string } }[] }> } };
export type ChatEnv = { AI: Pick<Ai, 'run'>; CRYPTO_MEDIA: Pick<R2Bucket, 'get'>; AI_SEARCH?: SearchNs; AI_SEARCH_INSTANCE?: string };

export async function askAstra(env: ChatEnv, question: string, history: ChatTurn[] = []) {
  const idx = await env.CRYPTO_MEDIA.get('rag/index.json');
  const index = idx ? await idx.json() : null;
  let chunks: Chunk[] = [], ragError: string | null = null;
  const rag = !!(env.AI_SEARCH && env.AI_SEARCH_INSTANCE);
  if (rag) {
    try {
      const res = await env.AI_SEARCH!.get(env.AI_SEARCH_INSTANCE!).search({
        messages: [...history.slice(-4), { role: 'user', content: question }], ai_search_options: { retrieval: { max_num_results: 12 } } });
      chunks = (res.chunks ?? []).map(c => ({ key: c.item?.key ?? '?', score: c.score ?? 0, text: String(c.text ?? '') }));
    } catch (e) { ragError = e instanceof Error ? e.message.slice(0, 200) : 'AI Search failed'; }
  }
  const p = buildChat(question, history, index, chunks);
  const base = { model: ASTRA_MODEL, ragConnected: rag, ragError, indexLoaded: !!index, sources: p.sources, estimatedUsd: p.estimatedUsd };
  if (p.overCap) return { ...base, answer: null, actualUsd: null, error: `question plus index is over the $${CHAT_CAP_USD} cap` };
  try {
    const res = await (env.AI.run as (m: string, i: unknown) => Promise<unknown>)(ASTRA_MODEL, { messages: p.messages, max_completion_tokens: CHAT_MAX_OUTPUT }) as
      { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const u = res?.usage;
    return { ...base, answer: res?.choices?.[0]?.message?.content ?? '', error: null,
      actualUsd: u?.prompt_tokens != null && u?.completion_tokens != null ? Math.round(estimateUsd(u.prompt_tokens, u.completion_tokens) * 1000) / 1000 : null };
  } catch (e) {
    return { ...base, answer: null, actualUsd: null, error: e instanceof Error ? e.message.slice(0, 300) : 'Astra call failed' };
  }
}
