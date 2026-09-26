// Execution seam for paper and real-money trading. Strategies place Orders; an Executor turns them into Fills.
// Paper and live share the same order/fill records, risk gate and accounting, so results are directly comparable
// and switching to real money is a configuration change. Live mode stays off until the owner configures it.

export type Mode = 'paper' | 'live';
export type ExecConfig = {
  mode: Mode;
  sizeUsd: number;             // per position
  maxOpenPositions: number;
  dailyLossLimitUsd: number;   // approved default: -$3/day
  maxDrawdownUsd: number;      // approved default: -$4 from the equity high
  maxBuySlippagePct: number;   // cancel a buy that would fill this far above the decision price ('bought the spike')
  latencyMs: number;           // paper fill delay; live records the real delay
  costPerSide: number;         // paper assumption: 1.25% fee + 2% slippage
};
export const DEFAULT_EXEC: ExecConfig = { mode: 'paper', sizeUsd: 2, maxOpenPositions: 5, dailyLossLimitUsd: 3, maxDrawdownUsd: 4, maxBuySlippagePct: 5, latencyMs: 2000, costPerSide: 0.0325 };

export type Order = { id: string; mint: string; side: 'buy' | 'sell'; fraction: number; decidedAt: number; refPrice: number; reason: string; strategy: string };
export type Fill = { orderId: string; mint: string; side: 'buy' | 'sell'; fraction: number; price: number | null; filledAt: number; latencyMs: number; feesUsd: number;
  status: 'filled' | 'rejected' | 'failed'; mode: Mode; note?: string; txSignature?: string };

export interface Executor { readonly mode: Mode; submit(order: Order): Promise<Fill>; }

// Paper: fills at the observed price latencyMs after the decision, with the configured per-side cost.
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;
  constructor(private priceAt: (mint: string, atMs: number) => Promise<number | null>, private cfg: ExecConfig = DEFAULT_EXEC) {}
  async submit(o: Order): Promise<Fill> {
    const filledAt = o.decidedAt + this.cfg.latencyMs, price = await this.priceAt(o.mint, filledAt);
    const base = { orderId: o.id, mint: o.mint, side: o.side, fraction: o.fraction, filledAt, latencyMs: this.cfg.latencyMs, mode: this.mode };
    if (price === null || !(price > 0)) return { ...base, price: null, feesUsd: 0, status: 'failed', note: 'no price at fill time' };
    if (o.side === 'buy' && price > o.refPrice * (1 + this.cfg.maxBuySlippagePct / 100))
      return { ...base, price, feesUsd: 0, status: 'rejected', note: `buy would fill ${((price / o.refPrice - 1) * 100).toFixed(1)}% above the decision price (cap ${this.cfg.maxBuySlippagePct}%)` };
    return { ...base, price, feesUsd: this.cfg.sizeUsd * o.fraction * this.cfg.costPerSide, status: 'filled' };
  }
}

// Live: the owner's signer submits the real transaction and reports the real fill. Nothing is sent without one.
export interface LiveSigner { swap(o: Order, sizeUsd: number, maxSlippagePct: number): Promise<{ price: number; filledAt: number; feesUsd: number; txSignature: string }>; }
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  constructor(private signer: LiveSigner | undefined, private cfg: ExecConfig) {}
  async submit(o: Order): Promise<Fill> {
    if (!this.signer) throw Error('Live trading is not configured: set mode=live and provide the owner signer.');
    const base = { orderId: o.id, mint: o.mint, side: o.side, fraction: o.fraction, mode: this.mode };
    try {
      const r = await this.signer.swap(o, this.cfg.sizeUsd * o.fraction, o.side === 'buy' ? this.cfg.maxBuySlippagePct : 100);
      return { ...base, price: r.price, filledAt: r.filledAt, latencyMs: r.filledAt - o.decidedAt, feesUsd: r.feesUsd, status: 'filled', txSignature: r.txSignature };
    } catch (e) { return { ...base, price: null, filledAt: Date.now(), latencyMs: Date.now() - o.decidedAt, feesUsd: 0, status: 'failed', note: e instanceof Error ? e.message : 'swap failed' }; }
  }
}

// Risk gate: checked before every buy, in both modes. Sells that reduce risk are always allowed.
export type BookState = { openPositions: number; realizedTodayUsd: number; equityUsd: number; equityHighUsd: number; halted?: string };
export function riskCheck(o: Order, b: BookState, cfg: ExecConfig = DEFAULT_EXEC): { ok: boolean; reason?: string } {
  if (o.side === 'sell') return { ok: true };
  if (b.halted) return { ok: false, reason: `halted: ${b.halted}` };
  if (b.openPositions >= cfg.maxOpenPositions) return { ok: false, reason: `max ${cfg.maxOpenPositions} open positions` };
  if (b.realizedTodayUsd <= -cfg.dailyLossLimitUsd) return { ok: false, reason: `daily loss limit -$${cfg.dailyLossLimitUsd} reached` };
  if (b.equityHighUsd - b.equityUsd >= cfg.maxDrawdownUsd) return { ok: false, reason: `drawdown limit -$${cfg.maxDrawdownUsd} reached` };
  return { ok: true };
}

export function executorFor(cfg: ExecConfig, deps: { priceAt: (mint: string, atMs: number) => Promise<number | null>; signer?: LiveSigner }): Executor {
  return cfg.mode === 'live' ? new LiveExecutor(deps.signer, cfg) : new PaperExecutor(deps.priceAt, cfg);
}

// Net return of a position from its fills, identical for paper and live.
export function positionReturnPct(buy: Fill, sells: Fill[], sizeUsd: number): number | null {
  if (buy.status !== 'filled' || !buy.price) return null;
  const outlay = sizeUsd + buy.feesUsd;
  const proceeds = sells.filter(s => s.status === 'filled' && s.price).reduce((a, s) => a + sizeUsd * s.fraction * (s.price! / buy.price!) - s.feesUsd, 0);
  return (proceeds / outlay - 1) * 100;
}
