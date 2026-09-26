export const defaults = Object.freeze({ balance: 11, size: 2, momentum: 3, take: 8, stop: 5, holdMs: 30000, delayMs: 1000, feePct: 1.25, slipPct: 2, networkUsd: 0.02, accountUsd: 0.3, maxGapMs: 5000 });

// Normalized single-market observations. USD prices must come from a documented
// source conversion; ingestion never guesses SOL/USD or token decimals.
export function observations(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 100000) throw Error('Supply 2–100,000 trade observations.');
  const ids = new Set(); let previous = -Infinity;
  return input.map(t => {
    if (!t || typeof t !== 'object' || !Number.isSafeInteger(t.time) || t.time < 0 || t.time < previous ||
      !Number.isFinite(t.priceUsd) || t.priceUsd <= 0 || !Number.isFinite(t.volumeUsd) || t.volumeUsd < 0 ||
      typeof t.id !== 'string' || !t.id || ids.has(t.id)) throw Error('Trades need unique IDs, ascending millisecond timestamps, positive priceUsd and nonnegative volumeUsd.');
    previous = t.time; ids.add(t.id);
    return { id: t.id, time: t.time, priceUsd: t.priceUsd, volumeUsd: t.volumeUsd };
  });
}

export function candles(rows, seconds) {
  if (![1, 5].includes(seconds)) throw Error('Only 1s and 5s candles are supported.');
  const result = []; const width = seconds * 1000;
  for (const t of rows) {
    const time = Math.floor(t.time / width) * width;
    let c = result.at(-1);
    if (!c || c.time !== time) { c = { time, open: t.priceUsd, high: t.priceUsd, low: t.priceUsd, close: t.priceUsd, volumeUsd: 0, count: 0 }; result.push(c); }
    c.high = Math.max(c.high, t.priceUsd); c.low = Math.min(c.low, t.priceUsd); c.close = t.priceUsd;
    c.volumeUsd += t.volumeUsd; c.count++;
  }
  return result; // Missing intervals remain gaps, not invented flat candles.
}

export function replay(rows, options = {}) {
  const r = { ...defaults, ...options };
  for (const key of Object.keys(defaults)) if (!Number.isFinite(r[key]) || r[key] < 0) throw Error(`Invalid ${key}`);
  if (r.balance <= 0 || r.size <= 0 || r.size > r.balance || r.feePct >= 100 || r.slipPct >= 100 || r.maxGapMs < 1 || r.holdMs < 1 || r.delayMs < 1) throw Error('Invalid budget, costs or timing.');
  let cash = r.balance, position = null, pending = null, nextEntry = 0, gaps = 0, failed = 0, paid = 0;
  let bucket = null; const completed = [], trades = [], events = [];
  const costOut = (quantity, price) => quantity * price * (1 - r.slipPct / 100) * (1 - r.feePct / 100) - r.networkUsd;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i], prev = rows[i - 1];
    const gap = prev && t.time - prev.time > r.maxGapMs;
    if (gap) { gaps++; completed.length = 0; bucket = null; }
    if (pending && t.time >= pending.at) {
      if (gap || t.time - pending.at > r.maxGapMs) {
        // A missing observation is not a successful execution. Charge a modeled
        // failed-attempt fee and keep a sell position open for another attempt.
        const fee = Math.min(cash, r.networkUsd); cash -= fee; paid += fee; failed++;
        events.push({ time: t.time, action: 'Unfilled attempt', reason: 'Observation gap', cost: fee }); pending = null;
      } else if (pending.side === 'buy') {
        const spend = r.size - r.networkUsd - r.accountUsd;
        if (cash >= r.size && spend > 0) {
          const quantity = spend / (1 + r.feePct / 100) / (t.priceUsd * (1 + r.slipPct / 100));
          const cost = r.size - quantity * t.priceUsd;
          position = { quantity, openedAt: t.time, cost: r.size, entry: t.priceUsd, entryCosts: cost };
          cash -= r.size; paid += cost;
        }
        pending = null;
      } else if (position) {
        const proceeds = Math.max(0, costOut(position.quantity, t.priceUsd));
        const cost = position.quantity * t.priceUsd - proceeds; paid += cost; cash += proceeds;
        trades.push({ ...position, closedAt: t.time, exit: t.priceUsd, proceeds, pnl: proceeds - position.cost, reason: pending.reason, exitCosts: cost });
        position = null; pending = null; nextEntry = t.time + 30000;
      }
    }
    if (position && !pending) {
      const net = costOut(position.quantity, t.priceUsd) / position.cost - 1;
      const reason = net >= r.take / 100 ? 'Profit trigger' : net <= -r.stop / 100 ? 'Loss trigger' : t.time - position.openedAt >= r.holdMs ? 'Time exit' : null;
      if (reason) pending = { side: 'sell', at: t.time + r.delayMs, reason };
    }
    const start = Math.floor(t.time / 5000) * 5000;
    if (bucket && start !== bucket.time) {
      completed.push(bucket); if (completed.length > 2) completed.shift();
      const [a, b] = completed;
      // Only fully closed contiguous candles generate a signal. Current trade
      // cannot become a same-timestamp fill; execution waits for a later event.
      if (!position && !pending && t.time >= nextEntry && a && b && b.time - a.time === 5000 && start - b.time === 5000 &&
        (b.close / a.close - 1) * 100 >= r.momentum && b.volumeUsd > a.volumeUsd && cash >= r.size) {
        pending = { side: 'buy', at: t.time + r.delayMs, reason: 'Closed 5s momentum and rising volume' };
      }
      bucket = null;
    }
    if (!bucket) bucket = { time: start, close: t.priceUsd, volumeUsd: 0 };
    bucket.close = t.priceUsd; bucket.volumeUsd += t.volumeUsd;
  }
  // Open positions are never magically liquidated at end of data.
  return { rules: r, cash, position, pending, trades, events, gaps, failed, modeledCosts: paid,
    realizedPnl: trades.reduce((n, t) => n + t.pnl, 0),
    markedEquity: cash + (position ? Math.max(0, costOut(position.quantity, rows.at(-1).priceUsd)) : 0),
    liveTrading: false, fillModel: 'Delayed observed-price proxy; executable liquidity and on-chain fees unverified' };
}
