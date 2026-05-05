-- cliagents Database Schema
-- SQLite database for terminal registry and message queue

-- Terminals table: Tracks all persistent CLI sessions
CREATE TABLE IF NOT EXISTS terminals (
    terminal_id TEXT PRIMARY KEY,           -- 8-char hex ID
    session_name TEXT NOT NULL,             -- tmux session name
    window_name TEXT NOT NULL,              -- tmux window name
    adapter TEXT NOT NULL,                  -- Adapter type (codex-cli, gemini-cli, qwen-cli)
    agent_profile TEXT,                     -- Agent profile name (optional)
    role TEXT DEFAULT 'worker',             -- 'supervisor' or 'worker'
    status TEXT DEFAULT 'idle',             -- Current status
    work_dir TEXT,                          -- Working directory
    log_path TEXT,                          -- Path to log file
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inbox table: Message queue for inter-agent communication
CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,                -- Sending terminal ID
    receiver_id TEXT NOT NULL,              -- Receiving terminal ID
    message TEXT NOT NULL,                  -- Message content
    status TEXT DEFAULT 'pending',          -- 'pending', 'delivered', 'failed'
    priority INTEGER DEFAULT 0,             -- Higher = more urgent
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    delivered_at DATETIME,
    attempts INTEGER DEFAULT 0,             -- Delivery attempts
    last_attempt_at DATETIME,
    error TEXT                              -- Last error message if failed
);

-- Traces table: Orchestration traces for observability
CREATE TABLE IF NOT EXISTS traces (
    trace_id TEXT PRIMARY KEY,
    parent_terminal_id TEXT,                -- Supervisor terminal that initiated
    name TEXT,                              -- Trace name (e.g., "code-review")
    status TEXT DEFAULT 'active',           -- 'active', 'completed', 'failed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    metadata TEXT                           -- JSON blob for extra data
);

-- Spans table: Individual operations within a trace
CREATE TABLE IF NOT EXISTS spans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    operation TEXT NOT NULL,                -- Operation name (e.g., "handoff:developer")
    start_time INTEGER NOT NULL,            -- Unix timestamp ms
    end_time INTEGER,                       -- Unix timestamp ms
    status TEXT DEFAULT 'active',           -- 'active', 'completed', 'failed'
    input_summary TEXT,                     -- Truncated input for context
    output_summary TEXT,                    -- Truncated output for context
    metadata TEXT,                          -- JSON blob
    FOREIGN KEY (trace_id) REFERENCES traces(trace_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_inbox_receiver_status ON inbox(receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_inbox_priority ON inbox(priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_terminals_status ON terminals(status);
CREATE INDEX IF NOT EXISTS idx_terminals_adapter ON terminals(adapter);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);

-- ============================================================
-- SHARED MEMORY TABLES (for multi-agent collaboration)
-- ============================================================

-- Artifacts: Code, files, and other outputs from agents
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  type TEXT NOT NULL DEFAULT 'code',
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(task_id, key)
);

-- Findings: Insights, bugs, issues discovered by agents
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_profile TEXT,
  type TEXT NOT NULL DEFAULT 'suggestion',
  severity TEXT DEFAULT 'info',
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Context: Conversation summaries and key decisions
CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_decisions TEXT,
  pending_items TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for shared memory tables
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type);
CREATE INDEX IF NOT EXISTS idx_context_task ON context(task_id);

-- ============================================================
-- MESSAGES TABLE (Conversation History)
-- ============================================================
-- Stores all conversation messages for auditability and context
-- CRITICAL: Uses milliseconds (Date.now()) not seconds - agents generate
-- multiple events/second during tool loops

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT NOT NULL,               -- References terminal (no FK - allows audit after deletion)
  trace_id TEXT,                           -- For debugging multi-agent workflows
  role TEXT NOT NULL,                      -- 'user', 'assistant', 'system', 'tool'
  content TEXT NOT NULL,
  metadata TEXT,                           -- JSON: { "model", "tokens", "tool_id", "agentProfile" }
  created_at INTEGER NOT NULL              -- MILLISECONDS (Date.now()), NOT seconds!
);

-- Indexes for messages table
CREATE INDEX IF NOT EXISTS idx_messages_terminal_created ON messages(terminal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);

-- ============================================================
-- USAGE RECORDS TABLE (Token / cost observability)
-- ============================================================
-- Stores normalized usage records independently of terminal liveness so
-- root, run, and terminal usage remains queryable after cleanup/pruning.

CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_session_id TEXT,
  terminal_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  task_assignment_id TEXT,
  participant_id TEXT,
  adapter TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER,
  source_confidence TEXT NOT NULL DEFAULT 'unknown',
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_records_root_created ON usage_records(root_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_run_created ON usage_records(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_task_created ON usage_records(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_task_assignment_created ON usage_records(task_assignment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_terminal_created ON usage_records(terminal_id, created_at);

-- ============================================================
-- ADAPTER READINESS REPORTS
-- ============================================================
-- Latest live child-session readiness report per adapter. Historical readiness
-- transitions are intentionally deferred; this table is the current routing
-- hint and inspection surface.

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

-- ============================================================
-- DISCUSSIONS TABLE (Agent-to-Agent Communication)
-- ============================================================
-- Enables real-time bidirectional communication between agents

-- Discussions table: Tracks active agent-to-agent conversations
CREATE TABLE IF NOT EXISTS discussions (
    id TEXT PRIMARY KEY,                    -- Discussion ID (UUID)
    task_id TEXT,                           -- Parent task ID (optional)
    initiator_id TEXT NOT NULL,             -- Terminal that started discussion
    status TEXT DEFAULT 'active',           -- 'active', 'completed', 'timeout'
    topic TEXT,                             -- What the discussion is about
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    completed_at INTEGER,
    metadata TEXT                           -- JSON blob
);

-- Discussion messages table: Individual messages in a discussion
CREATE TABLE IF NOT EXISTS discussion_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discussion_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,                -- Sender terminal ID
    receiver_id TEXT,                       -- Receiver terminal ID (null for broadcast)
    message_type TEXT NOT NULL,             -- 'question', 'answer', 'info'
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',          -- 'pending', 'delivered', 'read'
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    delivered_at INTEGER,
    FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);

-- Indexes for discussion tables (performance optimized per Codex review)
CREATE INDEX IF NOT EXISTS idx_discussions_task ON discussions(task_id);
CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status);
CREATE INDEX IF NOT EXISTS idx_discussion_messages_discussion ON discussion_messages(discussion_id);
-- Composite index for efficient pending message queries (Codex performance recommendation)
CREATE INDEX IF NOT EXISTS idx_discussion_messages_receiver_status_created ON discussion_messages(receiver_id, status, created_at);
