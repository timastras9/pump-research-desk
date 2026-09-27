# Continue the pump.fun research build

Workspace: `/Users/tim/Documents/ChatGPT/pump.fun`.
User wants you to CONTINUE IMPLEMENTATION and testing, not just propose an architecture. Read this file, inspect current git diff and any applicable AGENTS.md, then act. Do not discard uncommitted work. User authorized parallel agents, Cloudflare deployment after testing, and research collection. No live trading or wallet transfers.

## Current live validation: do not interrupt
At 2026-09-26 07:12:21 UTC (03:12:21 America/Detroit), campaign `66b6d72a-e91c-4cd8-8d73-415340e23eea` was still running locally with THREE independent browser/recorder jobs, 751/751/771 frames and zero failures. Their fixed ten-minute windows end about **07:14:26 UTC / 03:14:26 EDT**, followed by final Kimi analysis and collective analysis. This is a validation pilot, not the requested larger production batch.

Local Worker: http://localhost:8790/studies.html. Running command:
`npx wrangler dev --config artifacts/wrangler-scaled.json --persist-to artifacts/scaled-state --port 8790 --inspector-port 9231`
Codex exec session was 60292; Claude may not share its terminal handle. Check port/process before launching another server. **Port8791 belongs to an unrelated user project; do not terminate it.**

**Do not edit imported src files or public assets until the current test finishes:** Wrangler hot reload interrupts real browser runs. Read-only status:
`node artifacts/study-check.mjs`
Do NOT use its `restart` option. It uses local test authentication internally and prints no credentials. `artifacts/study-progress.json` contains a recent snapshot; fetch fresh status. Current chunks can show 'Chunk in progress or interrupted' while actively writing; that alone is not a failure.

Test tokens:
- FUfdxNQMzsoVYDTtkWAXGZNMCwTJu9GBQ875wKkBpump
- CwygXurf36Wn3zTZ5DHpgVD5E7MF4RGANxSAxKTspump
- 4d42D2q6xoMDNtUL9xLkchjX4Qa3Rg1hvwAEfL1Dbk8G

Verify all finish, saved frame coverage/gaps, final per-token and group Kimi outputs, browser session release, and costs. Prior interrupted pilots remain preserved; don't present those as full ten-minute successes. Current pilot coverage was approximately77–80%, all extracted prices valid, no recorder failures; exact final metrics need verification.

## Product requirements
- Scan pump.fun Explore New during 30-minute admission window; each admitted token gets its own browser and independent 10-minute observation. Keep full window even after a rise.
- Default UI100 token total cap and20 concurrent, configurable1–50; actual account browser capacity measured200. Capacity checks reserve a scanner. Explore is sampled (20rows/scan), so cannot promise every market launch. Report misses/capacity skips honestly.
- Target500ms screenshots, actual timing/gaps recorded. Reuse persistent browser/page between15sec chunks; otherwise reload overhead was too large.
- Kimi WorkersAI screenshot analysis max1/chunk, structured token summaries every2min and final, collective summary after batch.
- D1 `crypto-study`, R2 `crypto-study-media`, authenticated screenshot replay. No encoded video yet; screenshot slider is implemented.
- Dashboard shows live previews, heartbeat/capture ages, errors/stalls, individual/group metrics and reversible exclusions. Keep losers/outliers; exclusion requires reason and original results remain available.
- Early60/120sec features must use only evidence available by cutoff. Compare later outcomes separately, no look-ahead or guaranteed profitability.
- Latest addition: **public token chat sentiment, repeated words and their association with subsequent price movement**, to inform future hypotheses. Distinguish association from causal triggers; account for spam, dependent samples, sarcasm and missing data. No trading implementation requested in this step.

## Already implemented, uncommitted
- src/study-collector.ts: StudyCoordinator discovery DurableObject + independent StudyRecorder pertoken; alarms, fixed windows, incremental D1 manifests and R2images, stops, capacity checks, analysis/cost accounting.
- src/observer.ts: session reconnect/reuse; acquisition-only20s timeout (DO NOT put AbortSignal on WebSocket upgrade; it kills session), persistent exact token page, deadline/stop checks, measured usage.
- src/study-analysis.ts: deterministic metrics, structured validated Kimi JSON, group all/included summaries, usage estimates.
- src/study-features.ts: early60/120 and separate later outcomes.
- src/worker.ts: authenticated /api/studies routes and media streaming; exports both newDOclasses.
- public/studies.html/js/css and observer link.
- wrangler.jsonc: new bindings, v2 migration for both newDOclasses, D1/R2 bindings. worker-configuration.d.ts generated.
- migrations/0001_crypto_study.sql: remote schema ALREADY applied successfully, no production study data yet.
- README updated background study docs.
- Tests:62 passed before latest chat standalone work; typecheck passed; prior drybuild passed. Need rerun after integration.

## Pending prepared patches / chat integration
**Drafts were deliberately not applied to avoid hot reload. Inspect each before applying after pilot completes.**
1. `artifacts/analysis-features.patch`: compact matched early/later per-token table for collective Kimi (up to100rows, <24kchars), optional earlyWindows/laterOutcomes for compactStudyInput. `artifacts/study-analysis-features.test.ts` has3passing draft tests; promote with import changed to `../src/study-analysis`. Collector must pass earlyWindows:t.earlyWindows,laterOutcomes:t.laterOutcomes to compactStudyInput. Interim analysis omits future outcome inputs.
2. `artifacts/chat-capture.patch`: observer optional captureChat, public token-specific Callouts snapshots every5seconds,max30maincomments,1000chars each; incremental chunk persistence; includes new test/chat-reader.test.mjs. Draft tests4passed, git apply --check passed. No extraAIcallpercomment.
3. `src/study-chat.ts` and `test/study-chat.test.ts`: standalone not yet imported. Dedup first-observed comments, bounded300, explicit unavailable/empty, heuristic sentiment, repeated words, early60/120 and full600 summaries (inspect latest types), wordMovementAssociations: prior price <=5s old and subsequent price30s later within5s. Counts are NOT independent observations or calibrated probabilities. Latest agent refinement uses text+valid publishedAt fallback identity to preserve repeated phrases at different posting times. Verify tests.
4. `artifacts/chat-ui.patch`: dashboard draft from agent, inspect availability/completion before applying. Designed for token.chatSummary, token.chatWindows, token.chatAssociations. Agent is finishing it during handoff; verify actual files.

Collector integration still needed: reconstruct chatstate from chunks' chatSnapshots chronologically during analyzeToken; map each snapshot to ingestChat({mint, observedAt:s.capturedAt, availability:s.status, comments:s.messages.map(m=>({text:m.text,publishedAt:m.publishedAt?Date.parse(m.publishedAt):null}))}). Persist chatSummary,chatWindows,chatAssociations on token. Send bounded compact summaries to existing Kimi input (no full unbounded histories); collective input needs chat feature/outcome comparisons too. Keep total payload<24000chars and update tests. Do not silently label absent historical chat as neutral.

### Grounded actual pump.fun DOM
Public token page has role=tab exacttext `Callouts`; click once on newpage, restore chart position after click. Panel `[data-testid="coin-callouts-feed-panel"]`, inside `ul[aria-label="Callouts for this coin"]`, main `article[data-testid="coin-callouts-feed-card"]`, first `p[data-testid="callout-note"]`, first `time[datetime]` ISO timestamp. Only main comment extracted; do not mix nested replies with main timestamp. Do not collect portfolio amounts or usernames.
**General sidebar 'Latest callouts across the site' contains unrelated tokens; exclude it.** Token-specific panel is public, no login needed in observed example. Validate click doesn't leave screenshot viewport scrolled to comments (window.scrollTo may not cover internal scrolling). Missing chat should not break price recording.

## Validation, deployment and start
After fullpilot ends, apply/review patches and integrate chat. Run `npm test`, `npm run check`, `npm run build` (Wrangler dry run). Exercise chat capture against actual public token Callouts and verify stored evidence, timestamps, chart screenshot unchanged, dashboard escaping. Existing auth, Origin/CSRF checks, media authentication and exclusions were tested; don't regress them. No need to rerun unrelated tests indefinitely once green; changes to recorder lifetime warrant fullwindow validation.

Production currently has OLD60second observer; NEWSTUDIES NOT DEPLOYED as of handoff. Once validated deploy using current Wrangler login/bindings; don't retrieve global key unnecessarily. Production https://pump-research-desk.timastras9.workers.dev. Newdashboard /studies.html. D1 UUID4228f1ee-1769-49c0-bf11-962ecbd3ae34; R2crypto-study-media; account0fc41c21a6be19f1c763c87e03a4ae0b. Migrationv2 new_sqlite_classes StudyCoordinator,StudyRecorder not yet deployed; v1ResearchDesk retained.

Start authorized larger campaign maxTokens100,concurrency20 after verifying deploy;30min admission, tenminute observations. User wants collection running, not another plan. Report actual startID/times and live dashboard. `STUDY_ORIGIN=https://pump-research-desk.timastras9.workers.dev node artifacts/study-check.mjs` is read-only status with existing local productionsecret. To start, use existing authenticated API POST/api/studies/start with options; inspect script for authentication without printing secrets. Preserve production credentials; **never deploy local test password**.

## Costs and limits
Kimi list rates$.95/Minput,$4/Moutput; browser$.09/hour beforeaccountallowances. Estimator excludes R2/D1, plan fees, concurrency charges and allowances. Browser paidplan10hoursincluded,10concurrencyincluded then$2/additionalmonthlyaverage dailymaximum (verify currentdocs if quoting). Give measured pilot subtotal and pertoken, not an invented finalinvoice. Current token AIusage around$.03 at7min; final stillpending. Failed/unknownusage flagged, not counted aszero. No guarantee ofprofitabletrading; displayedprices aren't executablequotes. Userfuturelivebudget$11, currently noorders/funding.

## Secrets/git
Do not display/read secret values into logs; .secrets/, .dev.vars*, artifacts/, .wrangler/ ignored. Production auth file .secrets/dashboard-access.txt alreadyused by script. No need wallet/Google/passkey credentials for research. Private repo https://github.com/timastras9/pump-research-desk main; latestpriorcommit8b7973e; currentchangesnotcommitted/pushed. Commit only intended source/docs/tests, neversecrets/artifacts. Existing authenticated push method uses gh accounttimastras9. Don'tdiscard user'schanges.

Communicate concise progress. Ask only truly missing requirements. Finish the concrete implementation and show verified results; don't claim pending code is deployed or pilot is production.
