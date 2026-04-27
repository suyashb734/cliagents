ALTER TABLE terminals ADD COLUMN model TEXT;
ALTER TABLE terminals ADD COLUMN last_message_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_terminals_external_session_ref ON terminals(external_session_ref);
CREATE INDEX IF NOT EXISTS idx_terminals_last_message_at ON terminals(last_message_at);
CREATE INDEX IF NOT EXISTS idx_terminals_root_last_message ON terminals(root_session_id, last_message_at);

UPDATE terminals
SET last_message_at = (
  SELECT MAX(messages.created_at)
  FROM messages
  WHERE messages.terminal_id = terminals.terminal_id
)
WHERE (last_message_at IS NULL OR last_message_at = 0)
  AND EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.terminal_id = terminals.terminal_id
  );
