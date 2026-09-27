// AstrasAgent Durable Object: one per Ask Astra chat session. Its own SQLite keeps the conversation;
// the tool loop and every guard live in astras-agent.ts.
import { DurableObject } from 'cloudflare:workers';
import { agentTurn, groqModel, workersAiModel, HISTORY_TURNS, type AgentEnv, type AgentReply } from './astras-agent';

export class AstrasAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL)');
  }
  /** One question in this session: remembers the conversation, runs the tool loop, stores the answer. */
  async chat(question: string): Promise<AgentReply> {
    const history = this.ctx.storage.sql.exec<{ role: string; content: string }>('SELECT role, content FROM (SELECT * FROM turns ORDER BY id DESC LIMIT ?) ORDER BY id', HISTORY_TURNS).toArray();
    // Only the bindings the tools use; secrets never reach the agent (audit F4).
    const e = this.env as unknown as AgentEnv;
    const env: AgentEnv = { AI: e.AI, CRYPTO_STUDY: e.CRYPTO_STUDY, CRYPTO_MEDIA: e.CRYPTO_MEDIA, AI_SEARCH: e.AI_SEARCH, AI_SEARCH_INSTANCE: e.AI_SEARCH_INSTANCE };
    // gpt-oss-120b on Groq when GROQ_API_KEY is set (cheapest); same model on Workers AI otherwise. The key goes to the model call only.
    const key = (this.env as unknown as { GROQ_API_KEY?: string }).GROQ_API_KEY;
    const reply = await agentTurn(env, history, question, key ? groqModel(key) : workersAiModel(e.AI));
    this.ctx.storage.sql.exec('INSERT INTO turns (at, role, content) VALUES (?,?,?)', Date.now(), 'user', question);
    if (reply.answer) this.ctx.storage.sql.exec('INSERT INTO turns (at, role, content) VALUES (?,?,?)', Date.now(), 'assistant', reply.answer);
    return reply;
  }
  async history() { return this.ctx.storage.sql.exec<{ at: number; role: string; content: string }>('SELECT at, role, content FROM turns ORDER BY id').toArray(); }
}
