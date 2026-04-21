ALTER TABLE terminals ADD COLUMN root_session_id TEXT;
ALTER TABLE terminals ADD COLUMN parent_session_id TEXT;
ALTER TABLE terminals ADD COLUMN session_kind TEXT DEFAULT 'legacy';
ALTER TABLE terminals ADD COLUMN origin_client TEXT DEFAULT 'legacy';
ALTER TABLE terminals ADD COLUMN external_session_ref TEXT;
ALTER TABLE terminals ADD COLUMN lineage_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE terminals ADD COLUMN session_metadata TEXT;

UPDATE terminals
SET root_session_id = terminal_id
WHERE root_session_id IS NULL OR TRIM(root_session_id) = '';

UPDATE terminals
SET session_kind = 'legacy'
WHERE session_kind IS NULL OR TRIM(session_kind) = '';

UPDATE terminals
SET origin_client = 'legacy'
WHERE origin_client IS NULL OR TRIM(origin_client) = '';

UPDATE terminals
SET lineage_depth = 0
WHERE lineage_depth IS NULL;

CREATE INDEX IF NOT EXISTS idx_terminals_root_session_id ON terminals(root_session_id);
CREATE INDEX IF NOT EXISTS idx_terminals_parent_session_id ON terminals(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_terminals_session_kind ON terminals(session_kind);
CREATE INDEX IF NOT EXISTS idx_terminals_origin_client ON terminals(origin_client);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  run_id TEXT,
  discussion_id TEXT,
  trace_id TEXT,
  parent_event_id TEXT,
  event_type TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  origin_client TEXT,
  payload_summary TEXT,
  payload_json TEXT,
  metadata TEXT,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE UNIQUE INDEX idx_session_events_idempotency_key ON session_events(idempotency_key);
CREATE UNIQUE INDEX idx_session_events_root_sequence ON session_events(root_session_id, sequence_no);
CREATE INDEX idx_session_events_session_id_occurred_at ON session_events(session_id, occurred_at);
CREATE INDEX idx_session_events_root_occurred_at ON session_events(root_session_id, occurred_at);
CREATE INDEX idx_session_events_run_id_occurred_at ON session_events(run_id, occurred_at);
CREATE INDEX idx_session_events_discussion_id_occurred_at ON session_events(discussion_id, occurred_at);
CREATE INDEX idx_session_events_event_type_occurred_at ON session_events(event_type, occurred_at);
