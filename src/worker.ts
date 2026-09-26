import { DurableObject } from 'cloudflare:workers';
import { buy, close, equity, event, initialState, processTick, rejectionReasons, validateRules, type DeskState } from './engine';
import { discover, mintPattern, quotes } from './market';

export class ResearchDesk extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
  return crypto.subtle.timingSafeEqual(x, y);
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
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON request required.');
  const reader = request.body?.getReader(); if (!reader) throw new Error('Missing request body.');
  let total = 0; const parts: Uint8Array[] = [];
  try { while (true) { const r = await reader.read(); if (r.done) break; total += r.value.length;
    if (total > 8192) throw new Error('Request too large.'); parts.push(r.value); } } finally { await reader.cancel(); }
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
    if (path === '/api/state' && request.method === 'GET') return json(await desk.snapshot());
    if (path === '/api/export' && request.method === 'GET') return json(await desk.snapshot(), 200, { 'Content-Disposition': 'attachment; filename="pump-research.json"' });
    if (path === '/api/discover' && request.method === 'GET') {
      try { return json({ tokens: await discover(), note: 'Search sample, not a complete launch feed or recommendation.' }); }
      catch { return json({ error: 'Token search is unavailable. Try again shortly or paste a mint address.' }, 502); }
    }
    if (path === '/api/refresh' && request.method === 'POST') { const result = await desk.refresh(); return json(result, result.ok ? 200 : 502); }
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
      response = json({ error: 'Request failed. Check your input and try again.' }, 400);
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
