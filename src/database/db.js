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
const {
  SESSION_CONTROL_MODES,
  normalizeSessionControlMode,
  resolveRuntimeHostMetadata,
  serializeRuntimeCapabilities
} = require('../runtime/host-model');
const { redactSecretsInText, redactSecretObject } = require('../security/secret-redaction');

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

function normalizeNullableBoolean(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return value ? 1 : 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return 1;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return 0;
  }
  return null;
}

function parseNullableBoolean(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value) === 1;
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

function normalizeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(normalized)
    ? normalized
    : null;
}

function normalizeUsageRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'unknown';
}

function classifyUsageRoleBucket(value) {
  const role = normalizeUsageRole(value);

  if (role === 'judge') {
    return 'judging';
  }

  if (role === 'plan' || role === 'planner' || role === 'architect') {
    return 'planning';
  }

  if (role === 'main' || role === 'supervisor' || role === 'monitor') {
    return 'supervision';
  }

  if (
    role === 'worker'
    || role === 'executor'
    || role === 'implement'
    || role === 'implementer'
    || role === 'participant'
    || role === 'reviewer'
    || role === 'reviewer-bugs'
    || role === 'review'
    || role === 'review-security'
    || role === 'review-performance'
    || role === 'test'
    || role === 'tester'
    || role === 'fix'
    || role === 'fixer'
    || role === 'research'
    || role === 'researcher'
    || role === 'document'
    || role === 'documenter'
  ) {
    return 'execution';
  }

  return 'unknown';
}

function buildUsageRoleSql(recordAlias = 'usage_records', participantAlias = 'rp', terminalAlias = 't') {
  return `LOWER(COALESCE(
    NULLIF(${participantAlias}.participant_role, ''),
    NULLIF(json_extract(${recordAlias}.metadata, '$.participantRole'), ''),
    NULLIF(json_extract(${recordAlias}.metadata, '$.role'), ''),
    NULLIF(${terminalAlias}.role, ''),
    'unknown'
  ))`;
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
    taskId: context.taskId || null,
    taskAssignmentId: context.taskAssignmentId || null,
    participantId: context.participantId || null,
    adapter: context.adapter || null,
    provider: context.provider || null,
    model: context.model || null,
    role: context.role || null,
    sourceConfidence: context.sourceConfidence || null
  });

  const inputTokens = getFirstUsageValue(usageMetadata, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const outputTokens = getFirstUsageValue(usageMetadata, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'candidateTokens', 'candidate_tokens']);
  const reasoningTokens = getFirstUsageValue(usageMetadata, ['reasoningTokens', 'reasoning_tokens', 'reasoningOutputTokens', 'reasoning_output_tokens']);
  const cachedInputTokens = getFirstUsageValue(usageMetadata, ['cachedInputTokens', 'cached_input_tokens']);
  const cacheReadInputTokens = getFirstUsageValue(usageMetadata, ['cacheReadInputTokens', 'cache_read_input_tokens']);
  const cacheCreationInputTokens = getFirstUsageValue(usageMetadata, [
    'cacheCreationInputTokens',
    'cache_creation_input_tokens'
  ]);
  const totalTokens = getFirstUsageValue(usageMetadata, ['totalTokens', 'total_tokens']);
  const costUsd = getFirstUsageValue(usageMetadata, ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd']);
  const durationMs = getFirstUsageValue(usageMetadata, ['durationMs', 'duration_ms']);
  const adapter = getFirstUsageValue(usageMetadata, ['adapter']) || context.adapter || null;
  const provider = getFirstUsageValue(usageMetadata, ['provider']) || context.provider || null;
  const model = getFirstUsageValue(usageMetadata, ['model']) || context.model || null;
  const runId = getFirstUsageValue(usageMetadata, ['runId', 'run_id']) || context.runId || null;
  const taskId = getFirstUsageValue(usageMetadata, ['taskId', 'task_id']) || context.taskId || null;
  const taskAssignmentId = getFirstUsageValue(usageMetadata, ['taskAssignmentId', 'task_assignment_id'])
    || context.taskAssignmentId
    || null;
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
  const normalizedCacheReadInputTokens = normalizeInteger(cacheReadInputTokens, 0);
  const normalizedCacheCreationInputTokens = normalizeInteger(cacheCreationInputTokens, 0);
  const normalizedCachedInputTokens = cachedInputTokens !== null && cachedInputTokens !== undefined
    ? normalizeInteger(cachedInputTokens, 0)
    : normalizedCacheReadInputTokens + normalizedCacheCreationInputTokens;
  const normalizedTotalTokens = normalizeUsageTotalTokens(
    totalTokens,
    normalizedInputTokens + normalizedOutputTokens + normalizedCacheReadInputTokens + normalizedCacheCreationInputTokens
  );

  const terminalId = String(context.terminalId || '').trim();
  if (!terminalId) {
    return null;
  }

  return {
    rootSessionId: context.rootSessionId || null,
    terminalId,
    runId,
    taskId,
    taskAssignmentId,
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

  const sessionMetadata = parseJsonField(terminalRow?.session_metadata || terminalRow?.sessionMetadata) || {};

  return buildUsageRecordFromMetadata({
    rootSessionId: terminalRow?.root_session_id || terminalRow?.rootSessionId || terminalId,
    terminalId,
    taskId: sessionMetadata.taskId || null,
    taskAssignmentId: sessionMetadata.taskAssignmentId || null,
    adapter: terminalRow?.adapter || null,
    role: terminalRow?.role || null,
    createdAt: options.createdAt
  }, metadata);
}

function buildUsageWhereClause(options = {}) {
  const clauses = [];
  const params = [];

  if (options.rootSessionId) {
    clauses.push('usage_records.root_session_id = ?');
    params.push(options.rootSessionId);
  }
  if (options.terminalId) {
    clauses.push('usage_records.terminal_id = ?');
    params.push(options.terminalId);
  }
  if (options.runId) {
    clauses.push('usage_records.run_id = ?');
    params.push(options.runId);
  }
  if (options.taskId) {
    clauses.push('usage_records.task_id = ?');
    params.push(options.taskId);
  }
  if (options.taskAssignmentId) {
    clauses.push('usage_records.task_assignment_id = ?');
    params.push(options.taskAssignmentId);
  }
  if (options.participantId) {
    clauses.push('usage_records.participant_id = ?');
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
const TERMINAL_INPUT_QUEUE_STATUSES = new Set(['pending', 'held_for_approval', 'delivered', 'expired', 'cancelled']);
const TERMINAL_INPUT_KINDS = new Set(['message', 'approval', 'denial']);
const ROOM_TURN_ACTIVE_STATUSES = new Set(['pending', 'running']);
const ROOM_TURN_TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed']);
const DEFAULT_ROOM_TURN_STALE_MS = 30 * 60 * 1000;
const ROOT_IO_EVENT_KINDS = new Set(['input', 'output', 'screen_snapshot', 'parsed_message', 'tool_event', 'usage', 'liveness']);
const ROOT_IO_EVENT_SOURCES = new Set(['broker', 'terminal_log', 'provider_metadata', 'parser']);
const ROOT_IO_RETENTION_CLASSES = new Set(['raw-bounded', 'summary-indefinite', 'metadata-indefinite']);
const MEMORY_SUMMARY_EDGE_NAMESPACES = new Set(['structural', 'derivation', 'execution']);
const MEMORY_SUMMARY_EDGE_KINDS = new Set(['contains', 'continues', 'summarizes', 'supersedes', 'derived_from', 'blocks', 'unblocks']);
const MEMORY_RECORD_TYPE_ALIASES = new Map([
  ['usage', 'usage_record'],
  ['root_io', 'root_io_event'],
  ['root_io_events', 'root_io_event']
]);
const MEMORY_PROJECTION_JSON_FIELDS = new Set([
  'metadata',
  'payload_json',
  'mentions_json',
  'checks',
  'details',
  'key_decisions',
  'pending_items'
]);
const MEMORY_PROJECTION_SOURCE_LOOKUPS = {
  projects: { primaryKey: 'id' },
  tasks: { primaryKey: 'id' },
  task_assignments: { primaryKey: 'id' },
  rooms: { primaryKey: 'id' },
  room_participants: { primaryKey: 'id' },
  room_turns: { primaryKey: 'id' },
  room_messages: { primaryKey: 'id' },
  terminals: { primaryKey: 'terminal_id' },
  session_events: { primaryKey: 'id' },
  messages: { primaryKey: 'id' },
  runs: { primaryKey: 'id' },
  run_participants: { primaryKey: 'id' },
  run_steps: { primaryKey: 'id' },
  run_inputs: { primaryKey: 'id' },
  run_outputs: { primaryKey: 'id' },
  run_tool_events: { primaryKey: 'id' },
  usage_records: { primaryKey: 'id' },
  terminal_input_queue: { primaryKey: 'id' },
  discussions: { primaryKey: 'id' },
  discussion_messages: { primaryKey: 'id' },
  artifacts: { primaryKey: 'id' },
  findings: { primaryKey: 'id' },
  context: { primaryKey: 'id' },
  memory_snapshots: { primaryKey: 'id' },
  root_io_events: { primaryKey: 'root_io_event_id' },
  memory_summary_edges: { primaryKey: 'edge_id' },
  operator_actions: { primaryKey: 'action_id' },
  run_blocked_states: { primaryKey: 'id' }
};

function normalizeTerminalInputQueueStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  return TERMINAL_INPUT_QUEUE_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeTerminalInputKind(value, fallback = 'message') {
  const normalized = String(value || '').trim().toLowerCase();
  return TERMINAL_INPUT_KINDS.has(normalized) ? normalized : fallback;
}

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

function normalizeWorkspaceRoot(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return fs.realpathSync(trimmed);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return path.resolve(trimmed);
    }
    throw error;
  }
}

function buildProjectId(workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return null;
  }

  return `project_${crypto.createHash('sha1').update(normalizedWorkspaceRoot, 'utf8').digest('hex').slice(0, 16)}`;
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

function normalizeProjectionList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return values
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function normalizeMemoryRecordTypes(value) {
  return normalizeProjectionList(value).map((entry) => {
    const normalized = String(entry || '').trim().toLowerCase();
    return MEMORY_RECORD_TYPE_ALIASES.get(normalized) || normalized;
  });
}

function normalizeProjectionTimestamp(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEnumValue(value, allowedValues, fallback = null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (allowedValues.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeOptionalInteger(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(1, Math.max(0, parsed));
}

function buildRedactedRootIoPayload(eventInput = {}) {
  const metadata = eventInput.metadata && typeof eventInput.metadata === 'object' && !Array.isArray(eventInput.metadata)
    ? redactSecretObject({ ...eventInput.metadata })
    : {};
  let contentFull = eventInput.contentFull ?? eventInput.content_full ?? eventInput.content ?? null;
  let contentPreview = eventInput.contentPreview ?? eventInput.content_preview ?? null;
  const redactionReasons = new Set();

  if (contentFull !== null && contentFull !== undefined) {
    const redaction = redactSecretsInText(contentFull);
    contentFull = redaction.content;
    if (redaction.redacted) {
      redaction.reasons.forEach((reason) => redactionReasons.add(reason));
    }
  } else {
    contentFull = null;
  }

  if (contentPreview !== null && contentPreview !== undefined) {
    const redaction = redactSecretsInText(contentPreview);
    contentPreview = redaction.content;
    if (redaction.redacted) {
      redaction.reasons.forEach((reason) => redactionReasons.add(reason));
    }
  } else if (contentFull) {
    contentPreview = truncateText(contentFull, 500);
  } else {
    contentPreview = null;
  }

  if (redactionReasons.size > 0) {
    const securityMetadata = metadata.security && typeof metadata.security === 'object'
      ? { ...metadata.security }
      : {};
    securityMetadata.redactedSecretLikeContent = true;
    securityMetadata.redactionReasonCodes = Array.from(redactionReasons);
    metadata.security = securityMetadata;
  }

  return {
    contentPreview,
    contentFull,
    metadata
  };
}

function computeRootIoContentHash({ eventKind, source, contentPreview, contentFull, metadata }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    eventKind,
    source,
    contentPreview: contentPreview || null,
    contentFull: contentFull || null,
    metadata: metadata || {}
  }), 'utf8').digest('hex');
}

function parseProjectionSourceRow(row) {
  if (!row) {
    return null;
  }

  const parsed = { ...row };
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (MEMORY_PROJECTION_JSON_FIELDS.has(key) || key.endsWith('_json')) {
      parsed[key] = parseJsonField(value);
    }
  }
  return parsed;
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
    this.db.pragma('foreign_keys = ON');

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
    this._repairPhase1ProjectAnchors();
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

  _hasTable(tableName) {
    return Boolean(this.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      tableName
    ));
  }

  _hasColumn(tableName, columnName) {
    if (!this._hasTable(tableName)) {
      return false;
    }

    return this.db.prepare(`PRAGMA table_info(${tableName})`).all()
      .some((column) => column.name === columnName);
  }

  _parseProjectRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      workspaceRoot: row.workspace_root,
      name: path.basename(row.workspace_root) || row.workspace_root,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _normalizeProjectCandidateRoots(values = []) {
    const roots = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = normalizeWorkspaceRoot(value);
      if (normalized) {
        roots.add(normalized);
      }
    }
    return [...roots];
  }

  _collectProjectWorkspaceRoots() {
    const workspaceRoots = new Set();
    const addRoots = (values = []) => {
      for (const normalized of this._normalizeProjectCandidateRoots(values)) {
        workspaceRoots.add(normalized);
      }
    };

    if (this._hasTable('tasks') && this._hasColumn('tasks', 'workspace_root')) {
      addRoots(
        this.db.prepare('SELECT workspace_root FROM tasks WHERE workspace_root IS NOT NULL AND TRIM(workspace_root) <> \'\'')
          .all()
          .map((row) => row.workspace_root)
      );
    }

    if (this._hasTable('runs') && this._hasColumn('runs', 'working_directory')) {
      addRoots(
        this.db.prepare('SELECT working_directory FROM runs WHERE working_directory IS NOT NULL AND TRIM(working_directory) <> \'\'')
          .all()
          .map((row) => row.working_directory)
      );
    }

    if (this._hasTable('terminals')) {
      const terminalRows = this.db.prepare(`
        SELECT work_dir, session_metadata
        FROM terminals
        WHERE (work_dir IS NOT NULL AND TRIM(work_dir) <> '')
           OR (session_metadata IS NOT NULL AND TRIM(session_metadata) <> '')
      `).all();
      for (const row of terminalRows) {
        const metadata = parseJsonField(row.session_metadata) || {};
        addRoots([row.work_dir, metadata.workspaceRoot]);
      }
    }

    if (this._hasTable('room_participants') && this._hasColumn('room_participants', 'work_dir')) {
      addRoots(
        this.db.prepare('SELECT work_dir FROM room_participants WHERE work_dir IS NOT NULL AND TRIM(work_dir) <> \'\'')
          .all()
          .map((row) => row.work_dir)
      );
    }

    return [...workspaceRoots];
  }

  ensureProjectForWorkspaceRoot(workspaceRoot, options = {}) {
    if (!this._hasTable('projects')) {
      return null;
    }

    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }

    const existing = this.db.prepare(`
      SELECT * FROM projects WHERE workspace_root = ?
    `).get(normalizedWorkspaceRoot);
    if (existing) {
      return this._parseProjectRow(existing);
    }

    const now = Number.isFinite(options.createdAt) ? options.createdAt : Date.now();
    const metadata = options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
      ? options.metadata
      : { source: 'workspace_root' };

    this.db.prepare(`
      INSERT OR IGNORE INTO projects (id, workspace_root, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      buildProjectId(normalizedWorkspaceRoot),
      normalizedWorkspaceRoot,
      JSON.stringify(metadata),
      now,
      now
    );

    const row = this.db.prepare(`
      SELECT * FROM projects WHERE workspace_root = ?
    `).get(normalizedWorkspaceRoot);
    return this._parseProjectRow(row);
  }

  getProject(projectId) {
    if (!this._hasTable('projects')) {
      return null;
    }

    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) {
      return null;
    }

    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(normalizedProjectId);
    return this._parseProjectRow(row);
  }

  getProjectByWorkspaceRoot(workspaceRoot) {
    if (!this._hasTable('projects')) {
      return null;
    }

    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }

    const row = this.db.prepare('SELECT * FROM projects WHERE workspace_root = ?').get(normalizedWorkspaceRoot);
    return this._parseProjectRow(row);
  }

  listProjects(options = {}) {
    if (!this._hasTable('projects')) {
      return [];
    }

    const clauses = [];
    const params = [];
    if (options.workspaceRoot) {
      const normalizedWorkspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
      if (!normalizedWorkspaceRoot) {
        return [];
      }
      clauses.push('workspace_root = ?');
      params.push(normalizedWorkspaceRoot);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(options.limit, 50, 500);
    return this.db.prepare(`
      SELECT *
      FROM projects
      ${whereSql}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit).map((row) => this._parseProjectRow(row));
  }

  _resolveProjectIdForWorkspaceRoot(workspaceRoot, options = {}) {
    if (!this._hasTable('projects')) {
      return null;
    }

    const project = this.ensureProjectForWorkspaceRoot(workspaceRoot, options);
    return project?.id || null;
  }

  _resolveSingleProjectId(candidates = []) {
    const ids = new Set(
      candidates
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    return ids.size === 1 ? [...ids][0] : null;
  }

  _getTaskProjectId(taskId) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId || !this._hasColumn('tasks', 'project_id')) {
      return null;
    }
    const row = this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(normalizedTaskId);
    return String(row?.project_id || '').trim() || null;
  }

  _getRunProjectId(runId) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId || !this._hasColumn('runs', 'project_id')) {
      return null;
    }
    const row = this.db.prepare('SELECT project_id FROM runs WHERE id = ?').get(normalizedRunId);
    return String(row?.project_id || '').trim() || null;
  }

  _getTerminalProjectId(terminalId) {
    const normalizedTerminalId = String(terminalId || '').trim();
    if (!normalizedTerminalId || !this._hasColumn('terminals', 'project_id')) {
      return null;
    }
    const row = this.db.prepare('SELECT project_id FROM terminals WHERE terminal_id = ?').get(normalizedTerminalId);
    return String(row?.project_id || '').trim() || null;
  }

  _resolveProjectIdForTask(taskId) {
    const existingProjectId = this._getTaskProjectId(taskId);
    if (existingProjectId) {
      return existingProjectId;
    }
    if (!this._hasColumn('tasks', 'workspace_root')) {
      return null;
    }
    const row = this.db.prepare('SELECT workspace_root FROM tasks WHERE id = ?').get(String(taskId || '').trim());
    return this._resolveProjectIdForWorkspaceRoot(row?.workspace_root, {
      metadata: { source: 'task_workspace_root' }
    });
  }

  _resolveProjectIdForTerminalContext(workDir, sessionMetadata = null, options = {}) {
    const metadata = typeof sessionMetadata === 'string'
      ? parseJsonField(sessionMetadata)
      : sessionMetadata;
    const roots = this._normalizeProjectCandidateRoots([
      workDir,
      metadata?.workspaceRoot,
      metadata?.workspace_root
    ]);

    if (roots.length !== 1) {
      return null;
    }

    return this._resolveProjectIdForWorkspaceRoot(roots[0], options);
  }

  _resolveProjectIdForUsage(record = {}) {
    const explicitProjectId = String(record.projectId || record.project_id || '').trim();
    if (explicitProjectId) {
      return explicitProjectId;
    }

    return this._resolveSingleProjectId([
      this._getTaskProjectId(record.taskId || record.task_id),
      this._getRunProjectId(record.runId || record.run_id),
      this._getTerminalProjectId(record.terminalId || record.terminal_id)
    ]);
  }

  repairProjectAnchors() {
    if (!this._hasTable('projects')) {
      return {
        projectsCreated: 0,
        taskProjectsLinked: 0,
        runProjectsLinked: 0,
        roomProjectsLinked: 0,
        usageProjectsLinked: 0,
        memorySnapshotProjectsLinked: 0,
        terminalProjectsLinked: 0
      };
    }

    const repair = this.db.transaction(() => {
      const results = {
        projectsCreated: 0,
        taskProjectsLinked: 0,
        runProjectsLinked: 0,
        roomProjectsLinked: 0,
        usageProjectsLinked: 0,
        memorySnapshotProjectsLinked: 0,
        terminalProjectsLinked: 0
      };
      const now = Date.now();
      const existingProjects = new Map(
        this.db.prepare('SELECT * FROM projects').all().map((row) => [row.workspace_root, row])
      );

      for (const workspaceRoot of this._collectProjectWorkspaceRoots()) {
        if (existingProjects.has(workspaceRoot)) {
          continue;
        }

        this.db.prepare(`
          INSERT INTO projects (id, workspace_root, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          buildProjectId(workspaceRoot),
          workspaceRoot,
          JSON.stringify({ source: 'workspace_root', backfilled: true }),
          now,
          now
        );
        existingProjects.set(
          workspaceRoot,
          this.db.prepare('SELECT * FROM projects WHERE workspace_root = ?').get(workspaceRoot)
        );
        results.projectsCreated += 1;
      }

      const projectIdByWorkspaceRoot = new Map(
        [...existingProjects.entries()].map(([workspaceRoot, row]) => [workspaceRoot, row.id])
      );
      const existingProjectIds = new Set([...projectIdByWorkspaceRoot.values()]);
      const taskProjectIdByTaskId = new Map();
      const runProjectIdByRunId = new Map();
      const terminalProjectIdByTerminalId = new Map();

      if (this._hasTable('tasks') && this._hasColumn('tasks', 'project_id')) {
        const updateTaskProject = this.db.prepare(`
          UPDATE tasks SET project_id = ? WHERE id = ?
        `);
        const taskRows = this.db.prepare(`
          SELECT id, workspace_root, project_id
          FROM tasks
        `).all();

        for (const row of taskRows) {
          const currentProjectId = String(row.project_id || '').trim();
          const desiredProjectId = projectIdByWorkspaceRoot.get(normalizeWorkspaceRoot(row.workspace_root)) || null;
          if ((!currentProjectId || !existingProjectIds.has(currentProjectId)) && desiredProjectId) {
            updateTaskProject.run(desiredProjectId, row.id);
            row.project_id = desiredProjectId;
            results.taskProjectsLinked += 1;
          }
          if (row.project_id) {
            taskProjectIdByTaskId.set(row.id, row.project_id);
          }
        }
      }

      if (this._hasTable('terminals') && this._hasColumn('terminals', 'project_id')) {
        const updateTerminalProject = this.db.prepare(`
          UPDATE terminals SET project_id = ? WHERE terminal_id = ?
        `);
        const terminalRows = this.db.prepare(`
          SELECT terminal_id, work_dir, session_metadata, project_id
          FROM terminals
        `).all();

        for (const row of terminalRows) {
          const metadata = parseJsonField(row.session_metadata) || {};
          const projectRoots = this._normalizeProjectCandidateRoots([row.work_dir, metadata.workspaceRoot]);
          const currentProjectId = String(row.project_id || '').trim();
          const desiredProjectId = projectRoots.length === 1
            ? projectIdByWorkspaceRoot.get(projectRoots[0]) || null
            : null;

          if ((!currentProjectId || !existingProjectIds.has(currentProjectId)) && desiredProjectId) {
            updateTerminalProject.run(desiredProjectId, row.terminal_id);
            row.project_id = desiredProjectId;
            results.terminalProjectsLinked += 1;
          }
          if (row.project_id) {
            terminalProjectIdByTerminalId.set(row.terminal_id, row.project_id);
          }
        }
      }

      if (this._hasTable('runs') && this._hasColumn('runs', 'project_id')) {
        const updateRunProject = this.db.prepare(`
          UPDATE runs SET project_id = ? WHERE id = ?
        `);
        const runRows = this.db.prepare(`
          SELECT id, task_id, working_directory, project_id
          FROM runs
        `).all();

        for (const row of runRows) {
          const candidates = new Set();
          const taskProjectId = taskProjectIdByTaskId.get(row.task_id);
          const workspaceProjectId = projectIdByWorkspaceRoot.get(normalizeWorkspaceRoot(row.working_directory));
          if (taskProjectId) {
            candidates.add(taskProjectId);
          }
          if (workspaceProjectId) {
            candidates.add(workspaceProjectId);
          }
          const currentProjectId = String(row.project_id || '').trim();
          const desiredProjectId = candidates.size === 1 ? [...candidates][0] : null;

          if ((!currentProjectId || !existingProjectIds.has(currentProjectId)) && desiredProjectId) {
            updateRunProject.run(desiredProjectId, row.id);
            row.project_id = desiredProjectId;
            results.runProjectsLinked += 1;
          }
          if (row.project_id) {
            runProjectIdByRunId.set(row.id, row.project_id);
          }
        }
      }

      if (this._hasTable('rooms') && this._hasColumn('rooms', 'project_id')) {
        const updateRoomProject = this.db.prepare(`
          UPDATE rooms SET project_id = ? WHERE id = ?
        `);
        const roomRows = this.db.prepare(`
          SELECT id, task_id, project_id
          FROM rooms
        `).all();

        for (const row of roomRows) {
          const currentProjectId = String(row.project_id || '').trim();
          const desiredProjectId = taskProjectIdByTaskId.get(row.task_id) || null;
          if ((!currentProjectId || !existingProjectIds.has(currentProjectId)) && desiredProjectId) {
            updateRoomProject.run(desiredProjectId, row.id);
            results.roomProjectsLinked += 1;
          }
        }
      }

      if (this._hasTable('usage_records') && this._hasColumn('usage_records', 'project_id')) {
        const updateUsageProject = this.db.prepare(`
          UPDATE usage_records SET project_id = ? WHERE id = ?
        `);
        const usageRows = this.db.prepare(`
          SELECT id, task_id, run_id, terminal_id, project_id
          FROM usage_records
        `).all();

        for (const row of usageRows) {
          const candidates = new Set();
          const currentProjectId = String(row.project_id || '').trim();
          const taskProjectId = taskProjectIdByTaskId.get(row.task_id);
          const runProjectId = runProjectIdByRunId.get(row.run_id);
          const terminalProjectId = terminalProjectIdByTerminalId.get(row.terminal_id);
          if (taskProjectId) {
            candidates.add(taskProjectId);
          }
          if (runProjectId) {
            candidates.add(runProjectId);
          }
          if (terminalProjectId) {
            candidates.add(terminalProjectId);
          }

          const desiredProjectId = candidates.size === 1 ? [...candidates][0] : null;
          if ((!currentProjectId || !existingProjectIds.has(currentProjectId)) && desiredProjectId) {
            updateUsageProject.run(desiredProjectId, row.id);
            results.usageProjectsLinked += 1;
          }
        }
      }

      if (this._hasTable('memory_snapshots') && this._hasColumn('memory_snapshots', 'project_id')) {
        const updateSnapshotProject = this.db.prepare(`
          UPDATE memory_snapshots SET project_id = ? WHERE id = ?
        `);
        const snapshotRows = this.db.prepare(`
          SELECT id, scope, scope_id, task_id, project_id
          FROM memory_snapshots
        `).all();

        for (const row of snapshotRows) {
          const candidates = new Set();
          const currentProjectId = String(row.project_id || '').trim();
          const taskProjectId = taskProjectIdByTaskId.get(row.task_id);
          if (taskProjectId) {
            candidates.add(taskProjectId);
          }
          if (row.scope === 'run') {
            const runProjectId = runProjectIdByRunId.get(row.scope_id);
            if (runProjectId) {
              candidates.add(runProjectId);
            }
          }

          const desiredProjectId = candidates.size === 1 ? [...candidates][0] : null;
          if ((!currentProjectId || !existingProjectIds.has(currentProjectId)) && desiredProjectId) {
            updateSnapshotProject.run(desiredProjectId, row.id);
            results.memorySnapshotProjectsLinked += 1;
          }
        }
      }

      return results;
    });

    return repair.immediate();
  }

  _repairPhase1ProjectAnchors() {
    try {
      return this.repairProjectAnchors();
    } catch (error) {
      if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
        console.warn('[db] Skipping Phase 1 project anchor repair due to transient SQLite lock:', error.message);
        return null;
      }
      if (String(error?.message || '').includes('no such table')) {
        return null;
      }
      throw error;
    }
  }

  getMemoryLinkageDiagnostics(options = {}) {
    const sampleLimit = clampLimit(options.sampleLimit, 5, 25);
    const diagnostics = {
      generatedAt: Date.now(),
      rootSessionId: {
        recoverable: { runs: 0, messages: 0, usageRecords: 0 },
        unknown: { runs: 0, messages: 0, usageRecords: 0 },
        samples: {
          recoverableRuns: [],
          unknownRuns: [],
          recoverableMessages: [],
          unknownMessages: [],
          recoverableUsageRecords: [],
          unknownUsageRecords: []
        }
      },
      taskId: {
        recoverable: { usageRecords: 0 },
        unknown: { runs: 0, rooms: 0, usageRecords: 0 },
        samples: {
          recoverableUsageRecords: [],
          unknownRuns: [],
          unknownRooms: [],
          unknownUsageRecords: []
        }
      },
      projectId: {
        recoverable: { tasks: 0, terminals: 0, runs: 0, rooms: 0, usageRecords: 0, memorySnapshots: 0 },
        unknown: { tasks: 0, terminals: 0, runs: 0, rooms: 0, usageRecords: 0, memorySnapshots: 0 },
        samples: {
          recoverableTasks: [],
          unknownTasks: [],
          recoverableTerminals: [],
          unknownTerminals: [],
          recoverableRuns: [],
          unknownRuns: [],
          recoverableRooms: [],
          unknownRooms: [],
          recoverableUsageRecords: [],
          unknownUsageRecords: [],
          recoverableMemorySnapshots: [],
          unknownMemorySnapshots: []
        }
      },
      usageLinkage: {
        missingTerminal: 0,
        missingRun: 0,
        missingTask: 0,
        missingProject: 0,
        samples: {
          missingTerminal: [],
          missingRun: [],
          missingTask: [],
          missingProject: []
        }
      }
    };

    const pushSample = (key, value) => {
      if (!Array.isArray(key) || key.length >= sampleLimit) {
        return;
      }
      key.push(value);
    };

    const tasks = this._hasTable('tasks')
      ? this.db.prepare('SELECT id, workspace_root, project_id FROM tasks').all()
      : [];
    const taskIds = new Set(tasks.map((row) => row.id));
    const runs = this._hasTable('runs')
      ? this.db.prepare('SELECT id, trace_id, root_session_id, task_id, working_directory, project_id FROM runs').all()
      : [];
    const runsById = new Map(runs.map((row) => [row.id, row]));
    const terminals = this._hasTable('terminals')
      ? this.db.prepare('SELECT terminal_id, root_session_id, work_dir, session_metadata, project_id FROM terminals').all()
      : [];
    const terminalsById = new Map(terminals.map((row) => [row.terminal_id, row]));
    const projects = this._hasTable('projects')
      ? this.db.prepare('SELECT id, workspace_root FROM projects').all()
      : [];
    const projectIdByWorkspaceRoot = new Map(
      projects.map((row) => [row.workspace_root, row.id])
    );
    const projectIds = new Set(projects.map((row) => row.id));
    const candidateProjectIdByWorkspaceRoot = new Map(projectIdByWorkspaceRoot);
    for (const workspaceRoot of this._collectProjectWorkspaceRoots()) {
      if (!candidateProjectIdByWorkspaceRoot.has(workspaceRoot)) {
        candidateProjectIdByWorkspaceRoot.set(workspaceRoot, buildProjectId(workspaceRoot));
      }
    }
    const candidateTaskProjectIdByTaskId = new Map(
      tasks.map((row) => [
        row.id,
        String(row.project_id || '').trim()
          || candidateProjectIdByWorkspaceRoot.get(normalizeWorkspaceRoot(row.workspace_root))
          || null
      ])
    );
    const candidateTerminalProjectIdByTerminalId = new Map(
      terminals.map((row) => {
        const metadata = parseJsonField(row.session_metadata) || {};
        const roots = this._normalizeProjectCandidateRoots([row.work_dir, metadata.workspaceRoot]);
        const currentProjectId = String(row.project_id || '').trim() || null;
        const candidateProjectId = roots.length === 1
          ? candidateProjectIdByWorkspaceRoot.get(roots[0]) || null
          : null;
        return [row.terminal_id, currentProjectId || candidateProjectId];
      })
    );
    const candidateRunProjectIdByRunId = new Map();
    for (const row of runs) {
      const candidates = new Set();
      const currentProjectId = String(row.project_id || '').trim() || null;
      const taskProjectId = candidateTaskProjectIdByTaskId.get(row.task_id);
      const workspaceProjectId = candidateProjectIdByWorkspaceRoot.get(normalizeWorkspaceRoot(row.working_directory));
      if (currentProjectId) {
        candidates.add(currentProjectId);
      }
      if (taskProjectId) {
        candidates.add(taskProjectId);
      }
      if (workspaceProjectId) {
        candidates.add(workspaceProjectId);
      }
      candidateRunProjectIdByRunId.set(row.id, candidates.size === 1 ? [...candidates][0] : currentProjectId);
    }
    const rooms = this._hasTable('rooms')
      ? this.db.prepare('SELECT id, task_id, project_id FROM rooms').all()
      : [];
    const usageRecords = this._hasTable('usage_records')
      ? this.db.prepare('SELECT id, root_session_id, terminal_id, run_id, task_id, project_id, metadata FROM usage_records').all()
      : [];
    const memorySnapshots = this._hasTable('memory_snapshots')
      ? this.db.prepare('SELECT id, scope, scope_id, task_id, project_id FROM memory_snapshots').all()
      : [];
    const messages = this._hasTable('messages')
      ? this.db.prepare('SELECT id, terminal_id, root_session_id FROM messages').all()
      : [];
    const recoverableRunRoots = new Map();
    const recoverableTraceRoots = new Map();

    if (this._hasTable('session_events')) {
      for (const row of this.db.prepare(`
        SELECT run_id, root_session_id
        FROM session_events
        WHERE run_id IS NOT NULL
          AND root_session_id IS NOT NULL
          AND TRIM(root_session_id) <> ''
      `).all()) {
        if (!recoverableRunRoots.has(row.run_id)) {
          recoverableRunRoots.set(row.run_id, new Set());
        }
        recoverableRunRoots.get(row.run_id).add(row.root_session_id);
      }
    }

    if (this._hasTable('spans') && this._hasTable('terminals')) {
      for (const row of this.db.prepare(`
        SELECT s.trace_id, t.root_session_id
        FROM spans s
        JOIN terminals t ON t.terminal_id = s.terminal_id
        WHERE s.trace_id IS NOT NULL
          AND t.root_session_id IS NOT NULL
          AND TRIM(t.root_session_id) <> ''
      `).all()) {
        if (!recoverableTraceRoots.has(row.trace_id)) {
          recoverableTraceRoots.set(row.trace_id, new Set());
        }
        recoverableTraceRoots.get(row.trace_id).add(row.root_session_id);
      }
    }

    for (const row of runs) {
      if (String(row.root_session_id || '').trim()) {
        continue;
      }

      const candidates = new Set([
        ...(recoverableRunRoots.get(row.id) || new Set()),
        ...(recoverableTraceRoots.get(row.trace_id) || new Set())
      ]);
      const bucket = candidates.size === 1 ? 'recoverable' : 'unknown';
      diagnostics.rootSessionId[bucket].runs += 1;
      pushSample(
        diagnostics.rootSessionId.samples[bucket === 'recoverable' ? 'recoverableRuns' : 'unknownRuns'],
        row.id
      );
    }

    for (const row of messages) {
      if (String(row.root_session_id || '').trim()) {
        continue;
      }

      const terminal = terminalsById.get(row.terminal_id);
      const bucket = String(terminal?.root_session_id || '').trim() ? 'recoverable' : 'unknown';
      diagnostics.rootSessionId[bucket].messages += 1;
      pushSample(
        diagnostics.rootSessionId.samples[bucket === 'recoverable' ? 'recoverableMessages' : 'unknownMessages'],
        row.id
      );
    }

    for (const row of usageRecords) {
      if (!String(row.root_session_id || '').trim()) {
        const candidates = new Set();
        const run = runsById.get(row.run_id);
        const terminal = terminalsById.get(row.terminal_id);
        if (String(run?.root_session_id || '').trim()) {
          candidates.add(run.root_session_id);
        }
        if (String(terminal?.root_session_id || '').trim()) {
          candidates.add(terminal.root_session_id);
        }
        const bucket = candidates.size === 1 ? 'recoverable' : 'unknown';
        diagnostics.rootSessionId[bucket].usageRecords += 1;
        pushSample(
          diagnostics.rootSessionId.samples[bucket === 'recoverable' ? 'recoverableUsageRecords' : 'unknownUsageRecords'],
          row.id
        );
      }

      const terminalExists = terminalsById.has(row.terminal_id);
      if (!terminalExists) {
        diagnostics.usageLinkage.missingTerminal += 1;
        pushSample(diagnostics.usageLinkage.samples.missingTerminal, row.id);
      }
      if (row.run_id && !runsById.has(row.run_id)) {
        diagnostics.usageLinkage.missingRun += 1;
        pushSample(diagnostics.usageLinkage.samples.missingRun, row.id);
      }
      if (row.task_id && !taskIds.has(row.task_id)) {
        diagnostics.usageLinkage.missingTask += 1;
        pushSample(diagnostics.usageLinkage.samples.missingTask, row.id);
      }
      if (row.project_id && !projectIds.has(row.project_id)) {
        diagnostics.usageLinkage.missingProject += 1;
        pushSample(diagnostics.usageLinkage.samples.missingProject, row.id);
      }

      if (!String(row.task_id || '').trim()) {
        const usageMetadata = parseJsonField(row.metadata) || {};
        const terminal = terminalsById.get(row.terminal_id);
        const terminalMetadata = parseJsonField(terminal?.session_metadata) || {};
        const run = runsById.get(row.run_id);
        const candidates = new Set();

        if (String(run?.task_id || '').trim()) {
          candidates.add(run.task_id);
        }
        for (const value of [
          terminalMetadata.taskId,
          terminalMetadata.task_id,
          usageMetadata.taskId,
          usageMetadata.task_id
        ]) {
          const normalized = String(value || '').trim();
          if (normalized) {
            candidates.add(normalized);
          }
        }

        const bucket = candidates.size === 1 ? 'recoverable' : 'unknown';
        diagnostics.taskId[bucket].usageRecords += 1;
        pushSample(
          diagnostics.taskId.samples[bucket === 'recoverable' ? 'recoverableUsageRecords' : 'unknownUsageRecords'],
          row.id
        );
      }
    }

    for (const row of runs) {
      if (!String(row.task_id || '').trim()) {
        diagnostics.taskId.unknown.runs += 1;
        pushSample(diagnostics.taskId.samples.unknownRuns, row.id);
      }
    }

    for (const row of rooms) {
      if (!String(row.task_id || '').trim()) {
        diagnostics.taskId.unknown.rooms += 1;
        pushSample(diagnostics.taskId.samples.unknownRooms, row.id);
      }
    }

    for (const row of tasks) {
      if (String(row.project_id || '').trim()) {
        continue;
      }
      const candidateProjectId = candidateProjectIdByWorkspaceRoot.get(normalizeWorkspaceRoot(row.workspace_root));
      const bucket = candidateProjectId ? 'recoverable' : 'unknown';
      diagnostics.projectId[bucket].tasks += 1;
      pushSample(
        diagnostics.projectId.samples[bucket === 'recoverable' ? 'recoverableTasks' : 'unknownTasks'],
        row.id
      );
    }

    for (const row of terminals) {
      if (String(row.project_id || '').trim()) {
        continue;
      }
      const metadata = parseJsonField(row.session_metadata) || {};
      const candidates = this._normalizeProjectCandidateRoots([row.work_dir, metadata.workspaceRoot]);
      const bucket = candidates.length === 1 && candidateProjectIdByWorkspaceRoot.has(candidates[0]) ? 'recoverable' : 'unknown';
      diagnostics.projectId[bucket].terminals += 1;
      pushSample(
        diagnostics.projectId.samples[bucket === 'recoverable' ? 'recoverableTerminals' : 'unknownTerminals'],
        row.terminal_id
      );
    }

    for (const row of runs) {
      if (String(row.project_id || '').trim()) {
        continue;
      }
      const candidates = new Set();
      const taskProjectId = candidateTaskProjectIdByTaskId.get(row.task_id);
      const workspaceProjectId = candidateProjectIdByWorkspaceRoot.get(normalizeWorkspaceRoot(row.working_directory));
      if (taskProjectId) {
        candidates.add(taskProjectId);
      }
      if (workspaceProjectId) {
        candidates.add(workspaceProjectId);
      }
      const bucket = candidates.size === 1 ? 'recoverable' : 'unknown';
      diagnostics.projectId[bucket].runs += 1;
      pushSample(
        diagnostics.projectId.samples[bucket === 'recoverable' ? 'recoverableRuns' : 'unknownRuns'],
        row.id
      );
    }

    for (const row of rooms) {
      if (String(row.project_id || '').trim()) {
        continue;
      }
      const bucket = candidateTaskProjectIdByTaskId.get(row.task_id) ? 'recoverable' : 'unknown';
      diagnostics.projectId[bucket].rooms += 1;
      pushSample(
        diagnostics.projectId.samples[bucket === 'recoverable' ? 'recoverableRooms' : 'unknownRooms'],
        row.id
      );
    }

    for (const row of usageRecords) {
      if (String(row.project_id || '').trim()) {
        continue;
      }
      const candidates = new Set();
      const taskProjectId = candidateTaskProjectIdByTaskId.get(row.task_id);
      const runProjectId = candidateRunProjectIdByRunId.get(row.run_id);
      const terminalProjectId = candidateTerminalProjectIdByTerminalId.get(row.terminal_id);
      if (taskProjectId) {
        candidates.add(taskProjectId);
      }
      if (runProjectId) {
        candidates.add(runProjectId);
      }
      if (terminalProjectId) {
        candidates.add(terminalProjectId);
      }
      const bucket = candidates.size === 1 ? 'recoverable' : 'unknown';
      diagnostics.projectId[bucket].usageRecords += 1;
      pushSample(
        diagnostics.projectId.samples[bucket === 'recoverable' ? 'recoverableUsageRecords' : 'unknownUsageRecords'],
        row.id
      );
    }

    for (const row of memorySnapshots) {
      if (String(row.project_id || '').trim()) {
        continue;
      }
      const candidates = new Set();
      const taskProjectId = candidateTaskProjectIdByTaskId.get(row.task_id);
      if (taskProjectId) {
        candidates.add(taskProjectId);
      }
      if (row.scope === 'run') {
        const runProjectId = candidateRunProjectIdByRunId.get(row.scope_id);
        if (runProjectId) {
          candidates.add(runProjectId);
        }
      }
      const bucket = candidates.size === 1 ? 'recoverable' : 'unknown';
      diagnostics.projectId[bucket].memorySnapshots += 1;
      pushSample(
        diagnostics.projectId.samples[bucket === 'recoverable' ? 'recoverableMemorySnapshots' : 'unknownMemorySnapshots'],
        row.id
      );
    }

    return diagnostics;
  }

  // ===================
  // Terminal Operations
  // ===================

  /**
   * Register a new terminal
   */
  registerTerminal(terminalId, sessionName, windowName, adapter, agentProfile = null, role = 'worker', workDir = null, logPath = null, options = {}) {
    const terminalOptions = options && typeof options === 'object' ? options : {};
    const sessionMetadataObject = terminalOptions.sessionMetadata && typeof terminalOptions.sessionMetadata === 'object'
      ? terminalOptions.sessionMetadata
      : parseJsonField(terminalOptions.sessionMetadata) || null;
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
    const model = String(terminalOptions.model || '').trim() || null;
    const requestedModel = String(
      terminalOptions.requestedModel
      ?? terminalOptions.requested_model
      ?? model
      ?? ''
    ).trim() || null;
    const effectiveModel = String(
      terminalOptions.effectiveModel
      ?? terminalOptions.effective_model
      ?? model
      ?? ''
    ).trim() || null;
    const requestedEffort = normalizeReasoningEffort(
      terminalOptions.requestedEffort
      ?? terminalOptions.requested_effort
      ?? terminalOptions.reasoningEffort
      ?? terminalOptions.reasoning_effort
      ?? terminalOptions.effort
    );
    const effectiveEffort = normalizeReasoningEffort(
      terminalOptions.effectiveEffort
      ?? terminalOptions.effective_effort
      ?? requestedEffort
    );
    const lastMessageAt = Number.isFinite(terminalOptions.lastMessageAt) ? terminalOptions.lastMessageAt : null;
    const sessionControlMode = normalizeSessionControlMode(
      terminalOptions.sessionControlMode || terminalOptions.session_control_mode,
      SESSION_CONTROL_MODES.OPERATOR
    );
    const runtimeMetadata = resolveRuntimeHostMetadata({
      terminalId,
      sessionName,
      windowName,
      sessionMetadata: sessionMetadataObject,
      adoptedAt,
      runtimeHost: terminalOptions.runtimeHost,
      runtimeId: terminalOptions.runtimeId,
      runtimeCapabilities: terminalOptions.runtimeCapabilities,
      runtimeFidelity: terminalOptions.runtimeFidelity
    });
    const hasProjectColumn = this._hasColumn('terminals', 'project_id');
    const projectId = hasProjectColumn
      ? this._resolveProjectIdForTerminalContext(workDir, sessionMetadataObject, {
        metadata: { source: 'terminal_register' }
      })
      : null;

    const columns = [
      'terminal_id',
      'session_name',
      'window_name',
      'adapter',
      'agent_profile',
      'role',
      'work_dir',
      'log_path',
      'root_session_id',
      'parent_session_id',
      'session_kind',
      'origin_client',
      'external_session_ref',
      'lineage_depth',
      'session_metadata',
      'harness_session_id',
      'provider_thread_ref',
      'adopted_at',
      'capture_mode',
      'model',
      'last_message_at'
    ];
    const values = [
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
      lastMessageAt
    ];
    if (hasProjectColumn) {
      columns.push('project_id');
      values.push(projectId);
    }
    if (this._hasColumn('terminals', 'runtime_host')) {
      columns.push('runtime_host');
      values.push(runtimeMetadata.runtimeHost);
    }
    if (this._hasColumn('terminals', 'runtime_id')) {
      columns.push('runtime_id');
      values.push(runtimeMetadata.runtimeId);
    }
    if (this._hasColumn('terminals', 'runtime_capabilities')) {
      columns.push('runtime_capabilities');
      values.push(serializeRuntimeCapabilities(runtimeMetadata.runtimeCapabilities, runtimeMetadata.runtimeHost));
    }
    if (this._hasColumn('terminals', 'runtime_fidelity')) {
      columns.push('runtime_fidelity');
      values.push(runtimeMetadata.runtimeFidelity);
    }
    if (this._hasColumn('terminals', 'session_control_mode')) {
      columns.push('session_control_mode');
      values.push(sessionControlMode);
    }
    if (this._hasColumn('terminals', 'requested_model')) {
      columns.push('requested_model');
      values.push(requestedModel);
    }
    if (this._hasColumn('terminals', 'effective_model')) {
      columns.push('effective_model');
      values.push(effectiveModel);
    }
    if (this._hasColumn('terminals', 'requested_effort')) {
      columns.push('requested_effort');
      values.push(requestedEffort);
    }
    if (this._hasColumn('terminals', 'effective_effort')) {
      columns.push('effective_effort');
      values.push(effectiveEffort);
    }

    this.db.run(`
      INSERT INTO terminals (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `, ...values);

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

    const runtimeUpdates = [];
    const runtimeValues = [];
    const hasRuntimeInput = (
      terminalOptions.runtimeHost !== undefined
      || terminalOptions.runtimeId !== undefined
      || terminalOptions.runtimeCapabilities !== undefined
      || terminalOptions.runtimeFidelity !== undefined
    );
    if (hasRuntimeInput) {
      const current = this.getTerminal(terminalId) || {};
      const runtimeMetadata = resolveRuntimeHostMetadata({
        ...current,
        terminalId,
        sessionName: current.session_name,
        windowName: current.window_name,
        sessionMetadata: parseJsonField(current.session_metadata),
        adoptedAt: terminalOptions.adoptedAt || current.adopted_at,
        runtimeHost: terminalOptions.runtimeHost ?? current.runtime_host,
        runtimeId: terminalOptions.runtimeId ?? current.runtime_id,
        runtimeCapabilities: terminalOptions.runtimeCapabilities ?? current.runtime_capabilities,
        runtimeFidelity: terminalOptions.runtimeFidelity ?? current.runtime_fidelity
      });
      if (this._hasColumn('terminals', 'runtime_host')) {
        runtimeUpdates.push('runtime_host = ?');
        runtimeValues.push(runtimeMetadata.runtimeHost);
      }
      if (this._hasColumn('terminals', 'runtime_id')) {
        runtimeUpdates.push('runtime_id = ?');
        runtimeValues.push(runtimeMetadata.runtimeId);
      }
      if (this._hasColumn('terminals', 'runtime_capabilities')) {
        runtimeUpdates.push('runtime_capabilities = ?');
        runtimeValues.push(serializeRuntimeCapabilities(runtimeMetadata.runtimeCapabilities, runtimeMetadata.runtimeHost));
      }
      if (this._hasColumn('terminals', 'runtime_fidelity')) {
        runtimeUpdates.push('runtime_fidelity = ?');
        runtimeValues.push(runtimeMetadata.runtimeFidelity);
      }
    }
    if (runtimeUpdates.length > 0) {
      this.db.run(`
        UPDATE terminals
        SET ${runtimeUpdates.join(', ')}, last_active = CURRENT_TIMESTAMP
        WHERE terminal_id = ?
      `, ...runtimeValues, terminalId);
    }
    if (
      this._hasColumn('terminals', 'session_control_mode')
      && (terminalOptions.sessionControlMode !== undefined || terminalOptions.session_control_mode !== undefined)
    ) {
      this.db.run(`
        UPDATE terminals
        SET session_control_mode = ?, last_active = CURRENT_TIMESTAMP
        WHERE terminal_id = ?
      `,
      normalizeSessionControlMode(
        terminalOptions.sessionControlMode ?? terminalOptions.session_control_mode,
        SESSION_CONTROL_MODES.OPERATOR
      ),
      terminalId);
    }

    const hasModelStateInput = (
      terminalOptions.model !== undefined
      || terminalOptions.requestedModel !== undefined
      || terminalOptions.requested_model !== undefined
      || terminalOptions.effectiveModel !== undefined
      || terminalOptions.effective_model !== undefined
      || terminalOptions.requestedEffort !== undefined
      || terminalOptions.requested_effort !== undefined
      || terminalOptions.effectiveEffort !== undefined
      || terminalOptions.effective_effort !== undefined
      || terminalOptions.reasoningEffort !== undefined
      || terminalOptions.reasoning_effort !== undefined
      || terminalOptions.effort !== undefined
    );
    if (hasModelStateInput) {
      const requestedModel = String(
        terminalOptions.requestedModel
        ?? terminalOptions.requested_model
        ?? terminalOptions.model
        ?? ''
      ).trim() || null;
      const effectiveModel = String(
        terminalOptions.effectiveModel
        ?? terminalOptions.effective_model
        ?? terminalOptions.model
        ?? ''
      ).trim() || null;
      const requestedEffort = normalizeReasoningEffort(
        terminalOptions.requestedEffort
        ?? terminalOptions.requested_effort
        ?? terminalOptions.reasoningEffort
        ?? terminalOptions.reasoning_effort
        ?? terminalOptions.effort
      );
      const effectiveEffort = normalizeReasoningEffort(
        terminalOptions.effectiveEffort
        ?? terminalOptions.effective_effort
        ?? requestedEffort
      );
      const modelStateUpdates = [];
      const modelStateValues = [];
      if (this._hasColumn('terminals', 'requested_model')) {
        modelStateUpdates.push('requested_model = COALESCE(?, requested_model)');
        modelStateValues.push(requestedModel);
      }
      if (this._hasColumn('terminals', 'effective_model')) {
        modelStateUpdates.push('effective_model = COALESCE(?, effective_model)');
        modelStateValues.push(effectiveModel);
      }
      if (this._hasColumn('terminals', 'requested_effort')) {
        modelStateUpdates.push('requested_effort = COALESCE(?, requested_effort)');
        modelStateValues.push(requestedEffort);
      }
      if (this._hasColumn('terminals', 'effective_effort')) {
        modelStateUpdates.push('effective_effort = COALESCE(?, effective_effort)');
        modelStateValues.push(effectiveEffort);
      }
      if (modelStateUpdates.length > 0) {
        this.db.run(`
          UPDATE terminals
          SET ${modelStateUpdates.join(', ')}, last_active = CURRENT_TIMESTAMP
          WHERE terminal_id = ?
        `, ...modelStateValues, terminalId);
      }
    }
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

      if (clientName && rowClientName && rowClientName !== clientName) {
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
    const effectiveModel = String(
      options.effectiveModel
      ?? options.effective_model
      ?? model
      ?? ''
    ).trim() || null;
    const requestedModel = String(
      options.requestedModel
      ?? options.requested_model
      ?? ''
    ).trim() || null;
    const requestedEffort = normalizeReasoningEffort(
      options.requestedEffort
      ?? options.requested_effort
      ?? options.reasoningEffort
      ?? options.reasoning_effort
      ?? options.effort
    );
    const effectiveEffort = normalizeReasoningEffort(
      options.effectiveEffort
      ?? options.effective_effort
      ?? requestedEffort
    );
    const updates = ['model = COALESCE(?, model)'];
    const params = [model];
    if (this._hasColumn('terminals', 'effective_model')) {
      updates.push('effective_model = COALESCE(?, effective_model)');
      params.push(effectiveModel);
    }
    if (this._hasColumn('terminals', 'requested_model')) {
      updates.push('requested_model = COALESCE(?, requested_model)');
      params.push(requestedModel);
    }
    if (this._hasColumn('terminals', 'requested_effort')) {
      updates.push('requested_effort = COALESCE(?, requested_effort)');
      params.push(requestedEffort);
    }
    if (this._hasColumn('terminals', 'effective_effort')) {
      updates.push('effective_effort = COALESCE(?, effective_effort)');
      params.push(effectiveEffort);
    }
    params.push(timestamp, timestamp, terminalId);
    const result = this.db.run(`
      UPDATE terminals
      SET
        ${updates.join(',\n        ')},
        last_message_at = CASE
          WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
          ELSE last_message_at
        END,
        last_active = CURRENT_TIMESTAMP
      WHERE terminal_id = ?
    `, ...params);
    return result.changes > 0;
  }

  /**
   * Delete terminal
   */
  deleteTerminal(terminalId) {
    this.db.run('DELETE FROM terminals WHERE terminal_id = ?', terminalId);
  }

  _parseTerminalInputQueueRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      terminalId: row.terminal_id,
      rootSessionId: row.root_session_id || null,
      runId: row.run_id || null,
      taskId: row.task_id || null,
      taskAssignmentId: row.task_assignment_id || null,
      inputKind: row.input_kind,
      message: row.message || null,
      status: row.status,
      controlMode: row.control_mode || SESSION_CONTROL_MODES.OPERATOR,
      requestedBy: row.requested_by || null,
      approvalRequired: Number(row.approval_required) === 1,
      approvedBy: row.approved_by || null,
      approvedAt: row.approved_at || null,
      decision: row.decision || null,
      holdReason: row.hold_reason || null,
      expiresAt: row.expires_at || null,
      deliveredAt: row.delivered_at || null,
      cancelledAt: row.cancelled_at || null,
      metadata: parseJsonField(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  enqueueTerminalInput(input = {}) {
    const terminalId = String(input.terminalId || input.terminal_id || '').trim();
    if (!terminalId) {
      throw new Error('terminalId is required');
    }
    if (!this.getTerminal(terminalId)) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    const terminalRow = this.getTerminal(terminalId);
    const terminalMetadata = parseJsonField(terminalRow?.session_metadata) || {};
    const inputKind = normalizeTerminalInputKind(input.inputKind || input.input_kind);
    const message = input.message == null ? null : String(input.message);
    if (!message && inputKind === 'message') {
      throw new Error('message is required');
    }

    const approvalRequired = input.approvalRequired === true || Number(input.approval_required) === 1;
    const status = normalizeTerminalInputQueueStatus(
      input.status || (approvalRequired ? 'held_for_approval' : 'pending')
    );
    const controlMode = normalizeSessionControlMode(
      input.controlMode || input.control_mode,
      SESSION_CONTROL_MODES.OPERATOR
    );
    const now = Number.isFinite(input.createdAt || input.created_at)
      ? (input.createdAt || input.created_at)
      : Date.now();
    const metadata = input.metadata == null
      ? null
      : (typeof input.metadata === 'string' ? input.metadata : JSON.stringify(input.metadata));
    const id = String(input.id || `input_${generateId()}`).trim();

    this.db.prepare(`
      INSERT INTO terminal_input_queue (
        id,
        terminal_id,
        root_session_id,
        run_id,
        task_id,
        task_assignment_id,
        input_kind,
        message,
        status,
        control_mode,
        requested_by,
        approval_required,
        approved_by,
        approved_at,
        decision,
        hold_reason,
        expires_at,
        delivered_at,
        cancelled_at,
        metadata,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      terminalId,
      input.rootSessionId || input.root_session_id || terminalRow?.root_session_id || terminalRow?.rootSessionId || null,
      input.runId || input.run_id || null,
      input.taskId || input.task_id || terminalMetadata.taskId || null,
      input.taskAssignmentId || input.task_assignment_id || terminalMetadata.taskAssignmentId || null,
      inputKind,
      message,
      status,
      controlMode,
      input.requestedBy || input.requested_by || null,
      approvalRequired ? 1 : 0,
      input.approvedBy || input.approved_by || null,
      Number.isFinite(input.approvedAt || input.approved_at) ? (input.approvedAt || input.approved_at) : null,
      input.decision || null,
      input.holdReason || input.hold_reason || (approvalRequired ? 'approval_required' : null),
      Number.isFinite(input.expiresAt || input.expires_at) ? (input.expiresAt || input.expires_at) : null,
      Number.isFinite(input.deliveredAt || input.delivered_at) ? (input.deliveredAt || input.delivered_at) : null,
      Number.isFinite(input.cancelledAt || input.cancelled_at) ? (input.cancelledAt || input.cancelled_at) : null,
      metadata,
      now,
      Number.isFinite(input.updatedAt || input.updated_at) ? (input.updatedAt || input.updated_at) : now
    );

    return this.getTerminalInputQueueItem(id);
  }

  getTerminalInputQueueItem(id) {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) {
      return null;
    }
    const row = this.db.prepare('SELECT * FROM terminal_input_queue WHERE id = ?').get(normalizedId);
    return this._parseTerminalInputQueueRow(row);
  }

  listTerminalInputQueue(options = {}) {
    const queueOptions = options && typeof options === 'object' ? options : {};
    const clauses = [];
    const params = [];

    if (queueOptions.terminalId || queueOptions.terminal_id) {
      clauses.push('terminal_id = ?');
      params.push(String(queueOptions.terminalId || queueOptions.terminal_id).trim());
    }
    if (queueOptions.rootSessionId || queueOptions.root_session_id) {
      clauses.push('root_session_id = ?');
      params.push(String(queueOptions.rootSessionId || queueOptions.root_session_id).trim());
    }
    if (queueOptions.taskId || queueOptions.task_id) {
      clauses.push('task_id = ?');
      params.push(String(queueOptions.taskId || queueOptions.task_id).trim());
    }
    if (queueOptions.status) {
      const statuses = Array.isArray(queueOptions.status) ? queueOptions.status : [queueOptions.status];
      const normalizedStatuses = statuses
        .map((status) => normalizeTerminalInputQueueStatus(status, null))
        .filter(Boolean);
      if (normalizedStatuses.length > 0) {
        clauses.push(`status IN (${normalizedStatuses.map(() => '?').join(', ')})`);
        params.push(...normalizedStatuses);
      }
    }

    const limit = clampLimit(queueOptions.limit, 100, 500);
    const offset = clampLimit(queueOptions.offset, 0, 100000);
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT *
      FROM terminal_input_queue
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return rows.map((row) => this._parseTerminalInputQueueRow(row));
  }

  updateTerminalInputQueueItem(id, patch = {}) {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) {
      throw new Error('inputQueueId is required');
    }
    const existing = this.getTerminalInputQueueItem(normalizedId);
    if (!existing) {
      throw new Error(`Input queue item not found: ${normalizedId}`);
    }

    const updates = [];
    const params = [];
    const addUpdate = (column, value) => {
      updates.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.status !== undefined) {
      addUpdate('status', normalizeTerminalInputQueueStatus(patch.status));
    }
    if (patch.message !== undefined) {
      addUpdate('message', patch.message == null ? null : String(patch.message));
    }
    if (patch.controlMode !== undefined || patch.control_mode !== undefined) {
      addUpdate('control_mode', normalizeSessionControlMode(patch.controlMode ?? patch.control_mode));
    }
    if (patch.requestedBy !== undefined || patch.requested_by !== undefined) {
      addUpdate('requested_by', patch.requestedBy ?? patch.requested_by ?? null);
    }
    if (patch.approvalRequired !== undefined || patch.approval_required !== undefined) {
      addUpdate('approval_required', (patch.approvalRequired ?? patch.approval_required) ? 1 : 0);
    }
    if (patch.approvedBy !== undefined || patch.approved_by !== undefined) {
      addUpdate('approved_by', patch.approvedBy ?? patch.approved_by ?? null);
    }
    if (patch.approvedAt !== undefined || patch.approved_at !== undefined) {
      addUpdate('approved_at', patch.approvedAt ?? patch.approved_at ?? null);
    }
    if (patch.decision !== undefined) {
      const decision = patch.decision == null ? null : String(patch.decision).trim().toLowerCase();
      if (decision && !['approved', 'denied'].includes(decision)) {
        throw new Error(`Invalid decision: ${patch.decision}`);
      }
      addUpdate('decision', decision || null);
    }
    if (patch.holdReason !== undefined || patch.hold_reason !== undefined) {
      addUpdate('hold_reason', patch.holdReason ?? patch.hold_reason ?? null);
    }
    if (patch.expiresAt !== undefined || patch.expires_at !== undefined) {
      addUpdate('expires_at', patch.expiresAt ?? patch.expires_at ?? null);
    }
    if (patch.deliveredAt !== undefined || patch.delivered_at !== undefined) {
      addUpdate('delivered_at', patch.deliveredAt ?? patch.delivered_at ?? null);
    }
    if (patch.cancelledAt !== undefined || patch.cancelled_at !== undefined) {
      addUpdate('cancelled_at', patch.cancelledAt ?? patch.cancelled_at ?? null);
    }
    if (patch.metadata !== undefined) {
      addUpdate('metadata', patch.metadata == null
        ? null
        : (typeof patch.metadata === 'string' ? patch.metadata : JSON.stringify(patch.metadata)));
    }

    if (updates.length === 0) {
      return existing;
    }

    addUpdate('updated_at', Number.isFinite(patch.updatedAt || patch.updated_at)
      ? (patch.updatedAt || patch.updated_at)
      : Date.now());

    this.db.prepare(`
      UPDATE terminal_input_queue
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params, normalizedId);

    return this.getTerminalInputQueueItem(normalizedId);
  }

  expireTerminalInputQueueItems(now = Date.now()) {
    const result = this.db.prepare(`
      UPDATE terminal_input_queue
      SET status = 'expired', updated_at = ?
      WHERE status IN ('pending', 'held_for_approval')
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).run(now, now);

    return result.changes || 0;
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

    const row = insertEvent.immediate();
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

  _parseRootIoEventRow(row) {
    if (!row) {
      return null;
    }

    return {
      ...row,
      rootIoEventId: row.root_io_event_id,
      idempotencyKey: row.idempotency_key || null,
      rootSessionId: row.root_session_id || null,
      terminalId: row.terminal_id || null,
      runId: row.run_id || null,
      taskId: row.task_id || null,
      taskAssignmentId: row.task_assignment_id || null,
      roomId: row.room_id || null,
      discussionId: row.discussion_id || null,
      traceId: row.trace_id || null,
      projectId: row.project_id || null,
      eventKind: row.event_kind,
      contentPreview: row.content_preview || null,
      contentFull: row.content_full || null,
      contentSha256: row.content_sha256 || null,
      logPath: row.log_path || null,
      logOffsetStart: row.log_offset_start,
      logOffsetEnd: row.log_offset_end,
      screenRows: row.screen_rows,
      screenCols: row.screen_cols,
      parsedRole: row.parsed_role || null,
      confidence: row.confidence,
      retentionClass: row.retention_class,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      metadata: parseJsonField(row.metadata) || {}
    };
  }

  getNextRootIoEventSequence(rootSessionId) {
    const normalizedRootSessionId = String(rootSessionId || '').trim();
    if (!normalizedRootSessionId || !this._hasTable('root_io_events')) {
      return 1;
    }
    const row = this.db.get(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
      FROM root_io_events
      WHERE root_session_id = ?
    `, normalizedRootSessionId);
    return row?.next_sequence || 1;
  }

  _resolveProjectIdForRootIoEvent(eventInput = {}) {
    const explicitProjectId = String(eventInput.projectId || eventInput.project_id || '').trim();
    if (explicitProjectId) {
      return explicitProjectId;
    }

    return this._resolveSingleProjectId([
      this._getTaskProjectId(eventInput.taskId || eventInput.task_id),
      this._getRunProjectId(eventInput.runId || eventInput.run_id),
      this._getTerminalProjectId(eventInput.terminalId || eventInput.terminal_id)
    ]);
  }

  appendRootIoEvent(event = {}) {
    if (!this._hasTable('root_io_events')) {
      return null;
    }

    const eventInput = event && typeof event === 'object' ? event : {};
    const rootSessionId = String(eventInput.rootSessionId || eventInput.root_session_id || '').trim();
    if (!rootSessionId) {
      throw new Error('rootSessionId is required');
    }

    const eventKind = normalizeEnumValue(
      eventInput.eventKind || eventInput.event_kind,
      ROOT_IO_EVENT_KINDS
    );
    if (!eventKind) {
      throw new Error(`eventKind must be one of ${Array.from(ROOT_IO_EVENT_KINDS).join(', ')}`);
    }

    const source = normalizeEnumValue(
      eventInput.source,
      ROOT_IO_EVENT_SOURCES,
      'broker'
    );
    const retentionClass = normalizeEnumValue(
      eventInput.retentionClass || eventInput.retention_class,
      ROOT_IO_RETENTION_CLASSES,
      'raw-bounded'
    );
    const terminalId = String(eventInput.terminalId || eventInput.terminal_id || '').trim() || null;
    const runId = String(eventInput.runId || eventInput.run_id || '').trim() || null;
    const taskId = String(eventInput.taskId || eventInput.task_id || '').trim() || null;
    const taskAssignmentId = String(eventInput.taskAssignmentId || eventInput.task_assignment_id || '').trim() || null;
    const roomId = String(eventInput.roomId || eventInput.room_id || '').trim() || null;
    const discussionId = String(eventInput.discussionId || eventInput.discussion_id || '').trim() || null;
    const traceId = String(eventInput.traceId || eventInput.trace_id || '').trim() || null;
    const logPath = String(eventInput.logPath || eventInput.log_path || '').trim() || null;
    const logOffsetStart = normalizeOptionalInteger(eventInput.logOffsetStart ?? eventInput.log_offset_start);
    const logOffsetEnd = normalizeOptionalInteger(eventInput.logOffsetEnd ?? eventInput.log_offset_end);
    const idempotencyKey = String(eventInput.idempotencyKey || eventInput.idempotency_key || (
      logPath && logOffsetStart !== null && logOffsetEnd !== null
        ? `${rootSessionId}:${source}:${eventKind}:${logPath}:${logOffsetStart}:${logOffsetEnd}`
        : ''
    )).trim() || null;
    const occurredAt = Number.isFinite(eventInput.occurredAt)
      ? eventInput.occurredAt
      : (Number.isFinite(eventInput.occurred_at) ? eventInput.occurred_at : Date.now());
    const recordedAt = Number.isFinite(eventInput.recordedAt)
      ? eventInput.recordedAt
      : (Number.isFinite(eventInput.recorded_at) ? eventInput.recorded_at : Date.now());
    const redactedPayload = buildRedactedRootIoPayload(eventInput);
    const contentSha256 = String(eventInput.contentSha256 || eventInput.content_sha256 || '').trim()
      || computeRootIoContentHash({
        eventKind,
        source,
        contentPreview: redactedPayload.contentPreview,
        contentFull: redactedPayload.contentFull,
        metadata: redactedPayload.metadata
      });
    const projectId = this._resolveProjectIdForRootIoEvent({
      ...eventInput,
      terminalId,
      runId,
      taskId
    });

    const insertEvent = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.db.get(`
          SELECT *
          FROM root_io_events
          WHERE idempotency_key = ?
        `, idempotencyKey);
        if (existing) {
          return existing;
        }
      }

      const rootIoEventId = String(eventInput.rootIoEventId || eventInput.root_io_event_id || eventInput.id || `rio_${generateId()}`).trim();
      const sequenceNo = Number.isInteger(eventInput.sequenceNo) && eventInput.sequenceNo > 0
        ? eventInput.sequenceNo
        : (Number.isInteger(eventInput.sequence_no) && eventInput.sequence_no > 0
          ? eventInput.sequence_no
          : this.getNextRootIoEventSequence(rootSessionId));

      this.db.run(`
        INSERT INTO root_io_events (
          root_io_event_id,
          idempotency_key,
          root_session_id,
          terminal_id,
          run_id,
          task_id,
          task_assignment_id,
          room_id,
          discussion_id,
          trace_id,
          project_id,
          event_kind,
          source,
          sequence_no,
          content_preview,
          content_full,
          content_sha256,
          log_path,
          log_offset_start,
          log_offset_end,
          screen_rows,
          screen_cols,
          parsed_role,
          confidence,
          retention_class,
          expires_at,
          metadata,
          occurred_at,
          recorded_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      rootIoEventId,
      idempotencyKey,
      rootSessionId,
      terminalId,
      runId,
      taskId,
      taskAssignmentId,
      roomId,
      discussionId,
      traceId,
      projectId,
      eventKind,
      source,
      sequenceNo,
      redactedPayload.contentPreview,
      redactedPayload.contentFull,
      contentSha256,
      logPath,
      logOffsetStart,
      logOffsetEnd,
      normalizeOptionalInteger(eventInput.screenRows ?? eventInput.screen_rows),
      normalizeOptionalInteger(eventInput.screenCols ?? eventInput.screen_cols),
      String(eventInput.parsedRole || eventInput.parsed_role || '').trim() || null,
      normalizeConfidence(eventInput.confidence),
      retentionClass,
      normalizeOptionalInteger(eventInput.expiresAt ?? eventInput.expires_at),
      JSON.stringify(redactedPayload.metadata),
      occurredAt,
      recordedAt);

      return this.db.get('SELECT * FROM root_io_events WHERE root_io_event_id = ?', rootIoEventId);
    });

    return this._parseRootIoEventRow(insertEvent.immediate());
  }

  listRootIoEvents(options = {}) {
    if (!this._hasTable('root_io_events')) {
      return [];
    }

    const eventOptions = options && typeof options === 'object' ? options : {};
    const clauses = [];
    const params = [];
    const pushTextMatch = (column, value) => {
      const normalized = String(value || '').trim();
      if (!normalized) {
        return;
      }
      clauses.push(`${column} = ?`);
      params.push(normalized);
    };

    pushTextMatch('root_session_id', eventOptions.rootSessionId || eventOptions.root_session_id);
    pushTextMatch('terminal_id', eventOptions.terminalId || eventOptions.terminal_id);
    pushTextMatch('run_id', eventOptions.runId || eventOptions.run_id);
    pushTextMatch('task_id', eventOptions.taskId || eventOptions.task_id);
    pushTextMatch('task_assignment_id', eventOptions.taskAssignmentId || eventOptions.task_assignment_id);
    pushTextMatch('room_id', eventOptions.roomId || eventOptions.room_id);
    pushTextMatch('discussion_id', eventOptions.discussionId || eventOptions.discussion_id);
    pushTextMatch('trace_id', eventOptions.traceId || eventOptions.trace_id);
    pushTextMatch('project_id', eventOptions.projectId || eventOptions.project_id);
    pushTextMatch('event_kind', eventOptions.eventKind || eventOptions.event_kind);
    pushTextMatch('source', eventOptions.source);

    const since = normalizeProjectionTimestamp(eventOptions.since);
    if (since !== null) {
      clauses.push('occurred_at >= ?');
      params.push(since);
    }
    const until = normalizeProjectionTimestamp(eventOptions.until);
    if (until !== null) {
      clauses.push('occurred_at <= ?');
      params.push(until);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(eventOptions.limit, 100, 500);
    return this.db.all(`
      SELECT *
      FROM root_io_events
      ${whereSql}
      ORDER BY occurred_at ASC, sequence_no ASC, recorded_at ASC, root_io_event_id ASC
      LIMIT ?
    `, ...params, limit).map((row) => this._parseRootIoEventRow(row));
  }

  getLatestRootIoLogOffset(options = {}) {
    if (!this._hasTable('root_io_events')) {
      return null;
    }

    const offsetOptions = options && typeof options === 'object' ? options : {};
    const rootSessionId = String(offsetOptions.rootSessionId || offsetOptions.root_session_id || '').trim();
    const terminalId = String(offsetOptions.terminalId || offsetOptions.terminal_id || '').trim();
    const logPath = String(offsetOptions.logPath || offsetOptions.log_path || '').trim();
    if (!rootSessionId || !terminalId || !logPath) {
      return null;
    }

    const row = this.db.get(`
      SELECT MAX(log_offset_end) AS log_offset_end
      FROM root_io_events
      WHERE root_session_id = ?
        AND terminal_id = ?
        AND log_path = ?
        AND source = 'terminal_log'
        AND event_kind = 'output'
        AND log_offset_end IS NOT NULL
    `, rootSessionId, terminalId, logPath);
    return Number.isFinite(row?.log_offset_end) ? row.log_offset_end : null;
  }

  _parseMemorySummaryEdgeRow(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
      edgeId: row.edge_id,
      edgeNamespace: row.edge_namespace,
      parentScopeType: row.parent_scope_type,
      parentScopeId: row.parent_scope_id,
      childScopeType: row.child_scope_type,
      childScopeId: row.child_scope_id,
      edgeKind: row.edge_kind,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  appendMemorySummaryEdge(edge = {}) {
    if (!this._hasTable('memory_summary_edges')) {
      return null;
    }

    const edgeInput = edge && typeof edge === 'object' ? edge : {};
    const edgeNamespace = normalizeEnumValue(
      edgeInput.edgeNamespace || edgeInput.edge_namespace,
      MEMORY_SUMMARY_EDGE_NAMESPACES,
      'derivation'
    );
    const edgeKind = normalizeEnumValue(
      edgeInput.edgeKind || edgeInput.edge_kind,
      MEMORY_SUMMARY_EDGE_KINDS,
      'summarizes'
    );
    const parentScopeType = String(edgeInput.parentScopeType || edgeInput.parent_scope_type || '').trim();
    const parentScopeId = String(edgeInput.parentScopeId || edgeInput.parent_scope_id || '').trim();
    const childScopeType = String(edgeInput.childScopeType || edgeInput.child_scope_type || '').trim();
    const childScopeId = String(edgeInput.childScopeId || edgeInput.child_scope_id || '').trim();
    if (!parentScopeType || !parentScopeId || !childScopeType || !childScopeId) {
      throw new Error('parentScopeType, parentScopeId, childScopeType, and childScopeId are required');
    }
    if (parentScopeType === childScopeType && parentScopeId === childScopeId) {
      throw new Error('memory summary edges cannot point to themselves');
    }

    const reverse = this.db.get(`
      SELECT edge_id
      FROM memory_summary_edges
      WHERE parent_scope_type = ?
        AND parent_scope_id = ?
        AND child_scope_type = ?
        AND child_scope_id = ?
      LIMIT 1
    `, childScopeType, childScopeId, parentScopeType, parentScopeId);
    if (reverse) {
      throw new Error('memory summary edges cannot create a direct cycle');
    }

    const now = Date.now();
    const createdAt = Number.isFinite(edgeInput.createdAt)
      ? edgeInput.createdAt
      : (Number.isFinite(edgeInput.created_at) ? edgeInput.created_at : now);
    const updatedAt = Number.isFinite(edgeInput.updatedAt)
      ? edgeInput.updatedAt
      : (Number.isFinite(edgeInput.updated_at) ? edgeInput.updated_at : createdAt);
    const metadata = edgeInput.metadata && typeof edgeInput.metadata === 'object' && !Array.isArray(edgeInput.metadata)
      ? redactSecretObject({ ...edgeInput.metadata })
      : {};

    const insertEdge = this.db.transaction(() => {
      const existing = this.db.get(`
        SELECT *
        FROM memory_summary_edges
        WHERE edge_namespace = ?
          AND parent_scope_type = ?
          AND parent_scope_id = ?
          AND child_scope_type = ?
          AND child_scope_id = ?
          AND edge_kind = ?
      `, edgeNamespace, parentScopeType, parentScopeId, childScopeType, childScopeId, edgeKind);
      if (existing) {
        return existing;
      }

      const edgeId = String(edgeInput.edgeId || edgeInput.edge_id || edgeInput.id || `mse_${generateId()}`).trim();
      this.db.run(`
        INSERT INTO memory_summary_edges (
          edge_id,
          edge_namespace,
          parent_scope_type,
          parent_scope_id,
          child_scope_type,
          child_scope_id,
          edge_kind,
          metadata,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      edgeId,
      edgeNamespace,
      parentScopeType,
      parentScopeId,
      childScopeType,
      childScopeId,
      edgeKind,
      JSON.stringify(metadata),
      createdAt,
      updatedAt);

      return this.db.get('SELECT * FROM memory_summary_edges WHERE edge_id = ?', edgeId);
    });

    return this._parseMemorySummaryEdgeRow(insertEdge.immediate());
  }

  listMemorySummaryEdges(options = {}) {
    if (!this._hasTable('memory_summary_edges')) {
      return [];
    }

    const edgeOptions = options && typeof options === 'object' ? options : {};
    const clauses = [];
    const params = [];
    const pushTextMatch = (column, value) => {
      const normalized = String(value || '').trim();
      if (!normalized) {
        return;
      }
      clauses.push(`${column} = ?`);
      params.push(normalized);
    };

    pushTextMatch('edge_namespace', edgeOptions.edgeNamespace || edgeOptions.edge_namespace);
    pushTextMatch('edge_kind', edgeOptions.edgeKind || edgeOptions.edge_kind);
    pushTextMatch('parent_scope_type', edgeOptions.parentScopeType || edgeOptions.parent_scope_type);
    pushTextMatch('parent_scope_id', edgeOptions.parentScopeId || edgeOptions.parent_scope_id);
    pushTextMatch('child_scope_type', edgeOptions.childScopeType || edgeOptions.child_scope_type);
    pushTextMatch('child_scope_id', edgeOptions.childScopeId || edgeOptions.child_scope_id);

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(edgeOptions.limit, 100, 500);
    return this.db.all(`
      SELECT *
      FROM memory_summary_edges
      ${whereSql}
      ORDER BY created_at DESC, edge_id ASC
      LIMIT ?
    `, ...params, limit).map((row) => this._parseMemorySummaryEdgeRow(row));
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
    const normalizedRole = String(role || '').trim().toLowerCase();
    const normalizedMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? redactSecretObject({ ...metadata })
      : {};
    let persistedContent = content == null ? '' : String(content);
    const redaction = redactSecretsInText(persistedContent);
    if (redaction.redacted) {
      persistedContent = redaction.content;
      const securityMetadata = normalizedMetadata.security && typeof normalizedMetadata.security === 'object'
        ? { ...normalizedMetadata.security }
        : {};
      securityMetadata.redactedSecretLikeContent = true;
      securityMetadata.redactionReasonCodes = redaction.reasons;
      normalizedMetadata.security = securityMetadata;
    }

    const stmt = this.db.prepare(`
      INSERT INTO messages (terminal_id, trace_id, root_session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const createdAt = Date.now(); // Milliseconds for proper ordering during fast tool loops
    const result = stmt.run(
      terminalId,
      traceId,
      explicitRootSessionId || terminalRow?.root_session_id || null,
      normalizedRole,
      persistedContent,
      JSON.stringify(normalizedMetadata),
      createdAt
    );
    const persistedRootSessionId = explicitRootSessionId || terminalRow?.root_session_id || null;

    this.touchTerminalMessage(terminalId, {
      timestamp: createdAt,
      model: normalizedMetadata?.model || null
    });

    if (persistedRootSessionId && this._hasTable('root_io_events')) {
      try {
        this.appendRootIoEvent({
          idempotencyKey: `message:${result.lastInsertRowid}`,
          rootSessionId: persistedRootSessionId,
          terminalId,
          runId: normalizedMetadata.runId || normalizedMetadata.run_id || null,
          taskId: normalizedMetadata.taskId || normalizedMetadata.task_id || null,
          taskAssignmentId: normalizedMetadata.taskAssignmentId || normalizedMetadata.task_assignment_id || null,
          roomId: normalizedMetadata.roomId || normalizedMetadata.room_id || null,
          discussionId: normalizedMetadata.discussionId || normalizedMetadata.discussion_id || null,
          traceId,
          eventKind: 'parsed_message',
          source: 'broker',
          contentFull: persistedContent,
          parsedRole: normalizedRole,
          metadata: {
            sourceTable: 'messages',
            messageId: result.lastInsertRowid
          },
          occurredAt: createdAt,
          recordedAt: createdAt,
          retentionClass: 'raw-bounded'
        });
      } catch (error) {
        console.warn('[db] Failed to append root IO event for message:', error.message);
      }
    }

    const usageRecord = buildUsageRecordFromMessage(terminalRow, terminalId, normalizedRole, normalizedMetadata, {
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
    const columns = [
      'root_session_id',
      'terminal_id',
      'run_id',
      'task_id',
      'task_assignment_id',
      'participant_id',
      'adapter',
      'provider',
      'model',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_input_tokens',
      'total_tokens',
      'cost_usd',
      'duration_ms',
      'source_confidence',
      'metadata',
      'created_at'
    ];
    const values = [
      usage.rootSessionId || null,
      usage.terminalId,
      usage.runId || null,
      usage.taskId || null,
      usage.taskAssignmentId || null,
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
      createdAt
    ];
    if (this._hasColumn('usage_records', 'project_id')) {
      columns.splice(columns.length - 1, 0, 'project_id');
      values.splice(values.length - 1, 0, this._resolveProjectIdForUsage(usage));
    }

    const result = this.db.run(`
      INSERT INTO usage_records (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `, ...values);

    const usageRecordId = result.lastID;
    const rootSessionId = usage.rootSessionId || usage.root_session_id || null;
    if (rootSessionId && this._hasTable('root_io_events')) {
      try {
        this.appendRootIoEvent({
          idempotencyKey: `usage_records:${usageRecordId}`,
          rootSessionId,
          terminalId: usage.terminalId,
          runId: usage.runId || null,
          taskId: usage.taskId || null,
          taskAssignmentId: usage.taskAssignmentId || null,
          eventKind: 'usage',
          source: 'provider_metadata',
          contentPreview: `${usage.model || usage.adapter || 'usage'} ${normalizeUsageTotalTokens(
            usage.totalTokens,
            normalizeInteger(usage.inputTokens, 0) + normalizeInteger(usage.outputTokens, 0) + normalizeInteger(usage.reasoningTokens, 0)
          )} tokens`,
          metadata: {
            sourceTable: 'usage_records',
            usageRecordId,
            adapter: usage.adapter || null,
            provider: usage.provider || null,
            model: usage.model || null,
            sourceConfidence: normalizeUsageConfidence(usage.sourceConfidence || 'unknown'),
            inputTokens: normalizeInteger(usage.inputTokens, 0),
            outputTokens: normalizeInteger(usage.outputTokens, 0),
            reasoningTokens: normalizeInteger(usage.reasoningTokens, 0),
            cachedInputTokens: normalizeInteger(usage.cachedInputTokens, 0),
            totalTokens: normalizeUsageTotalTokens(
              usage.totalTokens,
              normalizeInteger(usage.inputTokens, 0) + normalizeInteger(usage.outputTokens, 0) + normalizeInteger(usage.reasoningTokens, 0)
            )
          },
          occurredAt: createdAt,
          recordedAt: createdAt,
          retentionClass: 'metadata-indefinite'
        });
      } catch (error) {
        console.warn('[db] Failed to append root IO event for usage record:', error.message);
      }
    }

    return usageRecordId;
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
      taskId: usageInput.taskId || null,
      taskAssignmentId: usageInput.taskAssignmentId || null,
      participantId: usageInput.participantId || null,
      adapter: usageInput.adapter || null,
      provider: usageInput.provider || null,
      model: usageInput.model || null,
      role: usageInput.role || null,
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
      SELECT
      usage_records.*,
      rp.participant_role AS participant_role,
      t.role AS terminal_role,
      ${buildUsageRoleSql()} AS effective_role
      FROM usage_records
      LEFT JOIN run_participants rp ON rp.id = usage_records.participant_id
      LEFT JOIN terminals t ON t.terminal_id = usage_records.terminal_id
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);

    return rows.map((row) => ({
      ...row,
      metadata: parseJsonField(row.metadata),
      taskId: row.task_id || null,
      projectId: row.project_id || null,
      taskAssignmentId: row.task_assignment_id || null,
      effectiveRole: normalizeUsageRole(row.effective_role),
      roleGroup: classifyUsageRoleBucket(row.effective_role)
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
    const isRoleBreakdown = groupBy === 'role';
    if (!groupColumn && !isRoleBreakdown) {
      return [];
    }

    const { whereSql, params } = buildUsageWhereClause(usageOptions);
    const limit = Number.isInteger(usageOptions.limit) && usageOptions.limit > 0 ? usageOptions.limit : 20;
    const fromClause = isRoleBreakdown
      ? `
      FROM usage_records
      LEFT JOIN run_participants rp ON rp.id = usage_records.participant_id
      LEFT JOIN terminals t ON t.terminal_id = usage_records.terminal_id
    `
      : 'FROM usage_records';
    const groupExpr = isRoleBreakdown
      ? buildUsageRoleSql()
      : `COALESCE(${groupColumn}, 'unknown')`;

    return this.db.all(`
      SELECT
        ${groupExpr} AS bucket,
        COUNT(*) AS record_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(duration_ms), 0) AS duration_ms
      ${fromClause}
      ${whereSql}
      GROUP BY ${groupExpr}
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

  summarizeUsageAttribution(options = {}) {
    const summary = this.summarizeUsage(options);
    const roleBreakdown = this.listUsageBreakdown({
      ...options,
      groupBy: 'role',
      limit: 100
    });

    const grouped = {
      planning: { key: 'planning', recordCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      judging: { key: 'judging', recordCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      execution: { key: 'execution', recordCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      supervision: { key: 'supervision', recordCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      unknown: { key: 'unknown', recordCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    };

    for (const entry of roleBreakdown) {
      const bucket = grouped[classifyUsageRoleBucket(entry.key)];
      bucket.recordCount += entry.recordCount || 0;
      bucket.inputTokens += entry.inputTokens || 0;
      bucket.outputTokens += entry.outputTokens || 0;
      bucket.totalTokens += entry.totalTokens || 0;
      bucket.costUsd += entry.costUsd || 0;
    }

    const totalTokens = summary.totalTokens || 0;
    const brokerOverheadTokens = grouped.planning.totalTokens + grouped.judging.totalTokens + grouped.supervision.totalTokens;
    const executionTokens = grouped.execution.totalTokens;

    return {
      roleBreakdown,
      roleGroups: Object.values(grouped),
      planningTokens: grouped.planning.totalTokens,
      judgeTokens: grouped.judging.totalTokens,
      executionTokens,
      supervisionTokens: grouped.supervision.totalTokens,
      unknownRoleTokens: grouped.unknown.totalTokens,
      brokerOverheadTokens,
      brokerOverheadShare: totalTokens > 0 ? brokerOverheadTokens / totalTokens : 0,
      executionShare: totalTokens > 0 ? executionTokens / totalTokens : 0
    };
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
  // Adapter Readiness
  // =====================

  _parseAdapterReadinessReportRow(row) {
    if (!row) {
      return null;
    }

    return {
      adapter: row.adapter,
      available: parseNullableBoolean(row.available),
      authenticated: parseNullableBoolean(row.authenticated),
      authReason: row.auth_reason || null,
      ephemeralReady: parseNullableBoolean(row.ephemeral_ready),
      collaboratorReady: parseNullableBoolean(row.collaborator_ready),
      continuityMode: row.continuity_mode || null,
      overall: row.overall || null,
      reasonCode: row.reason_code || null,
      reason: row.reason || null,
      checks: parseJsonField(row.checks) || {},
      details: parseJsonField(row.details) || [],
      source: row.source || 'live',
      staleAfterMs: Number.isFinite(row.stale_after_ms) ? row.stale_after_ms : null,
      verifiedAt: row.verified_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  upsertAdapterReadinessReport(input = {}) {
    const adapter = String(input.adapter || '').trim();
    if (!adapter) {
      throw new Error('adapter is required');
    }

    const now = Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now();
    const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : now;
    const verifiedAt = Number.isFinite(input.verifiedAt) ? input.verifiedAt : now;
    const staleAfterMs = Number.isFinite(input.staleAfterMs) ? input.staleAfterMs : null;
    const source = String(input.source || 'live').trim().toLowerCase() || 'live';
    const checks = input.checks && typeof input.checks === 'object' && !Array.isArray(input.checks)
      ? input.checks
      : {};
    const details = Array.isArray(input.details)
      ? input.details
      : input.details ? [String(input.details)] : [];

    this.db.prepare(`
      INSERT INTO adapter_readiness_reports (
        adapter, available, authenticated, auth_reason, ephemeral_ready,
        collaborator_ready, continuity_mode, overall, reason_code, reason,
        checks, details, source, stale_after_ms, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adapter) DO UPDATE SET
        available = excluded.available,
        authenticated = excluded.authenticated,
        auth_reason = excluded.auth_reason,
        ephemeral_ready = excluded.ephemeral_ready,
        collaborator_ready = excluded.collaborator_ready,
        continuity_mode = excluded.continuity_mode,
        overall = excluded.overall,
        reason_code = excluded.reason_code,
        reason = excluded.reason,
        checks = excluded.checks,
        details = excluded.details,
        source = excluded.source,
        stale_after_ms = excluded.stale_after_ms,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `).run(
      adapter,
      normalizeNullableBoolean(input.available),
      normalizeNullableBoolean(input.authenticated),
      input.authReason || input.auth_reason || null,
      normalizeNullableBoolean(input.ephemeralReady ?? input.ephemeral_ready),
      normalizeNullableBoolean(input.collaboratorReady ?? input.collaborator_ready),
      input.continuityMode || input.continuity_mode || null,
      input.overall || null,
      input.reasonCode || input.reason_code || null,
      input.reason || null,
      JSON.stringify(checks),
      JSON.stringify(details),
      source,
      staleAfterMs,
      verifiedAt,
      createdAt,
      now
    );

    return this.getAdapterReadinessReport(adapter);
  }

  getAdapterReadinessReport(adapter) {
    const adapterName = String(adapter || '').trim();
    if (!adapterName) {
      return null;
    }
    const row = this.db.prepare('SELECT * FROM adapter_readiness_reports WHERE adapter = ?').get(adapterName);
    return this._parseAdapterReadinessReportRow(row);
  }

  listAdapterReadinessReports() {
    return this.db.prepare(`
      SELECT *
      FROM adapter_readiness_reports
      ORDER BY adapter ASC
    `).all().map((row) => this._parseAdapterReadinessReportRow(row));
  }

  // =====================
  // Task State
  // =====================

  _parseTaskRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      title: row.title,
      kind: row.kind || 'general',
      brief: row.brief || null,
      workspaceRoot: row.workspace_root || null,
      rootSessionId: row.root_session_id || null,
      projectId: row.project_id || null,
      metadata: parseJsonField(row.metadata) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _parseTaskAssignmentRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      taskId: row.task_id,
      terminalId: row.terminal_id || null,
      role: row.role,
      instructions: row.instructions,
      adapter: row.adapter || null,
      model: row.model || null,
      reasoningEffort: row.reasoning_effort || null,
      status: row.status || 'queued',
      worktreePath: row.worktree_path || null,
      worktreeBranch: row.worktree_branch || null,
      acceptanceCriteria: row.acceptance_criteria || null,
      metadata: parseJsonField(row.metadata) || {},
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  createTask(input = {}) {
    const id = String(input.id || `task_${generateId()}`).trim();
    const title = String(input.title || '').trim();
    const kind = String(input.kind || 'general').trim().toLowerCase() || 'general';
    const brief = typeof input.brief === 'string' ? input.brief : null;
    const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot) || null;
    const rootSessionId = String(input.rootSessionId || '').trim() || null;
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
    const hasProjectColumn = this._hasColumn('tasks', 'project_id');
    const projectId = hasProjectColumn
      ? this._resolveProjectIdForWorkspaceRoot(workspaceRoot, {
        metadata: { source: 'task_create' },
        createdAt: now
      })
      : null;

    if (!id) {
      throw new Error('task id is required');
    }
    if (!title) {
      throw new Error('title is required');
    }

    const columns = ['id', 'title', 'kind', 'brief', 'workspace_root', 'root_session_id', 'metadata', 'created_at', 'updated_at'];
    const values = [id, title, kind, brief, workspaceRoot, rootSessionId, JSON.stringify(metadata), now, now];
    if (hasProjectColumn) {
      columns.splice(6, 0, 'project_id');
      values.splice(6, 0, projectId);
    }

    this.db.prepare(`
      INSERT INTO tasks (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...values);

    return this.getTask(id);
  }

  getTask(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return this._parseTaskRow(row);
  }

  listTasks(options = {}) {
    const clauses = [];
    const params = [];
    if (options.workspaceRoot) {
      clauses.push('workspace_root = ?');
      params.push(String(options.workspaceRoot));
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(options.limit, 50, 500);
    return this.db.prepare(`
      SELECT *
      FROM tasks
      ${whereSql}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit).map((row) => this._parseTaskRow(row));
  }

  updateTask(taskId, patch = {}) {
    const updates = [];
    const params = [];
    if (patch.title !== undefined) {
      updates.push('title = ?');
      params.push(String(patch.title || '').trim());
    }
    if (patch.kind !== undefined) {
      updates.push('kind = ?');
      params.push(String(patch.kind || 'general').trim().toLowerCase() || 'general');
    }
    if (patch.brief !== undefined) {
      updates.push('brief = ?');
      params.push(typeof patch.brief === 'string' ? patch.brief : null);
    }
    if (patch.workspaceRoot !== undefined) {
      const workspaceRoot = normalizeWorkspaceRoot(patch.workspaceRoot) || null;
      updates.push('workspace_root = ?');
      params.push(workspaceRoot);
      if (this._hasColumn('tasks', 'project_id')) {
        updates.push('project_id = ?');
        params.push(this._resolveProjectIdForWorkspaceRoot(workspaceRoot, {
          metadata: { source: 'task_update' },
          createdAt: Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now()
        }));
      }
    }
    if (patch.rootSessionId !== undefined) {
      updates.push('root_session_id = ?');
      params.push(String(patch.rootSessionId || '').trim() || null);
    }
    if (patch.metadata !== undefined) {
      const metadata = patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
        ? patch.metadata
        : {};
      updates.push('metadata = ?');
      params.push(JSON.stringify(metadata));
    }

    const updatedAt = Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now();
    if (updates.length === 0) {
      this.db.prepare(`
        UPDATE tasks
        SET updated_at = ?
        WHERE id = ?
      `).run(updatedAt, taskId);
      return this.getTask(taskId);
    }

    updates.push('updated_at = ?');
    params.push(updatedAt);
    params.push(taskId);

    this.db.prepare(`
      UPDATE tasks
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params);
    return this.getTask(taskId);
  }

  createTaskAssignment(input = {}) {
    const id = String(input.id || `assignment_${generateId()}`).trim();
    const taskId = String(input.taskId || '').trim();
    const terminalId = String(input.terminalId || '').trim() || null;
    const role = String(input.role || '').trim().toLowerCase();
    const instructions = String(input.instructions || '').trim();
    const adapter = String(input.adapter || '').trim() || null;
    const model = String(input.model || '').trim() || null;
    const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort ?? input.reasoning_effort ?? input.effort);
    const status = String(input.status || 'queued').trim().toLowerCase() || 'queued';
    const worktreePath = String(input.worktreePath || '').trim() || null;
    const worktreeBranch = String(input.worktreeBranch || '').trim() || null;
    const acceptanceCriteria = typeof input.acceptanceCriteria === 'string' ? input.acceptanceCriteria : null;
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
    const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : null;
    const completedAt = Number.isFinite(input.completedAt) ? input.completedAt : null;

    if (!taskId) {
      throw new Error('taskId is required');
    }
    if (!role) {
      throw new Error('role is required');
    }
    if (!instructions) {
      throw new Error('instructions is required');
    }

    const columns = [
      'id', 'task_id', 'terminal_id', 'role', 'instructions', 'adapter', 'model', 'status',
      'worktree_path', 'worktree_branch', 'acceptance_criteria', 'metadata', 'started_at',
      'completed_at', 'created_at', 'updated_at'
    ];
    const values = [
      id,
      taskId,
      terminalId,
      role,
      instructions,
      adapter,
      model,
      status,
      worktreePath,
      worktreeBranch,
      acceptanceCriteria,
      JSON.stringify(metadata),
      startedAt,
      completedAt,
      now,
      now
    ];
    if (this._hasColumn('task_assignments', 'reasoning_effort')) {
      columns.splice(7, 0, 'reasoning_effort');
      values.splice(7, 0, reasoningEffort);
    }

    this.db.prepare(`
      INSERT INTO task_assignments (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...values);

    return this.getTaskAssignment(id);
  }

  getTaskAssignment(assignmentId) {
    const row = this.db.prepare('SELECT * FROM task_assignments WHERE id = ?').get(assignmentId);
    return this._parseTaskAssignmentRow(row);
  }

  listTaskAssignments(taskId, options = {}) {
    const clauses = ['task_id = ?'];
    const params = [taskId];
    if (options.status) {
      clauses.push('status = ?');
      params.push(String(options.status));
    }
    const limit = clampLimit(options.limit, 100, 500);
    return this.db.prepare(`
      SELECT *
      FROM task_assignments
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params, limit).map((row) => this._parseTaskAssignmentRow(row));
  }

  updateTaskAssignment(assignmentId, patch = {}) {
    const updates = [];
    const params = [];
    if (patch.terminalId !== undefined) {
      updates.push('terminal_id = ?');
      params.push(String(patch.terminalId || '').trim() || null);
    }
    if (patch.role !== undefined) {
      updates.push('role = ?');
      params.push(String(patch.role || '').trim().toLowerCase());
    }
    if (patch.instructions !== undefined) {
      updates.push('instructions = ?');
      params.push(String(patch.instructions || '').trim());
    }
    if (patch.adapter !== undefined) {
      updates.push('adapter = ?');
      params.push(String(patch.adapter || '').trim() || null);
    }
    if (patch.model !== undefined) {
      updates.push('model = ?');
      params.push(String(patch.model || '').trim() || null);
    }
    if (patch.reasoningEffort !== undefined || patch.reasoning_effort !== undefined || patch.effort !== undefined) {
      if (this._hasColumn('task_assignments', 'reasoning_effort')) {
        updates.push('reasoning_effort = ?');
        params.push(normalizeReasoningEffort(patch.reasoningEffort ?? patch.reasoning_effort ?? patch.effort));
      }
    }
    if (patch.status !== undefined) {
      updates.push('status = ?');
      params.push(String(patch.status || '').trim().toLowerCase() || 'queued');
    }
    if (patch.worktreePath !== undefined) {
      updates.push('worktree_path = ?');
      params.push(String(patch.worktreePath || '').trim() || null);
    }
    if (patch.worktreeBranch !== undefined) {
      updates.push('worktree_branch = ?');
      params.push(String(patch.worktreeBranch || '').trim() || null);
    }
    if (patch.acceptanceCriteria !== undefined) {
      updates.push('acceptance_criteria = ?');
      params.push(typeof patch.acceptanceCriteria === 'string' ? patch.acceptanceCriteria : null);
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

    if (updates.length === 0) {
      return this.getTaskAssignment(assignmentId);
    }

    const updatedAt = Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now();
    updates.push('updated_at = ?');
    params.push(updatedAt);
    params.push(assignmentId);

    this.db.prepare(`
      UPDATE task_assignments
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params);
    return this.getTaskAssignment(assignmentId);
  }

  getTaskLinkCounts(taskId) {
    return {
      runs: this.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE task_id = ?').get(taskId)?.count || 0,
      rooms: this.db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE task_id = ?').get(taskId)?.count || 0,
      discussions: this.db.prepare('SELECT COUNT(*) AS count FROM discussions WHERE task_id = ?').get(taskId)?.count || 0,
      memorySnapshots: this.db.prepare('SELECT COUNT(*) AS count FROM memory_snapshots WHERE task_id = ?').get(taskId)?.count || 0
    };
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
      taskId: row.task_id || null,
      projectId: row.project_id || null,
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
    const taskId = String(input.taskId || '').trim() || null;
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

    const columns = ['id', 'root_session_id', 'task_id', 'title', 'status', 'metadata', 'created_at', 'updated_at'];
    const values = [id, rootSessionId, taskId, title, status, JSON.stringify(metadata), now, now];
    if (this._hasColumn('rooms', 'project_id')) {
      columns.splice(3, 0, 'project_id');
      values.splice(3, 0, this._resolveProjectIdForTask(taskId));
    }

    this.db.prepare(`
      INSERT INTO rooms (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...values);

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
    if (patch.taskId !== undefined) {
      updates.push('task_id = ?');
      params.push(String(patch.taskId || '').trim() || null);
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
      projectId: row.project_id || null,
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
      taskId: row.task_id || null,
      projectId: row.project_id || null
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

  _requireRun(runId) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      throw new Error('runId is required');
    }
    const run = this.getRunById(normalizedRunId);
    if (!run) {
      throw new Error(`Run not found: ${normalizedRunId}`);
    }
    return run;
  }

  // =====================
  // Operator Actions (Phase 1A)
  // =====================
  // Durable record of operator replies, overrides, and interventions linked to runs.
  // Enables replay of operator decisions after broker restart.

  _parseOperatorActionRow(row) {
    if (!row) {
      return null;
    }
    return {
      actionId: row.action_id,
      runId: row.run_id,
      terminalId: row.terminal_id || null,
      actionKind: row.action_kind,
      payload: parseJsonField(row.payload_json),
      createdAt: row.created_at
    };
  }

  appendOperatorAction(input = {}) {
    const runId = String(input.runId || '').trim();
    const actionKind = String(input.actionKind || '').trim();
    const terminalId = input.terminalId ? String(input.terminalId).trim() : null;
    const payload = input.payload;
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();

    if (!runId) {
      throw new Error('runId is required');
    }
    if (!actionKind) {
      throw new Error('actionKind is required');
    }
    this._requireRun(runId);

    const validKinds = [
      'operator_reply',
      'operator_override',
      'operator_unblock',
      'operator_cancel',
      'operator_retry',
      'operator_escalate',
      'operator_resume'
    ];
    if (!validKinds.includes(actionKind)) {
      throw new Error(`Invalid actionKind: ${actionKind}`);
    }

    const id = input.actionId || `opact_${generateId()}`;
    const payloadJson = payload == null ? null : JSON.stringify(payload);

    this.db.prepare(`
      INSERT INTO operator_actions (action_id, run_id, terminal_id, action_kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, runId, terminalId, actionKind, payloadJson, now);

    return this.getOperatorAction(id);
  }

  getOperatorAction(actionId) {
    const row = this.db.prepare('SELECT * FROM operator_actions WHERE action_id = ?').get(actionId);
    return this._parseOperatorActionRow(row);
  }

  listOperatorActions(runId, options = {}) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      return [];
    }

    const clauses = ['run_id = ?'];
    const params = [normalizedRunId];

    if (options.actionKind) {
      clauses.push('action_kind = ?');
      params.push(String(options.actionKind).trim());
    }

    if (options.terminalId) {
      clauses.push('terminal_id = ?');
      params.push(String(options.terminalId).trim());
    }

    const whereSql = `WHERE ${clauses.join(' AND ')}`;
    const limit = clampLimit(options.limit, 50, 200);

    const rows = this.db.prepare(`
      SELECT * FROM operator_actions ${whereSql}
      ORDER BY created_at ASC, action_id ASC
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => this._parseOperatorActionRow(row));
  }

  // =====================
  // Run Blocked States (Phase 1A)
  // =====================
  // First-class blocked-state representation for runs.
  // Tracks when runs become blocked, why they are blocked, and when they unblock.

  _parseRunBlockedStateRow(row) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      runId: row.run_id,
      blockedReason: row.blocked_reason,
      blockingDetail: row.blocking_detail || null,
      unblockedAt: row.unblocked_at ?? null,
      unblockReason: row.unblock_reason || null,
      metadata: parseJsonField(row.metadata),
      createdAt: row.created_at
    };
  }

  appendRunBlockedState(input = {}) {
    const runId = String(input.runId || '').trim();
    const blockedReason = String(input.blockedReason || '').trim();
    const blockingDetail = input.blockingDetail != null ? String(input.blockingDetail).trim() : null;
    const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();

    if (!runId) {
      throw new Error('runId is required');
    }
    if (!blockedReason) {
      throw new Error('blockedReason is required');
    }
    this._requireRun(runId);

    const validReasons = [
      'waiting_for_input',
      'waiting_for_approval',
      'waiting_for_handoff',
      'waiting_for_resource',
      'waiting_for_dependency',
      'blocked_by_gate',
      'blocked_by_operator',
      'internal_block'
    ];
    if (!validReasons.includes(blockedReason)) {
      throw new Error(`Invalid blockedReason: ${blockedReason}`);
    }
    if (this.getActiveBlockedState(runId)) {
      throw new Error(`Run already has an active blocked state: ${runId}`);
    }

    const id = input.id || `rbs_${generateId()}`;
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};

    this.db.prepare(`
      INSERT INTO run_blocked_states (id, run_id, blocked_reason, blocking_detail, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, runId, blockedReason, blockingDetail, JSON.stringify(metadata), now);

    return this.getRunBlockedState(id);
  }

  getRunBlockedState(id) {
    const row = this.db.prepare('SELECT * FROM run_blocked_states WHERE id = ?').get(id);
    return this._parseRunBlockedStateRow(row);
  }

  getActiveBlockedState(runId) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT * FROM run_blocked_states
      WHERE run_id = ? AND unblocked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalizedRunId);
    return this._parseRunBlockedStateRow(row);
  }

  listRunBlockedStates(runId, options = {}) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      return [];
    }

    const clauses = ['run_id = ?'];
    const params = [normalizedRunId];

    if (options.blockedReason) {
      clauses.push('blocked_reason = ?');
      params.push(String(options.blockedReason).trim());
    }

    if (options.activeOnly) {
      clauses.push('unblocked_at IS NULL');
    }

    const whereSql = `WHERE ${clauses.join(' AND ')}`;
    const limit = clampLimit(options.limit, 50, 200);

    const rows = this.db.prepare(`
      SELECT * FROM run_blocked_states ${whereSql}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => this._parseRunBlockedStateRow(row));
  }

  unblockRun(runId, input = {}) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      throw new Error('runId is required');
    }
    this._requireRun(normalizedRunId);

    const now = Number.isFinite(input.unblockedAt) ? input.unblockedAt : Date.now();
    const unblockReason = input.unblockReason != null ? String(input.unblockReason).trim() : null;

    const result = this.db.prepare(`
      UPDATE run_blocked_states
      SET unblocked_at = ?, unblock_reason = ?
      WHERE run_id = ? AND unblocked_at IS NULL
    `).run(now, unblockReason, normalizedRunId);

    if (result.changes === 0) {
      throw new Error(`No active blocked state found for run: ${normalizedRunId}`);
    }

    return {
      runId: normalizedRunId,
      unblockedAt: now,
      unblockReason,
      unblockedCount: result.changes
    };
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

  _memoryReadModelHasRelation(name) {
    return Boolean(this.db.get(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
      name
    ));
  }

  _memoryReadModelHasColumn(tableName, columnName) {
    if (!this._memoryReadModelHasRelation(tableName)) {
      return false;
    }
    return this.db.prepare(`PRAGMA table_info(${tableName})`).all()
      .some((column) => column.name === columnName);
  }

  _assertMemoryReadModelReady(viewName) {
    const missing = [];
    if (!this._memoryReadModelHasRelation(viewName)) {
      missing.push(viewName);
    }
    if (!this._memoryReadModelHasRelation('projects')) {
      missing.push('projects table (Phase 1)');
    }

    const requiredColumns = [
      ['tasks', 'project_id'],
      ['runs', 'project_id'],
      ['rooms', 'project_id'],
      ['usage_records', 'project_id'],
      ['memory_snapshots', 'project_id'],
      ['terminals', 'project_id']
    ];
    for (const [tableName, columnName] of requiredColumns) {
      if (!this._memoryReadModelHasColumn(tableName, columnName)) {
        missing.push(`${tableName}.${columnName} (Phase 1)`);
      }
    }

    if (missing.length > 0) {
      const error = new Error(
        `Memory read-model projections require Phase 1 schema before ${viewName} is usable: ${missing.join(', ')}`
      );
      error.code = 'memory_read_model_unavailable';
      throw error;
    }
  }

  _buildMemoryReadModelFilters(options = {}) {
    const clauses = [];
    const params = [];
    const pushTextMatch = (column, value) => {
      const normalized = String(value || '').trim();
      if (!normalized) {
        return;
      }
      clauses.push(`${column} = ?`);
      params.push(normalized);
    };

    pushTextMatch('project_id', options.projectId || options.project_id);
    pushTextMatch('workspace_root', options.workspaceRoot || options.workspace_root);
    pushTextMatch('task_id', options.taskId || options.task_id);
    pushTextMatch('root_session_id', options.rootSessionId || options.root_session_id);
    pushTextMatch('run_id', options.runId || options.run_id);
    pushTextMatch('room_id', options.roomId || options.room_id);
    pushTextMatch('terminal_id', options.terminalId || options.terminal_id);
    pushTextMatch('task_assignment_id', options.taskAssignmentId || options.task_assignment_id);
    pushTextMatch('participant_id', options.participantId || options.participant_id);
    pushTextMatch('discussion_id', options.discussionId || options.discussion_id);
    pushTextMatch('trace_id', options.traceId || options.trace_id);

    const since = normalizeProjectionTimestamp(options.since);
    if (since !== null) {
      clauses.push('activity_at >= ?');
      params.push(since);
    }

    const until = normalizeProjectionTimestamp(options.until);
    if (until !== null) {
      clauses.push('activity_at <= ?');
      params.push(until);
    }

    return { clauses, params };
  }

  _parseMemoryRecordRow(row) {
    if (!row) {
      return null;
    }

    return {
      recordKey: row.record_key,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      recordType: row.record_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activityAt: row.activity_at,
      projectId: row.project_id || null,
      workspaceRoot: row.workspace_root || null,
      taskId: row.task_id || null,
      rootSessionId: row.root_session_id || null,
      runId: row.run_id || null,
      roomId: row.room_id || null,
      terminalId: row.terminal_id || null,
      taskAssignmentId: row.task_assignment_id || null,
      participantId: row.participant_id || null,
      discussionId: row.discussion_id || null,
      traceId: row.trace_id || null,
      displayText: row.display_text || null,
      searchText: row.search_text || ''
    };
  }

  _memoryRecordsProjectionSql() {
    if (this._memoryReadModelHasRelation('memory_records_root_io_v1')) {
      return `(SELECT * FROM memory_records_v1 UNION ALL SELECT * FROM memory_records_root_io_v1)`;
    }
    return 'memory_records_v1';
  }

  _memoryEdgesProjectionSql() {
    const projections = ['SELECT * FROM memory_edges_v1'];
    if (this._memoryReadModelHasRelation('memory_root_io_edges_v1')) {
      projections.push('SELECT * FROM memory_root_io_edges_v1');
    }
    if (this._memoryReadModelHasRelation('memory_summary_edges_v1')) {
      projections.push('SELECT * FROM memory_summary_edges_v1');
    }
    return projections.length === 1
      ? 'memory_edges_v1'
      : `(${projections.join(' UNION ALL ')})`;
  }

  queryMemoryRecords(options = {}) {
    this._assertMemoryReadModelReady('memory_records_v1');
    const { clauses, params } = this._buildMemoryReadModelFilters(options);
    const types = normalizeMemoryRecordTypes(options.types);
    const sourceTable = String(options.sourceTable || options.source_table || '').trim();
    const sourceId = options.sourceId ?? options.source_id;
    const queryText = String(options.q || '').trim().toLowerCase();

    if (types.length > 0) {
      clauses.push(`record_type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    if (sourceTable) {
      clauses.push('source_table = ?');
      params.push(sourceTable);
    }
    if (sourceId !== undefined && sourceId !== null && String(sourceId).trim()) {
      clauses.push('source_id = ?');
      params.push(String(sourceId).trim());
    }
    if (queryText) {
      clauses.push('LOWER(search_text) LIKE ?');
      params.push(`%${queryText}%`);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(options.limit, 100, 500);
    const projectionSql = this._memoryRecordsProjectionSql();
    const rows = this.db.prepare(`
      SELECT *
      FROM ${projectionSql}
      ${whereSql}
      ORDER BY activity_at DESC, created_at DESC, source_table ASC, source_id ASC
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => this._parseMemoryRecordRow(row));
  }

  getMemoryRecord(sourceTable, sourceId) {
    const normalizedSourceTable = String(sourceTable || '').trim();
    const normalizedSourceId = String(sourceId || '').trim();
    if (!normalizedSourceTable || !normalizedSourceId) {
      return null;
    }

    return this.queryMemoryRecords({
      sourceTable: normalizedSourceTable,
      sourceId: normalizedSourceId,
      limit: 1
    })[0] || null;
  }

  _parseMemoryEdgeRow(row) {
    if (!row) {
      return null;
    }

    return {
      edgeKey: row.edge_key,
      sourceRecordKey: row.source_record_key,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      sourceRecordType: row.source_record_type,
      edgeType: row.edge_type,
      targetScopeType: row.target_scope_type,
      targetId: row.target_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activityAt: row.activity_at,
      projectId: row.project_id || null,
      workspaceRoot: row.workspace_root || null,
      taskId: row.task_id || null,
      rootSessionId: row.root_session_id || null,
      runId: row.run_id || null,
      roomId: row.room_id || null,
      terminalId: row.terminal_id || null,
      taskAssignmentId: row.task_assignment_id || null,
      participantId: row.participant_id || null,
      discussionId: row.discussion_id || null,
      traceId: row.trace_id || null
    };
  }

  queryMemoryEdges(options = {}) {
    this._assertMemoryReadModelReady('memory_edges_v1');
    const { clauses, params } = this._buildMemoryReadModelFilters(options);
    const edgeTypes = normalizeProjectionList(options.edgeTypes || options.edge_types || options.types);
    const sourceTable = String(options.sourceTable || options.source_table || '').trim();
    const sourceId = options.sourceId ?? options.source_id;
    const targetScopeType = String(options.targetScopeType || options.target_scope_type || '').trim();
    const targetId = options.targetId ?? options.target_id;

    if (edgeTypes.length > 0) {
      clauses.push(`edge_type IN (${edgeTypes.map(() => '?').join(', ')})`);
      params.push(...edgeTypes);
    }
    if (sourceTable) {
      clauses.push('source_table = ?');
      params.push(sourceTable);
    }
    if (sourceId !== undefined && sourceId !== null && String(sourceId).trim()) {
      clauses.push('source_id = ?');
      params.push(String(sourceId).trim());
    }
    if (targetScopeType) {
      clauses.push('target_scope_type = ?');
      params.push(targetScopeType);
    }
    if (targetId !== undefined && targetId !== null && String(targetId).trim()) {
      clauses.push('target_id = ?');
      params.push(String(targetId).trim());
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(options.limit, 100, 500);
    const projectionSql = this._memoryEdgesProjectionSql();
    const rows = this.db.prepare(`
      SELECT *
      FROM ${projectionSql}
      ${whereSql}
      ORDER BY activity_at DESC, created_at DESC, source_table ASC, source_id ASC, edge_type ASC
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => this._parseMemoryEdgeRow(row));
  }

  getMemoryRecordSource(sourceTable, sourceId) {
    const normalizedSourceTable = String(sourceTable || '').trim();
    const normalizedSourceId = String(sourceId || '').trim();
    if (!normalizedSourceTable || !normalizedSourceId) {
      return null;
    }

    const lookup = MEMORY_PROJECTION_SOURCE_LOOKUPS[normalizedSourceTable];
    if (!lookup) {
      throw new Error(`Unsupported memory projection source table: ${normalizedSourceTable}`);
    }

    const row = this.db.prepare(`
      SELECT *
      FROM ${normalizedSourceTable}
      WHERE ${lookup.primaryKey} = ?
      LIMIT 1
    `).get(normalizedSourceId);

    return parseProjectionSourceRow(row);
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
      memorySnapshots: this.db.prepare("SELECT COUNT(*) as count FROM memory_snapshots").get().count,
      projects: this._hasTable('projects')
        ? this.db.prepare("SELECT COUNT(*) as count FROM projects").get().count
        : 0
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
