CREATE TABLE IF NOT EXISTS root_io_events (
  root_io_event_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  root_session_id TEXT NOT NULL,
  terminal_id TEXT,
  run_id TEXT,
  task_id TEXT,
  task_assignment_id TEXT,
  room_id TEXT,
  discussion_id TEXT,
  trace_id TEXT,
  project_id TEXT,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('input', 'output', 'screen_snapshot', 'parsed_message', 'tool_event', 'usage', 'liveness')),
  source TEXT NOT NULL DEFAULT 'broker'
    CHECK (source IN ('broker', 'terminal_log', 'provider_metadata', 'parser')),
  sequence_no INTEGER,
  content_preview TEXT,
  content_full TEXT,
  content_sha256 TEXT,
  log_path TEXT,
  log_offset_start INTEGER,
  log_offset_end INTEGER,
  screen_rows INTEGER,
  screen_cols INTEGER,
  parsed_role TEXT,
  confidence REAL,
  retention_class TEXT NOT NULL DEFAULT 'raw-bounded'
    CHECK (retention_class IN ('raw-bounded', 'summary-indefinite', 'metadata-indefinite')),
  expires_at INTEGER,
  metadata TEXT,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_root_io_events_root_sequence
  ON root_io_events(root_session_id, sequence_no, occurred_at);
CREATE INDEX IF NOT EXISTS idx_root_io_events_terminal_occurred
  ON root_io_events(terminal_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_root_io_events_kind_occurred
  ON root_io_events(event_kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_root_io_events_task_occurred
  ON root_io_events(task_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_root_io_events_project_occurred
  ON root_io_events(project_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_root_io_events_log_span
  ON root_io_events(root_session_id, source, log_path, log_offset_start, log_offset_end, event_kind)
  WHERE log_path IS NOT NULL
    AND log_offset_start IS NOT NULL
    AND log_offset_end IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_summary_edges (
  edge_id TEXT PRIMARY KEY,
  edge_namespace TEXT NOT NULL DEFAULT 'derivation'
    CHECK (edge_namespace IN ('structural', 'derivation', 'execution')),
  parent_scope_type TEXT NOT NULL,
  parent_scope_id TEXT NOT NULL,
  child_scope_type TEXT NOT NULL,
  child_scope_id TEXT NOT NULL,
  edge_kind TEXT NOT NULL DEFAULT 'summarizes'
    CHECK (edge_kind IN ('contains', 'continues', 'summarizes', 'supersedes', 'derived_from', 'blocks', 'unblocks')),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(edge_namespace, parent_scope_type, parent_scope_id, child_scope_type, child_scope_id, edge_kind)
);

CREATE INDEX IF NOT EXISTS idx_memory_summary_edges_parent
  ON memory_summary_edges(parent_scope_type, parent_scope_id, edge_kind);
CREATE INDEX IF NOT EXISTS idx_memory_summary_edges_child
  ON memory_summary_edges(child_scope_type, child_scope_id, edge_kind);
CREATE INDEX IF NOT EXISTS idx_memory_summary_edges_created
  ON memory_summary_edges(created_at DESC);

DROP VIEW IF EXISTS memory_summary_edges_v1;
DROP VIEW IF EXISTS memory_root_io_edges_v1;
DROP VIEW IF EXISTS memory_records_root_io_v1;

CREATE VIEW memory_records_root_io_v1 (
  record_key,
  source_table,
  source_id,
  record_type,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id,
  display_text,
  search_text
) AS
WITH
task_records AS (
  SELECT source_id, project_id, workspace_root, task_id, root_session_id
  FROM memory_records_v1
  WHERE record_type = 'task'
),
run_records AS (
  SELECT source_id, project_id, workspace_root, task_id, root_session_id, run_id, discussion_id, trace_id
  FROM memory_records_v1
  WHERE record_type = 'run'
),
room_records AS (
  SELECT source_id, project_id, workspace_root, task_id, root_session_id, room_id
  FROM memory_records_v1
  WHERE record_type = 'room'
),
terminal_records AS (
  SELECT source_id, project_id, workspace_root, task_id, root_session_id, run_id, room_id, terminal_id, task_assignment_id, discussion_id, trace_id
  FROM memory_records_v1
  WHERE record_type = 'terminal'
)
SELECT
  'root_io_events:' || rio.root_io_event_id,
  'root_io_events',
  rio.root_io_event_id,
  'root_io_event',
  rio.recorded_at,
  rio.recorded_at,
  rio.occurred_at,
  COALESCE(NULLIF(TRIM(rio.project_id), ''), run.project_id, task.project_id, room.project_id, terminal.project_id),
  COALESCE(run.workspace_root, task.workspace_root, room.workspace_root, terminal.workspace_root),
  COALESCE(NULLIF(TRIM(rio.task_id), ''), run.task_id, task.task_id, room.task_id, terminal.task_id),
  COALESCE(NULLIF(TRIM(rio.root_session_id), ''), run.root_session_id, task.root_session_id, room.root_session_id, terminal.root_session_id),
  COALESCE(NULLIF(TRIM(rio.run_id), ''), terminal.run_id),
  COALESCE(NULLIF(TRIM(rio.room_id), ''), room.room_id, terminal.room_id),
  COALESCE(NULLIF(TRIM(rio.terminal_id), ''), terminal.terminal_id),
  COALESCE(NULLIF(TRIM(rio.task_assignment_id), ''), terminal.task_assignment_id),
  NULL,
  COALESCE(NULLIF(TRIM(rio.discussion_id), ''), run.discussion_id, terminal.discussion_id),
  COALESCE(NULLIF(TRIM(rio.trace_id), ''), run.trace_id, terminal.trace_id),
  SUBSTR(COALESCE(rio.content_preview, rio.event_kind), 1, 240),
  TRIM(
    COALESCE(rio.event_kind, '') || ' ' ||
    COALESCE(rio.source, '') || ' ' ||
    COALESCE(rio.parsed_role, '') || ' ' ||
    COALESCE(rio.content_preview, '') || ' ' ||
    COALESCE(rio.content_full, '') || ' ' ||
    COALESCE(rio.log_path, '') || ' ' ||
    COALESCE(rio.metadata, '')
  )
FROM root_io_events rio
LEFT JOIN run_records run
  ON run.source_id = rio.run_id
LEFT JOIN task_records task
  ON task.source_id = rio.task_id
LEFT JOIN room_records room
  ON room.source_id = rio.room_id
LEFT JOIN terminal_records terminal
  ON terminal.source_id = rio.terminal_id;

CREATE VIEW memory_root_io_edges_v1 (
  edge_key,
  source_record_key,
  source_table,
  source_id,
  source_record_type,
  edge_type,
  target_scope_type,
  target_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
) AS
SELECT
  record_key || '->project:' || project_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_project',
  'project',
  project_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE project_id IS NOT NULL AND TRIM(project_id) <> ''

UNION ALL

SELECT
  record_key || '->workspace_root:' || workspace_root,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_workspace_root',
  'workspace_root',
  workspace_root,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE workspace_root IS NOT NULL AND TRIM(workspace_root) <> ''

UNION ALL

SELECT
  record_key || '->task:' || task_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_task',
  'task',
  task_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE task_id IS NOT NULL AND TRIM(task_id) <> ''

UNION ALL

SELECT
  record_key || '->root_session:' || root_session_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_root_session',
  'root_session',
  root_session_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE root_session_id IS NOT NULL AND TRIM(root_session_id) <> ''

UNION ALL

SELECT
  record_key || '->run:' || run_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_run',
  'run',
  run_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE run_id IS NOT NULL AND TRIM(run_id) <> ''

UNION ALL

SELECT
  record_key || '->room:' || room_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_room',
  'room',
  room_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE room_id IS NOT NULL AND TRIM(room_id) <> ''

UNION ALL

SELECT
  record_key || '->terminal:' || terminal_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_terminal',
  'terminal',
  terminal_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE terminal_id IS NOT NULL AND TRIM(terminal_id) <> ''

UNION ALL

SELECT
  record_key || '->task_assignment:' || task_assignment_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_task_assignment',
  'task_assignment',
  task_assignment_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE task_assignment_id IS NOT NULL AND TRIM(task_assignment_id) <> ''

UNION ALL

SELECT
  record_key || '->discussion:' || discussion_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_discussion',
  'discussion',
  discussion_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE discussion_id IS NOT NULL AND TRIM(discussion_id) <> ''

UNION ALL

SELECT
  record_key || '->trace:' || trace_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_trace',
  'trace',
  trace_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
FROM memory_records_root_io_v1
WHERE trace_id IS NOT NULL AND TRIM(trace_id) <> '';

CREATE VIEW memory_summary_edges_v1 (
  edge_key,
  source_record_key,
  source_table,
  source_id,
  source_record_type,
  edge_type,
  target_scope_type,
  target_id,
  created_at,
  updated_at,
  activity_at,
  project_id,
  workspace_root,
  task_id,
  root_session_id,
  run_id,
  room_id,
  terminal_id,
  task_assignment_id,
  participant_id,
  discussion_id,
  trace_id
) AS
WITH all_records AS (
  SELECT * FROM memory_records_v1
  UNION ALL
  SELECT * FROM memory_records_root_io_v1
)
SELECT
  'memory_summary_edges:' || mse.edge_id,
  COALESCE(parent.record_key, 'memory_summary_edges:' || mse.edge_id),
  COALESCE(parent.source_table, 'memory_summary_edges'),
  COALESCE(parent.source_id, mse.edge_id),
  COALESCE(parent.record_type, 'memory_summary_edge'),
  mse.edge_kind,
  mse.child_scope_type,
  mse.child_scope_id,
  mse.created_at,
  mse.updated_at,
  mse.updated_at,
  COALESCE(parent.project_id, child.project_id),
  COALESCE(parent.workspace_root, child.workspace_root),
  COALESCE(parent.task_id, child.task_id),
  COALESCE(parent.root_session_id, child.root_session_id),
  COALESCE(parent.run_id, child.run_id),
  COALESCE(parent.room_id, child.room_id),
  COALESCE(parent.terminal_id, child.terminal_id),
  COALESCE(parent.task_assignment_id, child.task_assignment_id),
  COALESCE(parent.participant_id, child.participant_id),
  COALESCE(parent.discussion_id, child.discussion_id),
  COALESCE(parent.trace_id, child.trace_id)
FROM memory_summary_edges mse
LEFT JOIN all_records parent
  ON parent.record_type = mse.parent_scope_type
 AND parent.source_id = mse.parent_scope_id
LEFT JOIN all_records child
  ON child.record_type = mse.child_scope_type
 AND child.source_id = mse.child_scope_id;
