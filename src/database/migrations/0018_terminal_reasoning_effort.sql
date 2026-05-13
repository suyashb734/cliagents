ALTER TABLE terminals ADD COLUMN requested_effort TEXT;
ALTER TABLE terminals ADD COLUMN effective_effort TEXT;
ALTER TABLE task_assignments ADD COLUMN reasoning_effort TEXT;

CREATE INDEX IF NOT EXISTS idx_terminals_requested_effort ON terminals(requested_effort);
CREATE INDEX IF NOT EXISTS idx_terminals_effective_effort ON terminals(effective_effort);
CREATE INDEX IF NOT EXISTS idx_task_assignments_reasoning_effort ON task_assignments(reasoning_effort);
