CREATE TABLE IF NOT EXISTS study_campaigns (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS study_tokens (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS study_tokens_campaign ON study_tokens(campaign_id, started_at);
CREATE TABLE IF NOT EXISTS study_chunks (id TEXT PRIMARY KEY, token_id TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS study_chunks_token ON study_chunks(token_id, started_at);
