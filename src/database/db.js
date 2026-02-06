/**
 * Database Module - SQLite persistence for cliagents orchestration
 *
 * Uses better-sqlite3 for synchronous operations.
 * Manages terminals, inbox messages, traces, shared memory (artifacts, findings, context),
 * and conversation history (messages).
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Generate a unique ID for shared memory entries
 */
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

class OrchestrationDB {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Path to SQLite database file
   */
  constructor(options = {}) {
    const dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this.dbPath = options.dbPath || path.join(dataDir, 'cliagents.db');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    // Run migrations
    this._runMigrations();
  }

  /**
   * Run database migrations
   */
  _runMigrations() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Split by semicolons and execute each statement
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const statement of statements) {
      try {
        this.db.exec(statement);
      } catch (error) {
        // Ignore "already exists" errors
        if (!error.message.includes('already exists')) {
          console.error('Migration error:', error.message);
        }
      }
    }

    // Migration: Remove FK constraint from messages table (allows audit after terminal deletion)
    this._migrateMessagesTableRemoveFK();
  }

  /**
   * Migration: Recreate messages table without FOREIGN KEY constraint
   * This allows messages to persist for auditing even after terminals are deleted
   */
  _migrateMessagesTableRemoveFK() {
    try {
      // Check if messages table has FK constraint by examining table schema
      const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();

      if (!tableInfo || !tableInfo.sql) {
        return; // Table doesn't exist yet, schema.sql will create it correctly
      }

      // If table has FOREIGN KEY, migrate it
      if (tableInfo.sql.includes('FOREIGN KEY')) {
        console.log('[db] Migrating messages table to remove FK constraint...');

        this.db.exec(`
          -- Create new table without FK
          CREATE TABLE IF NOT EXISTS messages_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            terminal_id TEXT NOT NULL,
            trace_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER NOT NULL
          );

          -- Copy data
          INSERT INTO messages_new SELECT * FROM messages;

          -- Drop old table
          DROP TABLE messages;

          -- Rename new table
          ALTER TABLE messages_new RENAME TO messages;

          -- Recreate indexes
          CREATE INDEX IF NOT EXISTS idx_messages_terminal_created ON messages(terminal_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);
        `);

        console.log('[db] Messages table migrated successfully');
      }
    } catch (error) {
      // Migration may have already been applied or table doesn't exist
      if (!error.message.includes('no such table') && !error.message.includes('already exists')) {
        console.error('[db] Migration error:', error.message);
      }
    }
  }

  // ===================
  // Terminal Operations
  // ===================

  /**
   * Register a new terminal
   */
  registerTerminal(terminalId, sessionName, windowName, adapter, agentProfile = null, role = 'worker', workDir = null, logPath = null) {
    const stmt = this.db.prepare(`
      INSERT INTO terminals (terminal_id, session_name, window_name, adapter, agent_profile, role, work_dir, log_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(terminalId, sessionName, windowName, adapter, agentProfile, role, workDir, logPath);
    return terminalId;
  }

  /**
   * Get terminal by ID
   */
  getTerminal(terminalId) {
    const stmt = this.db.prepare('SELECT * FROM terminals WHERE terminal_id = ?');
    return stmt.get(terminalId);
  }

  /**
   * Update terminal status
   */
  updateStatus(terminalId, status) {
    const stmt = this.db.prepare(`
      UPDATE terminals
      SET status = ?, last_active = CURRENT_TIMESTAMP
      WHERE terminal_id = ?
    `);
    stmt.run(status, terminalId);
  }

  /**
   * List all terminals
   */
  listTerminals(options = {}) {
    let sql = 'SELECT * FROM terminals';
    const params = [];

    if (options.status) {
      sql += ' WHERE status = ?';
      params.push(options.status);
    }

    if (options.adapter) {
      sql += params.length ? ' AND adapter = ?' : ' WHERE adapter = ?';
      params.push(options.adapter);
    }

    sql += ' ORDER BY created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * Delete terminal
   */
  deleteTerminal(terminalId) {
    const stmt = this.db.prepare('DELETE FROM terminals WHERE terminal_id = ?');
    stmt.run(terminalId);
  }

  /**
   * Clean up stale terminals
   */
  cleanupStaleTerminals(maxAgeHours = 24) {
    const stmt = this.db.prepare(`
      DELETE FROM terminals
      WHERE last_active < datetime('now', '-' || ? || ' hours')
    `);
    const result = stmt.run(maxAgeHours);
    return result.changes;
  }

  // =================
  // Inbox Operations
  // =================

  /**
   * Queue a message for delivery
   */
  queueMessage(senderId, receiverId, message, priority = 0) {
    const stmt = this.db.prepare(`
      INSERT INTO inbox (sender_id, receiver_id, message, priority)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(senderId, receiverId, message, priority);
    return result.lastInsertRowid;
  }

  /**
   * Get pending messages for a receiver
   */
  getPendingMessages(receiverId = null, limit = 10) {
    let sql = `
      SELECT * FROM inbox
      WHERE status = 'pending'
    `;
    const params = [];

    if (receiverId) {
      sql += ' AND receiver_id = ?';
      params.push(receiverId);
    }

    sql += ' ORDER BY priority DESC, created_at ASC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * Mark message as delivered
   */
  markDelivered(messageId) {
    const stmt = this.db.prepare(`
      UPDATE inbox
      SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(messageId);
  }

  /**
   * Mark message as failed
   */
  markFailed(messageId, error) {
    const stmt = this.db.prepare(`
      UPDATE inbox
      SET status = 'failed',
          error = ?,
          attempts = attempts + 1,
          last_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(error, messageId);
  }

  /**
   * Increment attempt count
   */
  incrementAttempt(messageId) {
    const stmt = this.db.prepare(`
      UPDATE inbox
      SET attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(messageId);
  }

  /**
   * Get inbox stats for a terminal
   */
  getInboxStats(terminalId) {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM inbox
      WHERE receiver_id = ?
    `);
    return stmt.get(terminalId);
  }

  // =================
  // Trace Operations
  // =================

  /**
   * Create a new trace
   */
  createTrace(traceId, parentTerminalId, name, metadata = null) {
    const stmt = this.db.prepare(`
      INSERT INTO traces (trace_id, parent_terminal_id, name, metadata)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(traceId, parentTerminalId, name, metadata ? JSON.stringify(metadata) : null);
    return traceId;
  }

  /**
   * Get trace by ID
   */
  getTrace(traceId) {
    const stmt = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?');
    const trace = stmt.get(traceId);
    if (trace && trace.metadata) {
      trace.metadata = JSON.parse(trace.metadata);
    }
    return trace;
  }

  /**
   * Complete a trace
   */
  completeTrace(traceId, status = 'completed') {
    const stmt = this.db.prepare(`
      UPDATE traces
      SET status = ?, completed_at = CURRENT_TIMESTAMP
      WHERE trace_id = ?
    `);
    stmt.run(status, traceId);
  }

  /**
   * Add a span to a trace
   */
  addSpan(traceId, terminalId, operation, inputSummary = null, metadata = null) {
    const stmt = this.db.prepare(`
      INSERT INTO spans (trace_id, terminal_id, operation, start_time, input_summary, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      traceId,
      terminalId,
      operation,
      Date.now(),
      inputSummary,
      metadata ? JSON.stringify(metadata) : null
    );
    return result.lastInsertRowid;
  }

  /**
   * Complete a span
   */
  completeSpan(spanId, status = 'completed', outputSummary = null) {
    const stmt = this.db.prepare(`
      UPDATE spans
      SET status = ?, end_time = ?, output_summary = ?
      WHERE id = ?
    `);
    stmt.run(status, Date.now(), outputSummary, spanId);
  }

  /**
   * Get spans for a trace
   */
  getSpans(traceId) {
    const stmt = this.db.prepare(`
      SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time
    `);
    return stmt.all(traceId).map(span => {
      if (span.metadata) span.metadata = JSON.parse(span.metadata);
      return span;
    });
  }

  // =====================
  // Artifact Operations (Shared Memory)
  // =====================

  /**
   * Store an artifact (code, file, output)
   * @param {string} taskId - Task identifier
   * @param {string} key - Unique key within the task
   * @param {string} content - The artifact content
   * @param {Object} options - Additional options
   * @param {string} options.type - Artifact type (code, file, output, plan)
   * @param {string} options.agentId - ID of the agent storing the artifact
   * @param {Object} options.metadata - Additional metadata
   * @returns {string} - Artifact ID
   */
  storeArtifact(taskId, key, content, options = {}) {
    const { type = 'code', agentId = null, metadata = {} } = options;
    const id = generateId();

    const stmt = this.db.prepare(`
      INSERT INTO artifacts (id, task_id, agent_id, type, key, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, key) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        agent_id = excluded.agent_id,
        updated_at = strftime('%s', 'now')
    `);

    stmt.run(id, taskId, agentId, type, key, content, JSON.stringify(metadata));
    return id;
  }

  /**
   * Get a specific artifact by task ID and key
   * @param {string} taskId - Task identifier
   * @param {string} key - Artifact key
   * @returns {Object|null} - Artifact or null if not found
   */
  getArtifact(taskId, key) {
    const stmt = this.db.prepare(`
      SELECT * FROM artifacts WHERE task_id = ? AND key = ?
    `);
    const row = stmt.get(taskId, key);

    if (row && row.metadata) {
      row.metadata = JSON.parse(row.metadata);
    }
    return row || null;
  }

  /**
   * Get all artifacts for a task
   * @param {string} taskId - Task identifier
   * @param {Object} options - Filter options
   * @param {string} options.type - Filter by artifact type
   * @returns {Array} - Array of artifacts
   */
  getArtifacts(taskId, options = {}) {
    const { type } = options;

    let sql = `SELECT * FROM artifacts WHERE task_id = ?`;
    const params = [taskId];

    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }

    sql += ` ORDER BY created_at DESC`;

    return this.db.prepare(sql).all(...params).map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
  }

  /**
   * Delete a specific artifact
   * @param {string} taskId - Task identifier
   * @param {string} key - Artifact key
   * @returns {boolean} - True if deleted
   */
  deleteArtifact(taskId, key) {
    const stmt = this.db.prepare(`DELETE FROM artifacts WHERE task_id = ? AND key = ?`);
    const result = stmt.run(taskId, key);
    return result.changes > 0;
  }

  // =====================
  // Finding Operations (Shared Memory)
  // =====================

  /**
   * Store a finding (insight, bug, issue)
   * @param {string} taskId - Task identifier
   * @param {string} agentId - ID of the agent storing the finding
   * @param {string} content - The finding description
   * @param {Object} options - Additional options
   * @param {string} options.type - Finding type (bug, security, performance, suggestion)
   * @param {string} options.severity - Severity level (critical, high, medium, low, info)
   * @param {string} options.agentProfile - Name of the agent profile
   * @param {Object} options.metadata - Additional metadata (file, line, etc.)
   * @returns {string} - Finding ID
   */
  storeFinding(taskId, agentId, content, options = {}) {
    const {
      type = 'suggestion',
      severity = 'info',
      agentProfile = null,
      metadata = {}
    } = options;

    const id = generateId();

    const stmt = this.db.prepare(`
      INSERT INTO findings (id, task_id, agent_id, agent_profile, type, severity, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, taskId, agentId, agentProfile, type, severity, content, JSON.stringify(metadata));
    return id;
  }

  /**
   * Get findings for a task
   * @param {string} taskId - Task identifier
   * @param {Object} options - Filter options
   * @param {string} options.type - Filter by finding type
   * @param {string} options.severity - Filter by severity
   * @returns {Array} - Array of findings
   */
  getFindings(taskId, options = {}) {
    const { type, severity } = options;

    let sql = `SELECT * FROM findings WHERE task_id = ?`;
    const params = [taskId];

    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }

    if (severity) {
      sql += ` AND severity = ?`;
      params.push(severity);
    }

    sql += ` ORDER BY created_at DESC`;

    return this.db.prepare(sql).all(...params).map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
  }

  /**
   * Get a specific finding by ID
   * @param {string} id - Finding ID
   * @returns {Object|null} - Finding or null if not found
   */
  getFinding(id) {
    const stmt = this.db.prepare(`SELECT * FROM findings WHERE id = ?`);
    const row = stmt.get(id);

    if (row && row.metadata) {
      row.metadata = JSON.parse(row.metadata);
    }
    return row || null;
  }

  /**
   * Delete a specific finding
   * @param {string} id - Finding ID
   * @returns {boolean} - True if deleted
   */
  deleteFinding(id) {
    const stmt = this.db.prepare(`DELETE FROM findings WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // =====================
  // Context Operations (Shared Memory)
  // =====================

  /**
   * Store context (conversation summary, decisions)
   * @param {string} taskId - Task identifier
   * @param {string} agentId - ID of the agent storing the context
   * @param {Object} context - Context object
   * @param {string} context.summary - Summary of the conversation/work
   * @param {Array} context.keyDecisions - List of key decisions made
   * @param {Array} context.pendingItems - List of pending items
   * @returns {string} - Context ID
   */
  storeContext(taskId, agentId, context) {
    const { summary, keyDecisions = [], pendingItems = [] } = context;
    const id = generateId();

    const stmt = this.db.prepare(`
      INSERT INTO context (id, task_id, agent_id, summary, key_decisions, pending_items)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      taskId,
      agentId,
      summary,
      JSON.stringify(keyDecisions),
      JSON.stringify(pendingItems)
    );

    return id;
  }

  /**
   * Get context for a task
   * @param {string} taskId - Task identifier
   * @returns {Array} - Array of context entries (newest first)
   */
  getContext(taskId) {
    const rows = this.db.prepare(`
      SELECT * FROM context WHERE task_id = ? ORDER BY created_at DESC
    `).all(taskId);

    return rows.map(r => ({
      ...r,
      keyDecisions: JSON.parse(r.key_decisions || '[]'),
      pendingItems: JSON.parse(r.pending_items || '[]')
    }));
  }

  /**
   * Get the latest context entry for a task
   * @param {string} taskId - Task identifier
   * @returns {Object|null} - Latest context or null
   */
  getLatestContext(taskId) {
    const contexts = this.getContext(taskId);
    return contexts.length > 0 ? contexts[0] : null;
  }

  // =====================
  // Message History Operations
  // =====================

  /**
   * Store a conversation message
   * @param {string} terminalId - Terminal ID
   * @param {string} role - Message role: 'user', 'assistant', 'system', 'tool'
   * @param {string} content - Message content
   * @param {Object} options - Additional options
   * @param {string} options.traceId - Trace ID for multi-agent debugging
   * @param {Object} options.metadata - Additional metadata (model, tokens, etc.)
   * @returns {number} - Message ID
   */
  addMessage(terminalId, role, content, options = {}) {
    const { traceId = null, metadata = {} } = options;

    const stmt = this.db.prepare(`
      INSERT INTO messages (terminal_id, trace_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      terminalId,
      traceId,
      role,
      content,
      JSON.stringify(metadata),
      Date.now() // Milliseconds for proper ordering during fast tool loops
    );

    return result.lastInsertRowid;
  }

  /**
   * Get message history for a terminal
   * @param {string} terminalId - Terminal ID
   * @param {Object} options - Query options
   * @param {number} options.limit - Max messages to return (default: 100)
   * @param {number} options.offset - Offset for pagination
   * @param {string} options.traceId - Filter by trace ID
   * @param {string} options.role - Filter by role
   * @returns {Array} - Array of messages (oldest first)
   */
  getHistory(terminalId, options = {}) {
    const { limit = 100, offset = 0, traceId, role } = options;

    let sql = `SELECT * FROM messages WHERE terminal_id = ?`;
    const params = [terminalId];

    if (traceId) {
      sql += ` AND trace_id = ?`;
      params.push(traceId);
    }

    if (role) {
      sql += ` AND role = ?`;
      params.push(role);
    }

    sql += ` ORDER BY created_at ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params).map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
  }

  /**
   * Get message count for a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {number} - Message count
   */
  getMessageCount(terminalId) {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM messages WHERE terminal_id = ?`);
    return stmt.get(terminalId).count;
  }

  /**
   * Clear messages for a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {number} - Number of deleted messages
   */
  clearMessages(terminalId) {
    const stmt = this.db.prepare(`DELETE FROM messages WHERE terminal_id = ?`);
    return stmt.run(terminalId).changes;
  }

  // =====================
  // Task Memory Operations (Shared Memory)
  // =====================

  /**
   * Get complete shared memory for a task
   * @param {string} taskId - Task identifier
   * @returns {Object} - All shared memory for the task
   */
  getTaskMemory(taskId) {
    return {
      taskId,
      artifacts: this.getArtifacts(taskId),
      findings: this.getFindings(taskId),
      context: this.getContext(taskId)
    };
  }

  /**
   * Clear all memory for a task
   * @param {string} taskId - Task identifier
   * @returns {Object} - Counts of deleted items
   */
  clearTaskMemory(taskId) {
    const artifactCount = this.db.prepare(`DELETE FROM artifacts WHERE task_id = ?`).run(taskId).changes;
    const findingCount = this.db.prepare(`DELETE FROM findings WHERE task_id = ?`).run(taskId).changes;
    const contextCount = this.db.prepare(`DELETE FROM context WHERE task_id = ?`).run(taskId).changes;

    return {
      artifacts: artifactCount,
      findings: findingCount,
      context: contextCount
    };
  }

  /**
   * Clean up old shared memory entries
   * @param {number} olderThanSeconds - Delete entries older than this (default: 24 hours)
   * @returns {Object} - Counts of deleted items
   */
  cleanupMemory(olderThanSeconds = 86400) {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;

    const artifactCount = this.db.prepare(`DELETE FROM artifacts WHERE created_at < ?`).run(cutoff).changes;
    const findingCount = this.db.prepare(`DELETE FROM findings WHERE created_at < ?`).run(cutoff).changes;
    const contextCount = this.db.prepare(`DELETE FROM context WHERE created_at < ?`).run(cutoff).changes;

    return {
      artifacts: artifactCount,
      findings: findingCount,
      context: contextCount
    };
  }

  /**
   * Get statistics about shared memory
   * @returns {Object} - Memory statistics
   */
  getMemoryStats() {
    const artifactCount = this.db.prepare(`SELECT COUNT(*) as count FROM artifacts`).get().count;
    const findingCount = this.db.prepare(`SELECT COUNT(*) as count FROM findings`).get().count;
    const contextCount = this.db.prepare(`SELECT COUNT(*) as count FROM context`).get().count;
    const taskCount = this.db.prepare(`
      SELECT COUNT(DISTINCT task_id) as count FROM (
        SELECT task_id FROM artifacts
        UNION SELECT task_id FROM findings
        UNION SELECT task_id FROM context
      )
    `).get().count;

    return {
      artifacts: artifactCount,
      findings: findingCount,
      context: contextCount,
      tasks: taskCount
    };
  }

  // =====================
  // Discussion Operations (Agent-to-Agent)
  // =====================

  /**
   * Create a new discussion
   * @param {string} id - Discussion ID (UUID)
   * @param {string} initiatorId - Terminal that started the discussion
   * @param {Object} options - Additional options
   * @param {string} options.taskId - Parent task ID
   * @param {string} options.topic - Discussion topic
   * @param {Object} options.metadata - Additional metadata
   * @returns {string} - Discussion ID
   */
  createDiscussion(id, initiatorId, options = {}) {
    const { taskId = null, topic = null, metadata = {} } = options;

    const stmt = this.db.prepare(`
      INSERT INTO discussions (id, task_id, initiator_id, topic, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, taskId, initiatorId, topic, JSON.stringify(metadata), Date.now());
    return id;
  }

  /**
   * Get a discussion by ID
   * @param {string} id - Discussion ID
   * @returns {Object|null} - Discussion or null
   */
  getDiscussion(id) {
    const stmt = this.db.prepare(`SELECT * FROM discussions WHERE id = ?`);
    const row = stmt.get(id);

    if (row && row.metadata) {
      row.metadata = JSON.parse(row.metadata);
    }
    return row || null;
  }

  /**
   * Update discussion status
   * @param {string} id - Discussion ID
   * @param {string} status - New status ('active', 'completed', 'timeout')
   */
  updateDiscussionStatus(id, status) {
    const stmt = this.db.prepare(`
      UPDATE discussions SET status = ?, completed_at = ? WHERE id = ?
    `);
    const completedAt = status !== 'active' ? Date.now() : null;
    stmt.run(status, completedAt, id);
  }

  /**
   * Get discussions by task ID
   * @param {string} taskId - Task ID
   * @returns {Array} - Array of discussions
   */
  getDiscussionsByTask(taskId) {
    const stmt = this.db.prepare(`
      SELECT * FROM discussions WHERE task_id = ? ORDER BY created_at DESC
    `);
    return stmt.all(taskId).map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
  }

  /**
   * Add a discussion message
   * @param {string} discussionId - Discussion ID
   * @param {string} senderId - Sender terminal ID
   * @param {string} content - Message content
   * @param {Object} options - Additional options
   * @param {string} options.receiverId - Specific receiver (null for broadcast)
   * @param {string} options.messageType - Message type ('question', 'answer', 'info')
   * @returns {number} - Message ID
   */
  addDiscussionMessage(discussionId, senderId, content, options = {}) {
    const { receiverId = null, messageType = 'question' } = options;

    const stmt = this.db.prepare(`
      INSERT INTO discussion_messages (discussion_id, sender_id, receiver_id, message_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(discussionId, senderId, receiverId, messageType, content, Date.now());
    return result.lastInsertRowid;
  }

  /**
   * Get a discussion message by ID
   * @param {number} messageId - Message ID
   * @returns {Object|null} - Message or null
   */
  getDiscussionMessageById(messageId) {
    const stmt = this.db.prepare(`SELECT * FROM discussion_messages WHERE id = ?`);
    return stmt.get(messageId) || null;
  }

  /**
   * Get pending messages for a terminal (as receiver)
   * Uses composite index for performance (Codex review recommendation)
   * @param {string} terminalId - Terminal ID
   * @returns {Array} - Array of pending messages
   */
  getPendingDiscussionMessages(terminalId) {
    const stmt = this.db.prepare(`
      SELECT dm.*, d.topic, d.task_id
      FROM discussion_messages dm
      JOIN discussions d ON d.id = dm.discussion_id
      WHERE dm.receiver_id = ? AND dm.status = 'pending'
      ORDER BY dm.created_at ASC
    `);
    return stmt.all(terminalId);
  }

  /**
   * Mark a discussion message as delivered
   * Uses atomic update to prevent duplicate delivery (Codex review recommendation)
   * @param {number} messageId - Message ID
   * @returns {boolean} - True if message was marked (wasn't already delivered)
   */
  markDiscussionMessageDelivered(messageId) {
    const stmt = this.db.prepare(`
      UPDATE discussion_messages
      SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(Date.now(), messageId);
    return result.changes > 0;
  }

  /**
   * Mark a discussion message as read
   * @param {number} messageId - Message ID
   */
  markDiscussionMessageRead(messageId) {
    const stmt = this.db.prepare(`
      UPDATE discussion_messages SET status = 'read' WHERE id = ?
    `);
    stmt.run(messageId);
  }

  /**
   * Get all messages in a discussion
   * @param {string} discussionId - Discussion ID
   * @returns {Array} - Array of messages
   */
  getDiscussionMessages(discussionId) {
    const stmt = this.db.prepare(`
      SELECT * FROM discussion_messages WHERE discussion_id = ?
      ORDER BY created_at ASC
    `);
    return stmt.all(discussionId);
  }

  /**
   * Get active discussions for a terminal
   * @param {string} terminalId - Terminal ID (as initiator or participant)
   * @returns {Array} - Array of active discussions
   */
  getActiveDiscussions(terminalId) {
    const stmt = this.db.prepare(`
      SELECT DISTINCT d.*
      FROM discussions d
      LEFT JOIN discussion_messages dm ON d.id = dm.discussion_id
      WHERE d.status = 'active'
        AND (d.initiator_id = ? OR dm.sender_id = ? OR dm.receiver_id = ?)
      ORDER BY d.created_at DESC
    `);
    return stmt.all(terminalId, terminalId, terminalId).map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
  }

  // =================
  // Utility Methods
  // =================

  /**
   * Run a transaction
   */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  /**
   * Close the database
   */
  close() {
    this.db.close();
  }

  /**
   * Get database stats
   */
  getStats() {
    return {
      terminals: this.db.prepare("SELECT COUNT(*) as count FROM terminals").get().count,
      pendingMessages: this.db.prepare("SELECT COUNT(*) as count FROM inbox WHERE status = 'pending'").get().count,
      activeTraces: this.db.prepare("SELECT COUNT(*) as count FROM traces WHERE status = 'active'").get().count,
      artifacts: this.db.prepare("SELECT COUNT(*) as count FROM artifacts").get().count,
      findings: this.db.prepare("SELECT COUNT(*) as count FROM findings").get().count,
      context: this.db.prepare("SELECT COUNT(*) as count FROM context").get().count,
      messages: this.db.prepare("SELECT COUNT(*) as count FROM messages").get().count
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the database instance
 */
function getDB(options = {}) {
  if (!instance) {
    instance = new OrchestrationDB(options);
  }
  return instance;
}

/**
 * Close and reset the database instance
 */
function closeDB() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

module.exports = {
  OrchestrationDB,
  getDB,
  closeDB
};
