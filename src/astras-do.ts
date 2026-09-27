// AstrasAgent Durable Object: one per Ask Astra chat session. Its own SQLite keeps the conversation;
// the tool loop and every guard live in astras-agent.ts.
import { DurableObject } from 'cloudflare:workers';
import { validPrices, dsPrompt, askDeepSeek, resolveDeepSeekModel, scoreToken, btSummary, type BtRow } from './deepseek-bt';
import { agentTurn, astraModel, fireworksModel, groqModel, workersAiModel, withFallback, HISTORY_TURNS, PROMPT_VERSION, type AgentEnv, type AgentReply } from './astras-agent';

export class AstrasAgent extends DurableObject<Env> {
  private dsModel?: string;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL)');
    // Rules version per turn: memory written under older rules stays in the transcript but is never sent to the model.
    try { ctx.storage.sql.exec('ALTER TABLE turns ADD COLUMN v TEXT'); } catch { /* column already exists */ }
  }
  /** One question in this session: remembers the conversation, runs the tool loop, stores the answer. */
  async chat(question: string): Promise<AgentReply> {
    const history = this.ctx.storage.sql.exec<{ role: string; content: string }>('SELECT role, content FROM (SELECT * FROM turns WHERE v = ? ORDER BY id DESC LIMIT ?) ORDER BY id', PROMPT_VERSION, HISTORY_TURNS).toArray();
    // Only the bindings the tools use; secrets never reach the agent (audit F4).
    const e = this.env as unknown as AgentEnv;
    const env: AgentEnv = { AI: e.AI, CRYPTO_STUDY: e.CRYPTO_STUDY, CRYPTO_MEDIA: e.CRYPTO_MEDIA, AI_SEARCH: e.AI_SEARCH, AI_SEARCH_INSTANCE: e.AI_SEARCH_INSTANCE };
    // Tim's choice: DeepSeek V4 Pro on Fireworks. If a DeepSeek call fails, gpt-oss-120b (Groq, else Workers AI) takes the step.
    // Keys go to model calls only, never to tools.
    const keys = this.env as unknown as { GROQ_API_KEY?: string; FIREWORKS_API_KEY?: string };
    const backup = keys.GROQ_API_KEY ? groqModel(keys.GROQ_API_KEY) : workersAiModel(e.AI);
    if (keys.FIREWORKS_API_KEY && !this.dsModel) this.dsModel = await resolveDeepSeekModel(keys.FIREWORKS_API_KEY).catch(() => undefined);   // the DeepSeek id this account can call
    const model = keys.FIREWORKS_API_KEY ? withFallback(fireworksModel(keys.FIREWORKS_API_KEY, fetch, this.dsModel), backup) : withFallback(astraModel(e.AI), backup);
    const reply = await agentTurn(env, history, question, model);
    this.ctx.storage.sql.exec('INSERT INTO turns (at, role, content, v) VALUES (?,?,?,?)', Date.now(), 'user', question, PROMPT_VERSION);
    if (reply.answer) this.ctx.storage.sql.exec('INSERT INTO turns (at, role, content, v) VALUES (?,?,?,?)', Date.now(), 'assistant', reply.answer, PROMPT_VERSION);
    return reply;
  }
  // ---- DeepSeek screening backtest (instance "deepseek-backtest"): batches on alarms, results in D1 deepseek_bt ----
  async startBacktest() {
    const db = (this.env as unknown as AgentEnv).CRYPTO_STUDY as D1Database;
    await db.prepare('CREATE TABLE IF NOT EXISTS deepseek_bt (run TEXT NOT NULL, token_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run, token_id))').run();
    const ids = (await db.prepare("SELECT id FROM study_tokens WHERE json_extract(data,'$.metrics.changePct') IS NOT NULL AND COALESCE(json_extract(data,'$.excluded'),0)=0 ORDER BY started_at").all<{ id: string }>()).results.map(r => r.id);
    const key = (this.env as unknown as { FIREWORKS_API_KEY?: string }).FIREWORKS_API_KEY;
    if (!key) return { error: 'FIREWORKS_API_KEY is not set' };
    let model: string;
    try { model = await resolveDeepSeekModel(key); } catch (e) { return { error: e instanceof Error ? e.message : 'could not list Fireworks models' }; }
    const run = new Date().toISOString();
    await this.ctx.storage.put('bt', { run, model, queue: ids, total: ids.length, done: 0, fails: 0, errors: [] as string[], startedAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { run, model, total: ids.length };
  }
  async alarm() {
    const bt = await this.ctx.storage.get<{ run: string; model?: string; queue: string[]; total: number; done: number; fails?: number; errors: string[]; startedAt: number; finishedAt?: number }>('bt');
    const key = (this.env as unknown as { FIREWORKS_API_KEY?: string }).FIREWORKS_API_KEY;
    if (!bt || !bt.queue.length) return;
    if (!key) { bt.errors.push('FIREWORKS_API_KEY is not set'); bt.queue = []; await this.ctx.storage.put('bt', bt); return; }
    const db = (this.env as unknown as AgentEnv).CRYPTO_STUDY as D1Database;
    for (const id of bt.queue.splice(0, 5)) {
      try {
        const t = await db.prepare("SELECT campaign_id, json_extract(data,'$.name') AS name, json_extract(data,'$.startedAt') AS startedAt, json_extract(data,'$.launch') AS launch, json_extract(data,'$.candidate.marketCapUsd') AS cap, json_extract(data,'$.metrics.changePct') AS finalPct FROM study_tokens WHERE id=?").bind(id).first<any>();
        const chunks = (await db.prepare("SELECT json_extract(data,'$.samples') AS s FROM study_chunks WHERE token_id=?").bind(id).all<{ s: string | null }>()).results;
        const v = validPrices(chunks.flatMap(c => (c.s ? JSON.parse(c.s) : []) as any[]).map(x => ({ time: x.priceReadAt ?? x.capturedAt, priceUsd: x.priceUsd })));
        const prompt = t ? dsPrompt(v, t.startedAt, t.launch ? JSON.parse(t.launch) : null, t.cap) : null;
        if (!prompt) { bt.done++; continue; }
        const d = await askDeepSeek(key, prompt, fetch, bt.model);
        bt.fails = 0;
        const row = scoreToken(v, t.startedAt, d, { tokenId: id, name: t.name, campaignId: t.campaign_id, finalPct: t.finalPct });
        await db.prepare('INSERT OR REPLACE INTO deepseek_bt (run, token_id, data) VALUES (?,?,?)').bind(bt.run, id, JSON.stringify(row)).run();
      } catch (e) { bt.errors = [...bt.errors, `${id.slice(-8)}: ${e instanceof Error ? e.message.slice(0, 160) : 'failed'}`].slice(-20); bt.fails = (bt.fails ?? 0) + 1; }
      bt.done++;
    }
    if ((bt.fails ?? 0) >= 5) { bt.errors.push('stopped: 5 DeepSeek calls failed in a row'); bt.queue = []; }
    if (!bt.queue.length) bt.finishedAt = Date.now();
    await this.ctx.storage.put('bt', bt);
    if (bt.queue.length) await this.ctx.storage.setAlarm(Date.now() + 200);
  }
  async backtestStatus() {
    const bt = await this.ctx.storage.get<{ run: string; model?: string; total: number; done: number; errors: string[]; startedAt: number; finishedAt?: number; queue: string[] }>('bt');
    if (!bt) return { status: 'not started' };
    const db = (this.env as unknown as AgentEnv).CRYPTO_STUDY as D1Database;
    const rows = (await db.prepare('SELECT data FROM deepseek_bt WHERE run=?').bind(bt.run).all<{ data: string }>()).results.map(r => JSON.parse(r.data) as BtRow);
    return { status: bt.finishedAt ? 'finished' : 'running', run: bt.run, model: bt.model ?? null, total: bt.total, done: bt.done, errors: bt.errors, summary: btSummary(rows) };
  }
  async history() { return this.ctx.storage.sql.exec<{ at: number; role: string; content: string }>('SELECT at, role, content FROM turns ORDER BY id').toArray(); }
}
