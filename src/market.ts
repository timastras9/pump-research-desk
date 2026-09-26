import type { Quote } from './engine';
export const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type Pair = { chainId?: string; dexId?: string; pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string; liquidity?: { usd?: number }; volume?: { h1?: number };
  priceChange?: { m5?: number }; pairCreatedAt?: number };
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export function normalize(p: Pair, now: number): Quote | null {
  const price = Number(p.priceUsd);
  if (p.chainId !== 'solana' || !p.baseToken?.address || !mintPattern.test(p.baseToken.address)
    || !p.pairAddress || !['pumpfun', 'pumpswap'].includes(p.dexId ?? '') || !Number.isFinite(price) || price <= 0) return null;
  return { mint: p.baseToken.address, symbol: (p.baseToken.symbol ?? 'TOKEN').slice(0, 24),
    name: (p.baseToken.name ?? 'Unknown token').slice(0, 100), pair: p.pairAddress, dex: p.dexId!, price,
    liquidity: num(p.liquidity?.usd), volume1h: num(p.volume?.h1), momentum: num(p.priceChange?.m5),
    createdAt: num(p.pairCreatedAt), fetchedAt: now };
}
async function request(path: string): Promise<unknown> {
  const res = await fetch(`https://api.dexscreener.com${path}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Market data provider returned ${res.status}.`);
  // Bound third-party responses even if Content-Length is absent.
  const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > 2000000) throw new Error('Market response too large.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(total); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function quotes(mints: string[]): Promise<Quote[]> {
  if (!mints.length) return [];
  const data = await request(`/tokens/v1/solana/${mints.join(',')}`);
  if (!Array.isArray(data)) throw new Error('Unexpected market response.');
  const normalized = data.map(p => normalize(p, Date.now())).filter((q): q is Quote => !!q);
  return mints.flatMap(mint => {
    const matches = normalized.filter(q => q.mint === mint).sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    return matches.length ? [matches[0]] : [];
  });
}
export async function discover(): Promise<Quote[]> {
  const responses = await Promise.all(['/latest/dex/search?q=pumpswap', '/latest/dex/search?q=pumpfun'].map(path => request(path)));
  const result = responses.flatMap(data => {
    const value = data as { pairs?: Pair[] };
    if (!Array.isArray(value.pairs)) throw new Error('Unexpected search response.');
    return value.pairs.map(p => normalize(p, Date.now())).filter((q): q is Quote => !!q).slice(0, 10);
  });
  const seen = new Set<string>();
  return result.filter(q => { if (seen.has(q.mint)) return false; seen.add(q.mint); return true; }).slice(0, 20);
}
