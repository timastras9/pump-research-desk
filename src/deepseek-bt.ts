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

// ---- DeepSeek full decision: buy/skip + exit plan, with the exit lookup table (rag/exit-lookup.json) in the prompt ----
export type Plan = { buy: boolean; tp: number; sl: number; tmax: number };
export function lookupText(doc: any): string {
  return (doc?.rows ?? []).filter((r: any) => r.level === 'change+activity').map((r: any) =>
    `${r.change_30s} | ${r.activity_30s} | n=${r.n_train} | median peak ${r.median_peak_pct}% at ${r.median_secs_to_peak}s | drop before peak ${r.median_drop_before_peak_pct}% | rules v3 test ${r.rules_v3_test_avg_pct}% | best plan TP +${r.best_plan.take_profit_pct}% SL ${r.best_plan.stop_pct}% ${r.best_plan.time_limit_s}s -> test ${r.best_plan_test_avg_pct}%`).join('\n');
}
export const planSystem = (table: string) => `${DS_SYSTEM.replace('Answer with exactly one word: BUY or SKIP.', '')}
EXIT LOOKUP (5,700+ past launches; situation = price change over the last 30 s | seconds with a price change in that window):
${table}
Match the token to its row, then decide. Reply with ONLY one character: 1 = buy, 0 = skip.`;
export function parsePlan(text: string): Plan {
  const m = String(text).match(/\{[\s\S]*\}/); let j: any = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch { /* not JSON */ }
  const num = (x: any, d: number, lo: number, hi: number) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return { buy: String(j.decision ?? text).toUpperCase().includes('BUY'), tp: num(j.take_profit, 20, 1, 1000), sl: -Math.abs(num(j.stop, -10, -90, -1)), tmax: num(j.time_limit_s, 60, 5, 600) };
}
// Same bucket edges as research/exit_lookup_table.py, so the exit plan is the matching row's best plan (no model tokens).
const CHG_EDGES: [number, number, string][] = [[-1e9, -20, 'down >20%'], [-20, -5, 'down 5-20%'], [-5, 5, 'flat ±5%'], [5, 20, 'up 5-20%'], [20, 50, 'up 20-50%'], [50, 1e9, 'up >50%']];
const ACT_EDGES: [number, number, string][] = [[0, 5, 'quiet (0-5 s active)'], [6, 15, 'active (6-15 s)'], [16, 1e9, 'busy (16+ s)']];
export function situation(v: Px[], startAt: number) {
  const until = startAt + DECIDE_MS, seen = v.filter(s => s.time <= until); if (seen.length < 2) return null;
  const chg = (seen.at(-1)!.priceUsd / seen[0].priceUsd - 1) * 100, act = new Set(seen.filter((s, i) => i && s.priceUsd !== seen[i - 1].priceUsd).map(s => Math.floor(s.time / 1000))).size;
  return { chg, act, chgLabel: CHG_EDGES.find(([lo, hi]) => chg >= lo && chg < hi)![2], actLabel: ACT_EDGES.find(([lo, hi]) => act >= lo && act <= hi)![2] };
}
export function lookupPlan(doc: any, sit: { chgLabel: string; actLabel: string }): Omit<Plan, 'buy'> {
  const rows = doc?.rows ?? [];
  const r = rows.find((x: any) => x.level === 'change+activity' && x.change_30s === sit.chgLabel && x.activity_30s === sit.actLabel) ?? rows.find((x: any) => x.level === 'change' && x.change_30s === sit.chgLabel);
  return r ? { tp: r.best_plan.take_profit_pct, sl: r.best_plan.stop_pct, tmax: r.best_plan.time_limit_s } : { tp: 20, sl: -10, tmax: 60 };
}
export function situationText(v: Px[], startAt: number) {
  const until = startAt + DECIDE_MS, seen = v.filter(s => s.time <= until); if (seen.length < 2) return null;
  const chg = (seen.at(-1)!.priceUsd / seen[0].priceUsd - 1) * 100, act = new Set(seen.filter((s, i) => i && s.priceUsd !== seen[i - 1].priceUsd).map(s => Math.floor(s.time / 1000))).size;
  return `last 30 s: price change ${chg.toFixed(1)}%, seconds with a price change ${act}`;
}
/** Net % for a take-profit / stop / time plan entered at the first price at or after `at`; exits fill 2 s after the trigger. */
export function planNetFrom(v: Px[], at: number, p: Plan, costPerSide = PAPER_RULES.costPerSide): number | null {
  const i = v.findIndex(s => s.time >= at); if (i < 0 || i >= v.length - 1) return null;
  const e = v[i]; let trig = v.length - 1;
  for (let j = i + 1; j < v.length; j++) { const pct = (v[j].priceUsd / e.priceUsd - 1) * 100; if (pct >= p.tp || pct <= p.sl || v[j].time - e.time >= p.tmax * 1000) { trig = j; break; } }
  const f = v.find(s => s.time >= v[trig].time + FILL_DELAY_MS) ?? v.at(-1)!;
  return Math.round(((f.priceUsd / e.priceUsd) * (1 - costPerSide) / (1 + costPerSide) - 1) * 10000) / 100;
}
export async function askDeepSeekPlan(key: string, system: string, prompt: string, doFetch: typeof fetch = fetch, model = DS_MODEL) {
  const t0 = Date.now();
  const r = await doFetch('https://api.fireworks.ai/inference/v1/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 1, temperature: 0, reasoning_effort: 'none', service_tier: 'priority' }) });   // Tim: boolean answer for speed
  const j = await r.json() as any, latencyMs = Date.now() - t0;
  if (!r.ok) throw Error(`Fireworks ${r.status}: ${j?.error?.message ?? j?.message ?? 'request failed'}`);
  const text = String(j?.choices?.[0]?.message?.content ?? '');
  return { buy: text.trim().startsWith('1'), answer: text.slice(0, 20), latencyMs };
}

export type BtRow = { tokenId: string; name: string; campaignId: string; buy: boolean; answer: string; latencyMs: number; netAll: number | null; netDs: number | null; finalPct: number | null };
/** Score one token: DeepSeek's decision, its latency-delayed fill, and the buy-everything baseline on the same token. */
export function scoreToken(v: Px[], startAt: number, d: { buy: boolean; answer: string; latencyMs: number; tp?: number; sl?: number; tmax?: number }, meta: { tokenId: string; name: string; campaignId: string; finalPct: number | null }): BtRow {
  const decisionAt = startAt + DECIDE_MS, at = decisionAt + d.latencyMs + FILL_DELAY_MS;
  const plan = d.tp != null && d.sl != null && d.tmax != null ? { buy: d.buy, tp: d.tp, sl: d.sl, tmax: d.tmax } : null;
  return { ...meta, buy: d.buy, answer: d.answer, latencyMs: d.latencyMs,
    netAll: netFrom(v, decisionAt + FILL_DELAY_MS), netDs: d.buy ? (plan ? planNetFrom(v, at, plan) : netFrom(v, at)) : null };
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
