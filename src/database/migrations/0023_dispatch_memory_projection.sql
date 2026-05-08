DROP VIEW IF EXISTS memory_dispatch_edges_v1;
DROP VIEW IF EXISTS memory_records_dispatch_v1;

CREATE VIEW memory_records_dispatch_v1 (
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
task_scopes AS (
  SELECT
    t.id AS task_id,
    COALESCE(NULLIF(TRIM(t.project_id), ''), p_by_id.id, p_by_root.id) AS project_id,
    COALESCE(p_by_id.workspace_root, p_by_root.workspace_root, NULLIF(TRIM(t.workspace_root), '')) AS workspace_root,
    NULLIF(TRIM(t.root_session_id), '') AS root_session_id
  FROM tasks t
  LEFT JOIN projects p_by_id
    ON p_by_id.id = t.project_id
  LEFT JOIN projects p_by_root
    ON p_by_root.workspace_root = NULLIF(TRIM(t.workspace_root), '')
),
terminal_scopes AS (
  SELECT
    t.terminal_id,
    COALESCE(NULLIF(TRIM(t.project_id), ''), p_by_id.id, p_by_root.id) AS project_id,
    COALESCE(
      p_by_id.workspace_root,
      p_by_root.workspace_root,
      NULLIF(TRIM(t.work_dir), ''),
      NULLIF(TRIM(COALESCE(
        json_extract(t.session_metadata, '$.workspaceRoot'),
        json_extract(t.session_metadata, '$.workspace_root')
      )), '')
    ) AS workspace_root,
    NULLIF(TRIM(COALESCE(
      json_extract(t.session_metadata, '$.taskId'),
      json_extract(t.session_metadata, '$.task_id')
    )), '') AS task_id,
    NULLIF(TRIM(COALESCE(
      json_extract(t.session_metadata, '$.runId'),
      json_extract(t.session_metadata, '$.run_id')
    )), '') AS run_id,
    NULLIF(TRIM(COALESCE(
      json_extract(t.session_metadata, '$.roomId'),
      json_extract(t.session_metadata, '$.room_id')
    )), '') AS room_id,
    NULLIF(TRIM(COALESCE(
      json_extract(t.session_metadata, '$.taskAssignmentId'),
      json_extract(t.session_metadata, '$.task_assignment_id')
    )), '') AS task_assignment_id,
    NULLIF(TRIM(COALESCE(
      json_extract(t.session_metadata, '$.discussionId'),
      json_extract(t.session_metadata, '$.discussion_id')
    )), '') AS discussion_id,
    NULLIF(TRIM(COALESCE(
      json_extract(t.session_metadata, '$.traceId'),
      json_extract(t.session_metadata, '$.trace_id')
    )), '') AS trace_id,
    NULLIF(TRIM(t.root_session_id), '') AS root_session_id
  FROM terminals t
  LEFT JOIN projects p_by_id
    ON p_by_id.id = t.project_id
  LEFT JOIN projects p_by_root
    ON p_by_root.workspace_root = COALESCE(
      NULLIF(TRIM(t.work_dir), ''),
      NULLIF(TRIM(COALESCE(
        json_extract(t.session_metadata, '$.workspaceRoot'),
        json_extract(t.session_metadata, '$.workspace_root')
      )), '')
    )
),
assignment_scopes AS (
  SELECT
    ta.id AS task_assignment_id,
    NULLIF(TRIM(ta.task_id), '') AS task_id,
    NULLIF(TRIM(ta.terminal_id), '') AS terminal_id,
    COALESCE(ts.project_id, term.project_id) AS project_id,
    COALESCE(ts.workspace_root, term.workspace_root) AS workspace_root,
    COALESCE(ts.root_session_id, term.root_session_id) AS root_session_id,
    term.run_id,
    term.room_id,
    term.discussion_id,
    term.trace_id
  FROM task_assignments ta
  LEFT JOIN task_scopes ts
    ON ts.task_id = ta.task_id
  LEFT JOIN terminal_scopes term
    ON term.terminal_id = ta.terminal_id
),
dispatch_scopes AS (
  SELECT
    dr.*,
    COALESCE(task.project_id, assignment.project_id, terminal.project_id) AS scope_project_id,
    COALESCE(task.workspace_root, assignment.workspace_root, terminal.workspace_root) AS scope_workspace_root,
    COALESCE(NULLIF(TRIM(dr.task_id), ''), assignment.task_id, terminal.task_id) AS scope_task_id,
    COALESCE(NULLIF(TRIM(dr.root_session_id), ''), task.root_session_id, assignment.root_session_id, terminal.root_session_id) AS scope_root_session_id,
    COALESCE(NULLIF(TRIM(dr.run_id), ''), assignment.run_id, terminal.run_id) AS scope_run_id,
    COALESCE(NULLIF(TRIM(dr.room_id), ''), terminal.room_id, assignment.room_id) AS scope_room_id,
    COALESCE(NULLIF(TRIM(dr.terminal_id), ''), assignment.terminal_id) AS scope_terminal_id,
    COALESCE(NULLIF(TRIM(dr.task_assignment_id), ''), terminal.task_assignment_id) AS scope_task_assignment_id,
    COALESCE(assignment.discussion_id, terminal.discussion_id) AS scope_discussion_id,
    COALESCE(assignment.trace_id, terminal.trace_id) AS scope_trace_id
  FROM dispatch_requests dr
  LEFT JOIN task_scopes task
    ON task.task_id = dr.task_id
  LEFT JOIN assignment_scopes assignment
    ON assignment.task_assignment_id = dr.task_assignment_id
  LEFT JOIN terminal_scopes terminal
    ON terminal.terminal_id = dr.terminal_id
)
SELECT
  'dispatch_requests:' || dispatch_request_id,
  'dispatch_requests',
  dispatch_request_id,
  'dispatch_request',
  created_at,
  updated_at,
  COALESCE(dispatched_at, updated_at, created_at),
  scope_project_id,
  scope_workspace_root,
  scope_task_id,
  scope_root_session_id,
  scope_run_id,
  scope_room_id,
  scope_terminal_id,
  scope_task_assignment_id,
  NULL,
  scope_discussion_id,
  scope_trace_id,
  SUBSTR(COALESCE(request_kind, 'dispatch') || ' ' || COALESCE(status, ''), 1, 240),
  TRIM(
    COALESCE(dispatch_request_id, '') || ' ' ||
    COALESCE(request_kind, '') || ' ' ||
    COALESCE(status, '') || ' ' ||
    COALESCE(metadata, '')
  )
FROM dispatch_scopes

UNION ALL

SELECT
  'run_context_snapshots:' || rcs.context_snapshot_id,
  'run_context_snapshots',
  rcs.context_snapshot_id,
  'run_context_snapshot',
  rcs.created_at,
  rcs.created_at,
  rcs.created_at,
  dispatch.scope_project_id,
  dispatch.scope_workspace_root,
  dispatch.scope_task_id,
  dispatch.scope_root_session_id,
  dispatch.scope_run_id,
  dispatch.scope_room_id,
  dispatch.scope_terminal_id,
  dispatch.scope_task_assignment_id,
  NULL,
  dispatch.scope_discussion_id,
  dispatch.scope_trace_id,
  SUBSTR(COALESCE(rcs.prompt_summary, rcs.context_mode, 'context snapshot'), 1, 240),
  TRIM(
    COALESCE(rcs.context_snapshot_id, '') || ' ' ||
    COALESCE(rcs.context_mode, '') || ' ' ||
    COALESCE(rcs.prompt_summary, '') || ' ' ||
    COALESCE(rcs.prompt_body, '') || ' ' ||
    COALESCE(rcs.linked_context_json, '') || ' ' ||
    COALESCE(rcs.tool_policy_json, '') || ' ' ||
    COALESCE(rcs.metadata, '')
  )
FROM run_context_snapshots rcs
LEFT JOIN dispatch_scopes dispatch
  ON dispatch.dispatch_request_id = rcs.dispatch_request_id

UNION ALL

SELECT
  'task_session_bindings:' || tsb.binding_id,
  'task_session_bindings',
  tsb.binding_id,
  'task_session_binding',
  tsb.created_at,
  COALESCE(tsb.last_verified_at, tsb.created_at),
  COALESCE(tsb.last_verified_at, tsb.created_at),
  COALESCE(task.project_id, assignment.project_id, terminal.project_id),
  COALESCE(task.workspace_root, assignment.workspace_root, terminal.workspace_root),
  COALESCE(NULLIF(TRIM(tsb.task_id), ''), assignment.task_id, terminal.task_id),
  COALESCE(NULLIF(TRIM(tsb.root_session_id), ''), task.root_session_id, assignment.root_session_id, terminal.root_session_id),
  COALESCE(assignment.run_id, terminal.run_id),
  COALESCE(assignment.room_id, terminal.room_id),
  COALESCE(NULLIF(TRIM(tsb.terminal_id), ''), assignment.terminal_id),
  COALESCE(NULLIF(TRIM(tsb.task_assignment_id), ''), assignment.task_assignment_id, terminal.task_assignment_id),
  NULL,
  COALESCE(assignment.discussion_id, terminal.discussion_id),
  COALESCE(assignment.trace_id, terminal.trace_id),
  SUBSTR(COALESCE(tsb.adapter, 'adapter') || ' ' || COALESCE(tsb.model, '') || ' ' || COALESCE(tsb.status, ''), 1, 240),
  TRIM(
    COALESCE(tsb.binding_id, '') || ' ' ||
    COALESCE(tsb.adapter, '') || ' ' ||
    COALESCE(tsb.model, '') || ' ' ||
    COALESCE(tsb.reasoning_effort, '') || ' ' ||
    COALESCE(tsb.runtime_host, '') || ' ' ||
    COALESCE(tsb.runtime_fidelity, '') || ' ' ||
    COALESCE(tsb.reuse_policy, '') || ' ' ||
    COALESCE(tsb.reuse_decision_json, '') || ' ' ||
    COALESCE(tsb.metadata, '')
  )
FROM task_session_bindings tsb
LEFT JOIN task_scopes task
  ON task.task_id = tsb.task_id
LEFT JOIN assignment_scopes assignment
  ON assignment.task_assignment_id = tsb.task_assignment_id
LEFT JOIN terminal_scopes terminal
  ON terminal.terminal_id = tsb.terminal_id;

CREATE VIEW memory_dispatch_edges_v1 (
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
FROM memory_records_dispatch_v1
WHERE project_id IS NOT NULL AND TRIM(project_id) <> ''

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
FROM memory_records_dispatch_v1
WHERE task_id IS NOT NULL AND TRIM(task_id) <> ''

UNION ALL

SELECT
  record_key || '->root:' || root_session_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_root',
  'root',
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
FROM memory_records_dispatch_v1
WHERE root_session_id IS NOT NULL AND TRIM(root_session_id) <> ''

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
FROM memory_records_dispatch_v1
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
FROM memory_records_dispatch_v1
WHERE task_assignment_id IS NOT NULL AND TRIM(task_assignment_id) <> '';
