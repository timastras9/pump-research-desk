// AstrasAgent Durable Object: one per Ask Astra chat session. Its own SQLite keeps the conversation;
// the tool loop and every guard live in astras-agent.ts.
import { DurableObject } from 'cloudflare:workers';
import { agentTurn, astraModel, fireworksModel, groqModel, workersAiModel, withFallback, HISTORY_TURNS, PROMPT_VERSION, type AgentEnv, type AgentReply } from './astras-agent';

export class AstrasAgent extends DurableObject<Env> {
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
    const model = keys.FIREWORKS_API_KEY ? withFallback(fireworksModel(keys.FIREWORKS_API_KEY), backup) : withFallback(astraModel(e.AI), backup);
    const reply = await agentTurn(env, history, question, model);
    this.ctx.storage.sql.exec('INSERT INTO turns (at, role, content, v) VALUES (?,?,?,?)', Date.now(), 'user', question, PROMPT_VERSION);
    if (reply.answer) this.ctx.storage.sql.exec('INSERT INTO turns (at, role, content, v) VALUES (?,?,?,?)', Date.now(), 'assistant', reply.answer, PROMPT_VERSION);
    return reply;
  }
  async history() { return this.ctx.storage.sql.exec<{ at: number; role: string; content: string }>('SELECT at, role, content FROM turns ORDER BY id').toArray(); }
}
