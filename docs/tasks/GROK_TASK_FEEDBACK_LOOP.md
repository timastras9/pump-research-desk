# Grok task: feedback loop (Astra design, section 4)

**Owner:** Grok 4.7 · **Reviewer:** Claude · **Approved by:** Tim (Astra design, 2026-09-26)
**Estimated time:** 2–3 hours

Claude is building the BUY and SELL models in `research/train.py` at the same time. This task is the third piece of
Astra's design, the **feedback loop**. It is self-contained: new files only, so the two streams cannot collide.

Read first (10 min): `data-analysis/ASTRA_SYSTEM_DESIGN.md` sections **4. Feedback loop** and **Caveats**, then
`research/engine.py`.

---

## 0. Setup

```sh
cd /Users/tim/Documents/ChatGPT/pump.fun
git fetch origin
git worktree add .claude/worktrees/grok-feedback -b grok/feedback-loop origin/worktree-deploy-10min-studies
cd .claude/worktrees/grok-feedback
PY=/Users/tim/.claude/jobs/830a297a/tmp/tsfm-venv/bin/python   # has numpy, torch, sklearn
$PY -m unittest research/test_engine.py                        # must print OK (7 tests) before you start
```

Corpus (read-only, never write to it): `/Users/tim/Documents/ChatGPT/pump.fun/artifacts/corpus/launches.db`

## 1. File boundaries

| You may create | Do not edit |
|---|---|
| `research/feedback.py` | `research/engine.py`, `research/train.py` (Claude is editing) |
| `research/test_feedback.py` | anything in `src/`, `public/`, `scripts/` |
| `research/registry.py` | the corpus database |
| `research/test_registry.py` | |
| `scripts/promotion_gate.py` | |

If you need something from `engine.py` changed, write it under **Requests for Claude** in your final report. Do not
change it yourself.

## 2. Fixed facts you must use (from `research/engine.py`)

- `E.load_episodes(db, min_traded=20)` returns `Episode(mint, name, created, creator, tags, price, volume, trades, anomaly, has_trades)`.
  `price` is 1 s closes, length `E.WINDOW_S + 1` (721). Skip `ep.anomaly`.
- `E.buy_decision_time(ep)` returns decision second `d` or `None` (skip). Entry fills at `e = d + E.LATENCY_S` (2 s).
- `E.simulate(ep, sell_policy, decision_t=d)` returns `Trade` with `entry_t`, `entry_price`, and
  `fills = [(decision_t, fill_t, fraction, price), ...]`. `trade.net_return_pct()` is the ONE accounting formula. Never
  write your own P&L formula.
- `E.rules_v3()` is the current production seller. `E.summarize(returns)` gives bootstrap CI and drawdown.
- Costs: `E.COST_PER_SIDE = 0.0325` per side. Round-trip breakeven is about +6.72%.
- Horizon: forced exit at `min(E.WINDOW_S, e + E.HOLD_S)`.

## 3. Deliverable A: mistake labels (`research/feedback.py`)

```python
def label_trade(ep, decision_t, bought: bool, trade=None, seller=None) -> dict
def label_corpus(db_path, buy_gate, seller, out_db) -> dict   # returns counts per label
```

`buy_gate(ep, d) -> bool` decides buys. `seller` is a sell policy (default `E.rules_v3()`).

**Feasible opportunity** (reuse this exact definition everywhere): among decision seconds `s` in `e+1 .. end`, the best
delayed fill `price[min(s + LATENCY_S, end)]` gives a net return > +0.5% using the engine's formula (simulate a single
sell-all at `s`).

**BUY labels** (exactly one per candidate):

| label | condition |
|---|---|
| `bought_no_opportunity` | bought, no feasible opportunity |
| `bought_opportunity` | bought, a feasible opportunity existed |
| `skipped_policy_profitable` | skipped, and `simulate(ep, seller, d).net_return_pct() > 0` |
| `skipped_feasible_opportunity` | skipped, feasible opportunity existed, but the seller would not have profited |
| `correct_skip` | skipped, no feasible opportunity |

**SELL labels** (bought trades only; a trade can have several; `pp` = percentage points of gross return vs entry):

| label | condition |
|---|---|
| `premature_exit` | a feasible delayed fill AFTER the last sell decision is ≥ 10 pp above the realized quantity-weighted exit price |
| `giveback` | a feasible delayed fill BEFORE the first sell decision is ≥ 10 pp above the realized quantity-weighted exit price |
| `bad_partial_sizing` | trade has a partial fill, and selling 100% at that first partial decision beats realized net by ≥ 5 pp |
| `excessive_turnover` | more than 3 fills |
| `deadline_breach` | the final fill is the forced liquidation at the horizon |
| `failed_liquidation` | any fill price ≤ 1% of entry price (treat as unsellable) |
| `good_exit` | none of the above and net > 0 |

**Loser reason** for bought trades with no feasible opportunity. Copy the exact order and thresholds from
`scripts/export_label_review.py` lines 42–48: `dead_after_entry`, `bought_the_spike`, `dropped_immediately`,
`never_above_entry`, `spike_shorter_than_delay`, `rose_too_little`.

**Output:** a `mistakes` table in `out_db` (a NEW SQLite file, e.g. `artifacts/corpus/feedback.db`):

```
mistakes(mint, created, decision_t, bought, buy_label, sell_labels_json, loser_reason,
         net_pct, realized_exit_gross_pct, best_feasible_gross_pct, regret_pp,
         policy_version, labeler_version, labeled_at)
```

`regret_pp = best_feasible_gross_pct - realized_exit_gross_pct` (0 for skips). `labeler_version = "feedback-v1"`.
Also keep a `runs` table: `(run_id, policy_version, labeler_version, db_sha256_of_mint_list, n, counts_json, created_at)`.

**Rules from Astra (non-negotiable):**
- Deterministic evidence only. No LLM calls in this code. LLM reviews may suggest hypotheses later but never write labels.
- Never overwrite old rows. A relabel is a new `run_id`.
- Skipped launches get shadow outcomes, clearly marked `bought=0`. Never present them as real trades.

## 4. Deliverable B: model bundle registry (`research/registry.py`)

Astra: "Keep an immutable last-approved bundle of feature code, BUY model, SELL policy, thresholds, execution
configuration and label/replay versions."

```python
def save_bundle(root, files: dict[str, str], meta: dict) -> str   # returns bundle_id (sha256[:16] of contents+meta)
def load_bundle(root, bundle_id) -> dict
def approve(root, bundle_id, approver: str) -> None                # writes root/APPROVED (append-only history in root/approvals.jsonl)
def approved(root) -> str | None
def rollback(root, approver: str) -> str                           # re-points APPROVED to the previous approved bundle
```

- A bundle is a directory `root/<bundle_id>/` holding copies of the files plus `meta.json` with: git commit, dirty
  flag, `engine.LATENCY_S`, `COST_PER_SIDE`, `HOLD_S`, feature list, thresholds, `labeler_version`, created_at, and a
  sha256 per file.
- Saving the same contents twice returns the same id and writes nothing.
- A bundle directory is never modified after creation. `load_bundle` verifies every sha256 and raises if a file changed.
- `approve` requires a non-empty approver name. Only Tim approves in practice; the code just records the name.

## 5. Deliverable C: promotion gate (`scripts/promotion_gate.py`)

The approved gate (Tim, 2026-09-26):

- at least **200 paper trades** spanning at least **3 distinct UTC days**
- **max drawdown ≥ -$4** and **worst UTC day ≥ -$3**, at **$2 per position**
- the **lower bound of the 95% bootstrap CI of profit per trade** for the challenger is **above the champion's mean**
  profit per trade on the same period
- bootstrap by **UTC day block** (resample whole days), not individual trades, with 2,000 resamples and a fixed seed

Input: a CSV or JSON of paper trades `(closed_at_iso, strategy, net_pct)` plus `--challenger` and `--champion` names.
Output: JSON `{passed: bool, checks: [{name, value, threshold, passed}], ...}` and exit code 0 (pass) / 1 (fail).
It must never promote anything by itself. It only reports.

## 6. Tests (must pass)

`research/test_feedback.py`, synthetic episodes built like `ep_from()` in `research/test_engine.py`:

1. Flat price: bought gives `bought_no_opportunity` + `dead_after_entry`. Skipped gives `correct_skip`.
2. Price rises +50% at 20 s and stays: skipped gives `skipped_policy_profitable` under `rules_v3`.
3. Spike +40% for exactly 1 s: `bought_no_opportunity` + `spike_shorter_than_delay` (the 2 s delay misses it).
4. A seller that sells all at +10% while the price later reaches +80%: `premature_exit`.
5. A seller that holds from +100% down to +5%: `giveback`.
6. A hold-forever seller: `deadline_breach`.
7. `net_pct` equals `simulate(...).net_return_pct()` exactly.
8. Running `label_corpus` twice creates two runs and never changes rows of the first.

`research/test_registry.py`: same contents give the same id; a tampered file raises on load; approve → approve →
rollback returns the first; an empty approver raises.

Promotion gate: a test with 250 synthetic trades over 4 days that passes, and one each failing on count, days,
drawdown, daily loss and CI.

```sh
$PY -m unittest research/test_engine.py research/test_feedback.py research/test_registry.py
```

## 7. Real run (after tests pass)

```sh
$PY -c "from research import feedback as F, engine as E; print(F.label_corpus('/Users/tim/Documents/ChatGPT/pump.fun/artifacts/corpus/launches.db', lambda ep,d: True, E.rules_v3(), '/Users/tim/Documents/ChatGPT/pump.fun/artifacts/corpus/feedback.db'))"
```

Sanity check before reporting: the share of `bought_no_opportunity` should be near the loser share in
`data-analysis/exit_labels_v4.csv` (about 36%). If it differs by more than 5 points, find out why before reporting.

## 8. Finish

1. `git add` only the files in section 1. Commit message: `Feedback loop: mistake labels, model registry, promotion gate (Astra §4)`.
2. `git push -u origin grok/feedback-loop` (GitHub account `timastras9`: `gh auth switch --user timastras9` first,
   then switch back).
3. Final report in `docs/tasks/GROK_REPORT_FEEDBACK_LOOP.md`:
   - label counts from the real run
   - the loser-share sanity check result
   - test output (last 3 lines)
   - **Requests for Claude** (engine changes you needed but did not make)
   - anything you were unsure about, stated plainly

Out of scope (don't build): Worker/TypeScript logging, drift monitoring, retraining, any LLM calls, live trading.
