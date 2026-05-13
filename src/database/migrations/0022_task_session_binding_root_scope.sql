ALTER TABLE task_session_bindings ADD COLUMN root_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_task_session_bindings_root_created
  ON task_session_bindings(root_session_id, created_at);
