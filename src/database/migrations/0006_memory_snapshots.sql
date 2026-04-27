CREATE TABLE IF NOT EXISTS memory_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('run', 'root')),
  scope_id TEXT NOT NULL,
  run_id TEXT,
  root_session_id TEXT,
  task_id TEXT,
  brief TEXT NOT NULL,
  key_decisions TEXT,
  pending_items TEXT,
  generation_trigger TEXT NOT NULL CHECK (generation_trigger IN ('run_completed', 'root_refresh', 'repair', 'manual')),
  generation_strategy TEXT NOT NULL DEFAULT 'rule_based' CHECK (generation_strategy IN ('rule_based')),
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  UNIQUE(scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_scope_id ON memory_snapshots(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_root_updated ON memory_snapshots(root_session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_task_updated ON memory_snapshots(task_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_run_id ON memory_snapshots(run_id);

ALTER TABLE runs ADD COLUMN root_session_id TEXT;
ALTER TABLE runs ADD COLUMN task_id TEXT;

ALTER TABLE messages ADD COLUMN root_session_id TEXT;

UPDATE runs
SET root_session_id = (
  SELECT se.root_session_id
  FROM session_events se
  WHERE se.run_id = runs.id
    AND se.root_session_id IS NOT NULL
  ORDER BY se.occurred_at ASC, se.recorded_at ASC, se.id ASC
  LIMIT 1
)
WHERE (runs.root_session_id IS NULL OR TRIM(runs.root_session_id) = '')
  AND EXISTS (
    SELECT 1
    FROM session_events se
    WHERE se.run_id = runs.id
      AND se.root_session_id IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_runs_root_session_id ON runs(root_session_id);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_root_completed ON runs(root_session_id, completed_at DESC);

UPDATE messages
SET root_session_id = (
  SELECT t.root_session_id
  FROM terminals t
  WHERE t.terminal_id = messages.terminal_id
    AND t.root_session_id IS NOT NULL
  LIMIT 1
)
WHERE (messages.root_session_id IS NULL OR TRIM(messages.root_session_id) = '')
  AND EXISTS (
    SELECT 1
    FROM terminals t
    WHERE t.terminal_id = messages.terminal_id
      AND t.root_session_id IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_messages_root_session_created ON messages(root_session_id, created_at);
