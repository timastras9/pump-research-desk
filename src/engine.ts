export interface Rules {
  positionUsd: number; maxPositions: number; dailyLossUsd: number;
  minLiquidityUsd: number; minVolume1hUsd: number; minAgeMinutes: number;
  minMomentumPct: number; maxMomentumPct: number;
  stopLossPct: number; takeProfitPct: number; maxHoldMinutes: number;
  feePct: number; slippagePct: number; networkFeeUsd: number;
}
export const defaults: Rules = {
  positionUsd: 25, maxPositions: 3, dailyLossUsd: 30,
  minLiquidityUsd: 100000, minVolume1hUsd: 10000, minAgeMinutes: 5,
  minMomentumPct: 2, maxMomentumPct: 15,
  stopLossPct: 5, takeProfitPct: 8, maxHoldMinutes: 5,
  feePct: 1, slippagePct: 1, networkFeeUsd: 0.02,
};
export interface Quote {
  mint: string; symbol: string; name: string; pair: string; dex: string;
  price: number; liquidity: number | null; volume1h: number | null;
  momentum: number | null; createdAt: number | null; fetchedAt: number;
}
export interface Position {
  id: string; mint: string; symbol: string; quantity: number; cost: number;
  entryPrice: number; openedAt: number; rules: Rules; ruleVersion: number;
  entryMomentum: number | null; entryLiquidity: number | null; entryVolume1h: number | null;
  exitRequested?: string; exitBlocked?: string;
}
export interface Trade extends Position { closedAt: number; proceeds: number; pnl: number; reason: string; exitPrice: number }
export interface DeskState {
  initialCash: number; cash: number; rules: Rules; ruleVersion: number;
  enabled: boolean; watchlist: string[]; quotes: Record<string, Quote>;
  positions: Position[]; trades: Trade[];
  events: { at: number; message: string }[];
  history: { at: number; equity: number }[];
  lastClosed: Record<string, number>;
  day: string; dayStartEquity: number; halted: boolean;
  lastRefresh: number | null; lastAttempt: number | null;
  latencyMs: number | null; feedError: string | null;
  insight: { text: string; at: number; tradeCount: number; model: string } | null;
  lastAiAttempt: number | null;
}
export function initialState(): DeskState {
  return { initialCash: 1000, cash: 1000, rules: { ...defaults }, ruleVersion: 1,
    enabled: false, watchlist: [], quotes: {}, positions: [], trades: [], events: [], history: [],
    lastClosed: {}, day: '', dayStartEquity: 1000, halted: false,
    lastRefresh: null, lastAttempt: null, latencyMs: null, feedError: null, insight: null, lastAiAttempt: null };
}
export function event(s: DeskState, message: string, now = Date.now()) {
  s.events.unshift({ at: now, message }); s.events = s.events.slice(0, 200);
}
export function validateRules(value: unknown): Rules {
  if (!value || typeof value !== 'object') throw new Error('Rules must be an object.');
  const x = value as Record<string, unknown>;
  const ranges: Record<keyof Rules, [number, number]> = {
    positionUsd: [1, 100], maxPositions: [1, 10], dailyLossUsd: [1, 200],
    minLiquidityUsd: [1000, 100000000], minVolume1hUsd: [0, 100000000], minAgeMinutes: [1, 525600],
    minMomentumPct: [-50, 100], maxMomentumPct: [-50, 200], stopLossPct: [1, 90],
    takeProfitPct: [1, 500], maxHoldMinutes: [1, 10080], feePct: [0.1, 10],
    slippagePct: [0.1, 10], networkFeeUsd: [0.001, 10],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const v = x[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  if (!Number.isInteger(x.maxPositions)) throw new Error('Maximum positions must be a whole number.');
  if (Number(x.minMomentumPct) > Number(x.maxMomentumPct)) throw new Error('Momentum minimum exceeds maximum.');
  return Object.fromEntries(Object.keys(ranges).map(k => [k, x[k]])) as unknown as Rules;
}
export function fresh(q: Quote | undefined, now: number): q is Quote {
  return !!q && q.price > 0 && Number.isFinite(q.price) && now >= q.fetchedAt && now - q.fetchedAt <= 120000;
}
export function impact(notional: number, liquidity: number): number { return 2 * notional / liquidity; }
export function exitValue(p: Position, q: Quote | undefined): number {
  if (!q || !q.liquidity || q.price <= 0) return 0;
  const gross = p.quantity * q.price;
  const slip = p.rules.slippagePct / 100 + Math.min(1, impact(gross, q.liquidity));
  return Math.max(0, gross * Math.max(0, 1 - slip) * (1 - p.rules.feePct / 100) - p.rules.networkFeeUsd);
}
export function equity(s: DeskState): number {
  return s.cash + s.positions.reduce((sum, p) => sum + exitValue(p, s.quotes[p.mint]), 0);
}
export function rejectionReasons(s: DeskState, q: Quote | undefined, now: number): string[] {
  const r = s.rules; const reasons: string[] = [];
  if (!fresh(q, now)) return ['Missing or stale quote'];
  if (!['pumpfun', 'pumpswap'].includes(q.dex)) reasons.push('Not a Pump market');
  if (q.liquidity === null || q.liquidity < r.minLiquidityUsd) reasons.push('Liquidity below rule or unavailable');
  if (q.volume1h === null || q.volume1h < r.minVolume1hUsd) reasons.push('Hourly volume below rule or unavailable');
  if (!q.createdAt || (now - q.createdAt) / 60000 < r.minAgeMinutes) reasons.push('Market too new or age unavailable');
  if (q.momentum === null || q.momentum < r.minMomentumPct || q.momentum > r.maxMomentumPct) reasons.push('5m momentum outside range');
  if (s.positions.some(p => p.mint === q.mint)) reasons.push('Position already open');
  if (s.positions.length >= r.maxPositions) reasons.push('Position limit reached');
  if (s.halted || s.dayStartEquity - equity(s) >= r.dailyLossUsd) reasons.push('Daily loss limit reached');
  if (s.cash < r.positionUsd) reasons.push('Insufficient paper cash');
  if (now - (s.lastClosed[q.mint] ?? 0) < 3600000) reasons.push('One-hour re-entry cooldown');
  if (q.liquidity && impact(r.positionUsd, q.liquidity) > 0.02) reasons.push('Estimated price impact exceeds 2%');
  return reasons;
}
export function buy(s: DeskState, mint: string, now: number): void {
  const q = s.quotes[mint]; const reasons = rejectionReasons(s, q, now);
  if (reasons.length) throw new Error(reasons.join('; '));
  const r = s.rules;
  const entryPrice = q.price * (1 + r.slippagePct / 100 + impact(r.positionUsd, q.liquidity!));
  const quantity = (r.positionUsd - r.networkFeeUsd) / (1 + r.feePct / 100) / entryPrice;
  if (!(quantity > 0)) throw new Error('Trade costs exceed position size.');
  s.cash -= r.positionUsd;
  s.positions.push({ id: crypto.randomUUID(), mint, symbol: q.symbol, quantity, cost: r.positionUsd,
    entryPrice, openedAt: now, rules: { ...r }, ruleVersion: s.ruleVersion,
    entryMomentum: q.momentum, entryLiquidity: q.liquidity, entryVolume1h: q.volume1h });
  event(s, `Paper buy: ${q.symbol}, $${r.positionUsd.toFixed(2)} including estimated costs.`, now);
}
export function close(s: DeskState, id: string, reason: string, now: number): boolean {
  const p = s.positions.find(x => x.id === id); if (!p) throw new Error('Position not found.');
  const q = s.quotes[p.mint];
  if (!fresh(q, now) || !q.liquidity || impact(p.quantity * q.price, q.liquidity) > 0.02) {
    p.exitRequested = reason;
    const message = 'Exit blocked: missing quote, liquidity, or estimated impact above 2%.';
    if (p.exitBlocked !== message) event(s, `${p.symbol}: ${message}`, now);
    p.exitBlocked = message;
    return false;
  }
  const proceeds = exitValue(p, q);
  s.cash += proceeds;
  s.trades.unshift({ ...p, closedAt: now, proceeds, pnl: proceeds - p.cost, reason, exitPrice: proceeds / p.quantity });
  s.positions = s.positions.filter(x => x.id !== id);
  s.lastClosed[p.mint] = now;
  event(s, `Paper exit: ${p.symbol}, ${reason}, net P&L $${(proceeds - p.cost).toFixed(2)}.`, now);
  return true;
}
export function processTick(s: DeskState, now: number): void {
  const day = new Date(now).toISOString().slice(0, 10);
  if (s.day !== day) { s.day = day; s.dayStartEquity = equity(s); s.halted = false; }
  for (const p of [...s.positions]) {
    const q = s.quotes[p.mint];
    if (p.exitRequested) { close(s, p.id, p.exitRequested, now); continue; }
    if (!fresh(q, now)) continue;
    const change = (exitValue(p, q) / p.cost - 1) * 100;
    const reason = change <= -p.rules.stopLossPct ? 'Stop loss' : change >= p.rules.takeProfitPct ? 'Take profit'
      : now - p.openedAt >= p.rules.maxHoldMinutes * 60000 ? 'Time exit' : null;
    if (reason) close(s, p.id, reason, now);
  }
  if (s.dayStartEquity - equity(s) >= s.rules.dailyLossUsd && !s.halted) {
    s.halted = true; s.enabled = false; event(s, 'Daily loss limit reached. New entries paused until the next UTC day.', now);
  }
  if (s.enabled && !s.halted && !s.feedError) {
    for (const mint of s.watchlist) if (!rejectionReasons(s, s.quotes[mint], now).length) buy(s, mint, now);
  }
  s.history.push({ at: now, equity: equity(s) }); s.history = s.history.slice(-1440);
}
