export { StudyCoordinator, StudyRecorder } from './study-collector';
export { AstrasAgent } from './astras-do';
import { observe, scanExplore, type Frame } from './observer';
import { timingSafeEqual } from 'node:crypto';
import { costs } from './research-model';
import { askAstra, logChat, type ChatEnv, type ChatTurn } from './astra-chat';
import { exportStudy } from './rag-export';
import { DurableObject } from 'cloudflare:workers';
import { buy, close, equity, event, initialState, processTick, rejectionReasons, validateRules, type DeskState } from './engine';
import { discover, mintPattern, quotes } from './market';

export class ResearchDesk extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.researchSchema();
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS desk (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)');
  }
  private read(): DeskState {
    const row = this.ctx.storage.sql.exec<{data: string}>('SELECT data FROM desk WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.data) : initialState();
  }
  private save(s: DeskState): void {
    this.ctx.storage.sql.exec('INSERT INTO desk (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(s));
  }
  observerAllowed(): boolean {
    const sql = this.ctx.storage.sql; const now = Date.now();
    sql.exec('CREATE TABLE IF NOT EXISTS observer_budget (id INTEGER PRIMARY KEY, day TEXT, count INTEGER, last INTEGER)');
    const day = new Date(now).toISOString().slice(0, 10);
    const row = sql.exec<{day:string;count:number;last:number}>('SELECT day,count,last FROM observer_budget WHERE id=1').toArray()[0];
    if (row && (now - row.last < 120000 || (row.day === day && row.count >= 10))) return false;
    sql.exec('INSERT INTO observer_budget(id,day,count,last) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,count=excluded.count,last=excluded.last', day, row?.day === day ? row.count + 1 : 1, now);
    return true;
  }
  researchSchema() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS research_runs (id TEXT PRIMARY KEY, started INTEGER NOT NULL, data TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS research_frames (run TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run,idx))');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS research_scans (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS research_seen (mint TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS research_limits (kind TEXT PRIMARY KEY, day TEXT, count INTEGER, last INTEGER)');
  }
  researchLimit(kind:string) {
    const now=Date.now(),day=new Date(now).toISOString().slice(0,10),sql=this.ctx.storage.sql;
    const row=sql.exec<{day:string;count:number;last:number}>('SELECT day,count,last FROM research_limits WHERE kind=?',kind).toArray()[0];
    if(row && (now-row.last<120000 || (row.day===day && row.count>=10))) return false;
    sql.exec('INSERT INTO research_limits(kind,day,count,last) VALUES(?,?,1,?) ON CONFLICT(kind) DO UPDATE SET day=excluded.day,count=?,last=excluded.last',kind,day,now,row?.day===day?row.count+1:1);return true;
  }
  latestScan(): Awaited<ReturnType<typeof scanExplore>> | null {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM research_scans WHERE json_extract(data,'$.scope')='new-under-60s' ORDER BY json_extract(data,'$.completedAt') DESC LIMIT 1").toArray()[0];return row?JSON.parse(row.data):null;
  }
  scanAvailability() {
    const row=this.ctx.storage.sql.exec<{day:string;count:number;last:number}>('SELECT day,count,last FROM research_limits WHERE kind=?','scan').toArray()[0];
    const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
    return {nextScanAt:row?Math.max(row.last+120000,row.day===day&&row.count>=10?Date.parse(day+'T00:00:00Z')+86400000:0):0,remaining:Math.max(0,10-(row?.day===day?row.count:0))};
  }
  saveScan(scan:Awaited<ReturnType<typeof scanExplore>>) {
    const sql=this.ctx.storage.sql;
    for(const c of scan.candidates){sql.exec('INSERT OR IGNORE INTO research_seen(mint,first_seen) VALUES(?,?)',c.mint,c.detectedAt);c.firstSeenAt=sql.exec<{first_seen:number}>('SELECT first_seen FROM research_seen WHERE mint=?',c.mint).one().first_seen;}
    sql.exec('INSERT INTO research_scans(id,data) VALUES(?,?)',scan.id,JSON.stringify(scan));return scan;
  }
  getScan(id:string): Awaited<ReturnType<typeof scanExplore>> | null {const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM research_scans WHERE id=?',id).toArray()[0];return row?JSON.parse(row.data):null;}
  beginResearch(mint:string,scanId:string|null,seconds:number,assumptions:ReturnType<typeof costs>) {
    const sql=this.ctx.storage.sql;
    if(sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM research_runs').one().n>=100) throw Error('Research archive limit reached (100 runs). Export before expanding storage.');
    const id=crypto.randomUUID();const startedAt=Date.now();
    sql.exec('INSERT INTO research_runs(id,started,data) VALUES(?,?,?)',id,startedAt,JSON.stringify({id,mint,scanId,seconds,assumptions,startedAt,status:'recording',liveTrading:false}));return id;
  }
  saveResearchFrame(id:string,frame:Frame) {if(frame.image.length>500000)throw Error('Screenshot exceeded storage bound.');this.ctx.storage.sql.exec('INSERT OR REPLACE INTO research_frames(run,idx,data) VALUES(?,?,?)',id,frame.index,JSON.stringify(frame));}
  finishResearch(id:string,report:Record<string,unknown>) {const sql=this.ctx.storage.sql;const before=sql.exec<{data:string}>('SELECT data FROM research_runs WHERE id=?',id).one();sql.exec('UPDATE research_runs SET data=? WHERE id=?',JSON.stringify({...JSON.parse(before.data),...report,status:'finished'}),id);}
  researchList() {return this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM research_runs ORDER BY started DESC LIMIT 100').toArray().map(r=>{const d=JSON.parse(r.data);return {id:d.id,mint:d.mint,startedAt:d.startedAt,status:d.status,frameCount:d.frameCount??null,failure:d.failure??null};});}
  researchReport(id:string): string | null {const sql=this.ctx.storage.sql,row=sql.exec<{data:string}>('SELECT data FROM research_runs WHERE id=?',id).toArray()[0];if(!row)return null;return JSON.stringify({...JSON.parse(row.data),frames:sql.exec<{data:string}>('SELECT data FROM research_frames WHERE run=? ORDER BY idx',id).toArray().map(r=>JSON.parse(r.data))});}
  loginAllowed(ip: string): boolean {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM login_attempts WHERE start < ?', now - 60000);
    this.ctx.storage.sql.exec('INSERT INTO login_attempts (ip,start,count) VALUES (?,?,1) ON CONFLICT(ip) DO UPDATE SET count=count+1', ip, now);
    return this.ctx.storage.sql.exec<{count: number}>('SELECT count FROM login_attempts WHERE ip=?', ip).one().count <= 10;
  }
  snapshot() {
    const s = this.read();
    return { ...s, equity: equity(s), now: Date.now(), reasons: Object.fromEntries(s.watchlist.map(m => [m, rejectionReasons(s, s.quotes[m], Date.now())])) };
  }
  async review(force = false) {
    const start = Date.now(); const before = this.read();
    if (before.lastAiAttempt && start - before.lastAiAttempt < 300000) return { ok: true, cached: true };
    if (!force && (before.trades.length < 5 || before.trades.length - (before.insight?.tradeCount ?? 0) < 5)) return { ok: true, skipped: true };
    if (!force && before.lastAiAttempt && start - before.lastAiAttempt < 3600000) return { ok: true, skipped: true };
    before.lastAiAttempt = start; this.save(before);
    const trades = before.trades.slice(0, 100);
    const byVersion = Object.fromEntries([...new Set(trades.map(t => t.ruleVersion))].map(version => {
      const rows = trades.filter(t => t.ruleVersion === version);
      return [version, { count: rows.length, netUsd: rows.reduce((a, t) => a + t.pnl, 0), wins: rows.filter(t => t.pnl > 0).length }];
    }));
    const metrics = { totalClosed: before.trades.length, analyzedLast: trades.length,
      averageNetUsd: trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : null,
      byVersion, blockedExits: before.positions.filter(p => p.exitBlocked).length,
      feedError: !!before.feedError, rules: before.rules,
      recent: trades.slice(0, 30).map(t => ({ netUsd: t.pnl, momentum5m: t.entryMomentum,
        liquidityUsd: t.entryLiquidity, heldMinutes: (t.closedAt - t.openedAt) / 60000,
        exitReason: t.reason, ruleVersion: t.ruleVersion })) };
    try {
      const output = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [{ role: 'system', content: 'You explain a beginner\'s paper-trading experiment. Use ONLY the supplied numerical evidence. Write at most 100 words in plain language: one observed result, one limitation, and one next experiment. If zero closed trades, explicitly say there is no trading performance evidence yet. With fewer than 30 closed trades, recommend collecting an unchanged baseline; do not suggest numerical rule changes. Never invent results, claim a profitable edge, recommend coins or live-money trades, or suggest bypassing risk controls. Quotes are aggregate snapshots sampled once per minute; source-data age is unknown. Security checks are absent. All fills and costs are estimates. Do not infer causes from correlations. Different rule versions are different experiments. Your text cannot change any rules.' },
          { role: 'user', content: JSON.stringify(metrics) }], max_tokens: 220, temperature: 0.2,
      });
      if (!('response' in output) || typeof output.response !== 'string' || !output.response.trim()) throw new Error('No review returned.');
      const s = this.read(); s.insight = { text: output.response.slice(0, 1800), at: Date.now(), tradeCount: before.trades.length, model: '@cf/meta/llama-3.1-8b-instruct-fp8' };
      this.save(s); return { ok: true };
    } catch (error) {
      console.error(JSON.stringify({ message: 'ai_review_failed', error: error instanceof Error ? error.message : 'Unknown' }));
      return { ok: false, error: 'AI review is unavailable. Your measured trade statistics remain available.' };
    }
  }
  mutate(action: string, input: Record<string, unknown>) {
    const s = this.read(); const now = Date.now();
    try {
      if (action === 'watch') {
        const mint = String(input.mint ?? '').trim();
        if (!mintPattern.test(mint)) throw new Error('Enter a valid Solana token mint address.');
        if (s.watchlist.includes(mint)) throw new Error('Token is already on your watchlist.');
        if (s.watchlist.length >= 20) throw new Error('This research desk supports 20 watched tokens.');
        s.watchlist.push(mint); event(s, `Added token ${mint.slice(0, 6)}…${mint.slice(-4)} to watchlist.`, now);
      } else if (action === 'unwatch') {
        const mint = String(input.mint);
        if (s.positions.some(p => p.mint === mint)) throw new Error('Close the paper position before removing this token.');
        s.watchlist = s.watchlist.filter(m => m !== mint); delete s.quotes[mint];
      } else if (action === 'rules') {
        s.rules = validateRules(input.rules); s.ruleVersion++; event(s, `Saved rules v${s.ruleVersion}. Existing positions retain their entry rules.`, now);
      } else if (action === 'toggle') {
        if (typeof input.enabled !== 'boolean') throw new Error('Expected an enabled boolean.');
        if (input.enabled && s.trades.length >= 1990) throw new Error('Journal limit reached. Export this experiment before starting another.');
        if (input.enabled && s.halted) throw new Error('Daily loss halt remains active until the next UTC day.');
        s.enabled = input.enabled; event(s, s.enabled ? 'Automatic paper entries enabled.' : 'Automatic paper entries paused. Exit rules remain active.', now);
      } else if (action === 'buy') {
        if (s.trades.length >= 1990) throw new Error('Journal limit reached. Export this experiment.');
        if (s.feedError) throw new Error('Market feed is unavailable. New entries are blocked.');
        const mint = String(input.mint); if (!s.watchlist.includes(mint)) throw new Error('Add token to watchlist first.');
        buy(s, mint, now);
      } else if (action === 'close') { close(s, String(input.id), 'Manual exit', now);
      } else throw new Error('Unknown action.');
      this.save(s); return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Invalid request.' }; }
  }
  async refresh() {
    const start = Date.now(); const before = this.read();
    if (before.lastAttempt && start - before.lastAttempt < 15000) return { ok: true, throttled: true };
    before.lastAttempt = start; this.save(before);
    if (!before.watchlist.length) return { ok: true };
    try {
      const values = await quotes(before.watchlist);
      // Re-read after network I/O: rule edits and watchlist changes must not be overwritten.
      const s = this.read();
      for (const mint of before.watchlist) {
        if (!s.watchlist.includes(mint)) continue;
        const q = values.find(x => x.mint === mint);
        if (q) s.quotes[mint] = { ...q, fetchedAt: start };
        else if (s.quotes[mint]) s.quotes[mint].fetchedAt = 0;
      }
      s.feedError = null; s.lastRefresh = Date.now(); s.latencyMs = Date.now() - start;
      if (s.trades.length >= 1990) s.enabled = false;
      processTick(s, Date.now()); this.save(s);
      return { ok: true };
    } catch (error) {
      const s = this.read(); s.feedError = error instanceof Error ? error.message : 'Market data is unavailable.';
      event(s, `Feed unavailable. Entries blocked. ${s.feedError}`); this.save(s);
      console.error(JSON.stringify({ message: 'market_refresh_failed', error: s.feedError }));
      return { ok: false, error: s.feedError };
    }
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
async function equal(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return timingSafeEqual(new Uint8Array(x), new Uint8Array(y));
}
async function sessionToken(secret: string, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`desk:${expires}`));
  return `${expires}.${Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('')}`;
}
async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret) return false;
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)desk_session=([^;]+)/)?.[1];
  if (!token) return false;
  const expires = Number(token.split('.')[0]);
  if (!Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + 86400000) return false;
  return equal(token, await sessionToken(secret, expires));
}
async function body(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON request required.');
  const reader = request.body?.getReader(); if (!reader) throw new Error('Missing request body.');
  let total = 0; const parts: Uint8Array[] = [];
  try { while (true) { const r = await reader.read(); if (r.done) break; total += r.value.length;
    if (total > maxBytes) throw new Error('Request too large.'); parts.push(r.value); } } finally { await reader.cancel(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const p of parts) { bytes.set(p, offset); offset += p.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname;
  const desk = env.DESK.getByName('timastras9');
  if (path === '/api/health') return json({ ok: true, mode: 'paper-only', liveTrading: false });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Origin not allowed.' }, 403);
  }
  if (path === '/api/login' && request.method === 'POST') {
    if (!env.DASHBOARD_PASSWORD) return json({ error: 'Dashboard access has not been configured.' }, 503);
    if (!await desk.loginAllowed(request.headers.get('CF-Connecting-IP') ?? 'local')) return json({ error: 'Too many attempts. Wait one minute.' }, 429);
    const input = await body(request);
    if (typeof input.password !== 'string' || !await equal(input.password, env.DASHBOARD_PASSWORD)) return json({ error: 'Access key is incorrect.' }, 401);
    const token = await sessionToken(env.DASHBOARD_PASSWORD, Date.now() + 86400000);
    return json({ ok: true }, 200, { 'Set-Cookie': `desk_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` });
  }
  const access = await authorized(request, env.DASHBOARD_PASSWORD);
  if (path.startsWith('/api/')) {
    if (!access) return json({ error: 'Sign in to your research desk.' }, 401);
    if (path === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': 'desk_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
    if(path.startsWith('/api/studies')) {
      const studies=env.STUDIES.getByName('timastras9');
      if(path==='/api/studies/media' && request.method==='GET') {
        const key=url.searchParams.get('key')??'';
        if(!key.startsWith('studies/') || key.includes('..') || key.length>300)return json({error:'Invalid evidence key.'},400);
        const object=await env.CRYPTO_MEDIA.get(key);
        if(!object)return json({error:'Evidence not found.'},404);
        return new Response(object.body,{headers:{'Content-Type':object.httpMetadata?.contentType??'application/octet-stream'}});
      }
      if(path==='/api/studies' && request.method==='GET')return json({...await studies.list(),status:await studies.status()});
      if(path==='/api/studies/status' && request.method==='GET')return json(await studies.status());
      if(path==='/api/studies/token' && request.method==='GET')return json(await studies.token(url.searchParams.get('id')??''));
      if(path==='/api/studies/flag' && request.method==='POST'){const input=await body(request);if(typeof input.id!=='string'||typeof input.excluded!=='boolean'||typeof input.reason!=='string')return json({error:'Invalid exclusion update.'},400);return json(await studies.flag(input.id,input.excluded,input.reason));}
      if(path==='/api/studies/start' && request.method==='POST')return json(await studies.start(await body(request)));
      if(path==='/api/studies/paper-auto' && request.method==='POST'){const input=await body(request);if(typeof input.enabled!=='boolean')return json({error:'enabled must be true or false.'},400);return json(await studies.setPaperAuto(input.enabled));}
      if(path==='/api/studies/paper-rules' && request.method==='POST')return json(await studies.setPaperRules(await body(request)));
      if(path==='/api/studies/overview' && request.method==='GET')return json(await studies.overview());
      if(path==='/api/studies/detail' && request.method==='GET')return json(await studies.detail(url.searchParams.get('id')??''));
      if(path==='/api/studies/model' && request.method==='GET')return json(await studies.modelOverview());
      if(path==='/api/studies/model-run' && request.method==='GET'){const campaign=url.searchParams.get('campaign')??'',sha=url.searchParams.get('sha')??'';const r=await studies.modelRun(campaign,sha);
        const out={run:JSON.parse(r.run),review:r.review?JSON.parse(r.review):null};
        return url.searchParams.get('download')==='1'?json({...out.run,astraReview:out.review},200,{'Content-Disposition':`attachment; filename="model-run-${campaign}-${sha}.json"`}):json(out);}
      if(path==='/api/studies/model-activate' && request.method==='POST'){const input=await body(request);if(typeof input.key!=='string'||typeof input.by!=='string')return json({error:'key and by are required.'},400);return json(await studies.setActiveModel(input.key,input.by));}
      if(path==='/api/studies/model-eval' && request.method==='POST'){const input=await body(request);if(typeof input.campaignId!=='string')return json({error:'campaignId is required.'},400);return json(await studies.queueModelRun(input.campaignId));}
      if(path==='/api/studies/stop' && request.method==='POST'){const input=await body(request);return json(await studies.stop(typeof input.id==='string'?input.id:undefined));}
      return json({error:'Study route not found.'},404);
    }
    // Ask Astra tab: questions over the RAG export; sync re-exports one study from D1 to R2 (rag/).
    if (path === '/api/chat' && request.method === 'POST') {
      const input = await body(request, 262144);   // chat: 256 KB (the rest of the API keeps 8 KB)
      if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 50000) return json({ error: 'Ask a question (up to 50,000 characters).' }, 400);
      // With a session id the Astras agent (Durable Object, tools, memory) answers; without one, the plain RAG answer.
      const session = typeof input.session === 'string' && /^[a-z0-9-]{8,64}$/.test(input.session) ? input.session : null;
      const history = (Array.isArray(input.history) ? input.history : []).filter((t): t is ChatTurn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string');
      const result = session ? await env.ASTRAS.getByName(session).chat(input.question.trim()) : await askAstra(env as unknown as ChatEnv, input.question.trim(), history);
      await logChat(env.CRYPTO_STUDY, input.question.trim(), result).catch(() => {});   // Astra history (astra_log)
      return json(result);
    }
    if (path === '/api/rag/studies' && request.method === 'GET') {
      const rows = (await env.CRYPTO_STUDY.prepare('SELECT id, started_at FROM study_campaigns ORDER BY started_at DESC').all<{ id: string; started_at: number }>()).results;
      const idx = await env.CRYPTO_MEDIA.get('rag/index.json');
      return json({ studies: rows, index: idx ? await idx.json() : null, aiSearchInstance: (env as unknown as ChatEnv).AI_SEARCH_INSTANCE || null });
    }
    if (path === '/api/rag/sync' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.id !== 'string') return json({ error: 'id is required.' }, 400);
      return json(await exportStudy(env.CRYPTO_STUDY, env.CRYPTO_MEDIA, input.id));
    }
    if (path === '/api/state' && request.method === 'GET') return json(await desk.snapshot());
    if (path === '/api/export' && request.method === 'GET') return json(await desk.snapshot(), 200, { 'Content-Disposition': 'attachment; filename="pump-research.json"' });
    if (path === '/api/discover' && request.method === 'GET') {
      try { return json({ tokens: await discover(), note: 'Search sample, not a complete launch feed or recommendation.' }); }
      catch { return json({ error: 'Token search is unavailable. Try again shortly or paste a mint address.' }, 502); }
    }
    if (path === '/api/refresh' && request.method === 'POST') { const result = await desk.refresh(); return json(result, result.ok ? 200 : 502); }
    if(path === '/api/research/scan' && request.method === 'GET') return json({scan:await desk.latestScan(),...await desk.scanAvailability()});
    if (path === '/api/research/scan' && request.method === 'POST') {
      if(!await desk.researchLimit('scan')) {
        const previous=await desk.latestScan();const availability=await desk.scanAvailability();
        return previous?json({...previous,...availability,cached:true}):json({error:'A scan is in progress or the scan allowance is exhausted. Try after '+new Date(availability.nextScanAt).toLocaleTimeString('en-US',{timeZone:'UTC'})+' UTC.',...availability},429);
      }
      try{return json({...await desk.saveScan(await scanExplore(env)),...await desk.scanAvailability(),cached:false});}catch{return json({error:'Explore scan unavailable. Browser access or account limits may be blocking it.'},502);}
    }
    if (path === '/api/research/runs' && request.method === 'GET') return json({runs:await desk.researchList()});
    if (['/api/research/report','/api/research/export'].includes(path) && request.method === 'GET') {
      const report=await desk.researchReport(url.searchParams.get('id')??'');return report?json(JSON.parse(report),200,path.endsWith('/export')?{'Content-Disposition':'attachment; filename="research-evidence.json"'}:{}):json({error:'Recording not found.'},404);
    }
    if (path === '/api/observe' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.mint !== 'string' || !mintPattern.test(input.mint)) return json({error:'Enter an exact Solana token mint.'},400);
      const seconds=input.seconds??30;if(![10,30,60].includes(Number(seconds)))return json({error:'Choose 10, 30 or 60 seconds.'},400);
      const assumptions=costs(input.assumptions??{});const scanId=typeof input.scanId==='string'?input.scanId:null;
      const discovery=scanId?await desk.getScan(scanId):null;
      if(scanId && (!discovery || Date.now()-discovery.completedAt>300000 || !discovery.candidates.some(c=>c.mint===input.mint)))return json({error:'Candidate scan expired or mint was not observed. Scan again.'},400);
      const candidate=discovery?.candidates.find(c=>c.mint===input.mint);
      if(discovery && (!candidate?.createdAt || Date.now()-candidate.createdAt>60000))return json({error:'This token is now older than one minute. Scan for a fresh launch.'},400);
      if (!await desk.observerAllowed()) return json({error:'Recording budget: wait two minutes between runs; maximum ten runs per UTC day.'},429);
      const id=await desk.beginResearch(input.mint,scanId,Number(seconds),assumptions);
      try {
        const report=await observe(env,input.mint,id,Number(seconds),assumptions,frame=>desk.saveResearchFrame(id,frame),candidate?.createdAt??null);
        await desk.finishResearch(id,{...report,discovery,tokenCreatedAt:candidate?.createdAt??null,ageAtRecordingStartMs:candidate?.createdAt?report.startedAt-candidate.createdAt:null});return json(JSON.parse((await desk.researchReport(id))!));
      } catch {
        await desk.finishResearch(id,{failure:'Research run interrupted. Saved frames remain available.',completedAt:Date.now()});
        return json({error:'Recording interrupted. Partial evidence is in Saved recordings.',id},502);
      }
    }
    if (path === '/api/review' && request.method === 'POST') { const result = await desk.review(true); return json(result, result.ok ? 200 : 502); }
    const action = path.slice('/api/'.length);
    if (request.method === 'POST' && ['watch', 'unwatch', 'rules', 'toggle', 'buy', 'close'].includes(action)) {
      const result = await desk.mutate(action, await body(request)); return json(result, result.ok ? 200 : 400);
    }
    return json({ error: 'Not found.' }, 404);
  }
  const publicPaths = ['/login.html', '/login.js', '/styles.css', '/favicon.svg'];
  if (!access && !publicPaths.includes(path)) return Response.redirect(new URL('/login.html', url).toString(), 302);
  if (access && path === '/login.html') return Response.redirect(new URL('/', url).toString(), 302);
  return env.ASSETS.fetch(path === '/' ? new Request(new URL('/index.html', url), request) : request);
}
export default {
  async fetch(request, env) {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      console.error(JSON.stringify({ message: 'request_failed', error: error instanceof Error ? error.message : 'Unknown' }));
      response = error instanceof Error && error.message === 'Request too large.' ? json({ error: 'Request too large. Shorten the question.' }, 413)
        : json({ error: 'Request failed. Check your input and try again.' }, 400);
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY'); headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_controller, env) { const desk = env.DESK.getByName('timastras9'); await desk.refresh(); await desk.review(); },
} satisfies ExportedHandler<Env>;
