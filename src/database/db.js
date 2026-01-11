/**
 * Database Module - SQLite persistence for cliagents orchestration
 *
 * Uses better-sqlite3 for synchronous operations.
 * Manages terminals, inbox messages, traces, and annotations.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
  // Annotation Operations
  // =====================

  /**
   * Add an annotation
   */
  addAnnotation(workspaceId, terminalId, filePath, type, content, lineStart = null, lineEnd = null) {
    const stmt = this.db.prepare(`
      INSERT INTO annotations (workspace_id, terminal_id, file_path, type, content, line_start, line_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(workspaceId, terminalId, filePath, type, content, lineStart, lineEnd);
    return result.lastInsertRowid;
  }

  /**
   * Get annotations for a workspace
   */
  getAnnotations(workspaceId, filePath = null) {
    let sql = 'SELECT * FROM annotations WHERE workspace_id = ?';
    const params = [workspaceId];

    if (filePath) {
      sql += ' AND file_path = ?';
      params.push(filePath);
    }

    sql += ' ORDER BY file_path, line_start';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * Clear annotations for a workspace
   */
  clearAnnotations(workspaceId) {
    const stmt = this.db.prepare('DELETE FROM annotations WHERE workspace_id = ?');
    stmt.run(workspaceId);
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
      terminals: this.db.prepare('SELECT COUNT(*) as count FROM terminals').get().count,
      pendingMessages: this.db.prepare('SELECT COUNT(*) as count FROM inbox WHERE status = "pending"').get().count,
      activeTraces: this.db.prepare('SELECT COUNT(*) as count FROM traces WHERE status = "active"').get().count,
      annotations: this.db.prepare('SELECT COUNT(*) as count FROM annotations').get().count
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
