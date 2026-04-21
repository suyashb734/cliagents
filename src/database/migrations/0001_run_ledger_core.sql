CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('consensus', 'plan-review', 'pr-review', 'discussion', 'implementation-run', 'research-run')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'partial', 'abandoned')),
  message_hash TEXT NOT NULL,
  input_summary TEXT,
  working_directory TEXT,
  initiator TEXT,
  trace_id TEXT,
  discussion_id TEXT,
  current_step TEXT,
  active_participant_count INTEGER NOT NULL DEFAULT 0,
  decision_summary TEXT,
  decision_source TEXT,
  failure_class TEXT CHECK (failure_class IN ('timeout', 'auth', 'rate_limit', 'process_exit', 'protocol_parse', 'tool_error', 'validation', 'cancelled', 'unknown')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  last_heartbeat_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER
);

CREATE TABLE run_participants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  participant_role TEXT NOT NULL,
  participant_name TEXT,
  adapter TEXT NOT NULL,
  agent_profile TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'retrying', 'cancelled', 'abandoned')),
  attempt_index INTEGER NOT NULL DEFAULT 0,
  attempt_key TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  failure_class TEXT CHECK (failure_class IN ('timeout', 'auth', 'rate_limit', 'process_exit', 'protocol_parse', 'tool_error', 'validation', 'cancelled', 'unknown')),
  is_required INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  started_at INTEGER,
  last_heartbeat_at INTEGER,
  ended_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  UNIQUE (attempt_key)
);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  participant_id TEXT,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'abandoned')),
  attempt_index INTEGER NOT NULL DEFAULT 0,
  retry_safe INTEGER NOT NULL DEFAULT 0,
  failure_class TEXT CHECK (failure_class IN ('timeout', 'auth', 'rate_limit', 'process_exit', 'protocol_parse', 'tool_error', 'validation', 'cancelled', 'unknown')),
  metadata TEXT,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  last_heartbeat_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES run_participants(id) ON DELETE CASCADE
);

CREATE TABLE run_outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  participant_id TEXT,
  output_kind TEXT NOT NULL CHECK (output_kind IN ('participant_final', 'judge_final', 'participant_error')),
  preview_text TEXT,
  full_text TEXT,
  compressed_blob BLOB,
  content_sha256 TEXT NOT NULL,
  original_bytes INTEGER NOT NULL DEFAULT 0,
  compressed_bytes INTEGER,
  compression TEXT NOT NULL DEFAULT 'none' CHECK (compression IN ('none', 'gzip')),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('inline_text', 'compressed', 'preview_only')),
  is_truncated INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES run_participants(id) ON DELETE CASCADE
);

CREATE TABLE run_tool_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  participant_id TEXT,
  step_id TEXT,
  tool_class TEXT NOT NULL CHECK (tool_class IN ('mcp', 'cli', 'api', 'web', 'filesystem', 'browser', 'database')),
  tool_name TEXT NOT NULL,
  idempotency TEXT NOT NULL DEFAULT 'unknown' CHECK (idempotency IN ('idempotent', 'side_effectful', 'unknown')),
  preview_text TEXT,
  full_text TEXT,
  compressed_blob BLOB,
  content_sha256 TEXT,
  original_bytes INTEGER NOT NULL DEFAULT 0,
  compressed_bytes INTEGER,
  compression TEXT NOT NULL DEFAULT 'none' CHECK (compression IN ('none', 'gzip')),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('inline_text', 'compressed', 'preview_only')),
  is_truncated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'abandoned')),
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  completed_at INTEGER,
  metadata TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES run_participants(id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES run_steps(id) ON DELETE SET NULL
);

CREATE INDEX idx_runs_kind_status_started_at ON runs(kind, status, started_at DESC);
CREATE INDEX idx_runs_started_at ON runs(started_at DESC);
CREATE INDEX idx_runs_message_hash ON runs(message_hash);
CREATE INDEX idx_run_participants_run_id ON run_participants(run_id);
CREATE INDEX idx_run_participants_adapter_run_id ON run_participants(adapter, run_id);
CREATE INDEX idx_run_participants_status_run_id ON run_participants(status, run_id);
CREATE INDEX idx_run_steps_run_id_started_at ON run_steps(run_id, started_at);
CREATE INDEX idx_run_steps_participant_id_started_at ON run_steps(participant_id, started_at);
CREATE UNIQUE INDEX idx_run_steps_attempt_key ON run_steps(run_id, IFNULL(participant_id, ''), step_key, attempt_index);
CREATE INDEX idx_run_outputs_run_id_created_at ON run_outputs(run_id, created_at);
CREATE INDEX idx_run_outputs_participant_id_created_at ON run_outputs(participant_id, created_at);
CREATE INDEX idx_run_tool_events_run_id_started_at ON run_tool_events(run_id, started_at);
CREATE INDEX idx_run_tool_events_participant_id_started_at ON run_tool_events(participant_id, started_at);
