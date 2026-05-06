ALTER TABLE terminals ADD COLUMN runtime_host TEXT DEFAULT 'tmux';
ALTER TABLE terminals ADD COLUMN runtime_id TEXT;
ALTER TABLE terminals ADD COLUMN runtime_capabilities TEXT;
ALTER TABLE terminals ADD COLUMN runtime_fidelity TEXT DEFAULT 'managed';

UPDATE terminals
SET runtime_host = 'tmux'
WHERE runtime_host IS NULL OR TRIM(runtime_host) = '';

UPDATE terminals
SET runtime_id = session_name || ':' || window_name
WHERE (runtime_id IS NULL OR TRIM(runtime_id) = '')
  AND session_name IS NOT NULL
  AND window_name IS NOT NULL;

UPDATE terminals
SET runtime_fidelity = CASE
  WHEN adopted_at IS NOT NULL AND TRIM(adopted_at) <> '' THEN 'adopted-partial'
  ELSE 'managed'
END
WHERE runtime_fidelity IS NULL OR TRIM(runtime_fidelity) = '';

UPDATE terminals
SET runtime_capabilities = '["detach","kill","multi_viewer","read_output","resize","send_input","stream_events"]'
WHERE runtime_capabilities IS NULL OR TRIM(runtime_capabilities) = '';

CREATE INDEX IF NOT EXISTS idx_terminals_runtime_host ON terminals(runtime_host);
CREATE INDEX IF NOT EXISTS idx_terminals_runtime_id ON terminals(runtime_host, runtime_id);
