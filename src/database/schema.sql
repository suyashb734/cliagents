-- cliagents Database Schema
-- SQLite database for terminal registry and message queue

-- Terminals table: Tracks all persistent CLI sessions
CREATE TABLE IF NOT EXISTS terminals (
    terminal_id TEXT PRIMARY KEY,           -- 8-char hex ID
    session_name TEXT NOT NULL,             -- tmux session name
    window_name TEXT NOT NULL,              -- tmux window name
    adapter TEXT NOT NULL,                  -- Adapter type (claude-code, gemini-cli, etc.)
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

-- Annotations table: Shared workspace annotations (from LangGraph)
CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    type TEXT NOT NULL,                     -- 'bug', 'security', 'performance', 'suggestion'
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_inbox_receiver_status ON inbox(receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_inbox_priority ON inbox(priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_terminals_status ON terminals(status);
CREATE INDEX IF NOT EXISTS idx_terminals_adapter ON terminals(adapter);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_annotations_workspace ON annotations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_annotations_file ON annotations(file_path);
