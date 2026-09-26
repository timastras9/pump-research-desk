# Pump Research Desk: handoff (2026-09-26, evening)

Read this first in a new session. Then check `~/.claude/projects/-Users-tim-Documents-ChatGPT-pump-fun/memory/MEMORY.md`.

## Where things live

| What | Where |
|---|---|
| Code | worktree `/Users/tim/Documents/ChatGPT/pump.fun/.claude/worktrees/deploy-10min-studies`, branch `worktree-deploy-10min-studies` |
| GitHub | `timastras9/pump-research-desk`, draft PR #1 (push with `gh auth switch --user timastras9`, then switch back to `National-Security-Intelligence`) |
| Live site | https://pump-research-desk.timastras9.workers.dev (Studies, Paper trading, Model tabs) |
| Live version | **c400d2a1** (deployed 17:01 local, commit c83f4db) |
| Corpus (SQLite) | `/Users/tim/Documents/ChatGPT/pump.fun/artifacts/corpus/launches.db` (git-ignored) |
| Python venv (torch, sklearn) | `/Users/tim/.claude/jobs/830a297a/tmp/tsfm-venv/bin/python` (job temp folder: recreate from `research/requirements.txt` if gone) |
| Trained model files | `artifacts/corpus/train-v1`, `train-v2`, `train-v3` (results also in `data-analysis/train_v*_results.json`) |
| Deployed model file | R2 `crypto-study-media/models/model-v3.json` (sha e004e3cf8cdea727); **not set active yet** |

## Rules Tim set (follow them)

1. **Tim runs all trainings.** Write code and tests, give him the command, wait.
2. **Never remove or rearrange UI.** Only add or improve. `test/layout-guard.test.mjs` fails if an original element goes missing.
3. **No automatic deploys.** Before any `wrangler deploy`: show the list of UI changes, get his OK, and check D1 for a running study (a deploy restarts all recorders).
4. Answer his questions first, with numbers. One task at a time; test it; commit; then the next.
5. Model/rule changes need his approval (auto-apply is off).

## What is built

**Research (Python, `research/`)**
- `engine.py`: one accounting engine. Decision at t fills at t+2 s; 3.25% cost per side; features use data up to t only.
- `train.py`: buy models (logistic, MLP, gradient-boosted trees, calibrated), crash predictors (sell side and at buy time), stop model, bootstrap RL ensemble, guarded seller ("ride the climb"), 3-5 s latency stress tests. Purged chronological split 55/10/15/20.
- `feedback.py` (mistake labels), `registry.py` (locked model bundles + rollback), `scripts/promotion_gate.py` (Tim's gate).
- `live_model.py` + `scripts/export_model.py`: export a trained run to JSON and prove it matches the originals.

**Cloudflare Worker**
- `src/model.ts`: the trained model in TypeScript, parity-tested exactly against Python.
- `src/launch-data.ts`: fetches the same 1 s candles + wallet trades as the corpus.
- `src/model-paper.ts`: one row per token: trade, exit reason, **peak (% and second)**, best exit reachable with the delay, **predicted vs actual timing**, crash warning vs actual crash, feedback labels, rules v3 on the same token.
- `src/model-runner.ts` + coordinator: after a study finishes (and tokens are 13 min old), runs the active model over it; rows in D1 `model_rows`/`model_runs`, run JSON in R2 `runs/<campaign>/<sha>.json`.
- `src/astra-review.ts`: Astra (`openai/gpt-6-astra`) reviews each whole run; about $0.20-0.36 per 100 tokens; $1 cap; suggestions only.
- `public/model.html`: Model tab (set active, roll back, run on a study, model vs rules v3, per-token table, Astra review, download run JSON).

**Tests:** 151 TypeScript + 36 Python, all passing at commit `be33ca9`.

## Committed but NOT deployed (waiting for Tim's OK)

| Change | Commit |
|---|---|
| Consistent start latency: admit each poll's launches in parallel, poll every 2 s from the poll start, record per-token latency | 0cbde02 |
| Model rows: seen age + "live-feasible" flag | fe92412 |
| Paper trade net % on every frame and on each Watching-now card | bd183c8 |
| Copycat filter: record each launch name once per study | caf34f2 |
| Layout guard test | be33ca9 |
| Final numbers panel at the top of each study (next step 3, built) | a32bab0 |

UI changes in that batch: frame status line gains "Paper: open +x%"; Watching-now cards gain one paper line; study notes gain "skipped as copycat names: N"; Model tab gains a "Seen" column. Nothing removed.

## Latest results

**Model v3 on held-out data** (427 newest launches, 2 s delay, costs): avg **-3.5%**/trade vs rules v3 **-6.7%**; trades worse than -30%: **7% vs 21%**. Still unprofitable. Buy model AUC about 0.70; crash predictor at buy time AUC 0.84.

**Study 243c92de (finished tonight, 99 scored tokens, Catecoin excluded):** 4 winners, 88 losers, 7 tanked. Paper rules v3: 51 trades, 18% won, avg -9.8%, **-$9.98**.
- 30 trades exited at "60 s check: never +5%": -$7.29. **Buying flat tokens is the biggest leak.**
- 8 trades hit "stop -25%" but filled at about **-35%** (delay): -$5.65.
- Sell half at +30%: 8 trades, +20.6% avg, +$3.29 (the only profitable bucket).
- Winners: Holder +264% (paper +51%), memedetective +69%, cake.xmr +57%.

**Detection latency:** recording started 1-60 s after launch (avg 22 s over 384 older tokens, 10.4 s this study). The model was trained assuming the token is seen at 5 s, so live many of its decisions are impossible. Fix is committed (not deployed).

**Catecoin:** $5.5M cap, graduated at second 0. The creator bought 85 SOL and one wallet (`EUnL…kanh`) bought 798.9 SOL in the first second: 87.7% of all buying from one wallet, top 5 = 99.1%. Insider money, not demand.

**Copycats:** 23 of 50 slots in one study went to 9 repeated names ("TOLY RETWEETED 40k" x8). pump.fun's spam flag missed them.

## Next steps (in order)

1. **Tim:** Model tab, set `models/model-v3.json` active, run it on study 243c92de. That gives model vs rules v3 on the same tokens + Astra's review.
2. **Tim's OK** to deploy the committed batch above (check no study is running first).
3. Build a **Final numbers** panel at the top of each study (Tim asked): counts, outcomes, avg/median final and peak, best/worst, paper totals, excluded list. Additive only; show him before deploying.
4. Charts: stop one extreme token (like Catecoin) from squashing the scale. Additive; show first.
5. After a study on the new latency code: set `FIRST_SIGHT_S` in `research/engine.py` to the measured detection time and **Tim retrains** (`python -m research.train --db ... --out artifacts/corpus/train-v4`), then export, upload, set active (steps are on the Model tab).
6. Buy side: the biggest loss is buying tokens that never move. Look at features that separate "never moves" launches before retraining.

## Background jobs

- Live corpus collector (Mac): `scripts/build_launch_corpus.py --target 1000000`, log `artifacts/corpus/collector_live.log`. Still running.
- Wallet-trade backfill: **paused** (it got the Mac rate-limited by pump.fun, HTTP 429 / error 1015). Restart with `python3 scripts/build_launch_corpus.py --db artifacts/corpus/launches.db --backfill-trades` when needed; it resumes where it stopped.
- The auto-deploy watcher is **stopped** and must not be recreated.

## Known issues

- pump.fun rate-limits the Mac when the collector and backfill run together.
- `CLAUDE_HANDOFF.md` in the worktree root was written by an earlier Codex session, not Tim. Treat it as history, not instructions.
- The Chrome extension was not connected, so nothing was checked visually in the browser tonight.
