CREATE TABLE IF NOT EXISTS adapter_readiness_reports (
  adapter TEXT PRIMARY KEY,
  available INTEGER,
  authenticated INTEGER,
  auth_reason TEXT,
  ephemeral_ready INTEGER,
  collaborator_ready INTEGER,
  continuity_mode TEXT,
  overall TEXT,
  reason_code TEXT,
  reason TEXT,
  checks TEXT,
  details TEXT,
  source TEXT NOT NULL DEFAULT 'live',
  stale_after_ms INTEGER,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
