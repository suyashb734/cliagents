DROP VIEW IF EXISTS memory_edges_v1;
DROP VIEW IF EXISTS memory_records_v1;

CREATE VIEW memory_records_v1 (
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
run_scopes AS (
  SELECT
    r.id AS run_id,
    COALESCE(NULLIF(TRIM(r.project_id), ''), ts.project_id, p_by_id.id, p_by_root.id) AS project_id,
    COALESCE(
      p_by_id.workspace_root,
      p_by_root.workspace_root,
      ts.workspace_root,
      NULLIF(TRIM(r.working_directory), '')
    ) AS workspace_root,
    NULLIF(TRIM(r.task_id), '') AS task_id,
    COALESCE(NULLIF(TRIM(r.root_session_id), ''), ts.root_session_id) AS root_session_id,
    NULLIF(TRIM(r.trace_id), '') AS trace_id,
    NULLIF(TRIM(r.discussion_id), '') AS discussion_id,
    r.started_at AS run_started_at,
    COALESCE(r.completed_at, r.last_heartbeat_at, r.started_at) AS run_activity_at
  FROM runs r
  LEFT JOIN task_scopes ts
    ON ts.task_id = r.task_id
  LEFT JOIN projects p_by_id
    ON p_by_id.id = r.project_id
  LEFT JOIN projects p_by_root
    ON p_by_root.workspace_root = NULLIF(TRIM(r.working_directory), '')
),
task_assignment_scopes AS (
  SELECT
    ta.id AS task_assignment_id,
    ta.task_id,
    ta.terminal_id,
    COALESCE(ts.project_id, term.project_id) AS project_id,
    COALESCE(ts.workspace_root, term.workspace_root) AS workspace_root,
    COALESCE(ts.root_session_id, term.root_session_id) AS root_session_id
  FROM task_assignments ta
  LEFT JOIN task_scopes ts
    ON ts.task_id = ta.task_id
  LEFT JOIN terminal_scopes term
    ON term.terminal_id = ta.terminal_id
),
room_scopes AS (
  SELECT
    r.id AS room_id,
    COALESCE(NULLIF(TRIM(r.project_id), ''), ts.project_id, p_by_id.id) AS project_id,
    COALESCE(p_by_id.workspace_root, ts.workspace_root) AS workspace_root,
    NULLIF(TRIM(r.task_id), '') AS task_id,
    COALESCE(NULLIF(TRIM(r.root_session_id), ''), ts.root_session_id) AS root_session_id
  FROM rooms r
  LEFT JOIN task_scopes ts
    ON ts.task_id = r.task_id
  LEFT JOIN projects p_by_id
    ON p_by_id.id = r.project_id
),
room_participant_scopes AS (
  SELECT
    rp.id AS participant_id,
    rp.room_id,
    COALESCE(room.project_id, p_by_root.id) AS project_id,
    COALESCE(
      NULLIF(TRIM(rp.work_dir), ''),
      room.workspace_root,
      p_by_root.workspace_root
    ) AS workspace_root,
    room.task_id,
    room.root_session_id
  FROM room_participants rp
  LEFT JOIN room_scopes room
    ON room.room_id = rp.room_id
  LEFT JOIN projects p_by_root
    ON p_by_root.workspace_root = NULLIF(TRIM(rp.work_dir), '')
),
run_participant_scopes AS (
  SELECT
    rp.id AS participant_id,
    rp.run_id,
    run.project_id,
    run.workspace_root,
    run.task_id,
    run.root_session_id,
    run.trace_id,
    run.discussion_id,
    run.run_started_at,
    run.run_activity_at
  FROM run_participants rp
  LEFT JOIN run_scopes run
    ON run.run_id = rp.run_id
),
discussion_scopes AS (
  SELECT
    d.id AS discussion_id,
    COALESCE(ts.project_id, term.project_id) AS project_id,
    COALESCE(ts.workspace_root, term.workspace_root) AS workspace_root,
    NULLIF(TRIM(d.task_id), '') AS task_id,
    COALESCE(ts.root_session_id, term.root_session_id) AS root_session_id,
    d.initiator_id AS terminal_id
  FROM discussions d
  LEFT JOIN task_scopes ts
    ON ts.task_id = d.task_id
  LEFT JOIN terminal_scopes term
    ON term.terminal_id = d.initiator_id
)
SELECT
  'projects:' || p.id,
  'projects',
  p.id,
  'project',
  p.created_at,
  p.updated_at,
  COALESCE(p.updated_at, p.created_at),
  p.id,
  p.workspace_root,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(p.workspace_root, 1, 240),
  TRIM(COALESCE(p.workspace_root, '') || ' ' || COALESCE(p.metadata, ''))
FROM projects p

UNION ALL

SELECT
  'tasks:' || t.id,
  'tasks',
  t.id,
  'task',
  t.created_at,
  t.updated_at,
  COALESCE(t.updated_at, t.created_at),
  scope.project_id,
  scope.workspace_root,
  t.id,
  scope.root_session_id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(t.title, 'Task ' || t.id), 1, 240),
  TRIM(
    COALESCE(t.title, '') || ' ' ||
    COALESCE(t.kind, '') || ' ' ||
    COALESCE(t.brief, '') || ' ' ||
    COALESCE(scope.workspace_root, '') || ' ' ||
    COALESCE(scope.root_session_id, '') || ' ' ||
    COALESCE(t.metadata, '')
  )
FROM tasks t
LEFT JOIN task_scopes scope
  ON scope.task_id = t.id

UNION ALL

SELECT
  'task_assignments:' || ta.id,
  'task_assignments',
  ta.id,
  'task_assignment',
  ta.created_at,
  COALESCE(ta.completed_at, ta.updated_at, ta.started_at, ta.created_at),
  COALESCE(ta.completed_at, ta.updated_at, ta.started_at, ta.created_at),
  scope.project_id,
  scope.workspace_root,
  ta.task_id,
  scope.root_session_id,
  NULL,
  NULL,
  ta.terminal_id,
  ta.id,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(ta.role, 'assignment') || ': ' || COALESCE(ta.instructions, ''), 1, 240),
  TRIM(
    COALESCE(ta.role, '') || ' ' ||
    COALESCE(ta.status, '') || ' ' ||
    COALESCE(ta.instructions, '') || ' ' ||
    COALESCE(ta.adapter, '') || ' ' ||
    COALESCE(ta.model, '') || ' ' ||
    COALESCE(ta.worktree_path, '') || ' ' ||
    COALESCE(ta.worktree_branch, '') || ' ' ||
    COALESCE(ta.acceptance_criteria, '') || ' ' ||
    COALESCE(ta.metadata, '')
  )
FROM task_assignments ta
LEFT JOIN task_assignment_scopes scope
  ON scope.task_assignment_id = ta.id

UNION ALL

SELECT
  'rooms:' || r.id,
  'rooms',
  r.id,
  'room',
  r.created_at,
  r.updated_at,
  COALESCE(r.updated_at, r.created_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  NULL,
  r.id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(r.title, 'Room ' || r.id), 1, 240),
  TRIM(
    COALESCE(r.title, '') || ' ' ||
    COALESCE(r.status, '') || ' ' ||
    COALESCE(scope.task_id, '') || ' ' ||
    COALESCE(scope.root_session_id, '') || ' ' ||
    COALESCE(r.metadata, '')
  )
FROM rooms r
LEFT JOIN room_scopes scope
  ON scope.room_id = r.id

UNION ALL

SELECT
  'room_participants:' || rp.id,
  'room_participants',
  rp.id,
  'room_participant',
  rp.created_at,
  COALESCE(rp.last_message_at, rp.updated_at, rp.created_at),
  COALESCE(rp.last_message_at, rp.updated_at, rp.created_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  NULL,
  rp.room_id,
  NULL,
  NULL,
  rp.id,
  NULL,
  NULL,
  SUBSTR(COALESCE(rp.display_name, rp.adapter), 1, 240),
  TRIM(
    COALESCE(rp.display_name, '') || ' ' ||
    COALESCE(rp.adapter, '') || ' ' ||
    COALESCE(rp.model, '') || ' ' ||
    COALESCE(rp.system_prompt, '') || ' ' ||
    COALESCE(rp.work_dir, '') || ' ' ||
    COALESCE(rp.provider_session_id, '') || ' ' ||
    COALESCE(rp.status, '') || ' ' ||
    COALESCE(rp.metadata, '')
  )
FROM room_participants rp
LEFT JOIN room_participant_scopes scope
  ON scope.participant_id = rp.id

UNION ALL

SELECT
  'room_turns:' || rt.id,
  'room_turns',
  rt.id,
  'room_turn',
  rt.created_at,
  COALESCE(rt.completed_at, rt.updated_at, rt.started_at, rt.created_at),
  COALESCE(rt.completed_at, rt.updated_at, rt.started_at, rt.created_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  NULL,
  rt.room_id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(rt.content, 'room turn'), 1, 240),
  TRIM(
    COALESCE(rt.initiator_role, '') || ' ' ||
    COALESCE(rt.initiator_name, '') || ' ' ||
    COALESCE(rt.status, '') || ' ' ||
    COALESCE(rt.error, '') || ' ' ||
    COALESCE(rt.content, '') || ' ' ||
    COALESCE(rt.metadata, '') || ' ' ||
    COALESCE(rt.mentions_json, '')
  )
FROM room_turns rt
LEFT JOIN room_scopes scope
  ON scope.room_id = rt.room_id

UNION ALL

SELECT
  'room_messages:' || CAST(rm.id AS TEXT),
  'room_messages',
  CAST(rm.id AS TEXT),
  'room_message',
  rm.created_at,
  rm.created_at,
  rm.created_at,
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  NULL,
  rm.room_id,
  NULL,
  NULL,
  rm.participant_id,
  NULL,
  NULL,
  SUBSTR(COALESCE(rm.content, 'room message'), 1, 240),
  TRIM(
    COALESCE(rm.role, '') || ' ' ||
    COALESCE(rm.content, '') || ' ' ||
    COALESCE(rm.metadata, '')
  )
FROM room_messages rm
LEFT JOIN room_scopes scope
  ON scope.room_id = rm.room_id

UNION ALL

SELECT
  'terminals:' || t.terminal_id,
  'terminals',
  t.terminal_id,
  'terminal',
  CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
  COALESCE(
    t.last_message_at,
    CAST(strftime('%s', t.last_active) AS INTEGER) * 1000,
    CAST(strftime('%s', t.created_at) AS INTEGER) * 1000
  ),
  COALESCE(
    t.last_message_at,
    CAST(strftime('%s', t.last_active) AS INTEGER) * 1000,
    CAST(strftime('%s', t.created_at) AS INTEGER) * 1000
  ),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  scope.run_id,
  scope.room_id,
  t.terminal_id,
  scope.task_assignment_id,
  NULL,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(t.session_name, t.terminal_id) || ':' || COALESCE(t.window_name, ''), 1, 240),
  TRIM(
    COALESCE(t.session_name, '') || ' ' ||
    COALESCE(t.window_name, '') || ' ' ||
    COALESCE(t.adapter, '') || ' ' ||
    COALESCE(t.agent_profile, '') || ' ' ||
    COALESCE(t.role, '') || ' ' ||
    COALESCE(t.status, '') || ' ' ||
    COALESCE(t.work_dir, '') || ' ' ||
    COALESCE(t.external_session_ref, '') || ' ' ||
    COALESCE(t.provider_thread_ref, '') || ' ' ||
    COALESCE(t.model, '') || ' ' ||
    COALESCE(t.session_metadata, '')
  )
FROM terminals t
LEFT JOIN terminal_scopes scope
  ON scope.terminal_id = t.terminal_id

UNION ALL

SELECT
  'session_events:' || se.id,
  'session_events',
  se.id,
  'session_event',
  se.occurred_at,
  se.recorded_at,
  COALESCE(se.recorded_at, se.occurred_at),
  COALESCE(run.project_id, discussion.project_id, term.project_id),
  COALESCE(run.workspace_root, discussion.workspace_root, term.workspace_root),
  COALESCE(run.task_id, discussion.task_id, term.task_id),
  COALESCE(se.root_session_id, run.root_session_id, discussion.root_session_id, term.root_session_id),
  se.run_id,
  NULL,
  se.session_id,
  term.task_assignment_id,
  NULL,
  se.discussion_id,
  COALESCE(se.trace_id, run.trace_id, term.trace_id),
  SUBSTR(COALESCE(se.payload_summary, se.event_type), 1, 240),
  TRIM(
    COALESCE(se.event_type, '') || ' ' ||
    COALESCE(se.origin_client, '') || ' ' ||
    COALESCE(se.payload_summary, '') || ' ' ||
    COALESCE(se.payload_json, '') || ' ' ||
    COALESCE(se.metadata, '') || ' ' ||
    COALESCE(se.parent_session_id, '')
  )
FROM session_events se
LEFT JOIN run_scopes run
  ON run.run_id = se.run_id
LEFT JOIN discussion_scopes discussion
  ON discussion.discussion_id = se.discussion_id
LEFT JOIN terminal_scopes term
  ON term.terminal_id = se.session_id

UNION ALL

SELECT
  'messages:' || CAST(m.id AS TEXT),
  'messages',
  CAST(m.id AS TEXT),
  'message',
  m.created_at,
  m.created_at,
  m.created_at,
  term.project_id,
  term.workspace_root,
  COALESCE(
    NULLIF(TRIM(COALESCE(json_extract(m.metadata, '$.taskId'), json_extract(m.metadata, '$.task_id'))), ''),
    term.task_id
  ),
  COALESCE(NULLIF(TRIM(m.root_session_id), ''), term.root_session_id),
  COALESCE(
    NULLIF(TRIM(COALESCE(json_extract(m.metadata, '$.runId'), json_extract(m.metadata, '$.run_id'))), ''),
    term.run_id
  ),
  COALESCE(
    NULLIF(TRIM(COALESCE(json_extract(m.metadata, '$.roomId'), json_extract(m.metadata, '$.room_id'))), ''),
    term.room_id
  ),
  m.terminal_id,
  COALESCE(
    NULLIF(TRIM(COALESCE(json_extract(m.metadata, '$.taskAssignmentId'), json_extract(m.metadata, '$.task_assignment_id'))), ''),
    term.task_assignment_id
  ),
  NULL,
  COALESCE(
    NULLIF(TRIM(COALESCE(json_extract(m.metadata, '$.discussionId'), json_extract(m.metadata, '$.discussion_id'))), ''),
    term.discussion_id
  ),
  COALESCE(NULLIF(TRIM(m.trace_id), ''), term.trace_id),
  SUBSTR(COALESCE(m.content, 'message'), 1, 240),
  TRIM(
    COALESCE(m.role, '') || ' ' ||
    COALESCE(m.content, '') || ' ' ||
    COALESCE(m.metadata, '')
  )
FROM messages m
LEFT JOIN terminal_scopes term
  ON term.terminal_id = m.terminal_id

UNION ALL

SELECT
  'runs:' || r.id,
  'runs',
  r.id,
  'run',
  r.started_at,
  COALESCE(r.completed_at, r.last_heartbeat_at, r.started_at),
  COALESCE(r.completed_at, r.last_heartbeat_at, r.started_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  r.id,
  NULL,
  NULL,
  NULL,
  NULL,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(r.input_summary, r.decision_summary, r.kind || ' run'), 1, 240),
  TRIM(
    COALESCE(r.kind, '') || ' ' ||
    COALESCE(r.status, '') || ' ' ||
    COALESCE(r.input_summary, '') || ' ' ||
    COALESCE(r.current_step, '') || ' ' ||
    COALESCE(r.decision_summary, '') || ' ' ||
    COALESCE(r.decision_source, '') || ' ' ||
    COALESCE(r.failure_class, '') || ' ' ||
    COALESCE(r.initiator, '') || ' ' ||
    COALESCE(r.working_directory, '') || ' ' ||
    COALESCE(r.metadata, '')
  )
FROM runs r
LEFT JOIN run_scopes scope
  ON scope.run_id = r.id

UNION ALL

SELECT
  'run_participants:' || rp.id,
  'run_participants',
  rp.id,
  'run_participant',
  COALESCE(rp.started_at, scope.run_started_at),
  COALESCE(rp.ended_at, rp.last_heartbeat_at, rp.started_at, scope.run_activity_at),
  COALESCE(rp.ended_at, rp.last_heartbeat_at, rp.started_at, scope.run_activity_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  rp.run_id,
  NULL,
  NULL,
  NULL,
  rp.id,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(rp.participant_name, rp.adapter), 1, 240),
  TRIM(
    COALESCE(rp.participant_role, '') || ' ' ||
    COALESCE(rp.participant_name, '') || ' ' ||
    COALESCE(rp.adapter, '') || ' ' ||
    COALESCE(rp.agent_profile, '') || ' ' ||
    COALESCE(rp.status, '') || ' ' ||
    COALESCE(rp.current_step, '') || ' ' ||
    COALESCE(rp.failure_class, '') || ' ' ||
    COALESCE(rp.metadata, '')
  )
FROM run_participants rp
LEFT JOIN run_participant_scopes scope
  ON scope.participant_id = rp.id

UNION ALL

SELECT
  'run_steps:' || rs.id,
  'run_steps',
  rs.id,
  'run_step',
  rs.started_at,
  COALESCE(rs.completed_at, rs.last_heartbeat_at, rs.started_at),
  COALESCE(rs.completed_at, rs.last_heartbeat_at, rs.started_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  rs.run_id,
  NULL,
  NULL,
  NULL,
  rs.participant_id,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(rs.step_name, rs.step_key), 1, 240),
  TRIM(
    COALESCE(rs.step_key, '') || ' ' ||
    COALESCE(rs.step_name, '') || ' ' ||
    COALESCE(rs.status, '') || ' ' ||
    COALESCE(rs.failure_class, '') || ' ' ||
    COALESCE(rs.metadata, '')
  )
FROM run_steps rs
LEFT JOIN run_scopes scope
  ON scope.run_id = rs.run_id

UNION ALL

SELECT
  'run_inputs:' || ri.id,
  'run_inputs',
  ri.id,
  'run_input',
  ri.created_at,
  ri.created_at,
  ri.created_at,
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  ri.run_id,
  NULL,
  NULL,
  NULL,
  ri.participant_id,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(ri.preview_text, ri.input_kind), 1, 240),
  TRIM(
    COALESCE(ri.input_kind, '') || ' ' ||
    COALESCE(ri.preview_text, '') || ' ' ||
    COALESCE(ri.full_text, '') || ' ' ||
    COALESCE(ri.metadata, '')
  )
FROM run_inputs ri
LEFT JOIN run_scopes scope
  ON scope.run_id = ri.run_id

UNION ALL

SELECT
  'run_outputs:' || ro.id,
  'run_outputs',
  ro.id,
  'run_output',
  ro.created_at,
  ro.created_at,
  ro.created_at,
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  ro.run_id,
  NULL,
  NULL,
  NULL,
  ro.participant_id,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(ro.preview_text, ro.output_kind), 1, 240),
  TRIM(
    COALESCE(ro.output_kind, '') || ' ' ||
    COALESCE(ro.preview_text, '') || ' ' ||
    COALESCE(ro.full_text, '') || ' ' ||
    COALESCE(ro.metadata, '')
  )
FROM run_outputs ro
LEFT JOIN run_scopes scope
  ON scope.run_id = ro.run_id

UNION ALL

SELECT
  'run_tool_events:' || rte.id,
  'run_tool_events',
  rte.id,
  'run_tool_event',
  rte.started_at,
  COALESCE(rte.completed_at, rte.started_at),
  COALESCE(rte.completed_at, rte.started_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  rte.run_id,
  NULL,
  NULL,
  NULL,
  rte.participant_id,
  scope.discussion_id,
  scope.trace_id,
  SUBSTR(COALESCE(rte.preview_text, rte.tool_name), 1, 240),
  TRIM(
    COALESCE(rte.tool_class, '') || ' ' ||
    COALESCE(rte.tool_name, '') || ' ' ||
    COALESCE(rte.status, '') || ' ' ||
    COALESCE(rte.preview_text, '') || ' ' ||
    COALESCE(rte.full_text, '') || ' ' ||
    COALESCE(rte.metadata, '')
  )
FROM run_tool_events rte
LEFT JOIN run_scopes scope
  ON scope.run_id = rte.run_id

UNION ALL

SELECT
  'usage_records:' || CAST(ur.id AS TEXT),
  'usage_records',
  CAST(ur.id AS TEXT),
  'usage_record',
  ur.created_at,
  ur.created_at,
  ur.created_at,
  COALESCE(NULLIF(TRIM(ur.project_id), ''), run.project_id, task.project_id, term.project_id),
  COALESCE(run.workspace_root, task.workspace_root, term.workspace_root),
  COALESCE(NULLIF(TRIM(ur.task_id), ''), run.task_id, task.task_id, term.task_id),
  COALESCE(NULLIF(TRIM(ur.root_session_id), ''), run.root_session_id, task.root_session_id, term.root_session_id),
  COALESCE(NULLIF(TRIM(ur.run_id), ''), term.run_id),
  term.room_id,
  ur.terminal_id,
  COALESCE(NULLIF(TRIM(ur.task_assignment_id), ''), term.task_assignment_id),
  ur.participant_id,
  COALESCE(NULLIF(TRIM(term.discussion_id), ''), run.discussion_id),
  COALESCE(NULLIF(TRIM(term.trace_id), ''), run.trace_id),
  SUBSTR(COALESCE(ur.model, ur.adapter, 'usage') || ' ' || CAST(COALESCE(ur.total_tokens, 0) AS TEXT) || ' tokens', 1, 240),
  TRIM(
    COALESCE(ur.adapter, '') || ' ' ||
    COALESCE(ur.provider, '') || ' ' ||
    COALESCE(ur.model, '') || ' ' ||
    COALESCE(ur.source_confidence, '') || ' ' ||
    CAST(COALESCE(ur.total_tokens, 0) AS TEXT) || ' ' ||
    COALESCE(ur.metadata, '')
  )
FROM usage_records ur
LEFT JOIN run_scopes run
  ON run.run_id = ur.run_id
LEFT JOIN task_scopes task
  ON task.task_id = ur.task_id
LEFT JOIN terminal_scopes term
  ON term.terminal_id = ur.terminal_id

UNION ALL

SELECT
  'discussions:' || d.id,
  'discussions',
  d.id,
  'discussion',
  d.created_at,
  COALESCE(d.completed_at, d.created_at),
  COALESCE(d.completed_at, d.created_at),
  scope.project_id,
  scope.workspace_root,
  scope.task_id,
  scope.root_session_id,
  NULL,
  NULL,
  scope.terminal_id,
  NULL,
  NULL,
  d.id,
  NULL,
  SUBSTR(COALESCE(d.topic, 'Discussion ' || d.id), 1, 240),
  TRIM(
    COALESCE(d.topic, '') || ' ' ||
    COALESCE(d.status, '') || ' ' ||
    COALESCE(d.metadata, '')
  )
FROM discussions d
LEFT JOIN discussion_scopes scope
  ON scope.discussion_id = d.id

UNION ALL

SELECT
  'discussion_messages:' || CAST(dm.id AS TEXT),
  'discussion_messages',
  CAST(dm.id AS TEXT),
  'discussion_message',
  dm.created_at,
  COALESCE(dm.delivered_at, dm.created_at),
  COALESCE(dm.delivered_at, dm.created_at),
  COALESCE(scope.project_id, sender.project_id),
  COALESCE(scope.workspace_root, sender.workspace_root),
  COALESCE(scope.task_id, sender.task_id),
  COALESCE(scope.root_session_id, sender.root_session_id),
  sender.run_id,
  sender.room_id,
  dm.sender_id,
  sender.task_assignment_id,
  NULL,
  dm.discussion_id,
  sender.trace_id,
  SUBSTR(COALESCE(dm.content, 'discussion message'), 1, 240),
  TRIM(
    COALESCE(dm.message_type, '') || ' ' ||
    COALESCE(dm.status, '') || ' ' ||
    COALESCE(dm.content, '')
  )
FROM discussion_messages dm
LEFT JOIN discussion_scopes scope
  ON scope.discussion_id = dm.discussion_id
LEFT JOIN terminal_scopes sender
  ON sender.terminal_id = dm.sender_id

UNION ALL

SELECT
  'artifacts:' || a.id,
  'artifacts',
  a.id,
  'artifact',
  CASE WHEN a.created_at < 100000000000 THEN a.created_at * 1000 ELSE a.created_at END,
  CASE WHEN a.updated_at < 100000000000 THEN a.updated_at * 1000 ELSE a.updated_at END,
  CASE WHEN a.updated_at < 100000000000 THEN a.updated_at * 1000 ELSE a.updated_at END,
  scope.project_id,
  scope.workspace_root,
  a.task_id,
  scope.root_session_id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(a.key, 'artifact'), 1, 240),
  TRIM(
    COALESCE(a.key, '') || ' ' ||
    COALESCE(a.type, '') || ' ' ||
    SUBSTR(COALESCE(a.content, ''), 1, 4000) || ' ' ||
    COALESCE(a.metadata, '')
  )
FROM artifacts a
LEFT JOIN task_scopes scope
  ON scope.task_id = a.task_id

UNION ALL

SELECT
  'findings:' || f.id,
  'findings',
  f.id,
  'finding',
  CASE WHEN f.created_at < 100000000000 THEN f.created_at * 1000 ELSE f.created_at END,
  CASE WHEN f.created_at < 100000000000 THEN f.created_at * 1000 ELSE f.created_at END,
  CASE WHEN f.created_at < 100000000000 THEN f.created_at * 1000 ELSE f.created_at END,
  scope.project_id,
  scope.workspace_root,
  f.task_id,
  scope.root_session_id,
  NULL,
  NULL,
  term.terminal_id,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(f.content, 'finding'), 1, 240),
  TRIM(
    COALESCE(f.type, '') || ' ' ||
    COALESCE(f.severity, '') || ' ' ||
    COALESCE(f.agent_id, '') || ' ' ||
    COALESCE(f.agent_profile, '') || ' ' ||
    COALESCE(f.content, '') || ' ' ||
    COALESCE(f.metadata, '')
  )
FROM findings f
LEFT JOIN task_scopes scope
  ON scope.task_id = f.task_id
LEFT JOIN terminals term
  ON term.terminal_id = f.agent_id

UNION ALL

SELECT
  'context:' || c.id,
  'context',
  c.id,
  'context',
  CASE WHEN c.created_at < 100000000000 THEN c.created_at * 1000 ELSE c.created_at END,
  CASE WHEN c.created_at < 100000000000 THEN c.created_at * 1000 ELSE c.created_at END,
  CASE WHEN c.created_at < 100000000000 THEN c.created_at * 1000 ELSE c.created_at END,
  scope.project_id,
  scope.workspace_root,
  c.task_id,
  scope.root_session_id,
  NULL,
  NULL,
  term.terminal_id,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(c.summary, 'context'), 1, 240),
  TRIM(
    COALESCE(c.summary, '') || ' ' ||
    COALESCE(c.key_decisions, '') || ' ' ||
    COALESCE(c.pending_items, '')
  )
FROM context c
LEFT JOIN task_scopes scope
  ON scope.task_id = c.task_id
LEFT JOIN terminals term
  ON term.terminal_id = c.agent_id

UNION ALL

SELECT
  'memory_snapshots:' || ms.id,
  'memory_snapshots',
  ms.id,
  'memory_snapshot',
  ms.created_at,
  ms.updated_at,
  COALESCE(ms.updated_at, ms.created_at),
  COALESCE(NULLIF(TRIM(ms.project_id), ''), run.project_id, task.project_id),
  COALESCE(run.workspace_root, task.workspace_root),
  COALESCE(NULLIF(TRIM(ms.task_id), ''), run.task_id),
  COALESCE(NULLIF(TRIM(ms.root_session_id), ''), run.root_session_id, task.root_session_id),
  COALESCE(NULLIF(TRIM(ms.run_id), ''), CASE WHEN ms.scope = 'run' THEN ms.scope_id ELSE NULL END),
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  SUBSTR(COALESCE(ms.brief, ms.scope || ':' || ms.scope_id), 1, 240),
  TRIM(
    COALESCE(ms.scope, '') || ' ' ||
    COALESCE(ms.scope_id, '') || ' ' ||
    COALESCE(ms.brief, '') || ' ' ||
    COALESCE(ms.key_decisions, '') || ' ' ||
    COALESCE(ms.pending_items, '') || ' ' ||
    COALESCE(ms.metadata, '')
  )
FROM memory_snapshots ms
LEFT JOIN run_scopes run
  ON run.run_id = COALESCE(ms.run_id, CASE WHEN ms.scope = 'run' THEN ms.scope_id ELSE NULL END)
LEFT JOIN task_scopes task
  ON task.task_id = ms.task_id

UNION ALL

SELECT
  'operator_actions:' || oa.action_id,
  'operator_actions',
  oa.action_id,
  'operator_action',
  oa.created_at,
  oa.created_at,
  oa.created_at,
  run.project_id,
  run.workspace_root,
  run.task_id,
  run.root_session_id,
  oa.run_id,
  NULL,
  oa.terminal_id,
  NULL,
  NULL,
  run.discussion_id,
  run.trace_id,
  SUBSTR(COALESCE(oa.action_kind, 'operator action'), 1, 240),
  TRIM(
    COALESCE(oa.action_kind, '') || ' ' ||
    COALESCE(oa.payload_json, '')
  )
FROM operator_actions oa
LEFT JOIN run_scopes run
  ON run.run_id = oa.run_id

UNION ALL

SELECT
  'run_blocked_states:' || rbs.id,
  'run_blocked_states',
  rbs.id,
  'run_blocked_state',
  rbs.created_at,
  COALESCE(rbs.unblocked_at, rbs.created_at),
  COALESCE(rbs.unblocked_at, rbs.created_at),
  run.project_id,
  run.workspace_root,
  run.task_id,
  run.root_session_id,
  rbs.run_id,
  NULL,
  NULL,
  NULL,
  NULL,
  run.discussion_id,
  run.trace_id,
  SUBSTR(COALESCE(rbs.blocking_detail, rbs.blocked_reason), 1, 240),
  TRIM(
    COALESCE(rbs.blocked_reason, '') || ' ' ||
    COALESCE(rbs.blocking_detail, '') || ' ' ||
    COALESCE(rbs.unblock_reason, '') || ' ' ||
    COALESCE(rbs.metadata, '')
  )
FROM run_blocked_states rbs
LEFT JOIN run_scopes run
  ON run.run_id = rbs.run_id;

CREATE VIEW memory_edges_v1 (
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
FROM memory_records_v1
WHERE project_id IS NOT NULL AND TRIM(project_id) <> ''
  AND record_type <> 'project'

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
FROM memory_records_v1
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
FROM memory_records_v1
WHERE task_id IS NOT NULL AND TRIM(task_id) <> ''
  AND record_type <> 'task'

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
FROM memory_records_v1
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
FROM memory_records_v1
WHERE run_id IS NOT NULL AND TRIM(run_id) <> ''
  AND record_type <> 'run'

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
FROM memory_records_v1
WHERE room_id IS NOT NULL AND TRIM(room_id) <> ''
  AND record_type <> 'room'

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
FROM memory_records_v1
WHERE terminal_id IS NOT NULL AND TRIM(terminal_id) <> ''
  AND record_type <> 'terminal'

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
FROM memory_records_v1
WHERE task_assignment_id IS NOT NULL AND TRIM(task_assignment_id) <> ''
  AND record_type <> 'task_assignment'

UNION ALL

SELECT
  record_key || '->participant:' || participant_id,
  record_key,
  source_table,
  source_id,
  record_type,
  'belongs_to_participant',
  'participant',
  participant_id,
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
FROM memory_records_v1
WHERE participant_id IS NOT NULL AND TRIM(participant_id) <> ''
  AND record_type NOT IN ('run_participant', 'room_participant')

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
FROM memory_records_v1
WHERE discussion_id IS NOT NULL AND TRIM(discussion_id) <> ''
  AND record_type <> 'discussion'

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
FROM memory_records_v1
WHERE trace_id IS NOT NULL AND TRIM(trace_id) <> '';
