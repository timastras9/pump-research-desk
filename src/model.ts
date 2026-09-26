// The trained model, running in the Worker. A line-for-line port of research/engine.py (features, entry schedule,
// delayed-fill simulator, rules v3) and research/live_model.py (buy trees, crash networks, guard). The weights come
// from the JSON written by scripts/export_model.py; test/model.test.ts proves the outputs match Python.

export type Layer = [number[][], number[]];
export type Scaler = { mean: number[]; std: number[] };
export type TreeNode = [feature: number, threshold: number, left: number, right: number, isLeaf: boolean, value: number, missingLeft: boolean];
export type ModelSpec = {
  format: 'pump-model-v1'; name: string; sha256: string; features: string[];
  engine: { latency_s: number; cost_per_side: number; first_sight_s: number; dead_after_s: number; no_chase: number; hold_s: number; window_s: number };
  buy: { kind: 'gbt'; baseline: number; trees: TreeNode[][]; calibration: [number, number]; threshold: number };
  entry_crash: { scaler: Scaler; layers: Layer[]; threshold: number | null };
  crash: { scaler: Scaler; layers: Layer[] };
  guard: { base: 'rules_v3'; early_exit_5s: boolean; stop_pct: number; crash_threshold: number | null; ride_trail_pct: number | null; ride_arm_pct: number; early_s: number };
  rules_v3: { take: number; window: number; part: number; check_at: number; check_min: number; stop: number; trail: number; arm: number };
};
/** One launch: 1 s close prices and volume from second 0 (forward-filled, length window_s + 1), plus raw wallet trades. */
export type Launch = {
  mint: string; creator: string | null; tags: { fee_routed: boolean; mayhem: boolean; terminal: boolean };
  price: number[]; volume: number[]; trades: [sec: number, wallet: string | null, side: string, sol: number][] | null;
};
export type Fill = [decisionT: number, fillT: number, fraction: number, price: number];
export type ModelTrade = { decisionT: number | null; bought: boolean; buyProb: number | null; entryCrashProb: number | null; entryT: number | null; fills: Fill[] | null; netPct: number | null };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// ---------------- features (engine.feature_table) ----------------
const WALLET = 12;
export function featureTable(l: Launch, windowS: number): number[][] {
  const n = windowS + 1, p = l.price, v = l.volume, rows: number[][] = [];
  let c1 = 0, c2 = 0, hi = -Infinity, act = 0, vc = 0; const vcum: number[] = [];
  const w = l.trades ? walletColumns(l, n) : null;
  for (let t = 0; t < n; t++) {
    const ret = t === 0 ? 0 : Math.log(p[t]) - Math.log(p[t - 1]); c1 += ret; c2 += ret * ret;
    const cnt = Math.max(t, 1), mean = c1 / cnt, variance = Math.max(c2 / cnt - mean * mean, 0);
    hi = Math.max(hi, p[t]); if (v[t] > 0) act++; vc += v[t]; vcum.push(vc);
    const before = t >= 5 ? vcum[t - 5] : 0, last5 = vc - before, nb = Math.max(t - 4, 1);
    const row = [t, (p[t] / p[0] - 1) * 100, act, act / (t + 1), Math.log1p(vc), (last5 + 1) / ((t - 4 > 0 ? before : vcum[0]) / nb * 5 + 1),
      t > 1 ? Math.sqrt(variance) * 100 : 0, (hi / p[0] - 1) * 100, (p[t] / hi - 1) * 100,
      (p[t] / p[Math.max(t - 5, 0)] - 1) * 100, (p[t] / p[Math.max(t - 15, 0)] - 1) * 100];
    row.push(...(w ? w[t] : new Array(WALLET).fill(NaN)));
    row.push(+l.tags.fee_routed, +l.tags.mayhem, +l.tags.terminal);
    rows.push(row);
  }
  return rows;
}

function walletColumns(l: Launch, n: number): number[][] {
  const buySol = new Array(n).fill(0), sellSol = new Array(n).fill(0), devBuy = new Array(n).fill(0), devSell = new Array(n).fill(0);
  const firstBuy = new Map<string | null, number>(), firstSell = new Map<string | null, number>(); const buyBySec: [string | null, number][][] = Array.from({ length: n }, () => []);
  for (const [sec, wallet, side, solRaw] of l.trades!) {
    if (sec == null || sec < 0 || sec > n - 1) continue;
    const sol = solRaw || 0;
    if (side === 'buy') {
      buySol[sec] += sol; if (!firstBuy.has(wallet)) firstBuy.set(wallet, sec); buyBySec[sec].push([wallet, sol]);
      if (wallet && wallet === l.creator) devBuy[sec] += sol;
    } else if (side === 'sell') {
      sellSol[sec] += sol; if (!firstSell.has(wallet)) firstSell.set(wallet, sec);
      if (wallet && wallet === l.creator) devSell[sec] += sol;
    }
  }
  const sellsBySec: (string | null)[][] = Array.from({ length: n }, () => []);
  for (const [wallet, sec] of firstSell) if (sec >= 0 && sec < n) sellsBySec[sec].push(wallet);
  let snipers = 0; for (const [wallet, sec] of firstBuy) if (sec <= 3 && wallet !== l.creator) snipers++;
  const amounts = new Map<string | null, number>(), buyers = new Set<string | null>(), sellers = new Set<string | null>(); const out: number[][] = [];
  let bs = 0, ss = 0, db = 0, ds = 0;
  for (let sec = 0; sec < n; sec++) {
    for (const [wallet, sol] of buyBySec[sec]) { amounts.set(wallet, (amounts.get(wallet) ?? 0) + sol); buyers.add(wallet); }
    for (const wallet of sellsBySec[sec]) sellers.add(wallet);
    const vals = [...amounts.values()], tot = vals.reduce((a, b) => a + b, 0);
    const top3 = tot ? [...vals].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) / tot : 0;
    let both = 0; for (const wallet of buyers) if (sellers.has(wallet)) both++;
    const union = buyers.size + sellers.size - both;
    bs += buySol[sec]; ss += sellSol[sec]; db += devBuy[sec]; ds += devSell[sec];
    out.push([buyers.size, sellers.size, buyers.size / Math.max(1, sellers.size), bs, ss, bs - ss, vals.length ? Math.max(...vals) : 0, top3, db, ds > 0 ? 1 : 0, snipers, both / Math.max(1, union)]);
  }
  return out;
}

// ---------------- small models ----------------
export function mlpForward(layers: Layer[], x: number[]): number[] {
  let h = x;
  layers.forEach(([W, b], i) => {
    const next = W.map((row, j) => row.reduce((acc, wij, k) => acc + wij * h[k], b[j]));
    h = i < layers.length - 1 ? next.map(z => Math.max(z, 0)) : next;
  });
  return h;
}
export const scale = (s: Scaler, x: number[]) => x.map((v, i) => Math.min(8, Math.max(-8, ((Number.isNaN(v) ? 0 : v) - s.mean[i]) / s.std[i])));
export function gbtRaw(buy: ModelSpec['buy'], x: number[]): number {
  let raw = buy.baseline;
  for (const tree of buy.trees) {
    let i = 0;
    while (!tree[i][4]) { const [f, th, left, right, , , missLeft] = tree[i]; const v = x[f]; i = Number.isNaN(v) ? (missLeft ? left : right) : v <= th ? left : right; }
    raw += tree[i][5];
  }
  return raw;
}

// ---------------- engine: entry schedule, rules v3, guard, delayed fills ----------------
export function buyDecisionTime(price: number[], e: ModelSpec['engine']): number | null {
  const s0 = e.first_sight_s;
  for (let t = s0 + 1; t <= Math.min(s0 + e.dead_after_s, e.window_s - e.latency_s); t++)
    if (price[t] !== price[s0]) return price[t] >= price[s0] * e.no_chase ? null : t;
  return null;
}
type Policy = (e: number, t: number, held: number, fills: Fill[]) => number;
export function rulesV3(price: number[], r: ModelSpec['rules_v3']): Policy {
  return (e, t, held, fills) => {
    const pct = (price[t] / price[e] - 1) * 100; let hi = -Infinity; for (let s = e; s <= t; s++) hi = Math.max(hi, price[s]);
    const took = fills.length > 0, el = t - e;
    if (pct <= -r.stop) return held;
    if (!took && el <= r.window && pct >= r.take) return r.part < 1 ? r.part : held;
    if (!took && el === r.check_at && hi < price[e] * (1 + r.check_min / 100)) return held;
    if (hi >= price[e] * (1 + r.arm / 100) && price[t] <= hi * (1 - r.trail / 100)) return held;
    return 0;
  };
}
export function guardDecision(price: number[], e: number, t: number, g: ModelSpec['guard'], crashP: () => number): 'sell' | 'hold' | 'base' {
  const r = price[t] / price[e] - 1;
  if (g.early_exit_5s && t - e <= g.early_s && r < 0) return 'sell';
  if (r <= -g.stop_pct / 100) return 'sell';
  if (g.crash_threshold != null && crashP() >= g.crash_threshold) return 'sell';
  if (g.ride_trail_pct != null) {
    let hi = -Infinity; for (let s = e; s <= t; s++) hi = Math.max(hi, price[s]);
    if (hi / price[e] - 1 >= g.ride_arm_pct / 100) return price[t] <= hi * (1 - g.ride_trail_pct / 100) ? 'sell' : 'hold';
  }
  return 'base';
}
export function simulate(price: number[], eng: ModelSpec['engine'], policy: Policy, d: number): { entryT: number; fills: Fill[] } {
  const e = d + eng.latency_s, end = Math.min(eng.window_s, e + eng.hold_s), fills: Fill[] = [];
  let held = 1, pendingUntil = -1;
  for (let t = e + 1; t < end; t++) {
    if (held <= 1e-9) break;
    if (t < pendingUntil) continue;
    const frac = Math.min(held, policy(e, t, held, fills));
    if (frac > 1e-9) { const f = Math.min(t + eng.latency_s, end); fills.push([t, f, frac, price[f]]); held -= frac; pendingUntil = f; }
  }
  if (held > 1e-9) fills.push([end, end, held, price[end]]);
  return { entryT: e, fills };
}
export function netReturnPct(entryPrice: number, fills: Fill[], cost: number): number {
  const proceeds = fills.reduce((a, [, , frac, px]) => a + frac * (px / entryPrice) * (1 - cost), 0);
  return (proceeds / (1 + cost) - 1) * 100;
}

// ---------------- the model ----------------
export class Model {
  private tables = new Map<string, number[][]>();
  constructor(readonly spec: ModelSpec) {
    if (spec.format !== 'pump-model-v1') throw new Error(`unsupported model format ${spec.format}`);
  }
  row(l: Launch, t: number): number[] {
    let table = this.tables.get(l.mint);
    if (!table) { table = featureTable(l, this.spec.engine.window_s); this.tables.set(l.mint, table); }
    return [...table[t], l.trades ? 1 : 0];
  }
  buyProb(l: Launch, d: number): number {
    const b = this.spec.buy, x = this.row(l, d).map(v => (Number.isNaN(v) ? 0 : v));
    const p = Math.min(Math.max(sigmoid(gbtRaw(b, x)), 1e-6), 1 - 1e-6);
    return sigmoid(b.calibration[0] * Math.log(p / (1 - p)) + b.calibration[1]);
  }
  entryCrashProb(l: Launch, d: number): number {
    const m = this.spec.entry_crash; return sigmoid(mlpForward(m.layers, scale(m.scaler, this.row(l, d)))[0]);
  }
  crashProb(l: Launch, e: number, t: number): number {
    const p = l.price; let hi = -Infinity; for (let s = e; s <= t; s++) hi = Math.max(hi, p[s]);
    const x = [...this.row(l, t), (p[t] / p[e] - 1) * 100, (hi / p[e] - 1) * 100, t - e];
    return sigmoid(mlpForward(this.spec.crash.layers, scale(this.spec.crash.scaler, x))[0]);
  }
  seller(l: Launch): Policy {
    const base = rulesV3(l.price, this.spec.rules_v3);
    return (e, t, held, fills) => {
      const g = guardDecision(l.price, e, t, this.spec.guard, () => this.crashProb(l, e, t));
      return g === 'sell' ? held : g === 'hold' ? 0 : base(e, t, held, fills);
    };
  }
  trade(l: Launch): ModelTrade {
    const eng = this.spec.engine, d = buyDecisionTime(l.price, eng);
    if (d == null) return { decisionT: null, bought: false, buyProb: null, entryCrashProb: null, entryT: null, fills: null, netPct: null };
    const buyProb = this.buyProb(l, d), entryCrashProb = this.entryCrashProb(l, d), ect = this.spec.entry_crash.threshold;
    const bought = buyProb >= this.spec.buy.threshold && (ect == null || entryCrashProb < ect);
    if (!bought) return { decisionT: d, bought, buyProb, entryCrashProb, entryT: null, fills: null, netPct: null };
    const { entryT, fills } = simulate(l.price, eng, this.seller(l), d);
    return { decisionT: d, bought, buyProb, entryCrashProb, entryT, fills, netPct: netReturnPct(l.price[entryT], fills, eng.cost_per_side) };
  }
}
