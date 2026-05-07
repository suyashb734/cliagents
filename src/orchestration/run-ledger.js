const crypto = require('crypto');
const zlib = require('zlib');
const { getDB } = require('../database/db');
const { redactSecretsInText, redactSecretObject } = require('../security/secret-redaction');

const OUTPUT_POLICY = {
  previewBytes: 16 * 1024,
  inlineBytes: 64 * 1024,
  compressedBytes: 256 * 1024
};

const INPUT_POLICY = {
  previewBytes: 16 * 1024,
  inlineBytes: 64 * 1024,
  compressedBytes: 256 * 1024
};

const TOOL_EVENT_POLICY = {
  previewBytes: 8 * 1024,
  inlineBytes: 32 * 1024,
  compressedBytes: 128 * 1024
};

const HASH_INPUT_FIELDS = {
  consensus: ['message'],
  'plan-review': ['plan', 'context'],
  'pr-review': ['summary', 'diff', 'testResults', 'context'],
  discussion: ['message']
};

function generateId(prefix = 'run') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeString(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function normalizeStructuredValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return normalizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeStructuredValue(item));
  }

  if (typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const normalized = normalizeStructuredValue(value[key]);
        if (normalized !== null && normalized !== undefined) {
          acc[key] = normalized;
        }
        return acc;
      }, {});
  }

  return value;
}

function buildParticipantHashShape(spec = {}) {
  return normalizeStructuredValue({
    name: spec.name || null,
    adapter: spec.adapter || null,
    systemPrompt: spec.systemPrompt || null,
    model: spec.model || null,
    timeout: spec.timeout || null,
    workDir: spec.workDir || null,
    jsonMode: spec.jsonMode === undefined ? null : Boolean(spec.jsonMode),
    jsonSchema: spec.jsonSchema || null
  });
}

function buildHashPayload(kind, payload = {}) {
  const normalized = {
    kind,
    workingDirectory: payload.workingDirectory || payload.workDir || null,
    timeout: payload.timeout || null,
    participants: Array.isArray(payload.participants)
      ? payload.participants.map((participant) => buildParticipantHashShape(participant))
      : [],
    judge: payload.judge ? buildParticipantHashShape(payload.judge) : null
  };

  const fields = HASH_INPUT_FIELDS[kind] || ['message'];
  for (const field of fields) {
    normalized[field] = payload[field] || null;
  }

  return normalizeStructuredValue(normalized);
}

function computeMessageHash(kind, payload = {}) {
  const canonicalJson = JSON.stringify(buildHashPayload(kind, payload));
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return String(text || '');
  }
  return buffer.subarray(0, maxBytes).toString('utf8');
}

function serializeJson(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sanitizeMetadata(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    return redactSecretsInText(value).content;
  }
  if (typeof value === 'object') {
    return redactSecretObject(value);
  }
  return value;
}

function attachRedactionMetadata(metadata, redaction) {
  if (!redaction?.redacted) {
    return metadata;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata;
  }

  const base = { ...metadata };
  const security = base.security && typeof base.security === 'object'
    ? { ...base.security }
    : {};
  security.redactedSecretLikeContent = true;
  security.redactionReasonCodes = redaction.reasons || [];
  base.security = security;
  return base;
}

function parseJson(value) {
  if (!value || typeof value !== 'string') {
    return value || null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function encodeBlob(value) {
  return value ? Buffer.from(value).toString('base64') : null;
}

function preparePayload(content, policy) {
  const redaction = redactSecretsInText(content);
  const text = String(redaction.content || '');
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const previewText = truncateUtf8(text, policy.previewBytes);
  const contentSha256 = sha256Text(text);

  if (originalBytes <= policy.inlineBytes) {
    return {
      previewText,
      fullText: text,
      compressedBlob: null,
      contentSha256,
      originalBytes,
      compressedBytes: null,
      compression: 'none',
      storageMode: 'inline_text',
      isTruncated: 0,
      redaction
    };
  }

  const compressedBlob = zlib.gzipSync(Buffer.from(text, 'utf8'));
  if (compressedBlob.byteLength <= policy.compressedBytes) {
    return {
      previewText,
      fullText: null,
      compressedBlob,
      contentSha256,
      originalBytes,
      compressedBytes: compressedBlob.byteLength,
      compression: 'gzip',
      storageMode: 'compressed',
      isTruncated: 0,
      redaction
    };
  }

  return {
    previewText,
    fullText: null,
    compressedBlob: null,
    contentSha256,
    originalBytes,
    compressedBytes: compressedBlob.byteLength,
    compression: 'gzip',
    storageMode: 'preview_only',
    isTruncated: 1,
    redaction
  };
}

function buildUpdateStatement(tableName, identifierField, identifierValue, patch, fieldMap = {}) {
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
  if (keys.length === 0) {
    return null;
  }

  const assignments = keys.map((key) => `${fieldMap[key] || key} = ?`);
  const values = keys.map((key) => patch[key]);
  values.push(identifierValue);

  return {
    sql: `UPDATE ${tableName} SET ${assignments.join(', ')} WHERE ${identifierField} = ?`,
    values
  };
}

const ACTIVE_RUN_STATUSES = new Set(['pending', 'running']);
const ACTIVE_PARTICIPANT_STATUSES = new Set(['queued', 'running', 'retrying']);
const ACTIVE_STEP_STATUSES = new Set(['pending', 'running']);
const ACTIVE_TOOL_EVENT_STATUSES = new Set(['pending', 'running']);

class RunLedgerService {
  constructor(db = getDB()) {
    this.db = db;
  }

  computeMessageHash(kind, payload = {}) {
    return computeMessageHash(kind, payload);
  }

  prepareOutput(content) {
    return preparePayload(content, OUTPUT_POLICY);
  }

  prepareInput(content) {
    return preparePayload(content, INPUT_POLICY);
  }

  prepareToolEventPayload(content) {
    return preparePayload(content, TOOL_EVENT_POLICY);
  }

  appendInput(input) {
    const inputId = input.id || generateId('input');
    const payload = this.prepareInput(input.content);
    const metadata = attachRedactionMetadata(sanitizeMetadata(input.metadata), payload.redaction);

    this.db.db.prepare(`
      INSERT INTO run_inputs (
        id, run_id, participant_id, input_kind, preview_text, full_text,
        compressed_blob, content_sha256, original_bytes, compressed_bytes,
        compression, storage_mode, is_truncated, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inputId,
      input.runId,
      input.participantId || null,
      input.inputKind,
      payload.previewText,
      payload.fullText,
      payload.compressedBlob,
      payload.contentSha256,
      payload.originalBytes,
      payload.compressedBytes,
      payload.compression,
      payload.storageMode,
      payload.isTruncated,
      serializeJson(metadata),
      input.createdAt || Date.now()
    );

    return inputId;
  }

  createRun(input) {
    const runId = input.id || generateId('run');
    const startedAt = input.startedAt || Date.now();
    const messageHash = input.messageHash || computeMessageHash(input.kind, input.hashInput || {});
    const hasProjectColumn = typeof this.db?._hasColumn === 'function'
      ? this.db._hasColumn('runs', 'project_id')
      : false;
    const projectId = hasProjectColumn
      ? (String(input.projectId || input.project_id || '').trim() || this.db._resolveSingleProjectId([
        this.db._getTaskProjectId(input.taskId),
        this.db._resolveProjectIdForWorkspaceRoot(input.workingDirectory, {
          metadata: { source: 'run_create' },
          createdAt: startedAt
        })
      ]))
      : null;

    const columns = [
      'id',
      'kind',
      'status',
      'message_hash',
      'input_summary',
      'working_directory',
      'initiator',
      'trace_id',
      'discussion_id',
      'current_step',
      'active_participant_count',
      'decision_summary',
      'decision_source',
      'failure_class',
      'retry_count',
      'metadata',
      'started_at',
      'last_heartbeat_at',
      'completed_at',
      'duration_ms',
      'root_session_id',
      'task_id'
    ];
    const values = [
      runId,
      input.kind,
      input.status || 'pending',
      messageHash,
      input.inputSummary || null,
      input.workingDirectory || null,
      input.initiator || null,
      input.traceId || null,
      input.discussionId || null,
      input.currentStep || null,
      input.activeParticipantCount || 0,
      input.decisionSummary || null,
      input.decisionSource || null,
      input.failureClass || null,
      input.retryCount || 0,
      serializeJson(input.metadata),
      startedAt,
      input.lastHeartbeatAt || startedAt,
      input.completedAt || null,
      input.durationMs || null,
      input.rootSessionId || null,
      input.taskId || null
    ];
    if (hasProjectColumn) {
      columns.push('project_id');
      values.push(projectId);
    }

    this.db.db.prepare(`
      INSERT INTO runs (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...values);

    return runId;
  }

  updateRun(runId, patch = {}) {
    const statement = buildUpdateStatement('runs', 'id', runId, {
      status: patch.status,
      message_hash: patch.messageHash,
      input_summary: patch.inputSummary,
      working_directory: patch.workingDirectory,
      initiator: patch.initiator,
      trace_id: patch.traceId,
      discussion_id: patch.discussionId,
      current_step: patch.currentStep,
      active_participant_count: patch.activeParticipantCount,
      decision_summary: patch.decisionSummary,
      decision_source: patch.decisionSource,
      failure_class: patch.failureClass,
      retry_count: patch.retryCount,
      metadata: patch.metadata === undefined ? undefined : serializeJson(patch.metadata),
      started_at: patch.startedAt,
      last_heartbeat_at: patch.lastHeartbeatAt,
      completed_at: patch.completedAt,
      duration_ms: patch.durationMs,
      root_session_id: patch.rootSessionId,
      task_id: patch.taskId
    });

    if (!statement) {
      return 0;
    }

    return this.db.db.prepare(statement.sql).run(...statement.values).changes;
  }

  addParticipant(input) {
    const participantId = input.id || generateId('participant');
    const attemptIndex = input.attemptIndex || 0;
    const attemptKey = input.attemptKey || `${input.runId}:${participantId}:${attemptIndex}`;

    this.db.db.prepare(`
      INSERT INTO run_participants (
        id, run_id, participant_role, participant_name, adapter, agent_profile,
        status, attempt_index, attempt_key, retry_count, current_step, failure_class,
        is_required, metadata, started_at, last_heartbeat_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      participantId,
      input.runId,
      input.participantRole,
      input.participantName || null,
      input.adapter,
      input.agentProfile || null,
      input.status || 'queued',
      attemptIndex,
      attemptKey,
      input.retryCount || 0,
      input.currentStep || null,
      input.failureClass || null,
      input.isRequired === undefined ? 1 : Number(Boolean(input.isRequired)),
      serializeJson(input.metadata),
      input.startedAt || null,
      input.lastHeartbeatAt || null,
      input.endedAt || null
    );

    return participantId;
  }

  updateParticipant(participantId, patch = {}) {
    const statement = buildUpdateStatement('run_participants', 'id', participantId, {
      participant_role: patch.participantRole,
      participant_name: patch.participantName,
      adapter: patch.adapter,
      agent_profile: patch.agentProfile,
      status: patch.status,
      attempt_index: patch.attemptIndex,
      attempt_key: patch.attemptKey,
      retry_count: patch.retryCount,
      current_step: patch.currentStep,
      failure_class: patch.failureClass,
      is_required: patch.isRequired === undefined ? undefined : Number(Boolean(patch.isRequired)),
      metadata: patch.metadata === undefined ? undefined : serializeJson(patch.metadata),
      started_at: patch.startedAt,
      last_heartbeat_at: patch.lastHeartbeatAt,
      ended_at: patch.endedAt
    });

    if (!statement) {
      return 0;
    }

    return this.db.db.prepare(statement.sql).run(...statement.values).changes;
  }

  appendStep(input) {
    const stepId = input.id || generateId('step');

    this.db.db.prepare(`
      INSERT INTO run_steps (
        id, run_id, participant_id, step_key, step_name, status,
        attempt_index, retry_safe, failure_class, metadata,
        started_at, last_heartbeat_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stepId,
      input.runId,
      input.participantId || null,
      input.stepKey,
      input.stepName,
      input.status || 'pending',
      input.attemptIndex || 0,
      input.retrySafe ? 1 : 0,
      input.failureClass || null,
      serializeJson(input.metadata),
      input.startedAt || Date.now(),
      input.lastHeartbeatAt || null,
      input.completedAt || null
    );

    return stepId;
  }

  updateStep(stepId, patch = {}) {
    const statement = buildUpdateStatement('run_steps', 'id', stepId, {
      participant_id: patch.participantId,
      step_key: patch.stepKey,
      step_name: patch.stepName,
      status: patch.status,
      attempt_index: patch.attemptIndex,
      retry_safe: patch.retrySafe === undefined ? undefined : Number(Boolean(patch.retrySafe)),
      failure_class: patch.failureClass,
      metadata: patch.metadata === undefined ? undefined : serializeJson(patch.metadata),
      started_at: patch.startedAt,
      last_heartbeat_at: patch.lastHeartbeatAt,
      completed_at: patch.completedAt
    });

    if (!statement) {
      return 0;
    }

    return this.db.db.prepare(statement.sql).run(...statement.values).changes;
  }

  appendOutput(input) {
    const outputId = input.id || generateId('output');
    const payload = this.prepareOutput(input.content);
    const createdAt = input.createdAt || Date.now();
    const metadata = attachRedactionMetadata(sanitizeMetadata(input.metadata), payload.redaction);

    this.db.db.prepare(`
      INSERT INTO run_outputs (
        id, run_id, participant_id, output_kind, preview_text, full_text,
        compressed_blob, content_sha256, original_bytes, compressed_bytes,
        compression, storage_mode, is_truncated, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outputId,
      input.runId,
      input.participantId || null,
      input.outputKind,
      payload.previewText,
      payload.fullText,
      payload.compressedBlob,
      payload.contentSha256,
      payload.originalBytes,
      payload.compressedBytes,
      payload.compression,
      payload.storageMode,
      payload.isTruncated,
      serializeJson(metadata),
      createdAt
    );

    if (
      input.participantId &&
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata)
    ) {
      if (typeof this.db.addUsageRecordFromMetadata !== 'function') {
        console.warn('[RunLedgerService] Skipping usage persistence because db.addUsageRecordFromMetadata is unavailable');
      } else if (typeof this.db.getRunById !== 'function') {
        console.warn('[RunLedgerService] Persisting usage without root-session linkage because db.getRunById is unavailable');
      }

      const run = typeof this.db.getRunById === 'function'
        ? this.db.getRunById(input.runId)
        : null;
      const participant = this.db.db.prepare('SELECT adapter, participant_role FROM run_participants WHERE id = ?').get(input.participantId);
      if (typeof this.db.addUsageRecordFromMetadata === 'function') {
        this.db.addUsageRecordFromMetadata({
          terminalId: input.participantId,
          rootSessionId: run?.rootSessionId || null,
          runId: input.runId,
          taskId: run?.taskId || null,
          participantId: input.participantId,
          adapter: participant?.adapter || null,
          role: participant?.participant_role || null,
          metadata,
          createdAt
        });
      }
    }

    return outputId;
  }

  appendToolEvent(input) {
    const eventId = input.id || generateId('tool');
    const payload = this.prepareToolEventPayload(input.content);
    const metadata = attachRedactionMetadata(sanitizeMetadata(input.metadata), payload.redaction);

    this.db.db.prepare(`
      INSERT INTO run_tool_events (
        id, run_id, participant_id, step_id, tool_class, tool_name,
        idempotency, preview_text, full_text, compressed_blob,
        content_sha256, original_bytes, compressed_bytes, compression,
        storage_mode, is_truncated, status, started_at, completed_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.runId,
      input.participantId || null,
      input.stepId || null,
      input.toolClass,
      input.toolName,
      input.idempotency || 'unknown',
      payload.previewText,
      payload.fullText,
      payload.compressedBlob,
      payload.contentSha256,
      payload.originalBytes,
      payload.compressedBytes,
      payload.compression,
      payload.storageMode,
      payload.isTruncated,
      input.status || 'completed',
      input.startedAt || Date.now(),
      input.completedAt || null,
      serializeJson(metadata)
    );

    return eventId;
  }

  updateToolEvent(eventId, patch = {}) {
    const statement = buildUpdateStatement('run_tool_events', 'id', eventId, {
      participant_id: patch.participantId,
      step_id: patch.stepId,
      tool_class: patch.toolClass,
      tool_name: patch.toolName,
      idempotency: patch.idempotency,
      preview_text: patch.previewText,
      full_text: patch.fullText,
      compressed_blob: patch.compressedBlob,
      content_sha256: patch.contentSha256,
      original_bytes: patch.originalBytes,
      compressed_bytes: patch.compressedBytes,
      compression: patch.compression,
      storage_mode: patch.storageMode,
      is_truncated: patch.isTruncated,
      status: patch.status,
      started_at: patch.startedAt,
      completed_at: patch.completedAt,
      metadata: patch.metadata === undefined ? undefined : serializeJson(patch.metadata)
    });

    if (!statement) {
      return 0;
    }

    return this.db.db.prepare(statement.sql).run(...statement.values).changes;
  }

  findStaleRuns(options = {}) {
    const now = options.now || Date.now();
    const staleMs = Math.max(1, Number(options.staleMs || 15 * 60 * 1000));
    const limit = Math.max(1, Number(options.limit || 100));
    const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
      ? options.statuses
      : Array.from(ACTIVE_RUN_STATUSES);
    const cutoff = now - staleMs;

    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db.db.prepare(`
      SELECT *
      FROM runs
      WHERE status IN (${placeholders})
        AND completed_at IS NULL
        AND COALESCE(last_heartbeat_at, started_at) <= ?
      ORDER BY started_at ASC
      LIMIT ?
    `).all(...statuses, cutoff, limit);

    return rows.map((row) => {
      const mapped = this._mapRunRow(row);
      mapped.staleByMs = now - (mapped.lastHeartbeatAt || mapped.startedAt || now);
      return mapped;
    });
  }

  reconcileStaleRuns(options = {}) {
    const now = options.now || Date.now();
    const staleMs = Math.max(1, Number(options.staleMs || 15 * 60 * 1000));
    const limit = Math.max(1, Number(options.limit || 100));
    const candidates = this.findStaleRuns({
      now,
      staleMs,
      limit,
      statuses: options.statuses
    });

    const reconciledRuns = [];

    for (const run of candidates) {
      const detail = this.getRunDetail(run.id);
      if (!detail) {
        continue;
      }

      const activeParticipants = detail.participants.filter((participant) => ACTIVE_PARTICIPANT_STATUSES.has(participant.status));
      const activeSteps = detail.steps.filter((step) => ACTIVE_STEP_STATUSES.has(step.status));
      const activeToolEvents = detail.toolEvents.filter((event) => ACTIVE_TOOL_EVENT_STATUSES.has(event.status));
      const hasActiveJudge = activeParticipants.some((participant) => participant.participantRole === 'judge');
      const completedParticipants = detail.participants.filter((participant) => participant.status === 'completed');
      const hasCompletedOutputs = detail.outputs.some((output) => output.outputKind === 'participant_final' || output.outputKind === 'judge_final');
      const nextStatus = (completedParticipants.length > 0 || hasCompletedOutputs) ? 'partial' : 'abandoned';
      const reconciliationReason = hasActiveJudge ? 'stale_judge' : 'stale_run';
      const abandonedParticipantIds = [];

      for (const participant of activeParticipants) {
        abandonedParticipantIds.push(participant.id);
        this.updateParticipant(participant.id, {
          status: 'abandoned',
          currentStep: 'abandoned',
          failureClass: 'timeout',
          lastHeartbeatAt: now,
          endedAt: now,
          metadata: {
            ...(participant.metadata || {}),
            reconciliation: {
              reason: reconciliationReason,
              reconciledAt: now,
              staleMs
            }
          }
        });

        this.appendOutput({
          runId: detail.run.id,
          participantId: participant.id,
          outputKind: 'participant_error',
          content: `Marked abandoned during stale-run reconciliation (${reconciliationReason}).`,
          metadata: {
            failureClass: 'timeout',
            reconciliationReason,
            recoveredAt: now,
            staleMs
          },
          createdAt: now
        });
      }

      for (const step of activeSteps) {
        this.updateStep(step.id, {
          status: 'abandoned',
          failureClass: 'timeout',
          lastHeartbeatAt: now,
          completedAt: now,
          metadata: {
            ...(step.metadata || {}),
            reconciliation: {
              reason: reconciliationReason,
              reconciledAt: now,
              staleMs
            }
          }
        });
      }

      for (const event of activeToolEvents) {
        this.updateToolEvent(event.id, {
          status: 'abandoned',
          completedAt: now,
          metadata: {
            ...(event.metadata || {}),
            reconciliation: {
              reason: reconciliationReason,
              reconciledAt: now,
              staleMs
            }
          }
        });
      }

      const nextMetadata = {
        ...(detail.run.metadata || {}),
        reconciliation: {
          reason: reconciliationReason,
          reconciledAt: now,
          staleMs,
          abandonedParticipantIds,
          abandonedStepCount: activeSteps.length,
          abandonedToolEventCount: activeToolEvents.length
        }
      };

      this.updateRun(detail.run.id, {
        status: nextStatus,
        currentStep: nextStatus === 'partial' ? 'recovered-partial' : 'abandoned',
        activeParticipantCount: 0,
        failureClass: 'timeout',
        decisionSummary: detail.run.decisionSummary || (
          nextStatus === 'partial'
            ? 'Recovered stale run after heartbeat timeout. Inspect surviving participant outputs.'
            : 'Marked abandoned after heartbeat timeout with no completed participant outputs.'
        ),
        decisionSource: detail.run.decisionSource || (nextStatus === 'partial' ? 'recovery' : null),
        metadata: nextMetadata,
        lastHeartbeatAt: now,
        completedAt: now,
        durationMs: detail.run.startedAt ? now - detail.run.startedAt : detail.run.durationMs
      });

      reconciledRuns.push({
        runId: detail.run.id,
        previousStatus: detail.run.status,
        status: nextStatus,
        reason: reconciliationReason,
        staleByMs: now - (detail.run.lastHeartbeatAt || detail.run.startedAt || now),
        abandonedParticipantIds
      });
    }

    return {
      staleMs,
      reconciledCount: reconciledRuns.length,
      runs: reconciledRuns
    };
  }

  _buildRunListQuery(filters = {}, options = {}) {
    const clauses = [];
    const params = [];
    let joinClause = '';

    if (filters.adapter) {
      joinClause = ' INNER JOIN run_participants rp ON rp.run_id = r.id';
      clauses.push('rp.adapter = ?');
      params.push(filters.adapter);
    }

    if (filters.kind) {
      clauses.push('r.kind = ?');
      params.push(filters.kind);
    }

    if (filters.status) {
      clauses.push('r.status = ?');
      params.push(filters.status);
    }

    if (filters.from) {
      clauses.push('r.started_at >= ?');
      params.push(filters.from);
    }

    if (filters.to) {
      clauses.push('r.started_at <= ?');
      params.push(filters.to);
    }

    const baseSql = [
      options.countOnly ? 'SELECT COUNT(DISTINCT r.id) AS count FROM runs r' : 'SELECT DISTINCT r.* FROM runs r',
      joinClause,
      clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    ].filter(Boolean).join(' ');

    if (options.countOnly) {
      return { sql: baseSql, params };
    }

    return {
      sql: [baseSql, 'ORDER BY r.started_at DESC', 'LIMIT ?', 'OFFSET ?'].join(' '),
      params: [...params, filters.limit || 50, filters.offset || 0]
    };
  }

  countRuns(filters = {}) {
    const query = this._buildRunListQuery(filters, { countOnly: true });
    return this.db.db.prepare(query.sql).get(...query.params).count;
  }

  listRuns(filters = {}) {
    const query = this._buildRunListQuery(filters);
    return this.db.db.prepare(query.sql).all(...query.params).map((row) => this._mapRunRow(row));
  }

  getRunDetail(runId) {
    const run = this.db.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) {
      return null;
    }

    const participants = this.db.db.prepare(
      'SELECT * FROM run_participants WHERE run_id = ? ORDER BY participant_role, participant_name, attempt_index'
    ).all(runId).map((row) => this._mapParticipantRow(row));

    const steps = this.db.db.prepare(
      'SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at, id'
    ).all(runId).map((row) => this._mapStepRow(row));

    const outputs = this.db.db.prepare(
      'SELECT * FROM run_outputs WHERE run_id = ? ORDER BY created_at, id'
    ).all(runId).map((row) => this._mapOutputRow(row));

    const inputs = this.db.db.prepare(
      'SELECT * FROM run_inputs WHERE run_id = ? ORDER BY created_at, id'
    ).all(runId).map((row) => this._mapInputRow(row));

    const toolEvents = this.db.db.prepare(
      'SELECT * FROM run_tool_events WHERE run_id = ? ORDER BY started_at, id'
    ).all(runId).map((row) => this._mapToolEventRow(row));

    const discussionId = run.discussion_id || null;
    const discussion = discussionId && typeof this.db.getDiscussion === 'function'
      ? this.db.getDiscussion(discussionId)
      : null;
    const discussionMessages = discussionId && typeof this.db.getDiscussionMessages === 'function'
      ? this.db.getDiscussionMessages(discussionId)
      : [];
    const blockedStates = typeof this.db.listRunBlockedStates === 'function'
      ? this.db.listRunBlockedStates(runId)
      : [];
    const activeBlockedState = typeof this.db.getActiveBlockedState === 'function'
      ? this.db.getActiveBlockedState(runId)
      : null;
    const operatorActions = typeof this.db.listOperatorActions === 'function'
      ? this.db.listOperatorActions(runId)
      : [];

    return {
      run: this._mapRunRow(run),
      discussion,
      discussionMessages,
      participants,
      steps,
      inputs,
      outputs,
      toolEvents,
      blockedStates,
      activeBlockedState,
      isBlocked: Boolean(activeBlockedState),
      operatorActions
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
      metadata: parseJson(row.metadata),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      rootSessionId: row.root_session_id || null,
      taskId: row.task_id || null
    };
  }

  _mapParticipantRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      participantRole: row.participant_role,
      participantName: row.participant_name,
      adapter: row.adapter,
      agentProfile: row.agent_profile,
      status: row.status,
      attemptIndex: row.attempt_index,
      attemptKey: row.attempt_key,
      retryCount: row.retry_count,
      currentStep: row.current_step,
      failureClass: row.failure_class,
      isRequired: Boolean(row.is_required),
      metadata: parseJson(row.metadata),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      endedAt: row.ended_at
    };
  }

  _mapStepRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      participantId: row.participant_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status,
      attemptIndex: row.attempt_index,
      retrySafe: Boolean(row.retry_safe),
      failureClass: row.failure_class,
      metadata: parseJson(row.metadata),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      completedAt: row.completed_at
    };
  }

  _mapOutputRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      participantId: row.participant_id,
      outputKind: row.output_kind,
      previewText: row.preview_text,
      fullText: row.full_text,
      compressedBlob: encodeBlob(row.compressed_blob),
      contentSha256: row.content_sha256,
      originalBytes: row.original_bytes,
      compressedBytes: row.compressed_bytes,
      compression: row.compression,
      storageMode: row.storage_mode,
      isTruncated: Boolean(row.is_truncated),
      metadata: parseJson(row.metadata),
      createdAt: row.created_at
    };
  }

  _mapInputRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      participantId: row.participant_id,
      inputKind: row.input_kind,
      previewText: row.preview_text,
      fullText: row.full_text,
      compressedBlob: encodeBlob(row.compressed_blob),
      contentSha256: row.content_sha256,
      originalBytes: row.original_bytes,
      compressedBytes: row.compressed_bytes,
      compression: row.compression,
      storageMode: row.storage_mode,
      isTruncated: Boolean(row.is_truncated),
      metadata: parseJson(row.metadata),
      createdAt: row.created_at
    };
  }

  _mapToolEventRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      participantId: row.participant_id,
      stepId: row.step_id,
      toolClass: row.tool_class,
      toolName: row.tool_name,
      idempotency: row.idempotency,
      previewText: row.preview_text,
      fullText: row.full_text,
      compressedBlob: encodeBlob(row.compressed_blob),
      contentSha256: row.content_sha256,
      originalBytes: row.original_bytes,
      compressedBytes: row.compressed_bytes,
      compression: row.compression,
      storageMode: row.storage_mode,
      isTruncated: Boolean(row.is_truncated),
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      metadata: parseJson(row.metadata)
    };
  }

  appendOperatorAction(input) {
    return this.db.appendOperatorAction({
      actionId: input.actionId,
      runId: input.runId,
      terminalId: input.terminalId || null,
      actionKind: input.actionKind,
      payload: input.payload,
      createdAt: input.createdAt
    });
  }

  getOperatorAction(actionId) {
    return this.db.getOperatorAction(actionId);
  }

  listOperatorActions(runId, options = {}) {
    return this.db.listOperatorActions(runId, options);
  }

  getActiveBlockedState(runId) {
    return this.db.getActiveBlockedState(runId);
  }

  getRunBlockedState(id) {
    return this.db.getRunBlockedState(id);
  }

  listRunBlockedStates(runId, options = {}) {
    return this.db.listRunBlockedStates(runId, options);
  }

  appendRunBlockedState(input) {
    // Blocked state is a run-ledger overlay, not a runs.status value. Existing
    // statuses continue to describe execution lifecycle while this side channel
    // carries operator-facing blockage details.
    return this.db.appendRunBlockedState({
      id: input.id,
      runId: input.runId,
      blockedReason: input.blockedReason,
      blockingDetail: input.blockingDetail || null,
      metadata: input.metadata || {},
      createdAt: input.createdAt
    });
  }

  unblockRun(runId, input = {}) {
    return this.db.unblockRun(runId, {
      unblockedAt: input.unblockedAt,
      unblockReason: input.unblockReason || null
    });
  }
}

module.exports = {
  RunLedgerService,
  INPUT_POLICY,
  OUTPUT_POLICY,
  TOOL_EVENT_POLICY,
  normalizeString,
  buildHashPayload,
  computeMessageHash,
  preparePayload
};
