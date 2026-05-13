PRAGMA legacy_alter_table = ON;

ALTER TABLE memory_snapshots RENAME TO memory_snapshots_old;

CREATE TABLE memory_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('run', 'root', 'room', 'task', 'project')),
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
  project_id TEXT,
  UNIQUE(scope, scope_id)
);

INSERT INTO memory_snapshots (
  id,
  scope,
  scope_id,
  run_id,
  root_session_id,
  task_id,
  brief,
  key_decisions,
  pending_items,
  generation_trigger,
  generation_strategy,
  metadata,
  created_at,
  updated_at,
  project_id
)
SELECT
  id,
  scope,
  scope_id,
  run_id,
  root_session_id,
  task_id,
  brief,
  key_decisions,
  pending_items,
  generation_trigger,
  generation_strategy,
  metadata,
  created_at,
  updated_at,
  project_id
FROM memory_snapshots_old;

DROP TABLE memory_snapshots_old;

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_scope_id ON memory_snapshots(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_root_updated ON memory_snapshots(root_session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_task_updated ON memory_snapshots(task_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_run_id ON memory_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project_updated ON memory_snapshots(project_id, updated_at);

PRAGMA legacy_alter_table = OFF;
