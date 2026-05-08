CREATE TABLE IF NOT EXISTS dispatch_requests (
  dispatch_request_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  orchestration_id TEXT,
  phase_id TEXT,
  task_id TEXT,
  task_assignment_id TEXT,
  room_id TEXT,
  root_session_id TEXT,
  requested_by TEXT,
  request_kind TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'spawned', 'deferred', 'cancelled', 'failed')),
  coalesce_key TEXT,
  coalesced_count INTEGER NOT NULL DEFAULT 0,
  defer_until INTEGER,
  context_snapshot_id TEXT,
  bound_session_id TEXT,
  run_id TEXT,
  terminal_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  cancelled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dispatch_requests_status_created
  ON dispatch_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_requests_root_status
  ON dispatch_requests(root_session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_requests_task_status
  ON dispatch_requests(task_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_requests_assignment_status
  ON dispatch_requests(task_assignment_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_requests_room_status
  ON dispatch_requests(room_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_requests_coalesce_active
  ON dispatch_requests(coalesce_key, status, created_at)
  WHERE coalesce_key IS NOT NULL
    AND status IN ('queued', 'claimed', 'deferred');

CREATE TABLE IF NOT EXISTS run_context_snapshots (
  context_snapshot_id TEXT PRIMARY KEY,
  dispatch_request_id TEXT NOT NULL,
  workspace_path TEXT,
  context_mode TEXT NOT NULL DEFAULT 'prompt',
  prompt_summary TEXT,
  prompt_body TEXT,
  linked_context_json TEXT,
  tool_policy_json TEXT,
  adapter TEXT,
  model TEXT,
  reasoning_effort TEXT,
  content_sha256 TEXT,
  retention_class TEXT NOT NULL DEFAULT 'raw-bounded'
    CHECK (retention_class IN ('raw-bounded', 'summary-indefinite', 'metadata-indefinite')),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (dispatch_request_id) REFERENCES dispatch_requests(dispatch_request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_context_snapshots_dispatch
  ON run_context_snapshots(dispatch_request_id);
CREATE INDEX IF NOT EXISTS idx_run_context_snapshots_created
  ON run_context_snapshots(created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_run_context_snapshots_no_update
BEFORE UPDATE ON run_context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'run_context_snapshots are immutable');
END;

CREATE TABLE IF NOT EXISTS task_session_bindings (
  binding_id TEXT PRIMARY KEY,
  task_id TEXT,
  task_assignment_id TEXT,
  orchestration_id TEXT,
  phase_id TEXT,
  adapter TEXT NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  terminal_id TEXT,
  provider_session_id TEXT,
  runtime_host TEXT,
  runtime_fidelity TEXT,
  reuse_policy TEXT,
  reuse_decision_json TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'failed', 'cancelled')),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_task_session_bindings_task_created
  ON task_session_bindings(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_session_bindings_assignment_created
  ON task_session_bindings(task_assignment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_session_bindings_terminal_created
  ON task_session_bindings(terminal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_session_bindings_provider
  ON task_session_bindings(adapter, provider_session_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_task_session_bindings_no_update
BEFORE UPDATE ON task_session_bindings
BEGIN
  SELECT RAISE(ABORT, 'task_session_bindings are append-only');
END;
