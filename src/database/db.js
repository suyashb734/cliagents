/**
 * Database Module - SQLite persistence for cliagents orchestration
 *
 * Uses better-sqlite3 for synchronous operations.
 * Manages terminals, inbox messages, traces, shared memory (artifacts, findings, context),
 * and conversation history (messages).
 */

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Generate a unique ID for shared memory entries
 */
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function parseJsonField(value) {
  if (!value || typeof value !== 'string') {
    return value || null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function normalizeNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUsageConfidence(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'provider_reported' || normalized === 'estimated' || normalized === 'unknown') {
    return normalized;
  }
  return 'unknown';
}

function getUsageMetadataSources(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }
  return [
    metadata,
    metadata.usage,
    metadata.stats,
    metadata.result?.usage,
    metadata.result?.stats
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function getFirstUsageValue(metadata, keys = []) {
  const sources = getUsageMetadataSources(metadata);
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
    }
  }
  return null;
}

function buildUsageRecordFromMessage(terminalRow, terminalId, role, metadata = {}, options = {}) {
  if (role !== 'assistant') {
    return null;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const inputTokens = getFirstUsageValue(metadata, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const outputTokens = getFirstUsageValue(metadata, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'candidateTokens', 'candidate_tokens']);
  const reasoningTokens = getFirstUsageValue(metadata, ['reasoningTokens', 'reasoning_tokens']);
  const cachedInputTokens = getFirstUsageValue(metadata, ['cachedInputTokens', 'cached_input_tokens']);
  const totalTokens = getFirstUsageValue(metadata, ['totalTokens', 'total_tokens']);
  const costUsd = getFirstUsageValue(metadata, ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd']);
  const durationMs = getFirstUsageValue(metadata, ['durationMs', 'duration_ms']);
  const adapter = getFirstUsageValue(metadata, ['adapter']) || terminalRow?.adapter || null;
  const provider = getFirstUsageValue(metadata, ['provider']) || null;
  const model = getFirstUsageValue(metadata, ['model']) || null;
  const runId = getFirstUsageValue(metadata, ['runId', 'run_id']) || null;
  const participantId = getFirstUsageValue(metadata, ['participantId', 'participant_id']) || null;
  const sourceConfidence = getFirstUsageValue(metadata, ['sourceConfidence', 'source_confidence'])
    || (metadata.usageEstimated ? 'estimated' : 'provider_reported');

  const hasUsageSignal = [
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    costUsd,
    durationMs
  ].some((value) => value !== null && value !== undefined);

  if (!hasUsageSignal) {
    return null;
  }

  const normalizedInputTokens = normalizeInteger(inputTokens, 0);
  const normalizedOutputTokens = normalizeInteger(outputTokens, 0);
  const normalizedReasoningTokens = normalizeInteger(reasoningTokens, 0);
  const normalizedCachedInputTokens = normalizeInteger(cachedInputTokens, 0);
  const normalizedTotalTokens = normalizeInteger(
    totalTokens,
    normalizedInputTokens + normalizedOutputTokens + normalizedReasoningTokens
  );

  return {
    rootSessionId: terminalRow?.root_session_id || terminalRow?.rootSessionId || terminalId,
    terminalId,
    runId,
    participantId,
    adapter,
    provider,
    model,
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    reasoningTokens: normalizedReasoningTokens,
    cachedInputTokens: normalizedCachedInputTokens,
    totalTokens: normalizedTotalTokens,
    costUsd: normalizeNullableNumber(costUsd),
    durationMs: normalizeInteger(durationMs, 0),
    sourceConfidence: normalizeUsageConfidence(sourceConfidence),
    metadata,
    createdAt: Date.now()
  };
}

function buildUsageWhereClause(options = {}) {
  const clauses = [];
  const params = [];

  if (options.rootSessionId) {
    clauses.push('root_session_id = ?');
    params.push(options.rootSessionId);
  }
  if (options.terminalId) {
    clauses.push('terminal_id = ?');
    params.push(options.terminalId);
  }
  if (options.runId) {
    clauses.push('run_id = ?');
    params.push(options.runId);
  }
  if (options.participantId) {
    clauses.push('participant_id = ?');
    params.push(options.participantId);
  }

  return {
    whereSql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function wrapDatabase(db) {
  return {
    exec(sql) {
      return db.exec(sql);
    },
    run(sql, ...params) {
      const result = db.prepare(sql).run(...params);
      return {
        ...result,
        lastID: result.lastInsertRowid
      };
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params);
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    prepare(sql) {
      return db.prepare(sql);
    },
    transaction(fn) {
      return db.transaction(fn);
    },
    pragma(...args) {
      return db.pragma(...args);
    },
    close() {
      return db.close();
    }
  };
}

class OrchestrationDB {
  /**
   * Create a database instance and run migrations synchronously.
   */
  constructor(options = {}) {
    const dataDir = options.dataDir || path.join(process.cwd(), 'data');
    const dbPath = options.dbPath || path.join(dataDir, 'cliagents.db');
    const schemaPath = options.schemaPath || path.join(__dirname, 'schema.sql');
    const migrationsDir = options.migrationsDir || path.join(__dirname, 'migrations');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const rawDb = new BetterSqlite3(dbPath);
    this.db = wrapDatabase(rawDb);

    // Initialize database pragmas
    this.db.pragma('journal_mode = WAL');

    // Run migrations
    this._runMigrations(schemaPath, migrationsDir);
  }

  /**
   * Run database migrations
   */
  _runMigrations(schemaPath, migrationsDir) {
    this._ensureSchemaMigrationsTable();
    this._applySchemaBaseline(schemaPath);
    this._applyFileMigrations(migrationsDir);

    // Legacy compatibility migration: Remove FK constraint from messages table.
    this._migrateMessagesTableRemoveFK();
  }

  /**
   * Ensure migration tracking table exists.
   */
  _ensureSchemaMigrationsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * Compute checksum for schema and migration files.
   */
  _computeChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Lookup an applied migration record.
   */
  _getAppliedMigration(version) {
    return this.db.get(
      'SELECT version, checksum, applied_at FROM schema_migrations WHERE version = ?',
      version
    );
  }

  /**
   * Record a migration as applied.
   */
  _recordMigration(version, checksum) {
    this.db.run(
      'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)',
      version,
      checksum
    );
  }

  /**
   * Apply the schema baseline once, then rely on ordered migration files.
   */
  _applySchemaBaseline(schemaPath) {
    const baselineVersion = '000000000000_schema_baseline';
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const checksum = this._computeChecksum(schema);
    const appliedBaseline = this._getAppliedMigration(baselineVersion);

    if (appliedBaseline) {
      if (appliedBaseline.checksum !== checksum) {
        console.warn(
          '[db] schema.sql checksum changed after baseline was recorded; ' +
          'ensure new changes are also represented as ordered migrations for existing databases.'
        );
      }
      return;
    }

    // Preserve previous behavior for pre-migration-runner databases by applying the
    // baseline exactly once before versioned migrations take over.
    this.db.exec(schema);
    this._recordMigration(baselineVersion, checksum);
  }

  /**
   * Apply ordered SQL migration files from the migrations directory.
   */
  _applyFileMigrations(migrationsDir) {
    if (!fs.existsSync(migrationsDir)) {
      return;
    }

    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      const checksum = this._computeChecksum(sql);
      const appliedMigration = this._getAppliedMigration(file);

      if (appliedMigration) {
        if (appliedMigration.checksum !== checksum) {
          throw new Error(
            '[db] Applied migration checksum mismatch for ' + file + '. ' +
            'Existing databases require a new migration file instead of mutating an applied one.'
          );
        }
        continue;
      }

      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this._recordMigration(file, checksum);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /**
   * Migration: Recreate messages table without FOREIGN KEY constraint
   * This allows messages to persist for auditing even after terminals are deleted
   */
  _migrateMessagesTableRemoveFK() {
    try {
      // Check if messages table has FK constraint by examining table schema
      const tableInfo = this.db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'");

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
  registerTerminal(terminalId, sessionName, windowName, adapter, agentProfile = null, role = 'worker', workDir = null, logPath = null, options = {}) {
    const terminalOptions = options && typeof options === 'object' ? options : {};
    const sessionMetadata = terminalOptions.sessionMetadata
      ? (typeof terminalOptions.sessionMetadata === 'string'
        ? terminalOptions.sessionMetadata
        : JSON.stringify(terminalOptions.sessionMetadata))
      : null;
    const rootSessionId = terminalOptions.rootSessionId || terminalId;
    const parentSessionId = terminalOptions.parentSessionId || null;
    const sessionKind = terminalOptions.sessionKind || 'legacy';
    const originClient = terminalOptions.originClient || 'legacy';
    const externalSessionRef = terminalOptions.externalSessionRef || null;
    const lineageDepth = Number.isInteger(terminalOptions.lineageDepth) && terminalOptions.lineageDepth >= 0
      ? terminalOptions.lineageDepth
      : (parentSessionId ? 1 : 0);
    const harnessSessionId = terminalOptions.harnessSessionId || terminalId;
    const providerThreadRef = terminalOptions.providerThreadRef || null;
    const adoptedAt = terminalOptions.adoptedAt || null;
    const captureMode = terminalOptions.captureMode || 'raw-tty';

    this.db.run(`
      INSERT INTO terminals (
        terminal_id,
        session_name,
        window_name,
        adapter,
        agent_profile,
        role,
        work_dir,
        log_path,
        root_session_id,
        parent_session_id,
        session_kind,
        origin_client,
        external_session_ref,
        lineage_depth,
        session_metadata,
        harness_session_id,
        provider_thread_ref,
        adopted_at,
        capture_mode
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    terminalId,
    sessionName,
    windowName,
    adapter,
    agentProfile,
    role,
    workDir,
    logPath,
    rootSessionId,
    parentSessionId,
    sessionKind,
    originClient,
    externalSessionRef,
    lineageDepth,
    sessionMetadata,
    harnessSessionId,
    providerThreadRef,
    adoptedAt,
    captureMode);

    return terminalId;
  }

  /**
   * Find a terminal row by tmux session/window target.
   */
  findTerminalByTmuxTarget(sessionName, windowName) {
    return this.db.get(`
      SELECT * FROM terminals
      WHERE session_name = ? AND window_name = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, sessionName, windowName);
  }

  /**
   * Get terminal by ID
   */
  getTerminal(terminalId) {
    return this.db.get('SELECT * FROM terminals WHERE terminal_id = ?', terminalId);
  }

  /**
   * Update terminal status
   */
  updateStatus(terminalId, status) {
    this.db.run(`
      UPDATE terminals
      SET status = ?, last_active = CURRENT_TIMESTAMP
      WHERE terminal_id = ?
    `, status, terminalId);
  }

  /**
   * Rebind a terminal row to a different control-plane/root context.
   */
  updateTerminalBinding(terminalId, options = {}) {
    const terminalOptions = options && typeof options === 'object' ? options : {};
    const sessionMetadata = terminalOptions.sessionMetadata == null
      ? null
      : (typeof terminalOptions.sessionMetadata === 'string'
        ? terminalOptions.sessionMetadata
        : JSON.stringify(terminalOptions.sessionMetadata));

    this.db.run(`
      UPDATE terminals
      SET
        adapter = COALESCE(?, adapter),
        role = COALESCE(?, role),
        work_dir = COALESCE(?, work_dir),
        log_path = COALESCE(?, log_path),
        root_session_id = COALESCE(?, root_session_id),
        parent_session_id = ?,
        session_kind = COALESCE(?, session_kind),
        origin_client = COALESCE(?, origin_client),
        external_session_ref = ?,
        lineage_depth = COALESCE(?, lineage_depth),
        session_metadata = COALESCE(?, session_metadata),
        harness_session_id = COALESCE(?, harness_session_id),
        provider_thread_ref = ?,
        adopted_at = COALESCE(?, adopted_at),
        capture_mode = COALESCE(?, capture_mode),
        status = COALESCE(?, status),
        last_active = CURRENT_TIMESTAMP
      WHERE terminal_id = ?
    `,
    terminalOptions.adapter || null,
    terminalOptions.role || null,
    terminalOptions.workDir || null,
    terminalOptions.logPath || null,
    terminalOptions.rootSessionId || null,
    terminalOptions.parentSessionId === undefined ? null : terminalOptions.parentSessionId,
    terminalOptions.sessionKind || null,
    terminalOptions.originClient || null,
    terminalOptions.externalSessionRef === undefined ? null : terminalOptions.externalSessionRef,
    Number.isInteger(terminalOptions.lineageDepth) ? terminalOptions.lineageDepth : null,
    sessionMetadata,
    terminalOptions.harnessSessionId || null,
    terminalOptions.providerThreadRef === undefined ? null : terminalOptions.providerThreadRef,
    terminalOptions.adoptedAt || null,
    terminalOptions.captureMode || null,
    terminalOptions.status || null,
    terminalId);
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

    if (options.rootSessionId) {
      sql += params.length ? ' AND root_session_id = ?' : ' WHERE root_session_id = ?';
      params.push(options.rootSessionId);
    }

    if (options.parentSessionId) {
      sql += params.length ? ' AND parent_session_id = ?' : ' WHERE parent_session_id = ?';
      params.push(options.parentSessionId);
    }

    if (options.sessionKind) {
      sql += params.length ? ' AND session_kind = ?' : ' WHERE session_kind = ?';
      params.push(options.sessionKind);
    }

    sql += ' ORDER BY created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    return this.db.all(sql, ...params);
  }

  /**
   * List orphaned terminal rows ordered oldest-first.
   */
  listOrphanedTerminals(options = {}) {
    const terminalOptions = options && typeof options === 'object' ? options : {};
    const clauses = ['status = ?'];
    const params = ['orphaned'];

    if (Number.isInteger(terminalOptions.olderThanHours) && terminalOptions.olderThanHours > 0) {
      clauses.push(`created_at < datetime('now', '-' || ? || ' hours')`);
      params.push(terminalOptions.olderThanHours);
    }

    if (terminalOptions.adapter) {
      clauses.push('adapter = ?');
      params.push(terminalOptions.adapter);
    }

    let sql = `SELECT * FROM terminals WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`;
    if (terminalOptions.limit) {
      sql += ' LIMIT ?';
      params.push(terminalOptions.limit);
    }

    return this.db.all(sql, ...params);
  }

  /**
   * Delete orphaned terminal rows older than the provided threshold.
   */
  pruneOrphanedTerminals(options = {}) {
    const terminalOptions = options && typeof options === 'object' ? options : {};
    const olderThanHours = Number.isInteger(terminalOptions.olderThanHours) && terminalOptions.olderThanHours > 0
      ? terminalOptions.olderThanHours
      : 24 * 7;
    const limit = Number.isInteger(terminalOptions.limit) && terminalOptions.limit > 0
      ? terminalOptions.limit
      : 500;

    const rows = this.listOrphanedTerminals({
      olderThanHours,
      adapter: terminalOptions.adapter || null,
      limit
    });

    if (!rows.length) {
      return {
        deletedCount: 0,
        terminals: []
      };
    }

    for (const row of rows) {
      const terminalId = row.terminal_id || row.terminalId;
      const rootSessionId = row.root_session_id || row.rootSessionId || terminalId;
      const originClient = row.origin_client || row.originClient || 'legacy';
      const sessionMetadata = parseJsonField(row.session_metadata || row.sessionMetadata);

      this.addSessionEvent({
        rootSessionId,
        sessionId: terminalId,
        parentSessionId: row.parent_session_id || row.parentSessionId || null,
        eventType: 'session_destroyed',
        originClient,
        idempotencyKey: `${rootSessionId}:${terminalId}:session_destroyed:prune`,
        payloadSummary: `${row.adapter || 'terminal'} session destroyed during prune`,
        payloadJson: {
          adapter: row.adapter || null,
          status: row.status || 'orphaned',
          reason: 'historical-orphan-prune'
        },
        metadata: sessionMetadata && typeof sessionMetadata === 'object' ? sessionMetadata : null
      });
    }

    const deleteRows = this.db.transaction((terminalIds) => {
      const deleteTerminal = this.db.prepare('DELETE FROM terminals WHERE terminal_id = ?');
      for (const terminalId of terminalIds) {
        deleteTerminal.run(terminalId);
      }
    });

    deleteRows(rows.map((row) => row.terminal_id || row.terminalId));

    return {
      deletedCount: rows.length,
      terminals: rows
    };
  }

  /**
   * List root sessions that have persisted control-plane events.
   */
  listRootSessions(options = {}) {
    const sessionOptions = options && typeof options === 'object' ? options : {};
    const params = [];
    let sql = `
      SELECT
        root_session_id,
        MAX(recorded_at) AS last_recorded_at,
        MAX(occurred_at) AS last_occurred_at,
        COUNT(*) AS event_count
      FROM session_events
    `;

    if (sessionOptions.originClient) {
      sql += ' WHERE origin_client = ?';
      params.push(sessionOptions.originClient);
    }

    sql += `
      GROUP BY root_session_id
      ORDER BY last_recorded_at DESC, last_occurred_at DESC, root_session_id DESC
    `;

    if (sessionOptions.limit) {
      sql += ' LIMIT ?';
      params.push(sessionOptions.limit);
    }

    return this.db.all(sql, ...params);
  }

  /**
   * Find the latest root session associated with a client/session reference.
   */
  findLatestRootSessionByClientRef(options = {}) {
    const sessionOptions = options && typeof options === 'object' ? options : {};
    const originClient = sessionOptions.originClient || null;
    const externalSessionRef = sessionOptions.externalSessionRef || null;
    const clientName = sessionOptions.clientName || null;

    if (!originClient && !externalSessionRef && !clientName) {
      return null;
    }

    const clauses = [
      'event_type = ?',
      'root_session_id = session_id'
    ];
    const params = ['session_started'];

    if (originClient) {
      clauses.push('origin_client = ?');
      params.push(originClient);
    }

    const rows = this.db.all(`
      SELECT *
      FROM session_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY recorded_at DESC, occurred_at DESC, id DESC
      LIMIT 200
    `, ...params);

    for (const row of rows) {
      const payload = parseJsonField(row.payload_json) || {};
      const metadata = parseJsonField(row.metadata) || {};
      const attachMode = String(payload.attachMode || metadata.attachMode || '').trim().toLowerCase();
      const rowExternalSessionRef =
        payload.externalSessionRef ||
        payload.clientSessionRef ||
        metadata.externalSessionRef ||
        metadata.clientSessionRef ||
        null;
      const rowClientName =
        payload.clientName ||
        metadata.clientName ||
        null;

      if (externalSessionRef && rowExternalSessionRef !== externalSessionRef) {
        continue;
      }

      if (!externalSessionRef && clientName && rowClientName !== clientName) {
        continue;
      }

      if (attachMode.startsWith('implicit')) {
        continue;
      }

      return {
        ...row,
        payload_json: payload,
        metadata,
        root_session_id: row.root_session_id
      };
    }

    return null;
  }

  /**
   * Delete terminal
   */
  deleteTerminal(terminalId) {
    this.db.run('DELETE FROM terminals WHERE terminal_id = ?', terminalId);
  }

  /**
   * Get the next session-event sequence number for a root session.
   */
  getNextSessionEventSequence(rootSessionId) {
    const row = this.db.get(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
      FROM session_events
      WHERE root_session_id = ?
    `, rootSessionId);
    return row?.next_sequence || 1;
  }

  /**
   * Add a durable session event with per-root ordering and idempotency.
   */
  addSessionEvent(event = {}) {
    const eventInput = event && typeof event === 'object' ? event : {};
    if (!eventInput.rootSessionId) {
      throw new Error('rootSessionId is required');
    }
    if (!eventInput.sessionId) {
      throw new Error('sessionId is required');
    }
    if (!eventInput.eventType) {
      throw new Error('eventType is required');
    }

    const payloadJson = eventInput.payloadJson == null
      ? null
      : (typeof eventInput.payloadJson === 'string'
        ? eventInput.payloadJson
        : JSON.stringify(eventInput.payloadJson));
    const metadata = eventInput.metadata == null
      ? null
      : (typeof eventInput.metadata === 'string'
        ? eventInput.metadata
        : JSON.stringify(eventInput.metadata));
    const payloadSummary = eventInput.payloadSummary || null;
    const occurredAt = Number.isFinite(eventInput.occurredAt) ? eventInput.occurredAt : Date.now();
    const idempotencyKey = eventInput.idempotencyKey
      || `${eventInput.rootSessionId}:${eventInput.sessionId}:${eventInput.eventType}:${generateId()}`;

    const insertEvent = this.db.transaction(() => {
      const existing = this.db.get(`
        SELECT *
        FROM session_events
        WHERE idempotency_key = ?
      `, idempotencyKey);
      if (existing) {
        return existing;
      }

      const sequenceNo = Number.isInteger(eventInput.sequenceNo) && eventInput.sequenceNo > 0
        ? eventInput.sequenceNo
        : this.getNextSessionEventSequence(eventInput.rootSessionId);
      const id = eventInput.id || `se_${generateId()}`;

      this.db.run(`
        INSERT INTO session_events (
          id,
          idempotency_key,
          root_session_id,
          session_id,
          parent_session_id,
          run_id,
          discussion_id,
          trace_id,
          parent_event_id,
          event_type,
          sequence_no,
          origin_client,
          payload_summary,
          payload_json,
          metadata,
          occurred_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      idempotencyKey,
      eventInput.rootSessionId,
      eventInput.sessionId,
      eventInput.parentSessionId || null,
      eventInput.runId || null,
      eventInput.discussionId || null,
      eventInput.traceId || null,
      eventInput.parentEventId || null,
      eventInput.eventType,
      sequenceNo,
      eventInput.originClient || null,
      payloadSummary,
      payloadJson,
      metadata,
      occurredAt);

      return this.db.get('SELECT * FROM session_events WHERE id = ?', id);
    });

    const row = insertEvent();
    if (!row) {
      return null;
    }

    return {
      ...row,
      payload_json: parseJsonField(row.payload_json),
      metadata: parseJsonField(row.metadata)
    };
  }

  /**
   * List session events ordered for replay.
   */
  listSessionEvents(options = {}) {
    const eventOptions = options && typeof options === 'object' ? options : {};
    const clauses = [];
    const params = [];

    if (eventOptions.rootSessionId) {
      clauses.push('root_session_id = ?');
      params.push(eventOptions.rootSessionId);
    }

    if (eventOptions.sessionId) {
      clauses.push('session_id = ?');
      params.push(eventOptions.sessionId);
    }

    if (eventOptions.runId) {
      clauses.push('run_id = ?');
      params.push(eventOptions.runId);
    }

    if (eventOptions.discussionId) {
      clauses.push('discussion_id = ?');
      params.push(eventOptions.discussionId);
    }

    if (Number.isInteger(eventOptions.afterSequenceNo) && eventOptions.afterSequenceNo >= 0) {
      clauses.push('sequence_no > ?');
      params.push(eventOptions.afterSequenceNo);
    }

    let sql = 'SELECT * FROM session_events';
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }

    sql += ' ORDER BY sequence_no ASC, occurred_at ASC, recorded_at ASC, id ASC';
    if (eventOptions.limit) {
      sql += ' LIMIT ?';
      params.push(eventOptions.limit);
    }

    return this.db.all(sql, ...params).map((row) => ({
      ...row,
      payload_json: parseJsonField(row.payload_json),
      metadata: parseJsonField(row.metadata)
    }));
  }

  /**
   * Clean up stale terminals
   */
  cleanupStaleTerminals(maxAgeHours = 24) {
    const result = this.db.run(`
      DELETE FROM terminals
      WHERE last_active < datetime('now', '-' || ? || ' hours')
    `, maxAgeHours);
    return result.changes;
  }

  // =================
  // Inbox Operations
  // =================

  /**
   * Queue a message for delivery
   */
  queueMessage(senderId, receiverId, message, priority = 0) {
    const result = this.db.run(`
      INSERT INTO inbox (sender_id, receiver_id, message, priority)
      VALUES (?, ?, ?, ?)
    `, senderId, receiverId, message, priority);
    return result.lastID;
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

    return this.db.all(sql, ...params);
  }

  /**
   * Mark message as delivered
   */
  markDelivered(messageId) {
    this.db.run(`
      UPDATE inbox
      SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, messageId);
  }

  /**
   * Mark message as failed
   */
  markFailed(messageId, error) {
    this.db.run(`
      UPDATE inbox
      SET status = 'failed',
          error = ?,
          attempts = attempts + 1,
          last_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, error, messageId);
  }

  /**
   * Increment attempt count
   */
  incrementAttempt(messageId) {
    this.db.run(`
      UPDATE inbox
      SET attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, messageId);
  }

  /**
   * Get inbox stats for a terminal
   */
  getInboxStats(terminalId) {
    return this.db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM inbox
      WHERE receiver_id = ?
    `, terminalId);
  }

  // =================
  // Trace Operations
  // =================

  /**
   * Create a new trace
   */
  createTrace(traceId, parentTerminalId, name, metadata = null) {
    this.db.run(`
      INSERT INTO traces (trace_id, parent_terminal_id, name, metadata)
      VALUES (?, ?, ?, ?)
    `, traceId, parentTerminalId, name, metadata ? JSON.stringify(metadata) : null);
    return traceId;
  }

  /**
   * Get trace by ID
   */
  getTrace(traceId) {
    const trace = this.db.get('SELECT * FROM traces WHERE trace_id = ?', traceId);
    if (trace && trace.metadata) {
      trace.metadata = JSON.parse(trace.metadata);
    }
    return trace;
  }

  /**
   * Complete a trace
   */
  completeTrace(traceId, status = 'completed') {
    this.db.run(`
      UPDATE traces
      SET status = ?, completed_at = CURRENT_TIMESTAMP
      WHERE trace_id = ?
    `, status, traceId);
  }

  /**
   * Add a span to a trace
   */
  addSpan(traceId, terminalId, operation, inputSummary = null, metadata = null) {
    const result = this.db.run(`
      INSERT INTO spans (trace_id, terminal_id, operation, start_time, input_summary, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      traceId,
      terminalId,
      operation,
      Date.now(),
      inputSummary,
      metadata ? JSON.stringify(metadata) : null
    );
    return result.lastID;
  }

  /**
   * Complete a span
   */
  completeSpan(spanId, status = 'completed', outputSummary = null) {
    this.db.run(`
      UPDATE spans
      SET status = ?, end_time = ?, output_summary = ?
      WHERE id = ?
    `, status, Date.now(), outputSummary, spanId);
  }

  /**
   * Get spans for a trace
   */
  getSpans(traceId) {
    const spans = this.db.all(`
      SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time
    `, traceId);
    return spans.map(span => {
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

    this.db.run(`
      INSERT INTO artifacts (id, task_id, agent_id, type, key, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, key) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        agent_id = excluded.agent_id,
        updated_at = strftime('%s', 'now')
    `,
      id, taskId, agentId, type, key, content, JSON.stringify(metadata));
    return id;
  }

  /**
   * Get a specific artifact by task ID and key
   * @param {string} taskId - Task identifier
   * @param {string} key - Artifact key
   * @returns {Object|null} - Artifact or null if not found
   */
  getArtifact(taskId, key) {
    const row = this.db.get(`
      SELECT * FROM artifacts WHERE task_id = ? AND key = ?
    `, taskId, key);

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

    const rows = this.db.all(sql, ...params);
    return rows.map(r => ({
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
    const result = this.db.run(`DELETE FROM artifacts WHERE task_id = ? AND key = ?`, taskId, key);
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

    this.db.run(`
      INSERT INTO findings (id, task_id, agent_id, agent_profile, type, severity, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      id, taskId, agentId, agentProfile, type, severity, content, JSON.stringify(metadata));

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

    const rows = this.db.all(sql, ...params);
    return rows.map(r => ({
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
    const row = this.db.get(`SELECT * FROM findings WHERE id = ?`, id);

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
    const result = this.db.run(`DELETE FROM findings WHERE id = ?`, id);
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

    const terminalRow = this.getTerminal(terminalId);
    const usageRecord = buildUsageRecordFromMessage(terminalRow, terminalId, role, metadata, {
      traceId
    });
    if (usageRecord) {
      this.addUsageRecord(usageRecord);
    }

    return result.lastInsertRowid;
  }

  /**
   * Store one normalized usage record.
   */
  addUsageRecord(record = {}) {
    const usage = record && typeof record === 'object' ? record : {};
    if (!usage.terminalId) {
      throw new Error('terminalId is required');
    }

    const metadataJson = usage.metadata == null
      ? null
      : (typeof usage.metadata === 'string'
        ? usage.metadata
        : JSON.stringify(usage.metadata));
    const createdAt = Number.isFinite(usage.createdAt) ? usage.createdAt : Date.now();

    const result = this.db.run(`
      INSERT INTO usage_records (
        root_session_id,
        terminal_id,
        run_id,
        participant_id,
        adapter,
        provider,
        model,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_input_tokens,
        total_tokens,
        cost_usd,
        duration_ms,
        source_confidence,
        metadata,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    usage.rootSessionId || null,
    usage.terminalId,
    usage.runId || null,
    usage.participantId || null,
    usage.adapter || null,
    usage.provider || null,
    usage.model || null,
    normalizeInteger(usage.inputTokens, 0),
    normalizeInteger(usage.outputTokens, 0),
    normalizeInteger(usage.reasoningTokens, 0),
    normalizeInteger(usage.cachedInputTokens, 0),
    normalizeInteger(
      usage.totalTokens,
      normalizeInteger(usage.inputTokens, 0) + normalizeInteger(usage.outputTokens, 0) + normalizeInteger(usage.reasoningTokens, 0)
    ),
    normalizeNullableNumber(usage.costUsd),
    normalizeNullableNumber(usage.durationMs),
    normalizeUsageConfidence(usage.sourceConfidence || 'unknown'),
    metadataJson,
    createdAt);

    return result.lastID;
  }

  /**
   * List persisted usage records.
   */
  listUsageRecords(options = {}) {
    const usageOptions = options && typeof options === 'object' ? options : {};
    const { whereSql, params } = buildUsageWhereClause(usageOptions);
    const limit = Number.isInteger(usageOptions.limit) && usageOptions.limit > 0 ? usageOptions.limit : 200;
    const offset = Number.isInteger(usageOptions.offset) && usageOptions.offset >= 0 ? usageOptions.offset : 0;

    const rows = this.db.all(`
      SELECT *
      FROM usage_records
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);

    return rows.map((row) => ({
      ...row,
      metadata: parseJsonField(row.metadata)
    }));
  }

  /**
   * Aggregate usage totals for a scope.
   */
  summarizeUsage(options = {}) {
    const usageOptions = options && typeof options === 'object' ? options : {};
    const { whereSql, params } = buildUsageWhereClause(usageOptions);
    const row = this.db.get(`
      SELECT
        COUNT(*) AS record_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM usage_records
      ${whereSql}
    `, ...params) || {};

    return {
      recordCount: row.record_count || 0,
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      reasoningTokens: row.reasoning_tokens || 0,
      cachedInputTokens: row.cached_input_tokens || 0,
      totalTokens: row.total_tokens || 0,
      costUsd: row.cost_usd || 0,
      durationMs: row.duration_ms || 0
    };
  }

  /**
   * Group usage by adapter, provider, model, or source confidence.
   */
  listUsageBreakdown(options = {}) {
    const usageOptions = options && typeof options === 'object' ? options : {};
    const groupBy = String(usageOptions.groupBy || '').trim().toLowerCase();
    const allowedGroupBy = new Map([
      ['adapter', 'adapter'],
      ['provider', 'provider'],
      ['model', 'model'],
      ['sourceconfidence', 'source_confidence']
    ]);
    const groupColumn = allowedGroupBy.get(groupBy);
    if (!groupColumn) {
      return [];
    }

    const { whereSql, params } = buildUsageWhereClause(usageOptions);
    const limit = Number.isInteger(usageOptions.limit) && usageOptions.limit > 0 ? usageOptions.limit : 20;
    return this.db.all(`
      SELECT
        COALESCE(${groupColumn}, 'unknown') AS bucket,
        COUNT(*) AS record_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM usage_records
      ${whereSql}
      GROUP BY COALESCE(${groupColumn}, 'unknown')
      ORDER BY total_tokens DESC, record_count DESC, bucket ASC
      LIMIT ?
    `, ...params, limit).map((row) => ({
      key: row.bucket,
      recordCount: row.record_count || 0,
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      reasoningTokens: row.reasoning_tokens || 0,
      cachedInputTokens: row.cached_input_tokens || 0,
      totalTokens: row.total_tokens || 0,
      costUsd: row.cost_usd || 0,
      durationMs: row.duration_ms || 0
    }));
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
   * Get the most recent message for a terminal.
   * @param {string} terminalId - Terminal ID
   * @param {Object} options - Query options
   * @param {string} options.traceId - Filter by trace ID
   * @param {string} options.role - Filter by role
   * @returns {Object|null} - Most recent message or null
   */
  getLatestMessage(terminalId, options = {}) {
    const { traceId, role } = options;

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

    sql += ` ORDER BY created_at DESC LIMIT 1`;

    const row = this.db.prepare(sql).get(...params);
    if (!row) {
      return null;
    }

    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    };
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
   * Get discussion messages created after a specific message ID.
   * @param {number} afterId - Last seen discussion message ID
   * @param {Object} options - Query options
   * @param {number} options.limit - Max messages to return
   * @returns {Array} - Array of discussion messages
   */
  listDiscussionMessagesSince(afterId = 0, options = {}) {
    const limit = Math.max(1, Number(options.limit || 100));
    const stmt = this.db.prepare(`
      SELECT dm.*, d.topic, d.task_id
      FROM discussion_messages dm
      JOIN discussions d ON d.id = dm.discussion_id
      WHERE dm.id > ?
      ORDER BY dm.id ASC
      LIMIT ?
    `);
    return stmt.all(Number(afterId) || 0, limit);
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
      messages: this.db.prepare("SELECT COUNT(*) as count FROM messages").get().count,
      usageRecords: this.db.prepare("SELECT COUNT(*) as count FROM usage_records").get().count
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
