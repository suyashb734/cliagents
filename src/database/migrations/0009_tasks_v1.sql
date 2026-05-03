CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  brief TEXT,
  workspace_root TEXT,
  root_session_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated ON tasks(workspace_root, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_root_updated ON tasks(root_session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  terminal_id TEXT,
  role TEXT NOT NULL,
  instructions TEXT NOT NULL,
  adapter TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  worktree_path TEXT,
  worktree_branch TEXT,
  acceptance_criteria TEXT,
  metadata TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_assignments_task_created ON task_assignments(task_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_task_assignments_task_status ON task_assignments(task_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_assignments_terminal ON task_assignments(terminal_id);

ALTER TABLE rooms ADD COLUMN task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_rooms_task_updated ON rooms(task_id, updated_at DESC);

INSERT OR IGNORE INTO tasks (
  id,
  title,
  kind,
  brief,
  workspace_root,
  root_session_id,
  metadata,
  created_at,
  updated_at
)
WITH distinct_task_ids AS (
  SELECT DISTINCT TRIM(task_id) AS task_id
  FROM runs
  WHERE task_id IS NOT NULL AND TRIM(task_id) <> '' AND TRIM(task_id) NOT LIKE 'room:%'
  UNION
  SELECT DISTINCT TRIM(task_id) AS task_id
  FROM discussions
  WHERE task_id IS NOT NULL AND TRIM(task_id) <> '' AND TRIM(task_id) NOT LIKE 'room:%'
  UNION
  SELECT DISTINCT TRIM(task_id) AS task_id
  FROM memory_snapshots
  WHERE task_id IS NOT NULL AND TRIM(task_id) <> '' AND TRIM(task_id) NOT LIKE 'room:%'
  UNION
  SELECT DISTINCT TRIM(task_id) AS task_id
  FROM artifacts
  WHERE task_id IS NOT NULL AND TRIM(task_id) <> '' AND TRIM(task_id) NOT LIKE 'room:%'
  UNION
  SELECT DISTINCT TRIM(task_id) AS task_id
  FROM findings
  WHERE task_id IS NOT NULL AND TRIM(task_id) <> '' AND TRIM(task_id) NOT LIKE 'room:%'
  UNION
  SELECT DISTINCT TRIM(task_id) AS task_id
  FROM context
  WHERE task_id IS NOT NULL AND TRIM(task_id) <> '' AND TRIM(task_id) NOT LIKE 'room:%'
)
SELECT
  d.task_id,
  COALESCE(
    (
      SELECT NULLIF(TRIM(r.input_summary), '')
      FROM runs r
      WHERE r.task_id = d.task_id
      ORDER BY COALESCE(r.completed_at, r.last_heartbeat_at, r.started_at, 0) DESC, r.id DESC
      LIMIT 1
    ),
    (
      SELECT NULLIF(TRIM(di.topic), '')
      FROM discussions di
      WHERE di.task_id = d.task_id
      ORDER BY COALESCE(di.completed_at, di.created_at, 0) DESC, di.id DESC
      LIMIT 1
    ),
    'Task ' || d.task_id
  ) AS title,
  'general' AS kind,
  NULL AS brief,
  (
    SELECT NULLIF(TRIM(r.working_directory), '')
    FROM runs r
    WHERE r.task_id = d.task_id
    ORDER BY COALESCE(r.completed_at, r.last_heartbeat_at, r.started_at, 0) DESC, r.id DESC
    LIMIT 1
  ) AS workspace_root,
  (
    SELECT NULLIF(TRIM(r.root_session_id), '')
    FROM runs r
    WHERE r.task_id = d.task_id
    ORDER BY COALESCE(r.completed_at, r.last_heartbeat_at, r.started_at, 0) DESC, r.id DESC
    LIMIT 1
  ) AS root_session_id,
  '{"backfilled":true,"source":"historical_task_id"}' AS metadata,
  CAST(strftime('%s','now') * 1000 AS INTEGER) AS created_at,
  CAST(strftime('%s','now') * 1000 AS INTEGER) AS updated_at
FROM distinct_task_ids d;
