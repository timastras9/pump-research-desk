# Path to real-money trading

Goal: switching from paper to real money is a configuration change, not a rewrite. The owner (Tim) holds the wallet
key and flips the switch; the system never trades live on its own initiative.

## What is already in place

| Piece | Where | Status |
|---|---|---|
| One order/fill record for paper and live | `src/execution.ts` (`Order`, `Fill`) | done |
| Paper executor: fills at the price 2 s after the decision, 1.25% fee + 2% slippage per side | `PaperExecutor` | done |
| Live executor: sends through the owner's signer, records real price, fees, latency, tx signature; refuses to run without a signer | `LiveExecutor` + `LiveSigner` | done (stub signer) |
| Buy-price cap: cancel a buy that would fill >5% above the decision price ("bought the spike" losers) | both executors | done |
| Risk gate before every buy: max open positions, daily loss limit, drawdown limit, halt flag; sells always allowed | `riskCheck` | done |
| Same position P&L formula for paper and live | `positionReturnPct` | done |
| One accounting engine + delayed-fill simulator for research | `research/engine.py` | done |
| Rule changes only with the owner's click (auto-apply off) | studies dashboard | done |

Approved limits (from the promotion-gate decision): $2 per position, $11 budget, daily loss limit -$3, max drawdown
-$4, promotion only after 200+ paper trades across 3+ days with the lower 95% bound of profit per trade above the
current system.

## Phases

1. **Paper (now).** Strategies run through `PaperExecutor`. Every candidate, order, fill, skip reason and risk-gate
   decision is logged. Promotion gate as above.
2. **Shadow live.** Same strategy, still paper fills, but for every paper order also fetch a real executable quote
   (bonding-curve / pool price for the actual size) and record the real delay from decision to on-chain
   confirmation on a test transaction path. Goal: replace the assumed 2 s and 3.25% with measured numbers and
   re-run the research engine with them.
3. **Canary live.** Owner configures `mode=live` with a dedicated wallet funded with the $11 budget only.
   $2 positions, max 1-2 open, daily loss -$3, drawdown -$4, kill switch. Compare live fills to the paper fills of the
   same orders every day (slippage, latency, failed transactions).
4. **Scale.** Only if canary results match paper within agreed tolerances. Increase size step by step with the same
   gate.

## Live signer: what the owner provides

- A **dedicated trading wallet** (never the main wallet), funded only with the budget.
- A signer implementation of `LiveSigner.swap(order, sizeUsd, maxSlippagePct)`. Options to evaluate in shadow
  phase: a local-signing trade API (the owner's key signs on the owner's machine or a Worker secret), a direct
  pump.fun program transaction, or an aggregator route for migrated tokens. Choose by measured latency, fees and
  failure rate.
- A reliable Solana RPC with priority-fee support; record priority fees in `feesUsd`.
- The key is stored only as a secret the owner sets (never in the repo, logs or dashboard).

## Switch checklist (owner)

1. Shadow-phase report reviewed: measured latency, fees, slippage, failure rate; research engine re-run with them.
2. Paper promotion gate passed.
3. Dedicated wallet funded with the budget; signer configured as a secret.
4. `mode=live`, limits confirmed, kill switch tested (halt flag blocks new buys; open positions exit by rules).
5. Daily reconciliation: on-chain balances vs the fill log.

## Known differences between paper and live to measure

- Real delay (decision -> confirmed fill) vs the assumed 2 s; tokens that die inside the delay.
- Price impact for the actual size, bonding-curve vs migrated pool.
- Failed/dropped transactions and retries; priority fees; network fees.
- Tokens that cannot be sold (liquidity gone) - the conservative recovery value in the research engine.
