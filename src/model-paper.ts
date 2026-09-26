// Paper trading with the trained model, plus the feedback for every exit: one row per token with the prediction, what
// actually happened (peak, best reachable exit, crash timing), the differences, and the mistake labels. Feedback labels
// are a port of research/feedback.py (same definitions, checked by test/model-paper.test.ts).
import { Model, simulate, rulesV3, netReturnPct, buyDecisionTime, type Fill, type Launch, type ModelSpec } from './model';

export const LABELER_VERSION = 'feedback-v1';
const MIN_FEASIBLE_NET = 0.5, BIG_MISS_PP = 10, PARTIAL_MISS_PP = 5, MAX_FILLS = 3, DEAD_PRICE = 0.01;
const CRASH_PCT = 20, CRASH_H = 10;   // same crash definition as research/train.py

export type Feedback = { buyLabel: string; sellLabels: string[]; loserReason: string | null; netPct: number; realizedExitGrossPct: number | null; bestFeasibleGrossPct: number; regretPp: number };
export type ModelRow = {
  mint: string; name?: string; model: string; modelSha: string; labeler: string;
  decisionT: number | null; bought: boolean; buyProb: number | null; entryCrashProb: number | null; entryT: number | null;
  trade: { fills: Fill[]; reasons: string[]; netPct: number; exitGrossPct: number; exitDecisionSec: number; exitFillSec: number } | null;
  shadow: { netPct: number; exitDecisionSec: number } | null;    // skipped launch: what the model's seller would have done (not a trade)
  actual: { peakPct: number; peakSec: number; best: { decisionSec: number; fillSec: number; grossPct: number; netPct: number }; winner: boolean; crashStartSec: number | null; after60: { maxPct: number; minPct: number } | null } | null;
  predictedVsActual: { exitVsBestSec: number | null; exitVsPeakSec: number | null; missVsPeakPts: number | null; missVsBestPts: number | null; crashPredictedSec: number | null; crashPredictedVsActualSec: number | null } | null;
  feedback: Feedback | null;
  rulesV3: { netPct: number; fills: Fill[] } | null;
};

const end = (e: number, eng: ModelSpec['engine']) => Math.min(eng.window_s, e + eng.hold_s);
const gross = (px: number, entry: number) => (px / entry - 1) * 100;

/** Every sell-all the delayed market allowed: [decision second, fill second, fill price]; holding to the horizon is last. */
export function feasibleFills(price: number[], e: number, eng: ModelSpec['engine']): [number, number, number][] {
  const out: [number, number, number][] = [], stop = end(e, eng);
  for (let s = e + 1; s < stop; s++) { const f = Math.min(s + eng.latency_s, stop); out.push([s, f, price[f]]); }
  out.push([stop, stop, price[stop]]);
  return out;
}
const bestOf = (opts: [number, number, number][]) => opts.reduce((b, o) => (o[2] > b[2] || (o[2] === b[2] && o[0] < b[0]) ? o : b));

export function loserReason(price: number[], e: number, eng: ModelSpec['engine']): string {
  const stop = end(e, eng), d = e - eng.latency_s, pe = price[e];
  const slip = (pe / price[d] - 1) * 100, after = price.slice(e + 1, stop + 1), maxGain = (Math.max(...after) / pe - 1) * 100;
  const firstBelow = after.findIndex(v => v < pe), secsBelow = firstBelow < 0 ? null : firstBelow + 1;
  if (after.every(v => v === pe)) return 'dead_after_entry';
  if (slip >= 10 && maxGain <= 0) return 'bought_the_spike';
  if (secsBelow !== null && secsBelow <= eng.latency_s && maxGain <= 0) return 'dropped_immediately';
  if (maxGain <= 0) return 'never_above_entry';
  if (maxGain >= 6.7) return 'spike_shorter_than_delay';
  return 'rose_too_little';
}

/** research/feedback.label_trade, for one candidate. `fills` = the model's trade (bought) or its shadow trade (skipped). */
export function labelTrade(price: number[], d: number, bought: boolean, fills: Fill[], eng: ModelSpec['engine']): Feedback {
  const e = d + eng.latency_s, entry = price[e], c = eng.cost_per_side, stop = end(e, eng);
  const opts = feasibleFills(price, e, eng), best = bestOf(opts);
  const netOf = (o: [number, number, number]) => netReturnPct(entry, [[o[0], o[1], 1, o[2]]], c);
  const feasible = netOf(best) > MIN_FEASIBLE_NET, net = netReturnPct(entry, fills, c), bestGross = gross(best[2], entry);
  if (!bought) {
    const buyLabel = feasible ? (net > 0 ? 'skipped_policy_profitable' : 'skipped_feasible_opportunity') : 'correct_skip';
    return { buyLabel, sellLabels: [], loserReason: null, netPct: net, realizedExitGrossPct: null, bestFeasibleGrossPct: bestGross, regretPp: 0 };
  }
  const realized = fills.reduce((a, [, , f, px]) => a + f * gross(px, entry), 0), firstDec = fills[0][0], lastDec = fills[fills.length - 1][0];
  const labels: string[] = [];
  if (opts.some(o => o[0] > lastDec && gross(o[2], entry) >= realized + BIG_MISS_PP && netOf(o) > MIN_FEASIBLE_NET)) labels.push('premature_exit');
  if (opts.some(o => o[0] < firstDec && gross(o[2], entry) >= realized + BIG_MISS_PP && netOf(o) > MIN_FEASIBLE_NET)) labels.push('giveback');
  if (fills[0][2] < 1 - 1e-9 && netReturnPct(entry, [[fills[0][0], fills[0][1], 1, fills[0][3]]], c) >= net + PARTIAL_MISS_PP) labels.push('bad_partial_sizing');
  if (fills.length > MAX_FILLS) labels.push('excessive_turnover');
  const last = fills[fills.length - 1]; if (last[0] === last[1] && last[1] === stop) labels.push('deadline_breach');
  if (fills.some(f => f[3] <= DEAD_PRICE * entry)) labels.push('failed_liquidation');
  if (!labels.length && net > 0) labels.push('good_exit');
  return { buyLabel: feasible ? 'bought_opportunity' : 'bought_no_opportunity', sellLabels: labels, loserReason: feasible ? null : loserReason(price, e, eng),
    netPct: net, realizedExitGrossPct: realized, bestFeasibleGrossPct: bestGross, regretPp: bestGross - realized };
}

/** First second after entry where a 20%+ drop from that second's price begins within latency + 10 s (the crash label). */
function crashStart(price: number[], e: number, eng: ModelSpec['engine']): number | null {
  const stop = end(e, eng);
  for (let t = e + 1; t < stop; t++) {
    const hi = Math.min(t + eng.latency_s + CRASH_H, stop);
    for (let s = t + 1; s <= hi; s++) if (price[s] <= price[t] * (1 - CRASH_PCT / 100)) return t;
  }
  return null;
}

export function modelRow(model: Model, l: Launch & { name?: string }): ModelRow {
  const spec = model.spec, eng = spec.engine, p = l.price;
  const base = { mint: l.mint, name: l.name, model: spec.name, modelSha: spec.sha256, labeler: LABELER_VERSION };
  const d = buyDecisionTime(p, eng);
  if (d == null) return { ...base, decisionT: null, bought: false, buyProb: null, entryCrashProb: null, entryT: null, trade: null, shadow: null, actual: null, predictedVsActual: null, feedback: null, rulesV3: null };
  const e = d + eng.latency_s, stop = end(e, eng), pe = p[e];
  const buyProb = model.buyProb(l, d), entryCrashProb = model.entryCrashProb(l, d), ect = spec.entry_crash.threshold;
  const bought = buyProb >= spec.buy.threshold && (ect == null || entryCrashProb < ect);
  const reasons = new Map<number, string>();
  const { fills } = simulate(p, eng, model.seller(l, reasons), d);                        // model seller (real trade or shadow)
  const net = netReturnPct(pe, fills, eng.cost_per_side), last = fills[fills.length - 1];
  const exitGross = fills.reduce((a, [, , f, px]) => a + f * gross(px, pe), 0);
  let peakSec = e + 1; for (let t = e + 1; t <= stop; t++) if (p[t] > p[peakSec]) peakSec = t;
  const best = bestOf(feasibleFills(p, e, eng)), bestNet = netReturnPct(pe, [[best[0], best[1], 1, best[2]]], eng.cost_per_side);
  const after = p.slice(last[1] + 1, Math.min(last[1] + 60, eng.window_s) + 1);
  let crashPredictedSec: number | null = null;
  if (spec.guard.crash_threshold != null) for (let t = e + 1; t < stop; t++) if (model.crashProb(l, e, t) >= spec.guard.crash_threshold) { crashPredictedSec = t; break; }
  const crashStartSec = crashStart(p, e, eng);
  const rules = simulate(p, eng, rulesV3(p, spec.rules_v3), d);
  return {
    ...base, decisionT: d, bought, buyProb, entryCrashProb, entryT: e,
    trade: bought ? { fills, reasons: fills.map(f => reasons.get(f[0]) ?? (f[0] === f[1] ? 'deadline' : 'rules v3')), netPct: net, exitGrossPct: exitGross, exitDecisionSec: last[0], exitFillSec: last[1] } : null,
    shadow: bought ? null : { netPct: net, exitDecisionSec: last[0] },
    actual: { peakPct: gross(p[peakSec], pe), peakSec, best: { decisionSec: best[0], fillSec: best[1], grossPct: gross(best[2], pe), netPct: bestNet }, winner: bestNet > MIN_FEASIBLE_NET,
      crashStartSec, after60: after.length ? { maxPct: gross(Math.max(...after), pe), minPct: gross(Math.min(...after), pe) } : null },
    predictedVsActual: {
      exitVsBestSec: bought ? last[0] - best[0] : null, exitVsPeakSec: bought ? last[1] - peakSec : null,
      missVsPeakPts: bought ? gross(p[peakSec], pe) - exitGross : null, missVsBestPts: bought ? gross(best[2], pe) - exitGross : null,
      crashPredictedSec, crashPredictedVsActualSec: crashPredictedSec != null && crashStartSec != null ? crashPredictedSec - crashStartSec : null,
    },
    feedback: labelTrade(p, d, bought, fills, eng),
    rulesV3: { netPct: netReturnPct(pe, rules.fills, eng.cost_per_side), fills: rules.fills },
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Run-level summary: model vs rules v3 on the same tokens, label counts, and the average timing/peak errors. */
export function summarizeRows(rows: ModelRow[], sizeUsd = 2) {
  const traded = rows.filter(r => r.trade), nets = traded.map(r => r.trade!.netPct);
  const rulesNets = rows.filter(r => r.rulesV3).map(r => r.rulesV3!.netPct);
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.feedback) for (const k of [r.feedback.buyLabel, ...r.feedback.sellLabels, ...(r.feedback.loserReason ? [r.feedback.loserReason] : [])]) counts[k] = (counts[k] ?? 0) + 1;
  const pva = traded.map(r => r.predictedVsActual!);
  const pick = (k: keyof NonNullable<ModelRow['predictedVsActual']>) => pva.map(x => x[k]).filter((v): v is number => v != null);
  const stat = (a: number[]) => ({ n: a.length, mean: mean(a) == null ? null : r2(mean(a)!), median: median(a) == null ? null : r2(median(a)!) });
  return {
    tokens: rows.length, evaluated: rows.filter(r => r.decisionT != null).length,
    model: { trades: traded.length, avgPct: mean(nets) == null ? null : r2(mean(nets)!), medianPct: median(nets) == null ? null : r2(median(nets)!),
      winRate: traded.length ? r2(nets.filter(x => x > 0).length / traded.length) : null, shareWorseThan30: traded.length ? r2(nets.filter(x => x <= -30).length / traded.length) : null,
      totalUsd: r2(nets.reduce((a, b) => a + b, 0) / 100 * sizeUsd) },
    rulesV3: { trades: rulesNets.length, avgPct: mean(rulesNets) == null ? null : r2(mean(rulesNets)!), totalUsd: r2(rulesNets.reduce((a, b) => a + b, 0) / 100 * sizeUsd) },
    labels: counts,
    timing: { exitVsBestSec: stat(pick('exitVsBestSec')), exitVsPeakSec: stat(pick('exitVsPeakSec')), missVsPeakPts: stat(pick('missVsPeakPts')), missVsBestPts: stat(pick('missVsBestPts')),
      crashPredictedVsActualSec: stat(rows.map(r => r.predictedVsActual?.crashPredictedVsActualSec).filter((v): v is number => v != null)) },
  };
}
