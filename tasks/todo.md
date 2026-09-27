# Astras agent on Cloudflare (Durable Object), called from the Ask Astra page

Goal: in the browser, Ask Astra talks to the **Astras agent** from the Open Astras repo, running on
Cloudflare in a Durable Object, working on the live study data.

## In scope
- [x] Persona sync: `scripts/sync-astras-prompt.mjs` copies Open Astras `prompts/astras.md` into
      `src/astras-prompt.ts` (Open Astras stays the single source).
- [ ] `src/astras-agent.ts`: `AstrasAgent` Durable Object, one per chat session.
  - Keeps the conversation in its own SQLite (survives reloads; last 30 turns sent to the model).
  - Model: Workers AI `openai/gpt-6-astra` with tool calling; up to 6 tool steps per question.
  - Tools (read-only):
    - `search_data(query)`: AI Search `crypto-study-media` (studies, tokens, recordings, chat).
    - `query_db(sql)`: one SELECT/WITH on D1 `crypto-study`; writes refused; 200-row cap.
    - `read_doc(key)`: one file from R2 under `rag/` only.
  - Cost cap $0.50 per question across all steps (stops and says so).
- [ ] Worker: `/api/chat` goes to the session's AstrasAgent; still behind sign-in; still logged to `astra_log`.
- [ ] `wrangler.jsonc`: `ASTRAS` Durable Object binding + migration `v3` (new SQLite class).
- [ ] Ask Astra page: keeps a session id (new-conversation button), shows which tools the agent
      used for each answer. Nothing existing removed.
- [ ] Tests: tool guards (SQL read-only, R2 prefix), tool loop with a fake model, cost cap, session memory.
- [ ] Type check + all tests green, commit, push.
- [ ] Deploy: only after Tim's OK (check no study is recording).

## Out of scope (not in this build)
- Shell commands, file writes, git/GitHub commits, spawning other agents (blocked as unsafe; would
  need a Cloudflare Sandbox container and Tim's explicit decision).
- Running the Open Astras Node runtime itself (Express + Postgres + Typesense) on Cloudflare.
- Changing rules, models or studies: the agent answers and suggests; Tim decides.

## Estimate
About 3-4 hours to build and test; one deploy afterwards.

## Done means
Tim opens Ask Astra on the live site, asks "which exit reason cost us the most in the last study
and show the query", and the Astras agent answers with numbers from a D1 query it ran, names the
tools it used, and the exchange appears in `astra_log`.
