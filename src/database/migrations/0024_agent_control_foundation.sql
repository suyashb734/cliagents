ALTER TABLE dispatch_requests ADD COLUMN claim_owner TEXT;
ALTER TABLE dispatch_requests ADD COLUMN claimed_at INTEGER;
ALTER TABLE dispatch_requests ADD COLUMN claim_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_dispatch_requests_claim_owner
  ON dispatch_requests(claim_owner, status, claim_expires_at);

CREATE TABLE IF NOT EXISTS terminal_input_leases (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  root_session_id TEXT,
  session_id TEXT,
  holder TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER,
  released_at INTEGER,
  revoked_at INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminal_input_leases_terminal_status
  ON terminal_input_leases(terminal_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_terminal_input_leases_root_status
  ON terminal_input_leases(root_session_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_input_leases_active_terminal
  ON terminal_input_leases(terminal_id)
  WHERE status = 'active';
