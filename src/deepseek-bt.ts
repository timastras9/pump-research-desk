// DeepSeek real-time screening backtest on the recorded studies (runs on Cloudflare; key never leaves the Worker).
// Per token: DeepSeek V4 Pro (Fireworks, thinking OFF) sees only the first DECIDE_MS of the recording plus launch facts
// and answers BUY or SKIP. Its measured latency is added to the fill: entry = first price at decision + latency + 2 s.
// Buy-everything enters at decision + 2 s. Both exit with the live paper trader's rules v3 (tradeFrom), costs included.
import { tradeFrom, PAPER_RULES } from './paper-trader';

export const DECIDE_MS = 30_000, FILL_DELAY_MS = 2_000;
export const DS_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';   // Tim's Fireworks example
export const DS_SYSTEM = 'You screen brand-new pump.fun token launches for a 10-minute paper trade. Costs are 6.5% round trip and the order fills a few seconds after you answer. Most launches lose; big pumps usually peak inside 60 s. Answer with exactly one word: BUY or SKIP.';

type Px = { time: number; priceUsd: number };
export const validPrices = (samples: { time: number; priceUsd: number | null }[]) =>
  samples.filter((s): s is Px => s.priceUsd != null && Number.isFinite(s.priceUsd) && s.priceUsd > 0 && Number.isFinite(s.time)).sort((a, b) => a.time - b.time);

/** Prompt from data up to the decision second ONLY (the caller passes the recording start). */
export function dsPrompt(v: Px[], startAt: number, launch: { mayhem?: boolean; feeRouted?: boolean; launchTool?: string } | null, capUsd: number | null) {
  const until = startAt + DECIDE_MS, seen = v.filter(s => s.time <= until);
  if (seen.length < 2) return null;
  const p0 = seen[0].priceUsd, perSec: number[] = [];
  for (let s = 0; s <= DECIDE_MS / 1000; s++) { const t = startAt + s * 1000; const last = [...seen].reverse().find(x => x.time <= t); perSec.push(last ? Math.round((last.priceUsd / p0 - 1) * 1000) / 10 : 0); }
  const changes = seen.filter((s, i) => i && s.priceUsd !== seen[i - 1].priceUsd).length;
  return `Recorded facts for the first ${DECIDE_MS / 1000} s (everything known so far):\n` +
    `price change from the first recorded price, one value per second: ${JSON.stringify(perSec)}\n` +
    `price changes observed: ${changes}; high so far: ${Math.max(...perSec)}%; now: ${perSec.at(-1)}%\n` +
    `market cap when first seen: ${capUsd == null ? 'unknown' : '$' + Math.round(capUsd)}; mayhem: ${!!launch?.mayhem}; fee-routed: ${!!launch?.feeRouted}; launch tool: ${launch?.launchTool ?? 'unknown'}\n` +
    'BUY or SKIP?';
}

/** Net % after costs for an entry at the first price at or after `at` (rules v3 exits); null if no price after it. */
export function netFrom(v: Px[], at: number): number | null {
  const i = v.findIndex(s => s.time >= at);
  if (i < 0 || i >= v.length - 1) return null;
  return tradeFrom(v, i, PAPER_RULES).pnlPct ?? null;
}

/** The DeepSeek model this Fireworks account can actually call (fixed ids 404 when not deployed for the account).
 *  Asks Fireworks' model list and prefers V4 Pro > V4 Flash > V3.2 > V3.1 > any DeepSeek. */
export const DS_PREFERENCE = ['deepseek-v4p1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3p2', 'deepseek-v3p1'];
export async function resolveDeepSeekModel(key: string, doFetch: typeof fetch = fetch): Promise<string> {
  const r = await doFetch('https://api.fireworks.ai/inference/v1/models', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const j = await r.json() as any;
  if (!r.ok) throw Error(`Fireworks model list ${r.status}: ${j?.error?.message ?? j?.message ?? 'request failed'}`);
  const ids: string[] = (j?.data ?? []).map((m: any) => String(m.id ?? '')).filter((id: string) => /deepseek/i.test(id));
  for (const pref of DS_PREFERENCE) { const hit = ids.find(id => id.endsWith('/' + pref)) ?? ids.find(id => id.includes(pref)); if (hit) return hit; }
  if (ids.length) return ids[0];
  throw Error('no DeepSeek model available to this Fireworks account');
}

export async function askDeepSeek(key: string, prompt: string, doFetch: typeof fetch = fetch, model = DS_MODEL) {
  const t0 = Date.now();
  const r = await doFetch('https://api.fireworks.ai/inference/v1/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: DS_SYSTEM }, { role: 'user', content: prompt }], max_tokens: 5, temperature: 0, reasoning_effort: 'none', service_tier: 'priority' }) });
  const j = await r.json() as any, latencyMs = Date.now() - t0;
  if (!r.ok) throw Error(`Fireworks ${r.status}: ${j?.error?.message ?? j?.message ?? 'request failed'}`);
  const text = String(j?.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
  return { buy: text.startsWith('BUY'), answer: text.slice(0, 20), latencyMs, inTok: j?.usage?.prompt_tokens ?? 0, outTok: j?.usage?.completion_tokens ?? 0 };
}

export type BtRow = { tokenId: string; name: string; campaignId: string; buy: boolean; answer: string; latencyMs: number; netAll: number | null; netDs: number | null; finalPct: number | null };
/** Score one token: DeepSeek's decision, its latency-delayed fill, and the buy-everything baseline on the same token. */
export function scoreToken(v: Px[], startAt: number, d: { buy: boolean; answer: string; latencyMs: number }, meta: { tokenId: string; name: string; campaignId: string; finalPct: number | null }): BtRow {
  const decisionAt = startAt + DECIDE_MS;
  return { ...meta, buy: d.buy, answer: d.answer, latencyMs: d.latencyMs,
    netAll: netFrom(v, decisionAt + FILL_DELAY_MS), netDs: d.buy ? netFrom(v, decisionAt + d.latencyMs + FILL_DELAY_MS) : null };
}

export function btSummary(rows: BtRow[]) {
  const s = (x: (number | null)[]) => { const a = x.filter((n): n is number => n != null); const n = a.length, m = n ? a.reduce((p, c) => p + c, 0) / n : null;
    const sd = n > 1 ? Math.sqrt(a.reduce((p, c) => p + (c - m!) ** 2, 0) / (n - 1)) : null;
    return { n, avgPct: m == null ? null : Math.round(m * 10) / 10, ci95: sd == null ? null : Math.round(1.96 * sd / Math.sqrt(n) * 10) / 10, winPct: n ? Math.round(a.filter(c => c > 0).length / n * 100) : null, usd: Math.round(a.reduce((p, c) => p + c, 0) * 0.02 * 100) / 100 }; };
  const lat = rows.map(r => r.latencyMs).sort((a, b) => a - b);
  return { tokens: rows.length, buys: rows.filter(r => r.buy).length,
    latencyMs: lat.length ? { median: lat[Math.floor((lat.length - 1) / 2)], p90: lat[Math.floor(lat.length * 0.9)] ?? lat.at(-1), max: lat.at(-1) } : null,
    buyEverything: s(rows.map(r => r.netAll)), deepseekBuys: s(rows.filter(r => r.buy).map(r => r.netDs)), deepseekSkips: s(rows.filter(r => !r.buy).map(r => r.netAll)) };
}
