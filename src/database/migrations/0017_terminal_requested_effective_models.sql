ALTER TABLE terminals ADD COLUMN requested_model TEXT;
ALTER TABLE terminals ADD COLUMN effective_model TEXT;

UPDATE terminals
SET requested_model = model
WHERE requested_model IS NULL
  AND model IS NOT NULL
  AND TRIM(model) <> '';

UPDATE terminals
SET effective_model = model
WHERE effective_model IS NULL
  AND model IS NOT NULL
  AND TRIM(model) <> '';

CREATE INDEX IF NOT EXISTS idx_terminals_requested_model ON terminals(requested_model);
CREATE INDEX IF NOT EXISTS idx_terminals_effective_model ON terminals(effective_model);
