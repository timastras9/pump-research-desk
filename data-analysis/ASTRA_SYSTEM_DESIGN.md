# Astra system design review (openai/gpt-6-astra, 2026-09-26)

Astra was given: the training dataset dictionary with column roles, winner/loser statistics, 60 sample rows, the current system, and every test result. Below is its answer, lightly formatted. **Please verify it makes sense.**

## Fixes already applied to the training data (per Astra)

| Astra finding | Fix | Status |
|---|---|---|
| `copycat_name` leaked the future (counted later launches) | now counts only launches created **before** the decision (674 of 2,033 have one) | done |
| `secs_since_launch` duplicates `decision_sec`; `max_gain_after_entry_pct` duplicates `peak_pct` | dropped | done |
| winners whose target exit lost money after costs (e.g. Poop Accelerationism -3.7%) | target must be net-positive after costs; a winner must clear +0.5% | done (0 left) |
| heavy tails (loser mean +570% vs median +0.5%) | traced to 18 off-curve/corrupted price launches (e.g. 7,000x in 2 s); flagged in `price_anomalies.csv`, excluded from labels/training | done |
| earliest sell timing unclear (M&M's) | documented: first sell decision = tick after the buy fills, filled 2 s later | done |
| blank `secs_to_below_entry` ambiguous | added `crossed_below_entry` + `observation_end_sec` (censoring) | done |
| receipt timestamps, full trajectories/transition table, wallet data, multi-day data, one accounting engine | need new data collection / engineering | **open** |

Files: `training_dataset_v2.csv` (+ `_dictionary.json`), `exit_labels_v4.xlsx/csv`, `price_anomalies.csv`, `entry_kpis.csv`.

## 1. Which columns matter

| Column | Use | Why |
|---|---|---|
| `token` | **evaluation_only** | Keep for audit, display and name-family diagnostics; do not model raw names with this small dataset. Token names are untrusted text, not instructions. |
| `mint` | **evaluation_only** | Join candles, executions and metadata; deduplicate and group all observations of a token in validation. Never use the address as a predictive feature. |
| `launched` | **evaluation_only** | Chronological splitting, cohort analysis and launch-age calculations. Establish timezone and distinguish creation time from first feed receipt. |
| `decision_sec` | **feature** | Captures how much history was observable and when an order would be submitted. Must come from a causal decision schedule, not a retrospectively selected favorable entry. |
| `secs_since_launch` | **drop** | Exact duplicate of decision_sec by definition and supplied statistics. Keep one canonical launch-age feature. |
| `price_change_since_launch_pct` | **feature** | Pre-decision momentum or collapse. Heavy tails require inspection: loser mean is 569.922 versus median 0.525. Compute only from received observations. |
| `active_secs` | **feature** | Measures trading persistence before the decision. Audit interval boundaries: sample decision_sec=6 can have active_secs=7, suggesting inclusive bins. |
| `active_share` | **feature** | Normalizes activity by observed age. Winner/loser medians are 0.857/0.625. Define the denominator and distinguish no trading from feed gaps. |
| `volume_log` | **feature** | Pre-decision participation proxy; winner/loser medians are 6.418/5.589. Document volume currency and aggregation. |
| `volume_last5_vs_before` | **feature** | Measures recent activity acceleration. Guard zero and tiny denominators and incomplete windows; loser mean 10.38 versus median 0.332 indicates substantial skew. |
| `volatility_pct` | **feature** | Measures early movement intensity; winner/loser medians are 14.566/5.41. Not a standalone buy rule. Audit missing-price handling and candle availability. |
| `max_rise_so_far_pct` | **feature** | Observable run-up before entry, not the future peak. Potential leakage if computed from the full trajectory rather than a decision-time prefix. |
| `drop_from_high_pct` | **feature** | Observable drawdown from the pre-decision high. Winner/loser medians are -10.469/-1.968, so a universal rule rejecting drawdowns is unsupported. |
| `first_move_up` | **feature** | Early directional indicator if the first move has actually been observed. Preserve missingness rather than treating an unknown move as down. |
| `fee_routed` | **feature** | Launch metadata potentially associated with behavior. Use only the version known at decision time; later metadata enrichment would leak. |
| `mayhem` | **feature** | Known launch regime; class means are 0.414 for winners and 0.229 for losers. Validate regime stability rather than assuming causality. |
| `terminal` | **feature** | Potential launch-source context if observable in real time. Means 0.295/0.284 suggest little marginal separation, but assess incremental out-of-time value. |
| `copycat_name` | **drop** | Current definition uses another launch anywhere in the dataset and can reveal future launches. Replace with an as-of-decision prior-name count or flag before admitting it as a feature. |
| `name_len` | **feature** | Cheap pre-decision metadata, probably weak: both class medians are 9. Fix whitespace and Unicode conventions and retain only if ablation supports it. |
| `label_buy` | **label** | Initial BUY opportunity target: a positive delayed, cost-adjusted exit existed. It is hindsight supervision, never an input, and does not mean a deployable sell policy earned money. |
| `target_exit_sec` | **label** | Hindsight sell-timing supervision, not state. Confirm whether this is submission time; samples suggest the exit fills later. Winner-only missingness directly reveals the class if exposed as input. |
| `target_exit_pct` | **label** | Auxiliary hindsight target for gross exit return and demonstration auditing. Never a state feature or direct reward. Being within 10 percentage points of peak does not imply net profitability. |
| `entry_fill_sec` | **evaluation_only** | Audit buy latency and initialize replay. Future information at BUY time; after confirmed entry, derive a separate causal time-since-entry SELL state. |
| `decision_price` | **evaluation_only** | Reference for execution and label audits under the supplied role. A separately timestamped observable quote can support causal features, but this spreadsheet reference is not evidence of executability. |
| `entry_price` | **evaluation_only** | Cost basis and replay initialization. Leaks the future buy fill if used for BUY; the confirmed live cost basis is legitimate SELL state after entry. |
| `entry_slippage_pct` | **evaluation_only** | Realized outcome of the buy delay, unavailable to BUY. Use for execution diagnostics; a separately trained pre-decision slippage forecast could later be an input. |
| `peak_sec` | **evaluation_only** | Future peak timing for hindsight diagnostics only. Feeding it to either policy would leak. |
| `peak_pct` | **evaluation_only** | Gross hindsight peak benchmark. Not necessarily reachable with a 2 s delay, costs and size; never a policy input. |
| `best_fill_sec` | **evaluation_only** | Oracle delayed-execution benchmark and timing audit. Future information, not an action schedule available live. |
| `best_pnl_pct` | **evaluation_only** | Oracle net opportunity benchmark and label consistency check. Do not use as realized strategy performance or assign it as reward to a chosen action. |
| `target_exit_pnl_pct` | **evaluation_only** | Audit the net value of the hindsight target. Can filter bad demonstrations, but cannot substitute for action-specific rewards; some supplied winner targets lose money. |
| `min_loss_pct` | **evaluation_only** | Least-bad hindsight exit for losers, not a guaranteed loss cap. Class-dependent missingness leaks label_buy. |
| `max_gain_after_entry_pct` | **drop** | Apparently duplicates peak_pct in supplied statistics and samples. Verify equivalence, then retain only peak_pct for evaluation; both leak future outcomes. |
| `secs_to_below_entry` | **evaluation_only** | Future path diagnostic for adverse movement. Missing values require censoring semantics; neither values nor missingness belong in decision features. |
| `loser_reason` | **evaluation_only** | Post-outcome error taxonomy for slicing results. Reasons and their missingness leak the outcome; they are not proven causal explanations. |
| `result` | **evaluation_only** | Outcome category, including winner-latency-gap, for auditing label logic. Direct target leakage as a feature. |
| `latency_s` | **evaluation_only** | Execution assumption and replay parameter; mean and median are 2 in both classes. Not useful as a constant predictor. Future realized latency must not enter BUY; an observable latency estimate can enter future states. |

## 2. Buy / skip prediction model

### Inputs
- Use only columns marked feature, with strict event-time and receipt-time cutoffs. Exclude all labels, evaluation fields and class-dependent missingness.
- Fit imputation, robust transformations and any clipping on training folds only. Add causal missing-window indicators; inspect extreme values before clipping legitimate price jumps.
- Add the repaired prior-name feature only after an as-of join audit. Later add contemporaneous liquidity, spread or executable quote, feed age, and estimated execution latency.

### Target
- Start with audited label_buy on all 2,050 rows: 1,299 winners and 751 losers. Explicitly call it opportunity classification, not realized-profit classification.
- Define a fixed observation horizon, feasible earliest sell time, trade size, costs and both delays when regenerating the target.
- For deployment, also estimate net return or profitability under a frozen causal SELL policy. Generate these targets through nested chronological training so the seller never learned from its target-validation episodes.

### Model
- Baseline: regularized logistic regression. Challenger: shallow, strongly regularized gradient-boosted trees with early stopping and a small hyperparameter search.
- Calibrate probabilities on a separate chronological calibration block. With this dataset size, prefer simple sigmoid calibration over a highly flexible calibrator.
- Do not build a large neural model or derive hard thresholds from class means. Test metadata and redundant activity features by ablation.

### Decision Time
- Reproduce the existing causal entry scheduler first; the spreadsheet median decision time is 6 s in both classes, not exactly the nominal 5 s.
- Live launches arrive 3–8 s after creation. Decide only after actual receipt and sufficient available history; do not backdate a decision to 5 s for a launch first seen at 8 s.
- Submit the buy at decision time and simulate its fill 2 s later. A later decision schedule requires newly reconstructed snapshots and labels, not reuse of the original row.
- Do not delay all entries just to obtain a better classifier: reported loser shares rise from 0.366 at 5 s to 0.577 at 60 s, and later AUC is a different decision problem.

### Validation
- Use expanding-window chronological train, calibration/threshold-validation and final test blocks. Group by mint and keep entire price trajectories together.
- Purge training episodes whose outcome windows overlap validation or test periods. Fit every preprocessing and label-dependent selection step inside training.
- Add creator/name-family holdout diagnostics once those identifiers are available. A one-day dataset cannot establish cross-day generalization; collect multiple market days before promotion.
- Compare buy-all plus the same SELL policy, skip-all, current filter plus that seller, and the challenger plus that seller. Separately evaluate replacement sellers with BUY held fixed.
- Report precision-recall, calibration, winner retention, loser rejection, trade coverage, net P&L per candidate and per executed trade, total capital-constrained P&L, drawdown and tail losses. Bootstrap by time block or episode, not individual candle.

### Threshold
- Choose on validation using realized replay net utility under the fixed seller, with drawdown, capacity and minimum-coverage constraints. Do not default to 0.5 or optimize accuracy.
- Where calibrated conditional return estimates are reliable, buy only when predicted net expected value exceeds a safety margin; otherwise use a small threshold grid and uncertainty-aware selection.
- The supplied filter changes losers from 259 to 192 and keeps 344/356 winners, while average P&L rises 62.5% to 71.4% but total P&L points fall 38435 to 38249. This does not establish an improvement in total opportunity value, and the P&L definition must be audited.
- Account for lost upside: supplied simple rules discard winners worth 3–15 times the losses avoided. A higher precision filter can still be economically worse.

### Success Criteria
- Untouched chronological replay and subsequent paper trading show positive net return and a credible improvement over the current end-to-end policy, within predeclared risk limits.
- Require stable performance across time blocks and launch modes, useful coverage, calibrated probabilities and no dependence on a few extreme winners.
- Measure the near-peak objective using executable, delayed fills, but make net economic performance primary. Report uncertainty rather than claiming a guaranteed winner filter.


## 3. RL sell model

### State
- Build complete sequential episodes for winners and losers. The one-row-per-token spreadsheet is insufficient for RL; join the 1-second candles and collect executable market-state data.
- At each available decision tick include time since launch and confirmed entry, trailing returns/volume/volatility/activity, causal high-water mark and drawdown, current estimated net liquidation return, liquidity and feed freshness.
- Include confirmed entry cost, remaining inventory, cumulative realized cash, remaining cost basis, pending order quantity, submission time, expected execution time and observed fill status.
- Include observable execution conditions and launch mode. Never include eventual peak, target exit, future best P&L, loser reason or winner identity.

### Actions
- Use a small discrete set: HOLD, SELL 25%, SELL 50%, SELL 100% of currently available inventory. These are proposed action choices, not supplied statistics.
- Reserve inventory when an order is submitted. Initially allow only one pending sell order; mask invalid actions and disallow overselling, buying more or leverage.
- Actions submitted at t execute no earlier than t+2 s under the base simulator. Define whether the earliest action is at confirmed entry or the next tick, and use that rule consistently in labels and replay.

### Reward
- Use action-dependent net portfolio return, not hindsight peak proximity: terminal reward = (total net sell proceeds + conservative executable value of residual inventory - total entry cash outlay) / total entry cash outlay.
- An equivalent dense reward is the change in net equity divided by initial entry outlay, with consistent initial accounting so rewards telescope to the same terminal net return. Do not double-count realized gains or fees.
- Apply buy and sell fills after their respective 2 s delays. Include the supplied 1.25% fee plus 2% adverse slippage per side, and document the exact multiplicative convention. Separate delay-induced price movement from slippage to avoid charging the same effect twice.
- Charge each partial execution correctly, including fixed network or priority fees once collected. Model failed orders and insufficient liquidity; no-trade candles do not imply a guaranteed fill.
- At the holding deadline, submit a forced liquidation and include its delayed execution. Unfillable inventory needs a documented conservative recovery value rather than an optimistic last-trade mark.
- Keep any drawdown or inventory-duration penalty small, explicit and validation-tuned; always report unpenalized net P&L separately.

### Algorithm
- First reproduce current v3 rules and a simple supervised stopping-policy baseline in the same simulator. Do not deploy RL from the spreadsheet alone.
- For this small corpus, use regularized fitted Q-iteration with shallow tree regressors, a short state vector, discrete actions, bounded horizon and conservative action support. This also permits rechecking the earlier FQI attempt after label repairs.
- Counterfactual action transitions reconstructed from market paths are simulator-generated, not observed executions. Partial sells are valid only with an explicit size/impact model and a checked small-trader assumption.
- If collecting real behavior trajectories, log action probabilities and restrict learning to supported state-action regions; consider conservative offline Q-learning only after there is adequate coverage. A large online PPO experiment is not the first step.
- Thousands of candles from one token do not constitute thousands of independent episodes. Tune and estimate uncertainty at episode/time-block level.

### Use Of Labels
- Treat target_exit_sec and target_exit_pct as privileged, hindsight demonstrations for a small sell/hold imitation warm-start or auxiliary stopping target, never as live inputs.
- Confirm submission-versus-fill semantics. For TIRED CAT, target_exit_sec=30 and peak_sec=32 are consistent with a submission followed by a 2 s fill delay.
- Reject or repair demonstrations with negative net targets: Poop Accelerationism has label_buy=1, best_pnl_pct=3.9 but target_exit_pnl_pct=-3.7; Holdoween has best_pnl_pct=0.5 but target_exit_pnl_pct=-6.0.
- Regenerate feasible net-positive target windows where they exist; otherwise mark the positive-target demonstration unavailable. Do not invent an exit label or remove the episode.
- Train loss containment on all 751 loser episodes too. Winner-only exit labels would otherwise teach survivorship-biased holding.
- Do not reward matching an oracle timestamp. Multiple exit times may have similar net value, and the best timestamp may be unpredictable from available state.

### Safety
- Retain $2 paper sizing initially. Before live trading, predeclare absolute per-position, daily-loss, aggregate exposure and liquidity-participation limits.
- Start with the current -25% stop and 10-minute deadline as benchmark guardrails, then validate any changes. A stop is an order trigger, not a guaranteed fill or maximum realized loss.
- Enforce slippage limits, stale-feed checks, valid quotes, pending-order reconciliation and transaction idempotency. Halt new buys when latency or data quality breaches limits.
- Use a deterministic fallback seller and operational kill switch. Do not silently replace the policy for an open position without recording the handoff.

### Validation
- Use chronological episode holdouts with BUY selection generated out of sample. Evaluate on false-positive buys and loser positions, not just labeled winners.
- Compare against current v3: half sold at +30% within the first 60 s, remainder trailing -30%, stop -25%, 10-minute exit. Reproduce exact trigger and delay semantics.
- The reported fixed-rule result is -5.8% to -10% per trade across 1,989 launches when buying every launch near 5 s; no evidence here establishes a profitable sell policy.
- Report net P&L, median return, tail loss, drawdown, holding time, turnover, failed-fill rate and residual inventory, with block-level confidence intervals.
- Report quantity-weighted gross exit-return gap to peak in percentage points, share within 10 points, and net regret to the best feasible delayed exit under identical horizon, size and execution constraints. Show unexecutable raw peaks separately.
- Stress longer-than-2 s latency, higher costs, stale quotes, liquidity loss and price gaps. Simulator replay is not unbiased off-policy evaluation; propensity-based estimators also require behavior support absent from these spreadsheet rows.
- Require independent paper-trading confirmation before a capped live canary.


## 4. Feedback loop

### Log Per Trade
- Log every eligible candidate, including SKIPs, not only executed trades: mint, creation and receipt timestamps, eligibility decisions, exact feature snapshot, source freshness, model/schema versions, calibrated probability, threshold and rejection reason.
- Log the complete SELL state/action stream, allowed-action mask, policy and fallback versions, randomization probability if applicable, pending inventory, and overrides.
- Log order submission, acknowledgement and fill timestamps; quantities; reference quotes; actual prices; liquidity; fees; slippage; failed or retried transactions; and realized latency on both sides.
- Retain raw event references, full outcome trajectories through the common horizon, censoring status, portfolio exposure, realized net P&L and risk-limit events.
- Version labels, cost models, replay code and data cutoffs. Retain shadow outcomes for skipped launches without presenting simulated counterfactual fills as actual trades.

### Mistake Labels
- Separate opportunity classification errors from execution and SELL errors: bought no feasible opportunity, skipped a feasible opportunity, skipped a policy-profitable trade, and correctly skipped a policy-unprofitable opportunity.
- Add SELL categories: premature exit, delayed exit/giveback, bad partial sizing, excessive turnover/costs, failed liquidation and deadline breach. Define them against explicit feasible counterfactuals and tag uncertainty.
- Retain the supplied descriptive loser taxonomy: rose too little 437; dropped immediately 165; spike shorter than the 2 s sell delay 47; never traded above entry 49; bought the spike 53.
- Add infrastructure categories: late launch detection, stale feed, invalid snapshot, unexpected execution latency, slippage-model miss, label bug and policy override.
- Keep deterministic evidence and reviewer annotations separate. LLM reviews may propose hypotheses but must not directly change labels, thresholds or production rules.

### Retrain Cadence
- Run data-quality, execution and risk checks continuously; produce daily diagnostics after labels mature.
- Proposed small-team cadence: weekly batch challengers once enough new complete episodes and multiple days exist, with an earlier investigation after material drift. Retraining is not automatic promotion.
- Freeze datasets, splits and policies per experiment. Corrected labels require a versioned rebuild and replay, not silent edits.

### Promotion Gate
- Require leakage/schema tests, accounting reconciliation, chronological validation, stress tests and independent paper-trading results.
- Predeclare minimum evidence, trade coverage, drawdown limits and an uncertainty-aware improvement criterion before examining the gate data. Numerical limits require the team's risk budget; none is supplied.
- The current practice of auto-applying a rule because it wins on the unseen study uses that study for selection; it is then validation, not an untouched final test. Reserve later independent data and account for repeated challenger testing.
- Compare BUY and SELL changes separately, then test the combined system. Require approval and a limited canary before wider deployment.

### Rollback
- Keep an immutable last-approved bundle of feature code, BUY model, SELL policy, thresholds, execution configuration and label/replay versions.
- Automatically halt new buys on risk-limit breaches, severe feed failures or execution anomalies. Reconcile pending orders and manage open inventory with the approved fallback rather than blindly cancelling or resubmitting.
- Rollback on sustained performance or calibration degradation under predefined monitoring rules; preserve the incident and affected trades for diagnosis.

### Drift Monitoring
- Monitor feature distributions, missingness, launch-mode mix, receipt delay, activity/liquidity, prediction scores, acceptance rate and action-support coverage.
- Monitor delayed realized outcomes: policy return, winner/loser mix, calibration, loser reasons, missed opportunities and conditional results by regime and time block.
- Track predicted versus observed latency, slippage, fill probability and net costs, including tail behavior.
- Set alerts using a reference period with sufficient data and distinguish small-sample noise from persistent drift. One day is not a stable reference distribution.


## 5. Data fixes (Astra priority order)

- P0: Recover full trajectories and audit the label generator before RL. Document the observation horizon, first permitted SELL decision, submission-versus-fill timestamps, cost formula, missing quotes, migration handling and terminal valuation.
- P0: Replace the within-10-percentage-points-only exit labeling criterion with feasible net-aware target windows. Preserve the distinction between label_buy indicating an opportunity and the selected target actually making money; repair the negative target examples.
- P0: Audit earliest-sale timing. Several samples suggest a next-tick restriction beyond entry+2 s; for example, M&M's enters at 9 s, peaks at 11 s, but is called a latency-gap loser. Establish whether this follows a documented observation/decision rule or a labeling error.
- P0: Eliminate future-derived copycat_name and all target-dependent missingness from feature generation. Add automated tests that recomputing features on a truncated history gives identical values.
- P0: Reconstruct features using receipt timestamps, not just finalized candle timestamps. A candle labeled second 6 may not be fully known at a decision made during second 6.
- P0: Verify that decision timing itself is causal. Collect snapshots at fixed eligible ages and record the trigger policy; do not train a new 5 s decision policy from retrospectively selected 6–31 s snapshots.
- P1: Preserve numeric precision and typed nulls. decision_price and entry_price summaries report means and medians of 0 despite nonzero scientific-notation samples; distinguish display rounding from corrupted values. Document price units and token decimals.
- P1: Resolve active_secs/active_share boundaries, partial 5-second volume windows, tiny ratio denominators, no-trade candles and missing feed intervals. Keep valid outliers rather than removing them because they resemble mistakes.
- P1: Add observation-end timestamps and explicit event/censoring flags. secs_to_below_entry is present for 1,210 winners and 710 losers; blanks must distinguish never observed crossing, insufficient horizon and missing data.
- P1: Reconcile cohort membership across approximately 2,300 active launches, 2,050 spreadsheet rows, 1,989 exit-rule episodes and approximately 250 studied tokens. Record exclusion and study-selection reasons; do not treat curated screenshots/chat as a representative sample.
- P1: Collect all detected launches, including inactive, illiquid, failed, rug-like and skipped launches, across multiple days. Record complete eligibility funnels to expose active-launch and survivorship bias.
- P1: Collect raw trades and executable bonding-curve/pool reserves or quotes, size-dependent price impact, migration events, transaction costs, execution failures and actual latency distributions. One-second last prices alone cannot validate partial sells.
- P1: Collect buyer/seller wallet events, unique participant counts, buy/sell imbalance, holder concentration, creator-linked activity and creator history as-of each decision. The supplied corpus has no wallet data; do not claim these features already exist.
- P1: Build an episode table and a transition table containing state timestamp, action, quantity, pending orders, fill, reward, next state, termination versus truncation, and behavior-policy identity/probability.
- P2: Reproduce all reported P&L figures with a single accounting engine. Explain whether the 62.5% to 71.4% filter comparison uses oracle or executable policy exits; it is not comparable to the negative fixed-rule returns until definitions and cohorts match.

## Priorities (next steps)

- Freeze automatic rule promotion; version the current system and reproduce its execution accounting.
- Audit causal timestamps, target-exit profitability, earliest sell timing, cohort selection and copycat leakage; regenerate validated labels.
- Join complete winner and loser trajectories and implement a deterministic delayed-fill simulator with realistic costs and explicit failure/censoring rules.
- Train and calibrate simple BUY baselines; select thresholds using out-of-time end-to-end utility with SELL fixed.
- Benchmark current rules and a supervised stopping policy; only then test conservative, small-model fitted Q-iteration with partial sells.
- Instrument every candidate and order, collect multiple days plus liquidity and wallet data, and run independent shadow/paper evaluation.
- Promote only through an independent gate, followed by a capped canary with rollback and drift monitoring.

## Caveats

- No existing spreadsheet column supplies a valid action-dependent RL reward. Rewards must be reconstructed from delayed executions and costs.
- A hindsight positive opportunity is not a predictable winner, and an oracle exit is not a deployable seller.
- The supplied tanker@10s AUC of 0.88 and runner AUCs of 0.71 at 10 s, 0.75 at 20 s and 0.79 at 30 s concern different targets and timings; they do not establish 5 s BUY or SELL profitability.
- The data covers one day of active launches and only 2,050 labeled rows. Aggregate class statistics show associations, not validated decision boundaries or causal effects.
- The 2 s latency assumption, $2 paper sizing and fixed per-side costs need execution validation. Real latency, liquidity and fixed fees may materially change labels and returns.
- Selling within 10 percentage points of a raw peak can still lose after costs or be impossible after delay. Report that objective separately from feasible net profit.
- Suggested action fractions, algorithms and operating cadence are proposals, not measured results. No profitable model, safe live sizing limit or defensible numerical promotion threshold can be inferred from the supplied summaries alone.

## Implementation note

Per Tim: models are built in plain **Python + PyTorch** (no Hugging Face Transformers).