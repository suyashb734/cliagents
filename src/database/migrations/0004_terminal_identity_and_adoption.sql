ALTER TABLE terminals ADD COLUMN harness_session_id TEXT;
ALTER TABLE terminals ADD COLUMN provider_thread_ref TEXT;
ALTER TABLE terminals ADD COLUMN adopted_at DATETIME;
ALTER TABLE terminals ADD COLUMN capture_mode TEXT DEFAULT 'raw-tty';

UPDATE terminals
SET harness_session_id = terminal_id
WHERE harness_session_id IS NULL OR TRIM(harness_session_id) = '';

UPDATE terminals
SET capture_mode = 'raw-tty'
WHERE capture_mode IS NULL OR TRIM(capture_mode) = '';

CREATE INDEX IF NOT EXISTS idx_terminals_harness_session_id ON terminals(harness_session_id);
CREATE INDEX IF NOT EXISTS idx_terminals_provider_thread_ref ON terminals(provider_thread_ref);
CREATE INDEX IF NOT EXISTS idx_terminals_session_target ON terminals(session_name, window_name);
