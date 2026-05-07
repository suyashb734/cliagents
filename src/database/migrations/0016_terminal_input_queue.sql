ALTER TABLE terminals ADD COLUMN session_control_mode TEXT DEFAULT 'operator';

UPDATE terminals
SET session_control_mode = 'operator'
WHERE session_control_mode IS NULL OR TRIM(session_control_mode) = '';

UPDATE terminals
SET runtime_capabilities = '["approve_permission","detach","kill","multi_viewer","read_output","resize","send_input","stream_events"]'
WHERE runtime_host = 'tmux'
  AND runtime_capabilities = '["detach","kill","multi_viewer","read_output","resize","send_input","stream_events"]';

CREATE INDEX IF NOT EXISTS idx_terminals_session_control_mode ON terminals(session_control_mode);

CREATE TABLE IF NOT EXISTS terminal_input_queue (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  root_session_id TEXT,
  run_id TEXT,
  task_id TEXT,
  task_assignment_id TEXT,
  input_kind TEXT NOT NULL DEFAULT 'message'
    CHECK (input_kind IN ('message', 'approval', 'denial')),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'held_for_approval', 'delivered', 'expired', 'cancelled')),
  control_mode TEXT NOT NULL DEFAULT 'operator'
    CHECK (control_mode IN ('observer', 'operator', 'exclusive')),
  requested_by TEXT,
  approval_required INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at INTEGER,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'denied')),
  hold_reason TEXT,
  expires_at INTEGER,
  delivered_at INTEGER,
  cancelled_at INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminal_input_queue_terminal_status
  ON terminal_input_queue(terminal_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_terminal_input_queue_root_status
  ON terminal_input_queue(root_session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_terminal_input_queue_task_status
  ON terminal_input_queue(task_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_terminal_input_queue_created
  ON terminal_input_queue(created_at DESC);
