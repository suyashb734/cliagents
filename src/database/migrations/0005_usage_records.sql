CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_session_id TEXT,
  terminal_id TEXT NOT NULL,
  run_id TEXT,
  participant_id TEXT,
  adapter TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER,
  source_confidence TEXT NOT NULL DEFAULT 'unknown',
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_records_root_created ON usage_records(root_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_run_created ON usage_records(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_terminal_created ON usage_records(terminal_id, created_at);
