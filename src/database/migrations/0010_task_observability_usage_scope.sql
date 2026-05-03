CREATE TABLE usage_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_session_id TEXT,
  terminal_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  task_assignment_id TEXT,
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

INSERT INTO usage_records_new (
  id,
  root_session_id,
  terminal_id,
  run_id,
  task_id,
  task_assignment_id,
  participant_id,
  adapter,
  provider,
  model,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cached_input_tokens,
  total_tokens,
  cost_usd,
  duration_ms,
  source_confidence,
  metadata,
  created_at
)
SELECT
  ur.id,
  ur.root_session_id,
  ur.terminal_id,
  ur.run_id,
  COALESCE(
    (
      SELECT NULLIF(TRIM(r.task_id), '')
      FROM runs r
      WHERE r.id = ur.run_id
      LIMIT 1
    ),
    NULLIF(TRIM(json_extract(t.session_metadata, '$.taskId')), ''),
    NULLIF(TRIM(json_extract(t.session_metadata, '$.task_id')), ''),
    NULLIF(TRIM(json_extract(ur.metadata, '$.taskId')), ''),
    NULLIF(TRIM(json_extract(ur.metadata, '$.task_id')), '')
  ) AS task_id,
  COALESCE(
    NULLIF(TRIM(json_extract(t.session_metadata, '$.taskAssignmentId')), ''),
    NULLIF(TRIM(json_extract(t.session_metadata, '$.task_assignment_id')), ''),
    NULLIF(TRIM(json_extract(ur.metadata, '$.taskAssignmentId')), ''),
    NULLIF(TRIM(json_extract(ur.metadata, '$.task_assignment_id')), '')
  ) AS task_assignment_id,
  ur.participant_id,
  ur.adapter,
  ur.provider,
  ur.model,
  ur.input_tokens,
  ur.output_tokens,
  ur.reasoning_tokens,
  ur.cached_input_tokens,
  ur.total_tokens,
  ur.cost_usd,
  ur.duration_ms,
  ur.source_confidence,
  ur.metadata,
  ur.created_at
FROM usage_records ur
LEFT JOIN terminals t ON t.terminal_id = ur.terminal_id;

DROP TABLE usage_records;
ALTER TABLE usage_records_new RENAME TO usage_records;

CREATE INDEX IF NOT EXISTS idx_usage_records_root_created ON usage_records(root_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_run_created ON usage_records(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_task_created ON usage_records(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_task_assignment_created ON usage_records(task_assignment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_terminal_created ON usage_records(terminal_id, created_at);
