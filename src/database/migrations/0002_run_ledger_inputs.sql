CREATE TABLE run_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  participant_id TEXT,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('run_message', 'participant_prompt', 'judge_prompt')),
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

CREATE INDEX idx_run_inputs_run_id_created_at ON run_inputs(run_id, created_at);
CREATE INDEX idx_run_inputs_participant_id_created_at ON run_inputs(participant_id, created_at);
CREATE INDEX idx_run_inputs_kind_run_id_created_at ON run_inputs(input_kind, run_id, created_at);
