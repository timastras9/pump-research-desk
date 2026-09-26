# Momentum Lab

Private, single-owner paper-trading research desk for Pump markets, hosted on Cloudflare Workers. A local setup command connects a separate CDP Solana wallet and verifies message signing. **The deployed dashboard has no wallet execution, transaction submission, or real-money trading.**

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

## Local Coinbase credential entry

Run `npm run credentials` and open http://127.0.0.1:8878. Select OAuth client credentials or a Coinbase API key, fill both fields, and save. The local-only server writes `.secrets/coinbase.json` as plaintext with owner-only permissions (directory 0700, file 0600). This directory is ignored by Git and is not part of the published assets. Saving replaces the existing Coinbase credential file; credentials are never returned to the browser or printed in logs.

Run `npm run credentials:upload` when ready to upload the saved values to the Worker configured in `wrangler.jsonc`. The uploader sends the JSON through Wrangler's standard input, not command arguments. This updates Worker secrets; it does not implement Coinbase OAuth authorization or enable live trading. OAuth credentials identify an application and still require account authorization. Close the local setup server with Ctrl+C when finished.

### CDP Solana wallet route

The selected approach is a separate CDP API-key-controlled Solana wallet, funded manually by the owner, rather than linking the consumer Coinbase balance. The existing Ed25519 developer API key is suitable for CDP API authentication. A separate Wallet Secret is required for wallet operations. The local credential form has a dedicated Wallet Secret section, which writes `.secrets/coinbase-wallet.json` with owner-only permissions without changing the API key pair. `npm run credentials:upload` includes `CDP_WALLET_SECRET` if that file exists. No wallet creation, funding, signing, or live execution is enabled just by saving/uploading these values. Create and verify the Solana wallet and test its signing flow before presenting an address for funding. The user's stated future live trial budget is $11 total, after testing.

Reference: https://docs.cdp.coinbase.com/wallets/quickstart/api-key-auth

Run `npm run wallet:check` to create or retrieve the named `pump-research-desk` Solana account, sign a unique connectivity-only message, independently verify its Ed25519 signature, and read the SOL balance using public mainnet RPC. It saves address and verification metadata in ignored `.secrets/solana-wallet.json`. Repeating the command reuses the same named account. It never signs a transaction or sends funds. An unavailable balance is `null`, not zero. Raw SDK errors and credentials are not printed.

Remaining before live use: deploy wallet access in the authenticated backend; connect a reliable Solana RPC and live trade feed; implement official Pump/PumpSwap transaction building, simulation, confirmation and sell retries; test slippage, fees and failure handling; and validate the strategy with the intended $11 trial budget. The existing $1,000 paper account is not yet calibrated to that budget. Funding comes after these tests. No strategy can guarantee profitable trades or immediate exits.

The uploader also accepts the downloaded `.secrets/cdp_wallet_secret.txt` directly and uploads its value as `CDP_WALLET_SECRET`. If both wallet files exist, their values must match; otherwise upload stops. Secret values are sent through standard input and never committed to Git or included in public assets.

## Seconds replay lab

Open `/lab.html` from the dashboard. This separate experiment starts with $11 and preserves the existing paper journal. Import a single-market JSON capture with `source`, `mint`, and `trades` (`id`, `time` in milliseconds, `priceUsd`, `volumeUsd`). 1s and 5s candles preserve gaps. Entries use two completed 5s candles, rising volume and configured momentum; fills wait for later observations after an explicit delay. One open position, 30s cooldown, and net-cost/time exits are enforced. Missing observations can leave attempts unfilled and positions open. There is no forced end-of-sample sale. Export includes rules, source, observations, results and a doubled-delay/cost comparison. Demo observations are synthetic and explicitly labeled.

All fees, adverse fill adjustments, network costs and account setup costs are assumptions; this is an observed-price proxy, not an executable quote or verified profitability. Actual pool fee schedules, price impact, priority fees, MEV, liquidatable size and token risks are not verified. The current live dashboard still uses minute snapshots. A live trade feed is NOT connected. PumpPortal's current token trade feed requires an API key and funded wallet and charges per event; no subscription or funding was started.

Run `npm run devnet:check` for a separate plumbing test. It creates/reuses two named CDP accounts, requests free devnet SOL if needed, signs and preflights a 0.001 test-SOL transfer out and back, and checks confirmations. Endpoint is fixed to devnet with no mainnet override. Public signatures/status are saved in ignored `.secrets/devnet-check.json`. An uncertain submission must be inspected before retrying; this command is not an automated order executor. Devnet transfers are not yet paired with replay trades and no USDC swap occurs.

## CoinGecko Demo credentials and planned quota

The local setup page at http://127.0.0.1:8878 now has a CoinGecko Demo key field. It saves only `COINGECKO_DEMO_API_KEY` to ignored `.secrets/coingecko.json` (owner-only permissions), clears the field and preserves Coinbase credentials. `npm run credentials:upload` includes this key when present. Saving does not make API calls or activate polling. No CoinGecko request integration or quota counter is active yet.

Planned allocation: at most 5,000 research calls, with 5,000 reserved. Before activating collection, implement a persistent pre-request counter, caching, rate-limit backoff, and an explicit stop at the research cap. Account usage outside this app must be reconciled with the provider dashboard. At one request every five seconds, 5,000 requests lasts 6h 56m 40s, excluding discovery and other requests. A reserve is not a profit guarantee.

Reviewed https://www.coingecko.com/learn/how-to-build-pump-fun-sniper-bot-in-python : retain the discovery/filter/execution separation; distinguish token and pool addresses; record age, liquidity, FDV, graduation and migrated destination; persist timestamps and raw observations for replay. Do not adopt example thresholds as a proven strategy. Its WebSocket example requires Basic or higher, and transaction/wallet integration is listed as further work. Demo OHLCV lists minute/hour/day, not second candles: https://docs.coingecko.com/demo/reference/pool-ohlcv-contract-address . Five-second polling cannot recreate missing intrabar trades. For this budget, bulk historical research with locally repeated replay is more economical than repeatedly requesting the same data.

## Browser Run research workflow

Open `/observer.html`. Scan fresh launches samples up to 20 rendered New-feed table rows, records mint IDs from row image alt text and labeled cells, and asks Kimi K2.6 for at most one new observation subject created within the last 60 seconds. Responses are validated against the supplied candidate set; malformed or invented selections produce no automatic choice. First-seen timestamps persist separately from the page's creation timestamp. “Scan and watch Kimi’s first pick” connects discovery to one bounded recording. Candidates are rechecked after selection, before recording, and after page loading; tokens older than 60 seconds are rejected. Creation time must be present and not in the future. Recordings expose token age at capture start. Saved scans from the older Movers workflow are not reused for fresh-launch selection. The UI supports manual mints too.

Recordings run 10, 30 or 60 seconds at a measured 500ms target, up to 120 JPEG frames. Browser loading and inference add time. The page's explicit price-mode control is selected; only plain, positive dollar prices from its labeled header are accepted. Abbreviated or subscript prices remain unknown. Display values are rounded snapshots with unverified source age, not executable quotes or trade candles. Market cap is never used as price. Screenshots and numeric observations have separate timestamps.

Kimi uses three task-specific prompts in `src/research-model.ts`: candidate selection, structured screenshot observations, and a final evidence review. Screenshot content is untrusted. One vision request is in flight at a time, at least five seconds between starts, at most six calls per recording; no queue of old frames. Calls time out after 20 seconds. Selection and final review are separate bounded calls. The owner previously authorized the welcome Continue acceptance; no pump.fun login is required or attempted.

Five independent paper experiments use a common prospective entry: the first positive displayed USD price after the first valid price-chart AI result plus the execution-delay assumption. Exit rules are 10/20/30-second holds, 5% trailing decline, and a valid down-direction visual result. Exits wait for the configured delay and a timely subsequent observation. Gaps incur modeled failed-attempt costs; positions are not magically closed at data end. Defaults are $2 size from an $11 budget, 1.25% fee and 2% slippage per side, $0.02 network cost per attempt, $0.30 setup and 1000ms delay. These are editable research assumptions, not verified provider costs or profitability evidence. Strategies are separate scenarios, not simultaneous positions in a portfolio.

SQLite Durable Object storage keeps every frame as it arrives and saves reports, original assumptions, model/prompt version, vision timing and comparisons. Saved recordings can be reopened and exported from the private authenticated page. Partial frames survive a later run failure. Keep the request page open through completion; this is a bounded experiment, not a continuously running scanner. Archive stops at 100 recordings with no automatic deletion. Scans and recordings each allow ten starts per UTC day, two minutes apart; failed starts count. These are usage bounds, not a dollar spending cap.

No Firecrawl, CoinGecko, wallet calls or Global API key are used by this workflow. It uses the existing browser and Workers AI bindings. Existing minute-based paper trading and the separate trade-data replay lab remain independent. There is no validated live-trading strategy, automated wallet execution, or claim of a safe exit.

Dependency note: npm audit reports three related high-severity findings in Cloudflare Puppeteer's transitive browser-download ZIP extraction dependencies. This Worker uses Cloudflare-hosted Chromium and does not download/extract browser archives. Do not use this package's local browser installer on untrusted archives; monitor upstream for a patched dependency chain.

Validation (2026-09-26): 30 automated tests cover engine behavior, malformed AI output, price units, delayed proxy execution, gaps, UI cooldown reuse, empty/error results, stale scans and escaped external text. Typecheck and deployment dry-run pass. An isolated local Worker using real remote Browser Run/Workers AI bindings was exercised through the in-app browser: sign-in, 37-candidate scan, repeat scan during cooldown, automatic selection-to-recording, full reload and saved-report reopening, and authenticated evidence download. That local run persisted 116 frames over 60 seconds (519ms mean interval, 1599ms maximum), 116 numeric prices and six valid vision responses. All five independent paper scenarios lost money. This verifies the workflow only; extraction accuracy, costs and predictive performance need continuing research. Production credentials were not changed and no test password is deployed.

Fresh-launch follow-up: New-only automatic discovery was also tested locally against the real site before deployment. Kimi selected a token 16 seconds old at scan; its chart recording began at 36.8 seconds old. Twenty frames averaged 502ms with two valid vision responses. The loading/selection delay is material and may miss the earliest move; no claim of observing a launch from time zero. The age gate has boundary, unknown-time, future-time and wrong-cohort tests (31 tests total).
