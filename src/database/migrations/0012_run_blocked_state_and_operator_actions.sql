-- Phase 1A: Run-state and blocked-state durability foundation
-- Long-Horizon Orchestration V1

-- operator_actions: Durable record of operator replies, overrides, and interventions
-- linked to runs. Enables replay of operator decisions after broker restart.
CREATE TABLE IF NOT EXISTS operator_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  terminal_id TEXT,
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'operator_reply',
    'operator_override',
    'operator_unblock',
    'operator_cancel',
    'operator_retry',
    'operator_escalate',
    'operator_resume'
  )),
  payload_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operator_actions_run_id ON operator_actions(run_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_terminal_id ON operator_actions(terminal_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_created_at ON operator_actions(created_at);

-- run_blocked_states: First-class blocked-state representation for runs.
-- Tracks when runs become blocked, why they are blocked, and when they unblock.
CREATE TABLE IF NOT EXISTS run_blocked_states (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  blocked_reason TEXT NOT NULL CHECK (blocked_reason IN (
    'waiting_for_input',
    'waiting_for_approval',
    'waiting_for_handoff',
    'waiting_for_resource',
    'waiting_for_dependency',
    'blocked_by_gate',
    'blocked_by_operator',
    'internal_block'
  )),
  blocking_detail TEXT,
  unblocked_at INTEGER,
  unblock_reason TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_blocked_states_run_id ON run_blocked_states(run_id);
CREATE INDEX IF NOT EXISTS idx_run_blocked_states_created_at ON run_blocked_states(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_blocked_states_active ON run_blocked_states(run_id)
  WHERE unblocked_at IS NULL;
