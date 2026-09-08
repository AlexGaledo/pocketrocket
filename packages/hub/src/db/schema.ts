export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT UNIQUE NOT NULL, title TEXT DEFAULT '',
  description TEXT DEFAULT '', avatar TEXT DEFAULT '', model TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]', max_budget_usd REAL NOT NULL DEFAULT 2.0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group')), name TEXT NOT NULL,
  coordinator_bot_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY (room_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
  author_type TEXT NOT NULL, author_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  payload TEXT, cause_id TEXT, hop INTEGER NOT NULL DEFAULT 0, turn_id TEXT, created_at INTEGER NOT NULL,
  UNIQUE(room_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, seq);
CREATE TABLE IF NOT EXISTS sessions (
  bot_id TEXT NOT NULL, room_id TEXT NOT NULL, sdk_session_id TEXT, last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, provider TEXT, PRIMARY KEY (bot_id, room_id)
);
-- Global settings (see @pocketrocket/shared SettingsSchema); value holds JSON.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, name TEXT NOT NULL, cron TEXT NOT NULL,
  prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, next_run_at INTEGER
);
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL, message_id TEXT, cost_usd REAL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '', path TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('imported','authored','bot')), review_status TEXT NOT NULL DEFAULT 'approved',
  created_by_bot TEXT
);
CREATE TABLE IF NOT EXISTS bot_skills (bot_id TEXT NOT NULL, skill_id TEXT NOT NULL, PRIMARY KEY (bot_id, skill_id));
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, turn_id TEXT, tool_name TEXT NOT NULL,
  tool_input TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, turn_id TEXT, cause_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, model_usage TEXT, duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_cause ON usage(cause_id);
`;
