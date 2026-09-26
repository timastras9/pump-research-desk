# Momentum Lab

Private, single-owner paper-trading research desk for Pump markets, hosted on Cloudflare Workers. **No Coinbase connection, wallet signing, transaction submission, or real-money trading is implemented.**

## Use it

1. Sign in with your dashboard access key.
2. Paste a Solana token mint address or load the Pump market sample and select Watch.
3. Read the eligibility reason. A paper buy is available only when the current filters pass.
4. Use Paper buy for a manual simulated entry or Start paper strategy for automatic entries on watched coins.
5. Exit now requests a simulated exit. Pausing stops new entries; open-position exit rules continue.
6. Review closed trades and Cloudflare AI notes. Export data before comparing experiments.

The starting account is **$1,000 simulated USD**. Default trades cost $25 including modeled costs, with an 8% net profit trigger, 5% net loss trigger, and five-minute time exit. These are experiment defaults, not investment recommendations. Sampling can cause exit overshoot.

## Architecture

- Workers serve private static assets and authenticated API routes.
- A SQLite-backed Durable Object stores this owner's watchlist, rules, paper account, journal, and sampled equity history. Mutations use synchronous SQLite read/write sections. Network operations re-read state after awaiting so edits are preserved.
- A one-minute Cron Trigger refreshes watched Pump/PumpSwap quotes from DEX Screener and evaluates fixed trading rules, including when the browser is closed.
- Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`) explains recorded numeric data. Reviews run after five additional closed trades, at most hourly, or on demand at most once per five minutes. The model has no trading tools and cannot change rules.
- Password authentication uses constant-time comparison, signed 24-hour HttpOnly/Secure/SameSite cookies, same-origin mutation checks, login throttling, and a restrictive CSP. Treat the access key as a password. Rotate the Worker secret to invalidate all sessions.

## Data and modeling limits

DEX Screener returns aggregate market snapshots, not all individual historical transactions or an executable quote. Fetch latency is not source-data age, RPC latency, or transaction inclusion time. There is **no subsecond launch detection or historical backtest**. Pump bonding-curve markets may lack usable liquidity fields; these are blocked rather than assigned fabricated values. Search results are a sample, not a ranked recommendation or complete universe.

Entries require fresh retrieval (within 120 seconds), Pump venue, positive price, liquidity, volume, market age, momentum bounds, position limit, cash, and daily loss checks. This does not verify holder concentration, authorities, bundles, scams, or market manipulation.

Modeled buys debit a fixed all-in cash amount. Modeled sells deduct fees, slippage, network costs, and a simple liquidity-impact proxy (`2 * notional / liquidity`). Trades above 2% estimated impact are blocked. Real bonding curves/AMMs may behave differently. Unavailable liquidity is marked at zero for paper equity; a missing/stale quote prevents a fill. Blocked requested exits remain open and retry. Stale marks may distort equity. Stops execute at the next sampled estimate, not the stop price. Trades retain their entry rule version and cost/exit parameters.

Daily loss is estimated equity loss relative to the first observation of each UTC day; it halts new entries, does not guarantee a maximum loss, and does not force-close all positions. Restarting the strategy after a halt requires a new UTC day and an explicit start. Re-entry cooldown is one hour. History retains 1,440 samples (not necessarily exactly 24 hours), activity retains 200 events, and the dashboard shows the latest 100 closed trades. The journal halts new entries at 1,990 completed trades, reserving room for existing exits; export the experiment before a future archival/reset workflow. No journal reset is exposed in this release.

## Development

Requires Node 22+, npm, and Cloudflare Wrangler authentication.

```sh
npm ci
# Create ignored .dev.vars with DASHBOARD_PASSWORD=<local-only-password>
npm run types
npm run check
npm test
npm run dev
```

Workers AI always uses the remote account even in local development. Resource usage is billed/limited according to the Cloudflare account's plan. No paid plan upgrades are performed by this project.

## Deployment

`wrangler.jsonc` explicitly targets the Astras AI Cloudflare account and the `pump-research-desk` Worker. The GitHub source repository is private under `timastras9`.

```sh
npm run check
npm test
npm run build
npm run deploy
npx wrangler secret put DASHBOARD_PASSWORD
```

Set the production password using protected stdin or the Wrangler prompt. Never commit `.dev.vars`, `.secrets`, account tokens, or wallet keys. The initial access key is saved locally in ignored `.secrets/dashboard-access.txt`. Source pushes do not automatically deploy; run `npm run deploy` after validation. Exported JSON contains the full retained paper-trade record.

## References

- [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [DEX Screener API](https://docs.dexscreener.com/api/reference)
- [Pump protocol documentation](https://github.com/pump-fun/pump-public-docs)
