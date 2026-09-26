// Live launch data for the model: the same free pump.fun endpoints and the same cleaning rules as the research corpus
// (scripts/build_launch_corpus.py + research/engine.py load_episodes), so the Worker's model sees what it was trained on.
import type { Launch } from './model';

const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const COIN_URL = (mint: string) => `https://frontend-api-v3.pump.fun/coins-v2/${mint}`;
export const CANDLES_URL = (mint: string, created: number) =>
  `https://swap-api.pump.fun/v2/coins/${mint}/candles?interval=1s&limit=1000&currency=USD&createdTs=${created}&program=pump&chainId=${CHAIN}`;
export const TRADES_URL = (mint: string, created: number, cursor: string) =>
  `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=100&cursor=${encodeURIComponent(cursor)}&program=pump&minSolAmount=0&chainId=${CHAIN}&createdTs=${created}`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Origin: 'https://pump.fun', Accept: 'application/json' };
export const MAX_TRADE_PAGES = 30;

export type ApiCoin = { mint?: string; name?: string; creator?: string | null; description?: string | null; image_uri?: string | null; mayhem_state?: unknown; created_timestamp?: number };
export type ApiCandle = { timestamp: number; close: number | string; volume?: number | string | null };
export type ApiTrade = { timestamp: string; userAddress?: string | null; type?: string; amountSol?: number | string | null; tx?: string | null };
export type LaunchData = Launch & { name: string; createdMs: number; candlesN: number; tradesStatus: 'done' | 'capped' | 'failed' | 'none' };

/** Engine rules: close > 0 inside the window, backfill before the first candle, forward-fill gaps; trades inside the window. */
export function buildLaunch(mint: string, createdMs: number, coin: ApiCoin, candles: ApiCandle[], trades: ApiTrade[] | null, windowS = 720): LaunchData | null {
  const n = windowS + 1, price: number[] = new Array(n).fill(NaN), volume: number[] = new Array(n).fill(0); let candlesN = 0;
  for (const c of candles) {
    const sec = Math.trunc((c.timestamp - createdMs) / 1000), close = Number(c.close);
    if (sec < 0 || sec > windowS || !(close > 0)) continue;
    if (Number.isNaN(price[sec])) candlesN++;
    price[sec] = close; volume[sec] = Number(c.volume ?? 0) || 0;
  }
  const first = price.findIndex(v => !Number.isNaN(v));
  if (first < 0) return null;
  for (let i = 0; i < first; i++) price[i] = price[first];
  for (let i = 1; i < n; i++) if (Number.isNaN(price[i])) price[i] = price[i - 1];
  const seen = new Set<string>();   // the corpus keeps one row per (tx, wallet, side)
  const rows = trades === null ? null : trades
    .map(x => { const ts = Date.parse(x.timestamp); return { ts, sec: Math.floor((ts - createdMs) / 1000), wallet: x.userAddress ?? null, side: String(x.type ?? ''), sol: Number(x.amountSol ?? 0) || 0, tx: x.tx ?? null }; })
    .filter(r => r.sec >= 0 && r.sec <= windowS)
    .filter(r => { const k = `${r.tx}|${r.wallet}|${r.side}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.ts - b.ts)
    .map(r => [r.sec, r.wallet, r.side, r.sol] as [number, string | null, string, number]);
  const img = coin.image_uri ?? '', desc = coin.description ?? '';
  return {
    mint, name: String(coin.name ?? ''), createdMs, creator: coin.creator ?? null, candlesN, price, volume, trades: rows, tradesStatus: 'none',
    tags: { fee_routed: /fees? to @\w+/i.test(desc), mayhem: Boolean(coin.mayhem_state), terminal: !(!img || /ipfs|pinata/.test(img)) },
  };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function getJson<T>(url: string, fetcher: Fetcher = fetch, tries = 5, pauseMs = 2000): Promise<T | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (r.status === 429) { await wait(pauseMs * (attempt + 1)); continue; }   // rate limited: back off and retry
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch { await wait(pauseMs); }
  }
  return null;
}

/** Wallet trades for the first 12 minutes: newest-first pages walked back until they pass the launch. */
export async function fetchTrades(mint: string, createdMs: number, fetcher: Fetcher = fetch, windowS = 720, pageGapMs = 350): Promise<{ trades: ApiTrade[] | null; status: LaunchData['tradesStatus'] }> {
  const out: ApiTrade[] = []; let cursor = '0';
  for (let page = 0; page < MAX_TRADE_PAGES; page++) {
    const d = await getJson<{ trades?: ApiTrade[]; pagination?: { hasMore?: boolean; nextCursor?: string } }>(TRADES_URL(mint, createdMs, cursor), fetcher);
    if (!d) return page === 0 ? { trades: null, status: 'failed' } : { trades: out, status: 'done' };
    let oldest: number | null = null;
    for (const x of d.trades ?? []) { oldest = Math.floor((Date.parse(x.timestamp) - createdMs) / 1000); if (oldest >= 0 && oldest <= windowS) out.push(x); }
    const pg = d.pagination ?? {};
    if (!pg.hasMore || !pg.nextCursor || (oldest !== null && oldest < 0)) return { trades: out, status: 'done' };
    cursor = pg.nextCursor; if (pageGapMs) await wait(pageGapMs);
  }
  return { trades: out, status: 'capped' };
}

export async function fetchLaunch(mint: string, createdMs: number, fetcher: Fetcher = fetch, windowS = 720): Promise<LaunchData | null> {
  const coin = (await getJson<ApiCoin>(COIN_URL(mint), fetcher)) ?? {};
  const candles = await getJson<ApiCandle[]>(CANDLES_URL(mint, createdMs), fetcher);
  if (!candles) return null;
  const { trades, status } = await fetchTrades(mint, createdMs, fetcher, windowS);
  const launch = buildLaunch(mint, createdMs, coin, candles, trades, windowS);
  if (launch) launch.tradesStatus = status;
  return launch;
}
