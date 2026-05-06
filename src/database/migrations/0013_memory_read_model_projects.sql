CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_root ON projects(workspace_root);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

ALTER TABLE tasks ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC);

ALTER TABLE runs ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_id, started_at DESC);

ALTER TABLE rooms ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_rooms_project_updated ON rooms(project_id, updated_at DESC);

ALTER TABLE usage_records ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_records_project_created ON usage_records(project_id, created_at);

ALTER TABLE memory_snapshots ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project_updated ON memory_snapshots(project_id, updated_at);

ALTER TABLE terminals ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_terminals_project_created ON terminals(project_id, created_at);
