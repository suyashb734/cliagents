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

function normalizeUsageTotalTokens(value, fallback = 0) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return normalizeInteger(value, fallback);
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
    metadata.responseMetadata,
    metadata.responseMetadata?.usage,
    metadata.responseMetadata?.stats,
    metadata.sendMetadata,
    metadata.sendMetadata?.usage,
    metadata.sendMetadata?.stats,
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

function mergeUsageMetadata(metadata = {}, overlay = {}) {
  const merged = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...metadata }
    : {};

  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') {
      merged[key] = value;
    }
  }

  return merged;
}

function buildUsageRecordFromMetadata(context = {}, metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const usageMetadata = mergeUsageMetadata(metadata, {
    runId: context.runId || null,
    participantId: context.participantId || null,
    adapter: context.adapter || null,
    provider: context.provider || null,
    model: context.model || null,
    sourceConfidence: context.sourceConfidence || null
  });

  const inputTokens = getFirstUsageValue(usageMetadata, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const outputTokens = getFirstUsageValue(usageMetadata, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'candidateTokens', 'candidate_tokens']);
  const reasoningTokens = getFirstUsageValue(usageMetadata, ['reasoningTokens', 'reasoning_tokens']);
  const cachedInputTokens = getFirstUsageValue(usageMetadata, ['cachedInputTokens', 'cached_input_tokens']);
  const totalTokens = getFirstUsageValue(usageMetadata, ['totalTokens', 'total_tokens']);
  const costUsd = getFirstUsageValue(usageMetadata, ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd']);
  const durationMs = getFirstUsageValue(usageMetadata, ['durationMs', 'duration_ms']);
  const adapter = getFirstUsageValue(usageMetadata, ['adapter']) || context.adapter || null;
  const provider = getFirstUsageValue(usageMetadata, ['provider']) || context.provider || null;
  const model = getFirstUsageValue(usageMetadata, ['model']) || context.model || null;
  const runId = getFirstUsageValue(usageMetadata, ['runId', 'run_id']) || context.runId || null;
  const participantId = getFirstUsageValue(usageMetadata, ['participantId', 'participant_id']) || context.participantId || null;
  const usageEstimated = getFirstUsageValue(usageMetadata, ['usageEstimated', 'usage_estimated']);
  const sourceConfidence = getFirstUsageValue(usageMetadata, ['sourceConfidence', 'source_confidence'])
    || context.sourceConfidence
    || (usageEstimated ? 'estimated' : 'provider_reported');

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
  const normalizedTotalTokens = normalizeUsageTotalTokens(
    totalTokens,
    normalizedInputTokens + normalizedOutputTokens + normalizedReasoningTokens
  );

  const terminalId = String(context.terminalId || '').trim();
  if (!terminalId) {
    return null;
  }

  return {
    rootSessionId: context.rootSessionId || null,
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
    metadata: usageMetadata,
    createdAt: Number.isFinite(context.createdAt) ? context.createdAt : Date.now()
  };
}

function buildUsageRecordFromMessage(terminalRow, terminalId, role, metadata = {}, options = {}) {
  if (role !== 'assistant') {
    return null;
  }

  return buildUsageRecordFromMetadata({
    rootSessionId: terminalRow?.root_session_id || terminalRow?.rootSessionId || terminalId,
    terminalId,
    adapter: terminalRow?.adapter || null,
    createdAt: options.createdAt
  }, metadata);
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

const MEMORY_SNAPSHOT_SCOPES = new Set(['run', 'root']);
const MEMORY_SNAPSHOT_GENERATION_TRIGGERS = new Set(['run_completed', 'root_refresh', 'repair', 'manual']);
const MEMORY_SNAPSHOT_GENERATION_STRATEGIES = new Set(['rule_based']);
const ROOM_TURN_ACTIVE_STATUSES = new Set(['pending', 'running']);
const ROOM_TURN_TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed']);
const DEFAULT_ROOM_TURN_STALE_MS = 30 * 60 * 1000;
function clampLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function truncateText(value, maxLength = 1500) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 16)).trimEnd()}... [truncated]`;
}

function dedupeStrings(values = [], maxItems = Infinity) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function inferAdapterFromOriginClient(originClient, fallbackAdapter = null) {
  const normalizedOriginClient = String(originClient || '').trim().toLowerCase();
  if (normalizedOriginClient === 'codex') return 'codex-cli';
  if (normalizedOriginClient === 'claude') return 'claude-code';
  if (normalizedOriginClient === 'gemini') return 'gemini-cli';
  if (normalizedOriginClient === 'qwen') return 'qwen-cli';
  if (normalizedOriginClient === 'opencode') return 'opencode-cli';
  return fallbackAdapter || null;
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
      const columns = this.db.prepare('PRAGMA table_info(messages)').all();

      if (!tableInfo || !tableInfo.sql) {
        return; // Table doesn't exist yet, schema.sql will create it correctly
      }

      // If table has FOREIGN KEY, migrate it
      if (tableInfo.sql.includes('FOREIGN KEY')) {
        console.log('[db] Migrating messages table to remove FK constraint...');

        const hasRootSessionId = columns.some((column) => column.name === 'root_session_id');
        const columnList = [
          'id',
          'terminal_id',
          'trace_id',
          ...(hasRootSessionId ? ['root_session_id'] : []),
          'role',
          'content',
          'metadata',
          'created_at'
        ];
        const rootSessionIdColumnSql = hasRootSessionId ? 'root_session_id TEXT,\n            ' : '';
        const rootSessionIdIndexSql = hasRootSessionId
          ? 'CREATE INDEX IF NOT EXISTS idx_messages_root_session_created ON messages(root_session_id, created_at);'
          : '';

        this.db.exec('SAVEPOINT migrate_messages_remove_fk');
        try {
          this.db.exec(`
            -- Remove any stale temp table from a previously interrupted migration.
            DROP TABLE IF EXISTS messages_new;

            -- Create new table without FK
            CREATE TABLE messages_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              terminal_id TEXT NOT NULL,
              trace_id TEXT,
              ${rootSessionIdColumnSql}role TEXT NOT NULL,
              content TEXT NOT NULL,
              metadata TEXT,
              created_at INTEGER NOT NULL
            );

            -- Copy data
            INSERT INTO messages_new (${columnList.join(', ')})
            SELECT ${columnList.join(', ')} FROM messages;

            -- Drop old table
            DROP TABLE messages;

            -- Rename new table
            ALTER TABLE messages_new RENAME TO messages;

            -- Recreate indexes
            CREATE INDEX IF NOT EXISTS idx_messages_terminal_created ON messages(terminal_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);
            ${rootSessionIdIndexSql}
          `);
          this.db.exec('RELEASE SAVEPOINT migrate_messages_remove_fk');
        } catch (migrationError) {
          try {
            this.db.exec('ROLLBACK TO SAVEPOINT migrate_messages_remove_fk');
            this.db.exec('RELEASE SAVEPOINT migrate_messages_remove_fk');
          } catch {}
          throw migrationError;
        }

        console.log('[db] Messages table migrated successfully');
      }
    } catch (error) {
      if (error.message.includes('no such table')) {
        return;
      }
      if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
        console.warn('[db] Skipping messages table FK migration due to transient SQLite lock:', error.message);
        return;
      }
      console.error('[db] Migration error:', error.message);
      throw error;
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
    const model = terminalOptions.model || null;
    const lastMessageAt = Number.isFinite(terminalOptions.lastMessageAt) ? terminalOptions.lastMessageAt : null;

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
        capture_mode,
        model,
        last_message_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    captureMode,
    model,
    lastMessageAt);

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
        model = COALESCE(?, model),
        last_message_at = COALESCE(?, last_message_at),
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
    terminalOptions.model || null,
    Number.isFinite(terminalOptions.lastMessageAt) ? terminalOptions.lastMessageAt : null,
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

    sql += ` ORDER BY
      COALESCE(last_message_at, CAST(strftime('%s', last_active) AS INTEGER) * 1000, CAST(strftime('%s', created_at) AS INTEGER) * 1000) DESC,
      created_at DESC`;

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
    const clauses = [];
    let sql = `
      WITH roots AS (
        SELECT DISTINCT root_session_id
        FROM session_events
        WHERE root_session_id IS NOT NULL AND TRIM(root_session_id) <> ''
        UNION
        SELECT DISTINCT root_session_id
        FROM terminals
        WHERE root_session_id IS NOT NULL AND TRIM(root_session_id) <> ''
        UNION
        SELECT DISTINCT root_session_id
        FROM messages
        WHERE root_session_id IS NOT NULL AND TRIM(root_session_id) <> ''
      )
      SELECT
        roots.root_session_id,
        (
          SELECT MAX(recorded_at)
          FROM session_events se
          WHERE se.root_session_id = roots.root_session_id
        ) AS last_recorded_at,
        (
          SELECT MAX(occurred_at)
          FROM session_events se
          WHERE se.root_session_id = roots.root_session_id
        ) AS last_occurred_at,
        (
          SELECT COUNT(*)
          FROM session_events se
          WHERE se.root_session_id = roots.root_session_id
        ) AS event_count,
        COALESCE(
          (
            SELECT MAX(created_at)
            FROM messages m
            WHERE m.root_session_id = roots.root_session_id
          ),
          (
            SELECT MAX(last_message_at)
            FROM terminals t
            WHERE t.root_session_id = roots.root_session_id
          )
        ) AS last_message_at,
        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.root_session_id = roots.root_session_id
        ) AS message_count
      FROM roots
    `;

    if (sessionOptions.originClient) {
      clauses.push(`(
        EXISTS (
          SELECT 1
          FROM terminals t
          WHERE t.root_session_id = roots.root_session_id
            AND t.origin_client = ?
        )
        OR EXISTS (
          SELECT 1
          FROM session_events se
          WHERE se.root_session_id = roots.root_session_id
            AND se.origin_client = ?
        )
      )`);
      params.push(sessionOptions.originClient, sessionOptions.originClient);
    }

    if (clauses.length) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }

    sql += `
      ORDER BY COALESCE(last_message_at, last_occurred_at, last_recorded_at) DESC, root_session_id DESC
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

    if (externalSessionRef) {
      const terminalClauses = [
        'external_session_ref = ?',
        'root_session_id IS NOT NULL',
        "TRIM(root_session_id) <> ''",
        '(parent_session_id IS NULL OR terminal_id = root_session_id)'
      ];
      const terminalParams = [externalSessionRef];

      if (originClient) {
        terminalClauses.push('origin_client = ?');
        terminalParams.push(originClient);
      }

      const terminalRows = this.db.all(`
        SELECT *
        FROM terminals
        WHERE ${terminalClauses.join(' AND ')}
        ORDER BY
          CASE
            WHEN session_kind = 'main' THEN 0
            WHEN session_kind = 'attach' THEN 1
            ELSE 2
          END ASC,
          COALESCE(last_message_at, CAST(strftime('%s', last_active) AS INTEGER) * 1000, CAST(strftime('%s', created_at) AS INTEGER) * 1000) DESC,
          created_at DESC,
          terminal_id DESC
        LIMIT 50
      `, ...terminalParams);

      for (const row of terminalRows) {
        const metadata = parseJsonField(row.session_metadata) || {};
        const rowClientName = metadata.clientName || null;
        if (clientName && rowClientName && rowClientName !== clientName) {
          continue;
        }

        return {
          ...row,
          metadata,
          payload_json: null,
          root_session_id: row.root_session_id
        };
      }
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

  findRootTerminalByProviderThreadRef(adapter, providerThreadRef) {
    const normalizedProviderThreadRef = String(providerThreadRef || '').trim();
    if (!normalizedProviderThreadRef) {
      return null;
    }

    const clauses = [
      'provider_thread_ref = ?',
      'root_session_id IS NOT NULL',
      "TRIM(root_session_id) <> ''",
      '(parent_session_id IS NULL OR terminal_id = root_session_id)'
    ];
    const params = [normalizedProviderThreadRef];

    if (adapter) {
      clauses.push('adapter = ?');
      params.push(adapter);
    }

    return this.db.get(`
      SELECT *
      FROM terminals
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE
          WHEN session_kind = 'main' THEN 0
          WHEN session_kind = 'attach' THEN 1
          ELSE 2
        END ASC,
        COALESCE(last_message_at, CAST(strftime('%s', last_active) AS INTEGER) * 1000, CAST(strftime('%s', created_at) AS INTEGER) * 1000) DESC,
        created_at DESC,
        terminal_id DESC
      LIMIT 1
    `, ...params) || null;
  }

  touchTerminalMessage(terminalId, options = {}) {
    const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
    const model = String(options.model || '').trim() || null;
    const result = this.db.run(`
      UPDATE terminals
      SET
        model = COALESCE(?, model),
        last_message_at = CASE
          WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
          ELSE last_message_at
        END,
        last_active = CURRENT_TIMESTAMP
      WHERE terminal_id = ?
    `, model, timestamp, timestamp, terminalId);
    return result.changes > 0;
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
    const { traceId = null, metadata = {}, rootSessionId: explicitRootSessionId = null } = options;
    const terminalRow = this.getTerminal(terminalId);

    const stmt = this.db.prepare(`
      INSERT INTO messages (terminal_id, trace_id, root_session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const createdAt = Date.now(); // Milliseconds for proper ordering during fast tool loops
    const result = stmt.run(
      terminalId,
      traceId,
      explicitRootSessionId || terminalRow?.root_session_id || null,
      role,
      content,
      JSON.stringify(metadata),
      createdAt
    );

    this.touchTerminalMessage(terminalId, {
      timestamp: createdAt,
      model: metadata?.model || null
    });

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
    normalizeUsageTotalTokens(
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

  addUsageRecordFromMetadata(input = {}) {
    const usageInput = input && typeof input === 'object' ? input : {};
    const terminalId = String(usageInput.terminalId || '').trim();
    if (!terminalId) {
      return null;
    }

    const metadata = usageInput.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const usageRecord = buildUsageRecordFromMetadata({
      rootSessionId: usageInput.rootSessionId || null,
      terminalId,
      runId: usageInput.runId || null,
      participantId: usageInput.participantId || null,
      adapter: usageInput.adapter || null,
      provider: usageInput.provider || null,
      model: usageInput.model || null,
      sourceConfidence: usageInput.sourceConfidence || null,
      createdAt: usageInput.createdAt
    }, metadata);

    if (!usageRecord) {
      return null;
    }

    return this.addUsageRecord(usageRecord);
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

  // =====================
  // Persistent Room State
  // =====================

  _parseRoomRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      rootSessionId: row.root_session_id,
      title: row.title || null,
      status: row.status || 'active',
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _parseRoomParticipantRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      roomId: row.room_id,
      adapter: row.adapter,
      displayName: row.display_name || null,
      model: row.model || null,
      systemPrompt: row.system_prompt || null,
      workDir: row.work_dir || null,
      providerSessionId: row.provider_session_id || null,
      status: row.status || 'active',
      lastMessageAt: row.last_message_at || null,
      importedFromProviderSessionId: row.imported_from_provider_session_id || null,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _parseRoomTurnRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      roomId: row.room_id,
      sequenceNo: row.sequence_no,
      requestId: row.request_id || null,
      initiatorRole: row.initiator_role,
      initiatorName: row.initiator_name || null,
      content: row.content,
      mentions: parseJsonField(row.mentions_json) || [],
      status: row.status,
      error: row.error || null,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      updatedAt: row.updated_at
    };
  }

  _parseRoomMessageRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      roomId: row.room_id,
      turnId: row.turn_id || null,
      sequenceNo: row.sequence_no,
      participantId: row.participant_id || null,
      role: row.role,
      content: row.content,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at
    };
  }

  createRoom(input = {}) {
    const id = String(input.id || `room_${generateId()}`).trim();
    const rootSessionId = String(input.rootSessionId || '').trim();
    const title = String(input.title || '').trim() || null;
    const status = String(input.status || 'active').trim().toLowerCase() || 'active';
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();

    if (!id) {
      throw new Error('room id is required');
    }
    if (!rootSessionId) {
      throw new Error('rootSessionId is required');
    }

    this.db.prepare(`
      INSERT INTO rooms (id, root_session_id, title, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      rootSessionId,
      title,
      status,
      JSON.stringify(metadata),
      now,
      now
    );

    return this.getRoom(id);
  }

  getRoom(roomId) {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    return this._parseRoomRow(row);
  }

  getRoomByRootSessionId(rootSessionId) {
    const row = this.db.prepare('SELECT * FROM rooms WHERE root_session_id = ?').get(rootSessionId);
    return this._parseRoomRow(row);
  }

  updateRoom(roomId, patch = {}) {
    const updates = [];
    const params = [];
    if (patch.title !== undefined) {
      updates.push('title = ?');
      params.push(String(patch.title || '').trim() || null);
    }
    if (patch.status !== undefined) {
      updates.push('status = ?');
      params.push(String(patch.status || '').trim().toLowerCase() || 'active');
    }
    if (patch.metadata !== undefined) {
      const metadata = patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
        ? patch.metadata
        : {};
      updates.push('metadata = ?');
      params.push(JSON.stringify(metadata));
    }

    const updatedAt = Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now();
    updates.push('updated_at = ?');
    params.push(updatedAt);
    params.push(roomId);

    this.db.prepare(`
      UPDATE rooms
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params);
    return this.getRoom(roomId);
  }

  listRooms(options = {}) {
    const clauses = [];
    const params = [];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(options.limit, 20, 100);
    return this.db.prepare(`
      SELECT *
      FROM rooms
      ${whereSql}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit).map((row) => this._parseRoomRow(row));
  }

  addRoomParticipant(input = {}) {
    const id = String(input.id || `participant_${generateId()}`).trim();
    const roomId = String(input.roomId || '').trim();
    const adapter = String(input.adapter || '').trim();
    const displayName = String(input.displayName || '').trim() || null;
    const model = String(input.model || '').trim() || null;
    const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt : null;
    const workDir = String(input.workDir || '').trim() || null;
    const providerSessionId = String(input.providerSessionId || '').trim() || null;
    const status = String(input.status || 'active').trim().toLowerCase() || 'active';
    const importedFromProviderSessionId = String(input.importedFromProviderSessionId || '').trim() || null;
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
    const lastMessageAt = Number.isFinite(input.lastMessageAt) ? input.lastMessageAt : null;

    if (!roomId) {
      throw new Error('roomId is required');
    }
    if (!adapter) {
      throw new Error('adapter is required');
    }

    this.db.prepare(`
      INSERT INTO room_participants (
        id, room_id, adapter, display_name, model, system_prompt, work_dir,
        provider_session_id, status, last_message_at, imported_from_provider_session_id,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      roomId,
      adapter,
      displayName,
      model,
      systemPrompt,
      workDir,
      providerSessionId,
      status,
      lastMessageAt,
      importedFromProviderSessionId,
      JSON.stringify(metadata),
      now,
      now
    );

    this.updateRoom(roomId, { updatedAt: now });
    return this.getRoomParticipant(id);
  }

  getRoomParticipant(participantId) {
    const row = this.db.prepare('SELECT * FROM room_participants WHERE id = ?').get(participantId);
    return this._parseRoomParticipantRow(row);
  }

  listRoomParticipants(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const params = [roomId];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const sql = `
      SELECT *
      FROM room_participants
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        COALESCE(last_message_at, updated_at, created_at) DESC,
        created_at ASC,
        id ASC
    `;
    return this.db.prepare(sql).all(...params).map((row) => this._parseRoomParticipantRow(row));
  }

  getRoomParticipantsByIds(roomId, participantIds = []) {
    const ids = Array.from(new Set((Array.isArray(participantIds) ? participantIds : []).map((value) => String(value || '').trim()).filter(Boolean)));
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT *
      FROM room_participants
      WHERE room_id = ? AND id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(roomId, ...ids).map((row) => this._parseRoomParticipantRow(row));
  }

  updateRoomParticipant(participantId, patch = {}) {
    const updates = [];
    const params = [];
    if (patch.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(String(patch.displayName || '').trim() || null);
    }
    if (patch.model !== undefined) {
      updates.push('model = ?');
      params.push(String(patch.model || '').trim() || null);
    }
    if (patch.systemPrompt !== undefined) {
      updates.push('system_prompt = ?');
      params.push(typeof patch.systemPrompt === 'string' ? patch.systemPrompt : null);
    }
    if (patch.workDir !== undefined) {
      updates.push('work_dir = ?');
      params.push(String(patch.workDir || '').trim() || null);
    }
    if (patch.providerSessionId !== undefined) {
      updates.push('provider_session_id = ?');
      params.push(String(patch.providerSessionId || '').trim() || null);
    }
    if (patch.status !== undefined) {
      updates.push('status = ?');
      params.push(String(patch.status || '').trim().toLowerCase() || 'active');
    }
    if (patch.lastMessageAt !== undefined) {
      updates.push('last_message_at = ?');
      params.push(Number.isFinite(patch.lastMessageAt) ? patch.lastMessageAt : null);
    }
    if (patch.importedFromProviderSessionId !== undefined) {
      updates.push('imported_from_provider_session_id = ?');
      params.push(String(patch.importedFromProviderSessionId || '').trim() || null);
    }
    if (patch.metadata !== undefined) {
      const metadata = patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
        ? patch.metadata
        : {};
      updates.push('metadata = ?');
      params.push(JSON.stringify(metadata));
    }

    const updatedAt = Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now();
    updates.push('updated_at = ?');
    params.push(updatedAt);
    params.push(participantId);

    this.db.prepare(`
      UPDATE room_participants
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params);

    const participant = this.getRoomParticipant(participantId);
    if (participant?.roomId) {
      this.updateRoom(participant.roomId, { updatedAt });
    }
    return participant;
  }

  getNextRoomTurnSequence(roomId) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
      FROM room_turns
      WHERE room_id = ?
    `).get(roomId);
    return row?.next_sequence || 1;
  }

  getNextRoomMessageSequence(roomId) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
      FROM room_messages
      WHERE room_id = ?
    `).get(roomId);
    return row?.next_sequence || 1;
  }

  getRoomTurn(turnId) {
    const row = this.db.prepare('SELECT * FROM room_turns WHERE id = ?').get(turnId);
    return this._parseRoomTurnRow(row);
  }

  getRoomTurnByRequestId(roomId, requestId) {
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedRequestId) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT *
      FROM room_turns
      WHERE room_id = ? AND request_id = ?
      LIMIT 1
    `).get(roomId, normalizedRequestId);
    return this._parseRoomTurnRow(row);
  }

  getLatestActiveRoomTurn(roomId) {
    const placeholders = Array.from(ROOM_TURN_ACTIVE_STATUSES).map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT *
      FROM room_turns
      WHERE room_id = ? AND status IN (${placeholders})
      ORDER BY sequence_no DESC, updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(roomId, ...Array.from(ROOM_TURN_ACTIVE_STATUSES));
    return this._parseRoomTurnRow(row);
  }

  expireStaleRoomTurns(roomId, options = {}) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) {
      return 0;
    }

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const staleMs = Number.isFinite(options.staleMs)
      ? options.staleMs
      : DEFAULT_ROOM_TURN_STALE_MS;
    if (staleMs <= 0) {
      return 0;
    }

    const cutoff = now - staleMs;
    const placeholders = Array.from(ROOM_TURN_ACTIVE_STATUSES).map(() => '?').join(', ');
    const result = this.db.prepare(`
      UPDATE room_turns
      SET
        status = 'failed',
        error = COALESCE(error, 'Room turn expired after broker restart or timeout'),
        completed_at = COALESCE(completed_at, ?),
        updated_at = ?
      WHERE room_id = ?
        AND status IN (${placeholders})
        AND updated_at < ?
    `).run(now, now, normalizedRoomId, ...Array.from(ROOM_TURN_ACTIVE_STATUSES), cutoff);
    return result.changes || 0;
  }

  getLatestRoomTurn(roomId) {
    const row = this.db.prepare(`
      SELECT *
      FROM room_turns
      WHERE room_id = ?
      ORDER BY sequence_no DESC, updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(roomId);
    return this._parseRoomTurnRow(row);
  }

  createRoomTurn(input = {}) {
    const roomId = String(input.roomId || '').trim();
    const content = String(input.content || '').trim();
    const initiatorRole = String(input.initiatorRole || 'user').trim().toLowerCase() || 'user';
    const initiatorName = String(input.initiatorName || '').trim() || null;
    const requestId = String(input.requestId || '').trim() || null;
    const mentions = Array.isArray(input.mentions)
      ? Array.from(new Set(input.mentions.map((value) => String(value || '').trim()).filter(Boolean)))
      : [];
    const status = String(input.status || 'pending').trim().toLowerCase() || 'pending';
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();

    if (!roomId) {
      throw new Error('roomId is required');
    }
    if (!content) {
      throw new Error('content is required');
    }

    const activeTurnStaleMs = Number.isFinite(input.activeTurnStaleMs)
      ? input.activeTurnStaleMs
      : DEFAULT_ROOM_TURN_STALE_MS;

    const create = this.db.transaction(() => {
      const existing = requestId ? this.getRoomTurnByRequestId(roomId, requestId) : null;
      if (existing) {
        return {
          ...existing,
          reusedRequest: true
        };
      }

      this.expireStaleRoomTurns(roomId, {
        now,
        staleMs: activeTurnStaleMs
      });

      const activeTurn = this.getLatestActiveRoomTurn(roomId);
      if (activeTurn) {
        const error = new Error(`room ${roomId} is already processing turn ${activeTurn.id}`);
        error.code = 'room_busy';
        error.roomId = roomId;
        error.turnId = activeTurn.id;
        throw error;
      }

      const id = String(input.id || `turn_${generateId()}`).trim();
      const sequenceNo = Number.isInteger(input.sequenceNo) && input.sequenceNo > 0
        ? input.sequenceNo
        : this.getNextRoomTurnSequence(roomId);
      this.db.prepare(`
        INSERT INTO room_turns (
          id, room_id, sequence_no, request_id, initiator_role, initiator_name,
          content, mentions_json, status, error, metadata, created_at, started_at,
          completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        roomId,
        sequenceNo,
        requestId,
        initiatorRole,
        initiatorName,
        content,
        JSON.stringify(mentions),
        status,
        null,
        JSON.stringify(metadata),
        now,
        status === 'running' ? now : null,
        ROOM_TURN_TERMINAL_STATUSES.has(status) ? now : null,
        now
      );
      this.updateRoom(roomId, { updatedAt: now });
      return this.getRoomTurn(id);
    });

    return create.immediate();
  }

  updateRoomTurn(turnId, patch = {}) {
    const existing = this.getRoomTurn(turnId);
    if (!existing) {
      return null;
    }

    const updates = [];
    const params = [];
    if (patch.status !== undefined) {
      updates.push('status = ?');
      params.push(String(patch.status || '').trim().toLowerCase() || existing.status);
    }
    if (patch.error !== undefined) {
      updates.push('error = ?');
      params.push(String(patch.error || '').trim() || null);
    }
    if (patch.mentions !== undefined) {
      const mentions = Array.isArray(patch.mentions)
        ? Array.from(new Set(patch.mentions.map((value) => String(value || '').trim()).filter(Boolean)))
        : [];
      updates.push('mentions_json = ?');
      params.push(JSON.stringify(mentions));
    }
    if (patch.metadata !== undefined) {
      const metadata = patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
        ? patch.metadata
        : {};
      updates.push('metadata = ?');
      params.push(JSON.stringify(metadata));
    }
    if (patch.startedAt !== undefined) {
      updates.push('started_at = ?');
      params.push(Number.isFinite(patch.startedAt) ? patch.startedAt : null);
    }
    if (patch.completedAt !== undefined) {
      updates.push('completed_at = ?');
      params.push(Number.isFinite(patch.completedAt) ? patch.completedAt : null);
    }

    const updatedAt = Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now();
    updates.push('updated_at = ?');
    params.push(updatedAt);
    params.push(turnId);

    this.db.prepare(`
      UPDATE room_turns
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params);
    this.updateRoom(existing.roomId, { updatedAt });
    return this.getRoomTurn(turnId);
  }

  addRoomMessage(input = {}) {
    const roomId = String(input.roomId || '').trim();
    const turnId = String(input.turnId || '').trim() || null;
    const participantId = String(input.participantId || '').trim() || null;
    const role = String(input.role || '').trim().toLowerCase();
    const content = String(input.content || '').trim();
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();

    if (!roomId) {
      throw new Error('roomId is required');
    }
    if (!role) {
      throw new Error('role is required');
    }
    if (!content) {
      throw new Error('content is required');
    }

    const insert = this.db.transaction(() => {
      const sequenceNo = Number.isInteger(input.sequenceNo) && input.sequenceNo > 0
        ? input.sequenceNo
        : this.getNextRoomMessageSequence(roomId);
      const result = this.db.prepare(`
        INSERT INTO room_messages (
          room_id, turn_id, sequence_no, participant_id, role, content, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        roomId,
        turnId,
        sequenceNo,
        participantId,
        role,
        content,
        JSON.stringify(metadata),
        createdAt
      );

      if (participantId) {
        this.updateRoomParticipant(participantId, {
          lastMessageAt: createdAt,
          updatedAt: createdAt
        });
      } else {
        this.updateRoom(roomId, { updatedAt: createdAt });
      }

      const row = this.db.prepare('SELECT * FROM room_messages WHERE id = ?').get(result.lastInsertRowid);
      return this._parseRoomMessageRow(row);
    });

    return insert.immediate();
  }

  listRoomMessages(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const params = [roomId];
    if (Number.isInteger(options.afterId) && options.afterId > 0) {
      clauses.push('id > ?');
      params.push(options.afterId);
    }
    if (options.turnId) {
      clauses.push('turn_id = ?');
      params.push(options.turnId);
    }
    const artifactMode = String(options.artifactMode || 'exclude').trim().toLowerCase();
    if (artifactMode === 'exclude') {
      clauses.push(`COALESCE(json_extract(metadata, '$.discussionArtifact'), 0) != 1`);
    } else if (artifactMode === 'only') {
      clauses.push(`COALESCE(json_extract(metadata, '$.discussionArtifact'), 0) = 1`);
    }
    const limit = clampLimit(options.limit, 100, 500);
    return this.db.prepare(`
      SELECT *
      FROM room_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY id ASC
      LIMIT ?
    `).all(...params, limit).map((row) => this._parseRoomMessageRow(row));
  }

  countRoomMessages(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const params = [roomId];
    const artifactMode = String(options.artifactMode || 'include').trim().toLowerCase();
    if (artifactMode === 'exclude') {
      clauses.push(`COALESCE(json_extract(metadata, '$.discussionArtifact'), 0) != 1`);
    } else if (artifactMode === 'only') {
      clauses.push(`COALESCE(json_extract(metadata, '$.discussionArtifact'), 0) = 1`);
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM room_messages
      WHERE ${clauses.join(' AND ')}
    `).get(...params);
    return row?.count || 0;
  }

  getRecentRoomMessages(roomId, limit = 12, options = {}) {
    const clauses = ['room_id = ?'];
    const params = [roomId];
    const artifactMode = String(options.artifactMode || 'exclude').trim().toLowerCase();
    if (artifactMode === 'exclude') {
      clauses.push(`COALESCE(json_extract(metadata, '$.discussionArtifact'), 0) != 1`);
    } else if (artifactMode === 'only') {
      clauses.push(`COALESCE(json_extract(metadata, '$.discussionArtifact'), 0) = 1`);
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM room_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY sequence_no DESC, id DESC
      LIMIT ?
    `).all(...params, clampLimit(limit, 12, 200));
    return rows.reverse().map((row) => this._parseRoomMessageRow(row));
  }

  // =====================
  // Message History Primitive
  // =====================

  _buildMessageSelectorClause(options = {}) {
    const selectors = [];
    if (options.terminalId) {
      selectors.push({ sql: 'terminal_id = ?', value: options.terminalId });
    }
    if (options.rootSessionId) {
      selectors.push({ sql: 'root_session_id = ?', value: options.rootSessionId });
    }
    if (options.traceId) {
      selectors.push({ sql: 'trace_id = ?', value: options.traceId });
    }

    if (selectors.length !== 1) {
      throw new Error('Exactly one of terminalId, rootSessionId, or traceId is required');
    }

    const clauses = [selectors[0].sql];
    const params = [selectors[0].value];

    if (Number.isInteger(options.afterId) && options.afterId > 0) {
      clauses.push('id > ?');
      params.push(options.afterId);
    }

    if (options.role) {
      clauses.push('role = ?');
      params.push(options.role);
    }

    return { clauses, params };
  }

  queryMessages(options = {}) {
    const { clauses, params } = this._buildMessageSelectorClause(options);
    const limit = clampLimit(options.limit, 100, 501);
    const sql = `SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit);
    return rows.map((row) => ({
      ...row,
      metadata: parseJsonField(row.metadata) || {}
    }));
  }

  listFinishedRunsForRepair(limit = 200) {
    return this.db.prepare(`
      SELECT id, root_session_id, task_id
      FROM runs
      WHERE completed_at IS NOT NULL
      ORDER BY completed_at DESC, started_at DESC, id DESC
      LIMIT ?
    `).all(clampLimit(limit, 200, 1000)).map((row) => ({
      id: row.id,
      rootSessionId: row.root_session_id || null,
      taskId: row.task_id || null
    }));
  }

  repairRunRootSessionIds() {
    let repaired = 0;

    const byRunEvent = this.db.run(`
      UPDATE runs
      SET root_session_id = (
        SELECT se.root_session_id
        FROM session_events se
        WHERE se.run_id = runs.id
          AND se.root_session_id IS NOT NULL
          AND TRIM(se.root_session_id) <> ''
        ORDER BY se.occurred_at ASC, se.recorded_at ASC, se.id ASC
        LIMIT 1
      )
      WHERE (runs.root_session_id IS NULL OR TRIM(runs.root_session_id) = '')
        AND EXISTS (
          SELECT 1
          FROM session_events se
          WHERE se.run_id = runs.id
            AND se.root_session_id IS NOT NULL
            AND TRIM(se.root_session_id) <> ''
        )
    `);
    repaired += byRunEvent.changes || 0;

    const byTraceSpan = this.db.run(`
      UPDATE runs
      SET root_session_id = (
        SELECT t.root_session_id
        FROM spans s
        JOIN terminals t ON t.terminal_id = s.terminal_id
        WHERE s.trace_id = runs.trace_id
          AND t.root_session_id IS NOT NULL
          AND TRIM(t.root_session_id) <> ''
        ORDER BY s.start_time ASC, s.id ASC
        LIMIT 1
      )
      WHERE (runs.root_session_id IS NULL OR TRIM(runs.root_session_id) = '')
        AND runs.trace_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM spans s
          JOIN terminals t ON t.terminal_id = s.terminal_id
          WHERE s.trace_id = runs.trace_id
            AND t.root_session_id IS NOT NULL
            AND TRIM(t.root_session_id) <> ''
        )
    `);
    repaired += byTraceSpan.changes || 0;

    return repaired;
  }

  repairMessageRootSessionIds() {
    const result = this.db.run(`
      UPDATE messages
      SET root_session_id = (
        SELECT t.root_session_id
        FROM terminals t
        WHERE t.terminal_id = messages.terminal_id
          AND t.root_session_id IS NOT NULL
          AND TRIM(t.root_session_id) <> ''
        LIMIT 1
      )
      WHERE (messages.root_session_id IS NULL OR TRIM(messages.root_session_id) = '')
        AND EXISTS (
          SELECT 1
          FROM terminals t
          WHERE t.terminal_id = messages.terminal_id
            AND t.root_session_id IS NOT NULL
            AND TRIM(t.root_session_id) <> ''
        )
    `);
    return result.changes || 0;
  }

  repairTerminalLastMessageAt() {
    const result = this.db.run(`
      UPDATE terminals
      SET last_message_at = (
        SELECT MAX(messages.created_at)
        FROM messages
        WHERE messages.terminal_id = terminals.terminal_id
      )
      WHERE EXISTS (
        SELECT 1
        FROM messages
        WHERE messages.terminal_id = terminals.terminal_id
      )
    `);
    return result.changes || 0;
  }

  repairAttachedRootTerminals() {
    const repair = this.db.transaction(() => {
      const rows = this.db.all(`
        SELECT *
        FROM session_events
        WHERE event_type = 'session_started'
          AND root_session_id = session_id
        ORDER BY occurred_at ASC, recorded_at ASC, id ASC
      `);

      let repaired = 0;
      for (const row of rows) {
        const payload = parseJsonField(row.payload_json) || {};
        const metadata = parseJsonField(row.metadata) || {};
        const attachMode = String(payload.attachMode || metadata.attachMode || '').trim().toLowerCase();
        if (!attachMode.includes('attach')) {
          continue;
        }

        const rootSessionId = row.root_session_id;
        if (!rootSessionId) {
          continue;
        }

        const existing = this.getTerminal(rootSessionId);
        const externalSessionRef =
          payload.externalSessionRef ||
          payload.clientSessionRef ||
          metadata.externalSessionRef ||
          metadata.clientSessionRef ||
          null;
        const workDir = metadata.workspaceRoot || payload.workDir || null;
        const model = payload.model || metadata.model || null;
        const adapter = inferAdapterFromOriginClient(
          row.origin_client || metadata.clientName || null,
          'codex-cli'
        );

        if (existing) {
          this.updateTerminalBinding(rootSessionId, {
            adapter,
            role: 'main',
            workDir,
            rootSessionId,
            parentSessionId: null,
            sessionKind: 'attach',
            originClient: row.origin_client || existing.origin_client || 'mcp',
            externalSessionRef,
            lineageDepth: 0,
            sessionMetadata: metadata,
            harnessSessionId: rootSessionId,
            captureMode: existing.capture_mode || 'raw-tty',
            model
          });
          continue;
        }

        this.registerTerminal(
          rootSessionId,
          `attached-${rootSessionId.slice(0, 12)}`,
          'root',
          adapter,
          null,
          'main',
          workDir,
          null,
          {
            rootSessionId,
            parentSessionId: null,
            sessionKind: 'attach',
            originClient: row.origin_client || 'mcp',
            externalSessionRef,
            lineageDepth: 0,
            sessionMetadata: metadata,
            harnessSessionId: rootSessionId,
            providerThreadRef: null,
            captureMode: 'raw-tty',
            model
          }
        );
        repaired += 1;
      }

      return repaired;
    });

    return repair.immediate();
  }

  countMessages(options = {}) {
    const { clauses, params } = this._buildMessageSelectorClause(options);
    const row = this.db.get(
      `SELECT COUNT(*) AS count FROM messages WHERE ${clauses.join(' AND ')}`,
      ...params
    );
    return row?.count || 0;
  }

  // =====================
  // Memory Snapshot Operations
  // =====================

  upsertMemorySnapshot(snapshot = {}) {
    const scope = String(snapshot.scope || '').trim().toLowerCase();
    const scopeId = String(snapshot.scopeId || '').trim();
    const generationTrigger = String(snapshot.generationTrigger || '').trim().toLowerCase();
    const generationStrategy = String(snapshot.generationStrategy || 'rule_based').trim().toLowerCase();

    if (!MEMORY_SNAPSHOT_SCOPES.has(scope)) {
      throw new Error(`Unsupported memory snapshot scope: ${scope || 'unknown'}`);
    }
    if (!scopeId) {
      throw new Error('scopeId is required');
    }
    if (!MEMORY_SNAPSHOT_GENERATION_TRIGGERS.has(generationTrigger)) {
      throw new Error(`Unsupported generation trigger: ${generationTrigger || 'unknown'}`);
    }
    if (!MEMORY_SNAPSHOT_GENERATION_STRATEGIES.has(generationStrategy)) {
      throw new Error(`Unsupported generation strategy: ${generationStrategy || 'unknown'}`);
    }

    const existing = this.getMemorySnapshot(scope, scopeId);
    const id = snapshot.id || existing?.id || generateId();
    const now = Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.now();
    const createdAt = existing?.createdAt || (Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : now);
    const brief = truncateText(snapshot.brief, 1500) || '(no brief available)';

    this.db.run(`
      INSERT INTO memory_snapshots (
        id, scope, scope_id, run_id, root_session_id, task_id,
        brief, key_decisions, pending_items, generation_trigger,
        generation_strategy, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id) DO UPDATE SET
        run_id = excluded.run_id,
        root_session_id = excluded.root_session_id,
        task_id = excluded.task_id,
        brief = excluded.brief,
        key_decisions = excluded.key_decisions,
        pending_items = excluded.pending_items,
        generation_trigger = excluded.generation_trigger,
        generation_strategy = excluded.generation_strategy,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `,
    id,
    scope,
    scopeId,
    snapshot.runId || null,
    snapshot.rootSessionId || null,
    snapshot.taskId || null,
    brief,
    JSON.stringify(dedupeStrings(snapshot.keyDecisions || [], 20)),
    JSON.stringify(dedupeStrings(snapshot.pendingItems || [], 20)),
    generationTrigger,
    generationStrategy,
    snapshot.metadata == null ? null : JSON.stringify(snapshot.metadata),
    createdAt,
    now);

    return id;
  }

  getMemorySnapshot(scope, scopeId) {
    const row = this.db.get(
      'SELECT * FROM memory_snapshots WHERE scope = ? AND scope_id = ?',
      scope,
      scopeId
    );
    return row ? this._parseMemorySnapshotRow(row) : null;
  }

  listMemorySnapshots(options = {}) {
    const clauses = [];
    const params = [];

    if (options.scope) {
      clauses.push('scope = ?');
      params.push(options.scope);
    }
    if (options.rootSessionId) {
      clauses.push('root_session_id = ?');
      params.push(options.rootSessionId);
    }
    if (options.taskId) {
      clauses.push('task_id = ?');
      params.push(options.taskId);
    }
    if (Number.isInteger(options.beforeTimestamp) && options.beforeTimestamp > 0) {
      clauses.push('updated_at < ?');
      params.push(options.beforeTimestamp);
    }

    const limit = clampLimit(options.limit, 20, 100);
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM memory_snapshots ${whereSql} ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit).map((row) => this._parseMemorySnapshotRow(row));
  }

  deleteMemorySnapshot(scope, scopeId) {
    const result = this.db.run('DELETE FROM memory_snapshots WHERE scope = ? AND scope_id = ?', scope, scopeId);
    return result.changes > 0;
  }

  _parseMemorySnapshotRow(row) {
    return {
      id: row.id,
      scope: row.scope,
      scopeId: row.scope_id,
      runId: row.run_id || null,
      rootSessionId: row.root_session_id || null,
      taskId: row.task_id || null,
      brief: row.brief || null,
      keyDecisions: parseJsonField(row.key_decisions) || [],
      pendingItems: parseJsonField(row.pending_items) || [],
      generationTrigger: row.generation_trigger,
      generationStrategy: row.generation_strategy,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      messageHash: row.message_hash,
      inputSummary: row.input_summary,
      workingDirectory: row.working_directory,
      initiator: row.initiator,
      traceId: row.trace_id,
      discussionId: row.discussion_id,
      currentStep: row.current_step,
      activeParticipantCount: row.active_participant_count,
      decisionSummary: row.decision_summary,
      decisionSource: row.decision_source,
      failureClass: row.failure_class,
      retryCount: row.retry_count,
      metadata: parseJsonField(row.metadata),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      rootSessionId: row.root_session_id || null,
      taskId: row.task_id || null
    };
  }

  // =====================
  // Run/Root Bundle Primitives
  // =====================

  getRunsByRootSessionId(rootSessionId, options = {}) {
    const limit = clampLimit(options.limit, 20, 100);
    const rows = this.db.prepare(`
      SELECT * FROM runs
      WHERE root_session_id = ?
      ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
      LIMIT ?
    `).all(rootSessionId, limit);
    return rows.map((row) => this._mapRunRow(row));
  }

  getLatestCompletedRuns(rootSessionId, limit = 20) {
    const rows = this.db.prepare(`
      SELECT * FROM runs
      WHERE root_session_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, started_at DESC, id DESC
      LIMIT ?
    `).all(rootSessionId, clampLimit(limit, 20, 50));
    return rows.map((row) => this._mapRunRow(row));
  }

  getLatestRunsForTask(taskId, limit = 5) {
    const rows = this.db.prepare(`
      SELECT * FROM runs
      WHERE task_id = ?
      ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
      LIMIT ?
    `).all(taskId, clampLimit(limit, 5, 20));
    return rows.map((row) => this._mapRunRow(row));
  }

  getRunById(runId) {
    const run = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
    return run ? this._mapRunRow(run) : null;
  }

  getRunOutputs(runId) {
    return this.db.prepare(`
      SELECT output_kind, preview_text, full_text, created_at
      FROM run_outputs
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId).map((row) => ({
      outputKind: row.output_kind,
      previewText: row.preview_text,
      fullText: row.full_text,
      createdAt: row.created_at
    }));
  }

  getLatestCompletedAtForRoot(rootSessionId) {
    const row = this.db.get(
      `SELECT MAX(completed_at) AS latest_completed_at FROM runs WHERE root_session_id = ? AND completed_at IS NOT NULL`,
      rootSessionId
    );
    return row?.latest_completed_at || null;
  }

  countCompletedRuns(rootSessionId) {
    const row = this.db.get(
      `SELECT COUNT(*) AS count FROM runs WHERE root_session_id = ? AND completed_at IS NOT NULL`,
      rootSessionId
    );
    return row?.count || 0;
  }

  getRootParticipantAdapters(rootSessionId) {
    const rows = this.db.all(`
      SELECT DISTINCT rp.adapter
      FROM run_participants rp
      JOIN runs r ON r.id = rp.run_id
      WHERE r.root_session_id = ? AND rp.adapter IS NOT NULL
      ORDER BY rp.adapter ASC
    `, rootSessionId);
    return rows.map((row) => row.adapter);
  }

  getRootUsageSummary(rootSessionId) {
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
      WHERE root_session_id = ?
    `, rootSessionId);

    return {
      recordCount: row?.record_count || 0,
      inputTokens: row?.input_tokens || 0,
      outputTokens: row?.output_tokens || 0,
      reasoningTokens: row?.reasoning_tokens || 0,
      cachedInputTokens: row?.cached_input_tokens || 0,
      totalTokens: row?.total_tokens || 0,
      costUsd: row?.cost_usd || 0,
      durationMs: row?.duration_ms || 0
    };
  }

  listRunSnapshotsByRoot(rootSessionId, limit = 20) {
    return this.db.prepare(`
      SELECT ms.*, r.kind AS run_kind, r.status AS run_status, r.completed_at
      FROM memory_snapshots ms
      LEFT JOIN runs r ON r.id = ms.run_id
      WHERE ms.scope = 'run' AND ms.root_session_id = ?
      ORDER BY COALESCE(r.completed_at, r.started_at, ms.updated_at) DESC, ms.updated_at DESC
      LIMIT ?
    `).all(rootSessionId, clampLimit(limit, 20, 50)).map((row) => ({
      ...this._parseMemorySnapshotRow(row),
      runKind: row.run_kind || null,
      runStatus: row.run_status || null,
      completedAt: row.completed_at || null
    }));
  }

  listRunSnapshotsByTask(taskId, limit = 5) {
    return this.db.prepare(`
      SELECT ms.*, r.kind AS run_kind, r.status AS run_status, r.completed_at
      FROM memory_snapshots ms
      LEFT JOIN runs r ON r.id = ms.run_id
      WHERE ms.scope = 'run' AND ms.task_id = ?
      ORDER BY COALESCE(r.completed_at, r.started_at, ms.updated_at) DESC, ms.updated_at DESC
      LIMIT ?
    `).all(taskId, clampLimit(limit, 5, 20)).map((row) => ({
      ...this._parseMemorySnapshotRow(row),
      runKind: row.run_kind || null,
      runStatus: row.run_status || null,
      completedAt: row.completed_at || null
    }));
  }

  getTopFindings(taskId, limit = 20) {
    const rows = this.db.prepare(`
      SELECT *
      FROM findings
      WHERE task_id = ?
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          WHEN 'info' THEN 4
          ELSE 99
        END ASC,
        created_at DESC
      LIMIT ?
    `).all(taskId, clampLimit(limit, 20, 50));

    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
  }

  _buildRunMemoryBundle(scopeId, options = {}) {
    const run = this.getRunById(scopeId);
    const snapshot = this.getMemorySnapshot('run', scopeId);
    if (!run && !snapshot) {
      return null;
    }

    const findings = run?.taskId ? this.getTopFindings(run.taskId, 20) : [];

    return {
      scopeType: 'run',
      scopeId,
      brief: snapshot?.brief || truncateText(run?.decisionSummary, 1500),
      keyDecisions: snapshot?.keyDecisions || [],
      pendingItems: snapshot?.pendingItems || [],
      findings,
      recentRuns: [],
      rawPointers: options.includeRawPointers === false
        ? null
        : {
            runId: scopeId,
            discussionId: run?.discussionId || null,
            traceId: run?.traceId || null
          },
      isStale: false
    };
  }

  _buildRootMemoryBundle(scopeId, options = {}) {
    const snapshot = this.getMemorySnapshot('root', scopeId);
    const recentRuns = this.listRunSnapshotsByRoot(scopeId, options.recentRunsLimit || 3).map((entry) => ({
      runId: entry.runId,
      brief: entry.brief,
      keyDecisions: entry.keyDecisions,
      pendingItems: entry.pendingItems,
      status: entry.runStatus,
      kind: entry.runKind,
      completedAt: entry.completedAt,
      updatedAt: entry.updatedAt
    }));
    const latestCompletedAt = this.getLatestCompletedAtForRoot(scopeId);
    if (!snapshot && recentRuns.length === 0 && !latestCompletedAt) {
      return null;
    }
    const isStale = Boolean(snapshot && latestCompletedAt && latestCompletedAt > snapshot.updatedAt);

    const fallbackBrief = recentRuns.length
      ? truncateText(recentRuns.map((entry, index) => `${index + 1}. ${entry.brief || `${entry.kind || 'run'} ${entry.runId}`}`).join('\n'), 1500)
      : null;

    return {
      scopeType: 'root',
      scopeId,
      brief: snapshot?.brief || fallbackBrief,
      keyDecisions: snapshot?.keyDecisions || dedupeStrings(recentRuns.flatMap((entry) => entry.keyDecisions), 20),
      pendingItems: snapshot?.pendingItems || dedupeStrings(recentRuns.flatMap((entry) => entry.pendingItems), 20),
      findings: [],
      recentRuns,
      rawPointers: options.includeRawPointers === false
        ? null
        : {
            runIds: recentRuns.map((entry) => entry.runId)
          },
      isStale: !snapshot ? recentRuns.length > 0 : isStale
    };
  }

  _buildTaskMemoryBundle(scopeId, options = {}) {
    const recentRunsLimit = clampLimit(options.recentRunsLimit, 3, 10);
    const latestRuns = this.getLatestRunsForTask(scopeId, 5);
    const runSnapshots = this.listRunSnapshotsByTask(scopeId, 5);
    const latestContext = this.getLatestContext(scopeId);
    const briefs = runSnapshots
      .map((entry) => entry.brief)
      .filter(Boolean)
      .slice(0, Math.min(recentRunsLimit, 3));
    const brief = briefs.length
      ? truncateText(briefs.join('\n\n'), 1500)
      : truncateText(latestContext?.summary, 1500);
    const keyDecisions = runSnapshots.length
      ? dedupeStrings(runSnapshots.flatMap((entry) => entry.keyDecisions), 20)
      : dedupeStrings(latestContext?.keyDecisions || [], 20);
    const pendingItems = runSnapshots.length
      ? dedupeStrings(runSnapshots.flatMap((entry) => entry.pendingItems), 20)
      : dedupeStrings(latestContext?.pendingItems || [], 20);
    const findings = this.getTopFindings(scopeId, 20);
    const artifacts = this.getArtifacts(scopeId).map((artifact) => ({
      key: artifact.key,
      type: artifact.type
    }));
    const contextIds = this.getContext(scopeId).slice(0, 5).map((entry) => entry.id);
    const snapshotByRunId = new Map(runSnapshots.map((entry) => [entry.runId, entry]));

    return {
      scopeType: 'task',
      scopeId,
      brief,
      keyDecisions,
      pendingItems,
      findings,
      recentRuns: latestRuns.slice(0, recentRunsLimit).map((run) => {
        const snapshot = snapshotByRunId.get(run.id);
        return {
          runId: run.id,
          brief: snapshot?.brief || truncateText(run.decisionSummary, 1500),
          keyDecisions: snapshot?.keyDecisions || [],
          pendingItems: snapshot?.pendingItems || [],
          status: run.status,
          kind: run.kind,
          completedAt: run.completedAt
        };
      }),
      rawPointers: options.includeRawPointers === false
        ? null
        : {
            runIds: latestRuns.map((run) => run.id),
            artifactKeys: artifacts,
            findingIds: findings.map((finding) => finding.id),
            contextIds
          },
      isStale: false
    };
  }

  getMemoryBundle(scopeId, scopeType = 'task', options = {}) {
    const normalizedScopeType = String(scopeType || 'task').trim().toLowerCase();
    const bundleOptions = {
      recentRunsLimit: clampLimit(options.recentRunsLimit, 3, 10),
      includeRawPointers: options.includeRawPointers !== false
    };

    if (normalizedScopeType === 'run') {
      return this._buildRunMemoryBundle(scopeId, bundleOptions);
    }
    if (normalizedScopeType === 'root') {
      return this._buildRootMemoryBundle(scopeId, bundleOptions);
    }
    if (normalizedScopeType === 'task') {
      return this._buildTaskMemoryBundle(scopeId, bundleOptions);
    }

    throw new Error(`Unsupported memory bundle scope type: ${scopeType}`);
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
      usageRecords: this.db.prepare("SELECT COUNT(*) as count FROM usage_records").get().count,
      memorySnapshots: this.db.prepare("SELECT COUNT(*) as count FROM memory_snapshots").get().count
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
