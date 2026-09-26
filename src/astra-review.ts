// Astra (openai/gpt-6-astra) reviews each whole model run: the summary plus one compact row per token (prediction,
// actual peak / best exit / crash timing, the differences, feedback labels, rules v3 on the same token). She suggests
// adjustments; nothing is applied automatically - the owner decides. Hard cap: $1 per review at list prices.
import type { RunFile } from './model-runner';
import type { ModelRow } from './model-paper';

export const ASTRA_MODEL = 'openai/gpt-6-astra';
// Cloudflare list price (developers.cloudflare.com/ai/models/openai/gpt-6-astra): short-context input $10/M, cache write
// $12/M, output $50/M. Budget with the cache-write rate so the estimate is never below the bill.
export const ASTRA_RATES = { inputPerMillion: 12, outputPerMillion: 50 };
export const REVIEW_CAP_USD = 1;
export const MAX_OUTPUT_TOKENS = 8000;   // includes reasoning tokens; the last Astra review used ~3,200
const CHARS_PER_TOKEN = 3;   // conservative for compact JSON (numbers tokenize densely)

export const ASTRA_PROMPT = `You review one paper-trading run of a pump.fun launch model for its owner, Tim. Data: a run summary and one row per token.
Engine: buy decision a few seconds after launch, every order fills 2 s after the decision, 1.25% fee + 2% slippage per side (~6.7% round trip), $2 per position, forced exit 10 min after entry.
Model: gradient-boosted BUY score + entry-crash network; SELL = guard (stop, predicted crash exit, ride the climb: hold once up 10% and sell on a drop of trail % from the high) around rules v3.
Row fields: sec values are seconds after entry. pred = model; act = what happened (peak, best exit reachable with the 2 s delay, crash start); diff = model minus actual (negative exitVsBest = sold before the best exit; crashVsActual < 0 = warned before the crash); fb = feedback labels; v3 = rules v3 on the same token.
Tim's goals: never take a 30% loss, sell within ~10 points of the peak, hold while price climbs, get out fast on crashes.
Use only the data given. Cite token names as evidence. Suggestions only; Tim decides.
Reply with JSON only: {"summary":str,"whatWorked":[str],"problems":[{"issue":str,"evidence":[str],"impact":str}],"adjustments":[{"parameter":str,"current":str,"suggested":str,"why":str,"expectedEffect":str,"confidence":"low"|"medium"|"high"}],"retrainNotes":[str],"dataRequests":[str]}`;

const r = (x: number | null | undefined, k = 1) => (x == null ? null : Math.round(x * 10 ** k) / 10 ** k);

export function compactRow(x: ModelRow & { tokenId?: string }) {
  const e = x.entryT ?? 0, rel = (s: number | null | undefined) => (s == null ? null : s - e);
  return {
    name: x.name || x.mint.slice(0, 6), bought: x.bought, buyP: r(x.buyProb, 2), crashRiskAtBuy: r(x.entryCrashProb, 2),
    pred: x.trade ? { net: r(x.trade.netPct), exitGross: r(x.trade.exitGrossPct), exitSec: rel(x.trade.exitDecisionSec), why: [...new Set(x.trade.reasons)], fills: x.trade.fills.length }
      : x.shadow ? { shadowNet: r(x.shadow.netPct), shadowExitSec: rel(x.shadow.exitDecisionSec) } : null,
    act: x.actual ? { peak: r(x.actual.peakPct), peakSec: rel(x.actual.peakSec), best: r(x.actual.best.grossPct), bestSec: rel(x.actual.best.decisionSec), winner: x.actual.winner,
      crashSec: rel(x.actual.crashStartSec), after60: x.actual.after60 ? [r(x.actual.after60.minPct), r(x.actual.after60.maxPct)] : null } : null,
    diff: x.predictedVsActual && x.bought ? { exitVsBest: x.predictedVsActual.exitVsBestSec, exitVsPeak: x.predictedVsActual.exitVsPeakSec, missPeak: r(x.predictedVsActual.missVsPeakPts),
      missBest: r(x.predictedVsActual.missVsBestPts), crashVsActual: x.predictedVsActual.crashPredictedVsActualSec } : x.predictedVsActual ? { crashVsActual: x.predictedVsActual.crashPredictedVsActualSec } : null,
    fb: x.feedback ? [x.feedback.buyLabel, ...x.feedback.sellLabels, ...(x.feedback.loserReason ? [x.feedback.loserReason] : [])] : null,
    v3: x.rulesV3 ? r(x.rulesV3.netPct) : null,
  };
}

export const estimateUsd = (inputTokens: number, outputTokens: number) => (inputTokens * ASTRA_RATES.inputPerMillion + outputTokens * ASTRA_RATES.outputPerMillion) / 1e6;

/** Payload for one run, trimmed (if ever needed) to stay under the cap: bought rows first, then skipped rows by missed upside. */
export function buildPayload(run: RunFile, capUsd = REVIEW_CAP_USD) {
  const rows = run.rows.filter(x => x.decisionT != null).map(x => ({ x, c: compactRow(x) }));
  rows.sort((a, b) => Number(b.x.bought) - Number(a.x.bought) || (b.x.actual?.best.grossPct ?? 0) - (a.x.actual?.best.grossPct ?? 0));
  const head = { model: run.model, guard: run.guard, summary: run.summary, tokensTotal: run.rows.length };
  const budgetTokens = (capUsd - estimateUsd(0, MAX_OUTPUT_TOKENS)) / (ASTRA_RATES.inputPerMillion / 1e6) - (ASTRA_PROMPT.length / CHARS_PER_TOKEN);
  let keep = rows.length, text = '';
  for (;;) {
    text = JSON.stringify({ ...head, rowsSent: keep, rows: rows.slice(0, keep).map(y => y.c) });
    if (text.length / CHARS_PER_TOKEN <= budgetTokens || keep === 0) break;
    keep = Math.floor(keep * 0.9);
  }
  const inputTokens = Math.ceil((text.length + ASTRA_PROMPT.length) / CHARS_PER_TOKEN);
  return { text, rowsSent: keep, rowsTotal: rows.length, estimatedUsd: estimateUsd(inputTokens, MAX_OUTPUT_TOKENS) };
}

export type AstraReview = { at: number; model: string; rowsSent: number; rowsTotal: number; estimatedUsd: number; actualUsd: number | null; usage: unknown; review: unknown; raw?: string; error?: string };

export async function reviewRun(ai: Pick<Ai, 'run'>, run: RunFile, now = Date.now()): Promise<AstraReview> {
  const p = buildPayload(run), base = { at: now, model: ASTRA_MODEL, rowsSent: p.rowsSent, rowsTotal: p.rowsTotal, estimatedUsd: Math.round(p.estimatedUsd * 1000) / 1000 };
  if (p.estimatedUsd > REVIEW_CAP_USD) return { ...base, actualUsd: null, usage: null, review: null, error: `estimated $${p.estimatedUsd.toFixed(2)} is over the $${REVIEW_CAP_USD} cap` };
  try {
    const res = await (ai.run as (m: string, i: unknown) => Promise<unknown>)(ASTRA_MODEL, { messages: [{ role: 'system', content: ASTRA_PROMPT }, { role: 'user', content: p.text }], max_completion_tokens: MAX_OUTPUT_TOKENS }) as
      { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const raw = res?.choices?.[0]?.message?.content ?? '', u = res?.usage;
    const actualUsd = u?.prompt_tokens != null && u?.completion_tokens != null ? Math.round(estimateUsd(u.prompt_tokens, u.completion_tokens) * 1000) / 1000 : null;
    const m = raw.match(/\{[\s\S]*\}/);
    let review: unknown = null; try { review = m ? JSON.parse(m[0]) : null; } catch { review = null; }
    return { ...base, actualUsd, usage: u ?? null, review, ...(review ? {} : { raw: raw.slice(0, 20000), error: 'reply was not valid JSON; raw text kept' }) };
  } catch (error) {
    return { ...base, actualUsd: null, usage: null, review: null, error: error instanceof Error ? error.message.slice(0, 300) : 'Astra call failed' };
  }
}
