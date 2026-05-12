ALTER TABLE task_assignments ADD COLUMN base_branch TEXT;
ALTER TABLE task_assignments ADD COLUMN branch_name TEXT;
ALTER TABLE task_assignments ADD COLUMN merge_target TEXT;
ALTER TABLE task_assignments ADD COLUMN branch_status TEXT;
ALTER TABLE task_assignments ADD COLUMN write_paths TEXT;
ALTER TABLE task_assignments ADD COLUMN path_lease_id TEXT;
ALTER TABLE task_assignments ADD COLUMN base_sha TEXT;
ALTER TABLE task_assignments ADD COLUMN head_sha TEXT;
ALTER TABLE task_assignments ADD COLUMN diff_stats TEXT;
ALTER TABLE task_assignments ADD COLUMN test_status TEXT;
ALTER TABLE task_assignments ADD COLUMN review_status TEXT;
ALTER TABLE task_assignments ADD COLUMN integrated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_task_assignments_branch_name
  ON task_assignments(branch_name);
CREATE INDEX IF NOT EXISTS idx_task_assignments_branch_status
  ON task_assignments(task_id, branch_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_assignments_path_lease
  ON task_assignments(path_lease_id);

CREATE TABLE IF NOT EXISTS task_assignment_path_leases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_assignment_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  branch_name TEXT,
  holder TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  write_paths TEXT NOT NULL,
  expires_at INTEGER,
  released_at INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_assignment_path_leases_workspace_status
  ON task_assignment_path_leases(workspace_root, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_task_assignment_path_leases_assignment
  ON task_assignment_path_leases(task_assignment_id, status);
CREATE INDEX IF NOT EXISTS idx_task_assignment_path_leases_task
  ON task_assignment_path_leases(task_id, status);
