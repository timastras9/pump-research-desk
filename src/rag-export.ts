// Indexed export of the study database (D1) into R2 for AI Search (RAG).
// Runs automatically when a study finishes and when a model run is saved; the Ask Astra tab can re-sync any study.
// Layout in the crypto-study-media bucket (point AI Search at the prefix `rag/`):
//   rag/index.json                          every study: date, status, token count, outcomes, paper totals, doc paths
//   rag/glossary.md                         what every field means and how the engine counts
//   rag/studies/<date>_<id>.json            one study: totals, outcomes, paper results, mistakes, model runs, excluded list
//   rag/tokens/<date>_<id>/<name>_<id>.json one token: outcome, peak, timing, launch facts, paper trades, price every 5 s
// Documents are small JSON (well under AI Search's 4 MB limit). Raw screenshots and chunks stay out.

type Any = Record<string, any>;
const r1 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const secs = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);
const iso = (t: unknown) => (typeof t === 'number' && t > 0 ? new Date(t).toISOString() : null);
const slug = (s: unknown) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'token';
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : null; };
const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);

/** Winner above +7% final, tanked at -50% or worse: the same lines the Studies page uses. */
export const outcome = (pct: unknown) => (typeof pct !== 'number' || !Number.isFinite(pct) ? 'unscored' : pct > 7 ? 'winner' : pct <= -50 ? 'tanked' : 'loser');

export const studyFolder = (c: Any) => `${(iso(c.startedAt) ?? '0000-00-00').slice(0, 10)}_${c.id}`;
export const studyKey = (c: Any) => `rag/studies/${studyFolder(c)}.json`;
export const tokenKey = (c: Any, t: Any) => `rag/tokens/${studyFolder(c)}/${slug(t.name)}_${slug(t.mint)}.json`;
export const recordingKey = (c: Any, t: Any) => `rag/recordings/${studyFolder(c)}/${slug(t.name)}_${slug(t.mint)}.json`;

/** One document per recording (the screenshots as data): every frame's price, one row per second, the key moments
 *  (entry, partial sale, exit, peak) tied to their exact screenshot, and the vision notes taken during recording.
 *  chunks = the token's study_chunks rows (parsed), any order. Frame paths are relative to mediaFolder. */
export function recordingDoc(c: Any, t: Any, chunks: Any[]) {
  const launch = t.createdAt ?? t.startedAt, folder = t.mediaPrefix ?? null;
  const rel = (key: string) => (folder && key.startsWith(folder + '/') ? key.slice(folder.length + 1) : key);
  const frames: { at: number; key: string; price: number | null }[] = [], vision: Any[] = [];
  for (const ch of [...chunks].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const samples = new Map<number, Any>((ch.samples ?? []).map((s: Any) => [s.index, s]));
    const byIndex = new Map<number, Any>((ch.frames ?? []).map((f: Any) => [f.index, f]));
    for (const f of ch.frames ?? []) { const s = samples.get(f.index); frames.push({ at: f.capturedAt, key: f.key, price: s && s.priceUsd > 0 ? s.priceUsd : null }); }
    for (const r of ch.reviews ?? []) {
      const f = byIndex.get(r.frame), v = r.vision;
      if (f && v) vision.push({ sec: secs(f.capturedAt - launch), frame: rel(f.key), direction: v.direction ?? null, chartVisible: v.chartVisible ?? null, blocked: v.blocked ?? null, note: v.evidence ?? null });
    }
  }
  frames.sort((a, b) => a.at - b.at);
  const seen = new Set<string>(), chat: { at: number; text: string; publishedAt: string | null }[] = [];   // each comment once, when first on screen
  for (const snap of chunks.flatMap(ch => ch.chat ?? []).sort((a: Any, b: Any) => a.capturedAt - b.capturedAt))
    for (const m of snap.messages ?? []) { const text = String(m.text ?? '').trim(), id = `${text}|${m.publishedAt ?? ''}`; if (text && !seen.has(id)) { seen.add(id); chat.push({ at: snap.capturedAt, text: text.slice(0, 500), publishedAt: m.publishedAt ?? null }); } }
  const base = t.firstPriceUsd || frames.find(f => f.price)?.price || null;
  const pct = (p: number | null) => (p && base ? r1((p / base - 1) * 100) : null);
  const at = (ts: unknown) => { if (typeof ts !== 'number' || !frames.length) return null;   // frame at or just before a moment
    let best = frames[0]; for (const f of frames) { if (f.at > ts) break; best = f; } return { sec: secs(ts - launch), pct: pct(best.price), frame: rel(best.key) }; };
  const timeline: [number | null, number | null, string][] = []; let lastSec = -1;   // first frame of every second
  for (const f of frames) { const s = Math.floor((f.at - launch) / 1000); if (s !== lastSec) { timeline.push([s, pct(f.price), rel(f.key)]); lastSec = s; } }
  const peak = frames.reduce<typeof frames[0] | null>((b, f) => (f.price && (!b || f.price > (b.price ?? 0)) ? f : b), null);
  const p = t.paper ?? {};
  return {
    type: 'recording', study: { id: c.id, startedAt: iso(c.startedAt) }, token: t.name ?? null, mint: t.mint, outcome: outcome(t.metrics?.changePct),
    tokenDoc: tokenKey(c, t), mediaFolder: folder, frames: frames.length, secondsCovered: timeline.length,
    // % values are from the first recorded price; sec = seconds after launch; open a frame at /api/studies/media?key=<mediaFolder>/<frame>
    keyMoments: { firstFrame: at(frames[0]?.at), paperEntry: at(p.entryAt), paperPartialSale: at(p.partialAt), paperExit: at(p.exitAt), peak: peak ? at(peak.at) : null, lastFrame: at(frames.at(-1)?.at) },
    paperExitReason: p.exitReason ?? p.skipReason ?? null,
    vision,   // what the vision model saw on screen during recording
    chatComments: chat.length,
    chat: chat.map(m => ({ ...at(m.at)!, text: m.text, postedAt: m.publishedAt })),   // token chat: first seen at sec, price then, frame then
    timeline, // [sec after launch, % from first price, frame]
  };
}

function paperTrade(p: Any | null | undefined) {
  if (!p) return null;
  return { status: p.status ?? null, skipReason: p.skipReason ?? null, exitReason: p.exitReason ?? null, netPct: r1(p.pnlPct), netUsd: r1(p.pnlUsd),
    heldSeconds: secs(p.holdMs), partialSold: p.partialFraction ?? null, rules: p.version ?? null };
}

/** One document per token. */
export function tokenDoc(c: Any, t: Any, modelRow: Any | null = null) {
  const m = t.metrics ?? {};
  return {
    type: 'token', study: { id: c.id, startedAt: iso(c.startedAt) }, id: t.id, name: t.name ?? null, mint: t.mint,
    outcome: outcome(m.changePct), excluded: !!t.excluded, exclusionReason: t.exclusionReason || null, status: t.status,
    launchedAt: iso(t.createdAt), recordingStartedAt: iso(t.startedAt),
    detectionDelaySeconds: secs(m.detectionDelayMs), marketCapWhenSeenUsd: r1(t.candidate?.marketCapUsd),
    finalChangePct: r1(m.changePct), peakGainPct: r1(m.peakGainPct), peakAfterSeconds: secs(m.peakAfterMs),
    firstRise10PctAfterSeconds: secs(m.firstRise10PctAfterMs), maxDrawdownPct: r1(m.maxDrawdownPct), dataCoverage: m.coverageStatus ?? null,
    launch: t.launch ? { tool: t.launch.launchTool ?? null, mayhem: !!t.launch.mayhem, feeRouted: !!t.launch.feeRouted } : null,
    paperAllTokens: paperTrade(t.paper), paperFiltered: paperTrade(t.paperFiltered),
    whatWentWrong: t.paperMistake?.label ?? null, whatWentWrongFiltered: t.paperFilteredMistake?.label ?? null,
    exits: t.exits ?? null,
    // Where the screenshots of this token live (same bucket); the link opens on the dashboard after sign-in.
    chat: { doc: recordingKey(c, t), note: 'chat comments with the second, price and frame when each appeared are in the recording doc' },
    recording: { doc: recordingKey(c, t), mediaFolder: t.mediaPrefix ?? null, frames: t.frameCount ?? 0, capturedSeconds: secs(t.capturedMs),
      latestFrame: t.latestFrame?.key ?? null, latestFrameAt: iso(t.latestFrame?.capturedAt),
      latestFrameUrl: t.latestFrame?.key ? `/api/studies/media?key=${encodeURIComponent(t.latestFrame.key)}` : null },
    model: modelRow ? { name: modelRow.model, bought: modelRow.bought, buyProbability: r1(modelRow.buyProb), netPct: r1(modelRow.trade?.netPct),
      exitReasons: modelRow.trade?.reasons ? [...new Set(modelRow.trade.reasons)] : null, rulesV3NetPct: r1(modelRow.rulesV3?.netPct),
      feedback: modelRow.feedback ?? null, liveFeasible: modelRow.liveFeasible ?? null } : null,
    // [seconds after launch, % change from the first recorded price], one point per 5 s
    priceEvery5s: Array.isArray(t.series) ? t.series : [],
  };
}

/** One document per study: the Final numbers panel plus paper, mistakes and model results. */
export function studyDoc(c: Any, tokens: Any[], modelRuns: Any[] = []) {
  const included = tokens.filter(t => !t.excluded);
  const scored = included.filter(t => outcome(t.metrics?.changePct) !== 'unscored');
  const fin = scored.map(t => t.metrics.changePct as number), peak = scored.map(t => t.metrics.peakGainPct).filter((x): x is number => typeof x === 'number');
  const byFinal = [...scored].sort((a, b) => b.metrics.changePct - a.metrics.changePct);
  const named = (t: Any | undefined, k: string) => (t ? { name: t.name, pct: r1(t.metrics[k]) } : null);
  return {
    type: 'study', id: c.id, startedAt: iso(c.startedAt), status: c.status, maxTokens: c.maxTokens ?? null,
    tokensRecorded: tokens.length, tokensScored: scored.length, excludedCount: tokens.length - included.length,
    outcomes: { winners: scored.filter(t => outcome(t.metrics.changePct) === 'winner').length, losers: scored.filter(t => outcome(t.metrics.changePct) !== 'winner').length,
      tanked: scored.filter(t => outcome(t.metrics.changePct) === 'tanked').length },
    finalChangePct: { avg: r1(mean(fin)), median: r1(median(fin)) }, peakGainPct: { avg: r1(mean(peak)), median: r1(median(peak)) },
    bestFinal: named(byFinal[0], 'changePct'), worstFinal: named(byFinal.at(-1), 'changePct'),
    highestPeak: named([...scored].sort((a, b) => (b.metrics.peakGainPct ?? -1e9) - (a.metrics.peakGainPct ?? -1e9))[0], 'peakGainPct'),
    excluded: tokens.filter(t => t.excluded).map(t => ({ name: t.name, reason: t.exclusionReason || null, finalChangePct: r1(t.metrics?.changePct) })),
    paperRules: c.paperResult?.rules ?? c.paperRules ?? null, paperFilter: c.paperResult?.filter ?? null,
    paperResult: c.paperResult ? { allTokens: c.paperResult.all ?? null, filtered: c.paperResult.filtered ?? null } : null,
    paperMistakes: c.paperMistakes ?? null, paperLessons: c.paperLessons?.lessons ?? null,
    skippedCopycats: c.skippedDuplicate ?? 0, seenCandidates: c.seenCount ?? null,
    modelRuns: modelRuns.map(m => ({ modelSha: m.model_sha, at: iso(m.created_at), summary: safeJson(m.summary), astraReview: safeJson(m.review) })),
    tokens: tokens.map(t => ({ name: t.name, outcome: outcome(t.metrics?.changePct), finalChangePct: r1(t.metrics?.changePct), peakGainPct: r1(t.metrics?.peakGainPct),
      paperNetPct: r1(t.paper?.pnlPct), paperExit: t.paper?.exitReason ?? t.paper?.skipReason ?? null, excluded: !!t.excluded, doc: tokenKey(c, t) })),
  };
}

/** One index line per study, so a question like "which study lost the most" is answered from one small file. */
export function indexLine(doc: ReturnType<typeof studyDoc>, key: string) {
  return { id: doc.id, startedAt: doc.startedAt, status: doc.status, tokensRecorded: doc.tokensRecorded, tokensScored: doc.tokensScored, outcomes: doc.outcomes,
    finalChangePct: doc.finalChangePct, paperAllTokensUsd: doc.paperResult?.allTokens?.totalUsd ?? null, paperFilteredUsd: doc.paperResult?.filtered?.totalUsd ?? null,
    paperRules: doc.paperRules?.version ?? null, modelRuns: doc.modelRuns.length, doc: key };
}

function safeJson(s: unknown) { if (typeof s !== 'string') return s ?? null; try { return JSON.parse(s); } catch { return s; } }

export const GLOSSARY = `# Pump Research Desk: data glossary

Data exported from the study database after every study and every model run. Paper trading only; no real trades.

## Documents
- rag/index.json: one line per study (date, token counts, outcomes, paper totals, path of the study document).
- rag/studies/<date>_<id>.json: one study. Totals, outcomes, best/worst, paper results, mistakes, model runs, excluded tokens, and a short line per token with the path of its token document.
- rag/recordings/<date>_<study id>/<name>_<mint>.json: one recording (the screenshots as data). Key moments (paper entry, partial sale, exit, peak) with the exact frame, the vision notes seen on screen, the token chat (each comment with the second, price and frame when it first appeared), and a timeline row per second: [sec after launch, % from first price, frame]. Open a frame at /api/studies/media?key=<mediaFolder>/<frame>.
- rag/tokens/<date>_<study id>/<name>_<mint>.json: one token. Outcome, peak and timing, launch facts, both paper trades, model result, price every 5 seconds.

## Outcome lines
- winner: final change above +7% over the 10-minute recording.
- tanked: final change of -50% or worse. loser: everything else that was scored.
- Excluded tokens (for example insider launches such as Catecoin) are left out of study outcomes and averages.

## Prices and timing
- finalChangePct and peakGainPct are measured from the first price we recorded, not the launch price.
- priceEvery5s: [seconds after launch, % change from the first recorded price].
- detectionDelaySeconds: how long after launch recording started (usually 10-22 s).

## Paper trading
- $2 per trade, decided second by second from recorded prices with no look-ahead.
- Costs: 1.25% fee + 2% slippage per side (about 6.5% round trip). netPct is after costs.
- paperAllTokens: every tradable launch. paperFiltered: only fee-routed or mayhem launches.
- Rules v3: sell half at +30% in the first 60 s; sell if never +5% by 60 s; stop -25% (fills near -35% because of the 2 s delay); trail -30% after +20%; out at 10 min.

## Model
- model.bought / buyProbability: the trained model's buy decision. model.netPct: its paper result after costs.
- model.liveFeasible = false: the model decided before we could have seen the token live.

## Corpus findings so far (5,700+ launches with 1-second candles)
- 72-78% of launches that reach +50% or +100% peak inside the first 60 seconds.
- Buying at 30 s or 58 s with simple price filters loses 7-14% per trade after costs.
- Activity and volatility at 30 s pick tokens that win more often but crash harder.
`;

type Bucket = Pick<R2Bucket, 'put' | 'get'>;
const put = (b: Bucket, key: string, body: string, type = 'application/json') => b.put(key, body, { httpMetadata: { contentType: type } });

/** Every document for one study, from plain rows (used by the Worker and by scripts/rag-dump.ts). */
export function studyFiles(c: Any, tokens: Any[], runs: Any[] = [], modelRows = new Map<string, Any>(), chunks = new Map<string, Any[]>()) {
  const doc = studyDoc(c, tokens, runs), key = studyKey(c);
  const files = tokens.map(t => ({ key: tokenKey(c, t), body: JSON.stringify(tokenDoc(c, t, modelRows.get(t.id) ?? null)) }));
  for (const t of tokens) { const ch = chunks.get(t.id); if (ch?.length) files.push({ key: recordingKey(c, t), body: JSON.stringify(recordingDoc(c, t, ch)) }); }
  files.push({ key, body: JSON.stringify(doc) });
  return { files, line: indexLine(doc, key) };
}
export const mergeIndex = (studies: Any[], line: Any) => ({ updatedAt: new Date().toISOString(),
  studies: [line, ...studies.filter(s => s.id !== line.id)].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))) });

/** Columns the export never needs (tick tapes, chat and AI text): dropped in SQL to keep reads small. */
export const TOKEN_SELECT = "json_remove(data,'$.tape','$.analysis','$.analysisHistory','$.chatWindows','$.chatAssociations','$.earlyWindows','$.laterOutcomes','$.candidate.raw') AS data";

/** Chunk fields the recording doc needs (frames, price samples, vision verdicts), without raw model text. */
export const CHUNK_SELECT = "json_object('startedAt',json_extract(data,'$.startedAt'),'frames',json_extract(data,'$.frames'),'samples',json_extract(data,'$.samples'),'chat',json_extract(data,'$.chatSnapshots'),'reviews',(SELECT json_group_array(json_object('frame',json_extract(r.value,'$.frame'),'vision',json_extract(r.value,'$.vision'))) FROM json_each(data,'$.reviews') r)) AS data";

/** Export one study (and all its tokens) from D1 to R2, then update the index. Returns what was written. */
export async function exportStudy(db: D1Database, bucket: Bucket, campaignId: string) {
  const row = await db.prepare('SELECT data FROM study_campaigns WHERE id=?').bind(campaignId).first<{ data: string }>();
  if (!row) throw Error('Study not found.');
  const c = JSON.parse(row.data) as Any;
  const tokens = (await db.prepare(`SELECT ${TOKEN_SELECT} FROM study_tokens WHERE campaign_id=? ORDER BY started_at`).bind(campaignId).all<{ data: string }>()).results.map(r => JSON.parse(r.data) as Any);
  let runs: Any[] = [], modelRows = new Map<string, Any>();
  try {
    runs = (await db.prepare('SELECT model_sha, created_at, summary, review FROM model_runs WHERE campaign_id=? ORDER BY created_at').bind(campaignId).all<Any>()).results;
    const latest = runs.at(-1);
    if (latest) modelRows = new Map((await db.prepare('SELECT token_id, data FROM model_rows WHERE campaign_id=? AND model_sha=?').bind(campaignId, latest.model_sha).all<{ token_id: string; data: string }>()).results.map(r => [r.token_id, JSON.parse(r.data)]));
  } catch { /* model tables not created yet */ }
  const chunks = new Map<string, Any[]>();   // one token at a time keeps Worker memory small
  for (const t of tokens) chunks.set(t.id, (await db.prepare(`SELECT ${CHUNK_SELECT} FROM study_chunks WHERE token_id=?`).bind(t.id).all<{ data: string }>()).results.map(r => JSON.parse(r.data)));
  const { files, line } = studyFiles(c, tokens, runs, modelRows, chunks);
  for (const f of files) await put(bucket, f.key, f.body);
  await put(bucket, 'rag/glossary.md', GLOSSARY, 'text/markdown');
  const old = await bucket.get('rag/index.json');
  await put(bucket, 'rag/index.json', JSON.stringify(mergeIndex(old ? ((await old.json()) as { studies: Any[] }).studies : [], line)));
  return { study: line.doc, tokens: tokens.length };
}
