/**
 * Memory Routes - REST API endpoints for shared memory
 *
 * Provides endpoints for:
 * - Artifacts: Store and retrieve code/file artifacts
 * - Findings: Share insights and issues between agents
 * - Context: Store conversation summaries for handoff
 */

const express = require('express');
const { getDB } = require('../database/db');
const {
  peekMemoryMaintenanceService
} = require('../orchestration/memory-maintenance-service');
const { redactSecretsInText } = require('../security/secret-redaction');

const MEMORY_BUNDLE_SCOPE_TYPES = new Set(['run', 'root', 'task']);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const MEMORY_RECORD_TYPES = new Set([
  'project',
  'task',
  'task_assignment',
  'room',
  'room_participant',
  'room_turn',
  'room_message',
  'terminal',
  'session_event',
  'message',
  'root_io',
  'root_io_event',
  'run',
  'run_participant',
  'run_step',
  'run_input',
  'run_output',
  'run_tool_event',
  'usage',
  'usage_record',
  'discussion',
  'discussion_message',
  'artifact',
  'finding',
  'context',
  'memory_snapshot',
  'operator_action',
  'run_blocked_state'
]);

function parseBooleanQuery(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIntegerQuery(value, {
  fallback,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  param = 'value'
} = {}) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    const error = new Error(`${param} must be an integer >= ${min}`);
    error.code = 'invalid_request';
    error.param = param;
    throw error;
  }

  return Math.min(parsed, max);
}

function sendRouteError(res, status, code, message, param) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(param ? { param } : {})
    }
  });
}

function parseCsvQuery(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseCsvQuery(entry));
  }
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildMemoryReadModelOptions(query = {}) {
  return {
    projectId: query.project_id || query.projectId || undefined,
    workspaceRoot: query.workspace_root || query.workspaceRoot || undefined,
    taskId: query.task_id || query.taskId || undefined,
    rootSessionId: query.root_session_id || query.rootSessionId || undefined,
    runId: query.run_id || query.runId || undefined,
    roomId: query.room_id || query.roomId || undefined,
    terminalId: query.terminal_id || query.terminalId || undefined,
    taskAssignmentId: query.task_assignment_id || query.taskAssignmentId || undefined,
    participantId: query.participant_id || query.participantId || undefined,
    discussionId: query.discussion_id || query.discussionId || undefined,
    traceId: query.trace_id || query.traceId || undefined
  };
}

function normalizeReadModelError(error) {
  if (error?.code === 'memory_read_model_unavailable') {
    return {
      status: 503,
      code: error.code,
      message: error.message
    };
  }
  if (error?.code === 'invalid_request') {
    return {
      status: 400,
      code: error.code,
      message: error.message,
      param: error.param
    };
  }
  return null;
}

/**
 * Create the memory router
 * @returns {express.Router}
 */
function createMemoryRouter(options = {}) {
  const router = express.Router();
  const db = options.db || getDB();
  const getMaintenanceService = options.getMemoryMaintenanceService || peekMemoryMaintenanceService;

  // ============================================================
  // Memory Bundle Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/bundle/:scopeId
   * Get a consolidated memory bundle for a run, root, or task
   */
  router.get('/bundle/:scopeId', (req, res) => {
    try {
      const { scopeId } = req.params;
      const {
        scope_type = 'task',
        recent_runs_limit = 3,
        include_raw_pointers = 'true'
      } = req.query;

      if (!MEMORY_BUNDLE_SCOPE_TYPES.has(scope_type)) {
        return sendRouteError(
          res,
          400,
          'invalid_request',
          `scope_type must be one of ${Array.from(MEMORY_BUNDLE_SCOPE_TYPES).join(', ')}`,
          'scope_type'
        );
      }

      const bundle = db.getMemoryBundle(scopeId, scope_type, {
        recentRunsLimit: parseIntegerQuery(recent_runs_limit, {
          fallback: 3,
          min: 1,
          max: 10,
          param: 'recent_runs_limit'
        }),
        includeRawPointers: parseBooleanQuery(include_raw_pointers, true)
      });

      if (!bundle) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Memory bundle not found for ${scope_type} ${scopeId}` }
        });
      }

      res.json(bundle);
    } catch (error) {
      console.error('[memory/bundle] Get error:', error.message);
      if (error.code === 'invalid_request') {
        return sendRouteError(res, 400, error.code, error.message, error.param);
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Message History Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/messages
   * Get durable message history with pagination
   */
  router.get('/messages', (req, res) => {
    try {
      const {
        terminal_id,
        root_session_id,
        trace_id,
        after_id,
        limit = 100,
        role
      } = req.query;

      const selectors = [terminal_id, root_session_id, trace_id].filter(Boolean);
      if (selectors.length !== 1) {
        return sendRouteError(
          res,
          400,
          'invalid_request',
          'Exactly one of terminal_id, root_session_id, or trace_id is required'
        );
      }

      if (role && !MESSAGE_ROLES.has(role)) {
        return sendRouteError(
          res,
          400,
          'invalid_request',
          `role must be one of ${Array.from(MESSAGE_ROLES).join(', ')}`,
          'role'
        );
      }

      const requestedLimit = parseIntegerQuery(limit, {
        fallback: 100,
        min: 1,
        max: 500,
        param: 'limit'
      });
      const afterId = parseIntegerQuery(after_id, {
        fallback: undefined,
        min: 1,
        param: 'after_id'
      });

      const rows = db.queryMessages({
        terminalId: terminal_id,
        rootSessionId: root_session_id,
        traceId: trace_id,
        afterId,
        limit: requestedLimit + 1,
        role
      });
      const hasMore = rows.length > requestedLimit;
      const messages = rows.slice(0, requestedLimit).map((row) => {
        const metadata = row.metadata || {};
        const redaction = redactSecretsInText(row.content);
        return {
          id: row.id,
          terminalId: row.terminal_id,
          traceId: row.trace_id,
          rootSessionId: row.root_session_id || null,
          role: row.role,
          content: redaction.content,
          metadata: redaction.redacted
            ? {
              ...metadata,
              security: {
                ...(metadata.security || {}),
                redactedSecretLikeContent: true,
                redactionReasonCodes: redaction.reasons
              }
            }
            : metadata,
          createdAt: row.created_at
        };
      });
      const totalCount = db.countMessages({
        terminalId: terminal_id,
        rootSessionId: root_session_id,
        traceId: trace_id,
        role
      });
      const remainingCount = db.countMessages({
        terminalId: terminal_id,
        rootSessionId: root_session_id,
        traceId: trace_id,
        afterId,
        role
      });

      res.json({
        messages,
        pagination: {
          total: totalCount,
          remaining: remainingCount,
          returned: messages.length,
          limit: requestedLimit,
          afterId,
          hasMore,
          nextAfterId: hasMore ? messages[messages.length - 1]?.id || null : null
        }
      });
    } catch (error) {
      console.error('[memory/messages] Get error:', error.message);
      if (error.code === 'invalid_request') {
        return sendRouteError(res, 400, error.code, error.message, error.param);
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Snapshot Maintenance Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/snapshots/repair
   * Run a manual memory repair sweep
   */
  router.post('/snapshots/repair', async (req, res) => {
    try {
      const service = getMaintenanceService();
      if (!service) {
        return sendRouteError(
          res,
          503,
          'service_unavailable',
          'memory maintenance service is not initialized'
        );
      }
      const result = await service.runOnce();
      res.json(result);
    } catch (error) {
      console.error('[memory/snapshots/repair] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Artifact Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/artifacts
   * Store an artifact
   */
  router.post('/artifacts', (req, res) => {
    try {
      const { taskId, key, content, type, agentId, metadata } = req.body;

      if (!taskId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'taskId is required', param: 'taskId' }
        });
      }

      if (!key) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'key is required', param: 'key' }
        });
      }

      if (!content) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'content is required', param: 'content' }
        });
      }

      const id = db.storeArtifact(taskId, key, content, { type, agentId, metadata });

      res.json({ id, taskId, key });
    } catch (error) {
      console.error('[memory/artifacts] Store error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/artifacts/:taskId
   * Get all artifacts for a task
   */
  router.get('/artifacts/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const { type } = req.query;

      const artifacts = db.getArtifacts(taskId, { type });

      res.json({ artifacts });
    } catch (error) {
      console.error('[memory/artifacts] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/artifacts/:taskId/:key
   * Get a specific artifact
   */
  router.get('/artifacts/:taskId/:key', (req, res) => {
    try {
      const { taskId, key } = req.params;

      const artifact = db.getArtifact(taskId, key);

      if (!artifact) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Artifact not found: ${key}` }
        });
      }

      res.json({ artifact });
    } catch (error) {
      console.error('[memory/artifacts] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/memory/artifacts/:taskId/:key
   * Delete a specific artifact
   */
  router.delete('/artifacts/:taskId/:key', (req, res) => {
    try {
      const { taskId, key } = req.params;

      const deleted = db.deleteArtifact(taskId, key);

      if (!deleted) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Artifact not found: ${key}` }
        });
      }

      res.json({ success: true, taskId, key });
    } catch (error) {
      console.error('[memory/artifacts] Delete error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Finding Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/findings
   * Store a finding
   */
  router.post('/findings', (req, res) => {
    try {
      const { taskId, agentId, content, type, severity, agentProfile, metadata } = req.body;

      if (!taskId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'taskId is required', param: 'taskId' }
        });
      }

      if (!agentId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentId is required', param: 'agentId' }
        });
      }

      if (!content) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'content is required', param: 'content' }
        });
      }

      const id = db.storeFinding(taskId, agentId, content, { type, severity, agentProfile, metadata });

      res.json({ id, taskId });
    } catch (error) {
      console.error('[memory/findings] Store error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/findings/:taskId
   * Get all findings for a task
   */
  router.get('/findings/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const { type, severity } = req.query;

      const findings = db.getFindings(taskId, { type, severity });

      res.json({ findings });
    } catch (error) {
      console.error('[memory/findings] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/findings/by-id/:id
   * Get a specific finding by ID
   */
  router.get('/findings/by-id/:id', (req, res) => {
    try {
      const { id } = req.params;

      const finding = db.getFinding(id);

      if (!finding) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Finding not found: ${id}` }
        });
      }

      res.json({ finding });
    } catch (error) {
      console.error('[memory/findings] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/memory/findings/:id
   * Delete a specific finding
   */
  router.delete('/findings/:id', (req, res) => {
    try {
      const { id } = req.params;

      const deleted = db.deleteFinding(id);

      if (!deleted) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Finding not found: ${id}` }
        });
      }

      res.json({ success: true, id });
    } catch (error) {
      console.error('[memory/findings] Delete error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Context Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/context
   * Store context
   */
  router.post('/context', (req, res) => {
    try {
      const { taskId, agentId, summary, keyDecisions, pendingItems } = req.body;

      if (!taskId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'taskId is required', param: 'taskId' }
        });
      }

      if (!agentId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentId is required', param: 'agentId' }
        });
      }

      if (!summary) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'summary is required', param: 'summary' }
        });
      }

      const id = db.storeContext(taskId, agentId, { summary, keyDecisions, pendingItems });

      res.json({ id, taskId });
    } catch (error) {
      console.error('[memory/context] Store error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/context/:taskId
   * Get all context for a task
   */
  router.get('/context/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;

      const context = db.getContext(taskId);

      res.json({ context });
    } catch (error) {
      console.error('[memory/context] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Task-level Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/tasks/:taskId
   * Get complete shared memory for a task
   */
  router.get('/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;

      const taskMemory = db.getTaskMemory(taskId);

      res.json(taskMemory);
    } catch (error) {
      console.error('[memory/tasks] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/memory/tasks/:taskId
   * Clear all memory for a task
   */
  router.delete('/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;

      const deleted = db.clearTaskMemory(taskId);

      res.json({ success: true, taskId, deleted });
    } catch (error) {
      console.error('[memory/tasks] Delete error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Maintenance Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/stats
   * Get memory statistics
   */
  router.get('/stats', (req, res) => {
    try {
      const stats = db.getMemoryStats();
      res.json(stats);
    } catch (error) {
      console.error('[memory/stats] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/memory/cleanup
   * Clean up old entries
   */
  router.post('/cleanup', (req, res) => {
    try {
      const { olderThanHours = 24 } = req.body;
      const olderThanSeconds = olderThanHours * 3600;

      const deleted = db.cleanupMemory(olderThanSeconds);

      res.json({ success: true, deleted });
    } catch (error) {
      console.error('[memory/cleanup] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Memory Read Model Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/query
   * Query the canonical memory read model with source provenance.
   */
  router.get('/query', (req, res) => {
    try {
      if (typeof db.queryMemoryRecords !== 'function') {
        return sendRouteError(res, 503, 'service_unavailable', 'memory read model is not configured');
      }

      const requestedLimit = parseIntegerQuery(req.query.limit, {
        fallback: 100,
        min: 1,
        max: 500,
        param: 'limit'
      });
      const types = parseCsvQuery(req.query.types).map((type) => type.toLowerCase());
      const invalidType = types.find((type) => !MEMORY_RECORD_TYPES.has(type));
      if (invalidType) {
        return sendRouteError(
          res,
          400,
          'invalid_request',
          `types must contain only supported memory record types: ${Array.from(MEMORY_RECORD_TYPES).join(', ')}`,
          'types'
        );
      }

      const since = parseIntegerQuery(req.query.since, {
        fallback: undefined,
        min: 0,
        param: 'since'
      });
      const until = parseIntegerQuery(req.query.until, {
        fallback: undefined,
        min: 0,
        param: 'until'
      });
      const filters = {
        ...buildMemoryReadModelOptions(req.query),
        types,
        q: req.query.q || undefined,
        since,
        until,
        limit: requestedLimit + 1
      };

      const rows = db.queryMemoryRecords(filters);
      const hasMore = rows.length > requestedLimit;
      const records = rows.slice(0, requestedLimit).map((record) => ({
        ...record,
        record: typeof db.getMemoryRecordSource === 'function'
          ? db.getMemoryRecordSource(record.sourceTable, record.sourceId)
          : null
      }));

      res.json({
        records,
        pagination: {
          returned: records.length,
          limit: requestedLimit,
          hasMore
        },
        filters: {
          projectId: filters.projectId || null,
          workspaceRoot: filters.workspaceRoot || null,
          taskId: filters.taskId || null,
          rootSessionId: filters.rootSessionId || null,
          runId: filters.runId || null,
          roomId: filters.roomId || null,
          terminalId: filters.terminalId || null,
          taskAssignmentId: filters.taskAssignmentId || null,
          participantId: filters.participantId || null,
          discussionId: filters.discussionId || null,
          traceId: filters.traceId || null,
          types,
          q: filters.q || null,
          since: since ?? null,
          until: until ?? null
        }
      });
    } catch (error) {
      console.error('[memory/query] Error:', error.message);
      const routeError = normalizeReadModelError(error);
      if (routeError) {
        return sendRouteError(res, routeError.status, routeError.code, routeError.message, routeError.param);
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/edges
   * Query lineage edges from the canonical memory read model.
   */
  router.get('/edges', (req, res) => {
    try {
      if (typeof db.queryMemoryEdges !== 'function') {
        return sendRouteError(res, 503, 'service_unavailable', 'memory read model is not configured');
      }

      const requestedLimit = parseIntegerQuery(req.query.limit, {
        fallback: 100,
        min: 1,
        max: 500,
        param: 'limit'
      });
      const since = parseIntegerQuery(req.query.since, {
        fallback: undefined,
        min: 0,
        param: 'since'
      });
      const until = parseIntegerQuery(req.query.until, {
        fallback: undefined,
        min: 0,
        param: 'until'
      });
      const filters = {
        ...buildMemoryReadModelOptions(req.query),
        edgeTypes: parseCsvQuery(req.query.edge_types || req.query.edgeTypes || req.query.types),
        sourceTable: req.query.source_table || req.query.sourceTable || undefined,
        sourceId: req.query.source_id || req.query.sourceId || undefined,
        targetScopeType: req.query.target_scope_type || req.query.targetScopeType || undefined,
        targetId: req.query.target_id || req.query.targetId || undefined,
        since,
        until,
        limit: requestedLimit + 1
      };

      const rows = db.queryMemoryEdges(filters);
      const hasMore = rows.length > requestedLimit;
      const edges = rows.slice(0, requestedLimit);

      res.json({
        edges,
        pagination: {
          returned: edges.length,
          limit: requestedLimit,
          hasMore
        },
        filters: {
          projectId: filters.projectId || null,
          workspaceRoot: filters.workspaceRoot || null,
          taskId: filters.taskId || null,
          rootSessionId: filters.rootSessionId || null,
          runId: filters.runId || null,
          roomId: filters.roomId || null,
          terminalId: filters.terminalId || null,
          taskAssignmentId: filters.taskAssignmentId || null,
          participantId: filters.participantId || null,
          discussionId: filters.discussionId || null,
          traceId: filters.traceId || null,
          edgeTypes: filters.edgeTypes,
          sourceTable: filters.sourceTable || null,
          sourceId: filters.sourceId || null,
          targetScopeType: filters.targetScopeType || null,
          targetId: filters.targetId || null,
          since: since ?? null,
          until: until ?? null
        }
      });
    } catch (error) {
      console.error('[memory/edges] Error:', error.message);
      const routeError = normalizeReadModelError(error);
      if (routeError) {
        return sendRouteError(res, routeError.status, routeError.code, routeError.message, routeError.param);
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/insights
   * Return aggregate task/project/root memory and usage diagnostics.
   */
  router.get('/insights', (req, res) => {
    try {
      if (typeof db.queryMemoryRecords !== 'function') {
        return sendRouteError(res, 503, 'service_unavailable', 'memory read model is not configured');
      }

      const requestedLimit = parseIntegerQuery(req.query.limit, {
        fallback: 20,
        min: 1,
        max: 100,
        param: 'limit'
      });
      const filters = buildMemoryReadModelOptions(req.query);
      const records = db.queryMemoryRecords({
        ...filters,
        limit: 500
      });
      const statusCounts = {};
      const latestActivity = records[0] || null;
      for (const record of records) {
        if (record.recordType !== 'task_assignment' && record.recordType !== 'run') {
          continue;
        }
        const source = typeof db.getMemoryRecordSource === 'function'
          ? db.getMemoryRecordSource(record.sourceTable, record.sourceId)
          : null;
        const status = String(source?.status || 'unknown').trim().toLowerCase() || 'unknown';
        const key = `${record.recordType}_${status}`;
        statusCounts[key] = (statusCounts[key] || 0) + 1;
      }

      const usageOptions = {
        taskId: filters.taskId,
        rootSessionId: filters.rootSessionId,
        runId: filters.runId,
        terminalId: filters.terminalId,
        taskAssignmentId: filters.taskAssignmentId,
        participantId: filters.participantId
      };
      const tokenTotals = typeof db.summarizeUsage === 'function'
        ? db.summarizeUsage(usageOptions)
        : {
          recordCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          durationMs: 0
        };

      const adapterUsage = typeof db.listUsageBreakdown === 'function'
        ? db.listUsageBreakdown({ ...usageOptions, groupBy: 'adapter', limit: requestedLimit })
        : [];
      const modelUsage = typeof db.listUsageBreakdown === 'function'
        ? db.listUsageBreakdown({ ...usageOptions, groupBy: 'model', limit: requestedLimit })
        : [];
      const usageAttribution = typeof db.summarizeUsageAttribution === 'function'
        ? db.summarizeUsageAttribution(usageOptions)
        : null;

      const findings = filters.taskId && typeof db.getFindings === 'function'
        ? db.getFindings(filters.taskId).slice(0, requestedLimit)
        : records
          .filter((record) => record.recordType === 'finding')
          .slice(0, requestedLimit)
          .map((record) => (typeof db.getMemoryRecordSource === 'function'
            ? db.getMemoryRecordSource(record.sourceTable, record.sourceId)
            : record));
      const severityRank = new Map([
        ['critical', 0],
        ['high', 1],
        ['medium', 2],
        ['low', 3],
        ['info', 4]
      ]);
      const topFindings = findings
        .sort((left, right) => {
          const leftRank = severityRank.get(String(left.severity || '').toLowerCase()) ?? 99;
          const rightRank = severityRank.get(String(right.severity || '').toLowerCase()) ?? 99;
          return leftRank - rightRank || (right.created_at || right.createdAt || 0) - (left.created_at || left.createdAt || 0);
        })
        .slice(0, requestedLimit);

      const contexts = filters.taskId && typeof db.getContext === 'function'
        ? db.getContext(filters.taskId)
        : records
          .filter((record) => record.recordType === 'context')
          .slice(0, requestedLimit)
          .map((record) => (typeof db.getMemoryRecordSource === 'function'
            ? db.getMemoryRecordSource(record.sourceTable, record.sourceId)
            : record));
      const pendingItems = [];
      for (const context of contexts) {
        const items = Array.isArray(context.pendingItems)
          ? context.pendingItems
          : (Array.isArray(context.pending_items) ? context.pending_items : []);
        pendingItems.push(...items);
        if (pendingItems.length >= requestedLimit) {
          break;
        }
      }

      res.json({
        statusCounts,
        latestActivity,
        adapterUsage,
        modelUsage,
        tokenTotals,
        usageAttribution,
        topFindings,
        pendingItems: pendingItems.slice(0, requestedLimit),
        missingLinkDiagnostics: typeof db.getMemoryLinkageDiagnostics === 'function'
          ? db.getMemoryLinkageDiagnostics({ sampleLimit: Math.min(requestedLimit, 25) })
          : null,
        generatedAt: Date.now()
      });
    } catch (error) {
      console.error('[memory/insights] Error:', error.message);
      const routeError = normalizeReadModelError(error);
      if (routeError) {
        return sendRouteError(res, routeError.status, routeError.code, routeError.message, routeError.param);
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  return router;
}

module.exports = { createMemoryRouter };
