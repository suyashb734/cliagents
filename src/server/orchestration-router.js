/**
 * Orchestration Router - REST API endpoints for multi-agent orchestration
 *
 * Provides endpoints for:
 * - handoff: Synchronous task delegation
 * - assign: Asynchronous task delegation
 * - send_message: Inter-agent messaging
 * - Terminal management
 */

const express = require('express');
const crypto = require('crypto');
const { handoff } = require('../orchestration/handoff');
const { assign } = require('../orchestration/assign');
const { runConsensus } = require('../orchestration/consensus');
const { runDiscussion } = require('../orchestration/discussion-runner');
const { runPlanReview, runPrReview } = require('../orchestration/review-protocols');
const { RunLedgerService } = require('../orchestration/run-ledger');
const { buildRootSessionSnapshot, listRootSessionSummaries } = require('../orchestration/root-session-monitor');
const {
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  buildManagedRootExternalSessionRef
} = require('../orchestration/managed-root-launch');
const { sendMessage, broadcastMessage } = require('../orchestration/send-message');
const { getAgentProfiles, resolveProfile } = require('../services/agent-profiles');
const { createMemoryRouter } = require('../routes/memory');
const { isAdapterAuthenticated } = require('../utils/adapter-auth');

/**
 * Create the orchestration router
 * @param {Object} context - Shared context with sessionManager, db, inboxService
 * @returns {express.Router}
 */
function createOrchestrationRouter(context) {
  const router = express.Router();
  const { sessionManager, apiSessionManager, db, inboxService } = context;
  const sessionGraphWritesEnabled = process.env.SESSION_GRAPH_WRITES_ENABLED === '1';
  const sessionEventsEnabled = process.env.SESSION_EVENTS_ENABLED === '1';
  const runLedgerWritesEnabled = process.env.RUN_LEDGER_ENABLED === '1';
  const runLedgerReadsEnabled = process.env.RUN_LEDGER_READS_ENABLED === '1';
  const requireRootAttach = process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH === '1';
  const runLedger = runLedgerWritesEnabled || runLedgerReadsEnabled ? new RunLedgerService(db) : null;

  function parseQueryInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function parseQueryBoolean(value, fallback = false) {
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

  function readHeaderValue(req, name) {
    const value = req.headers?.[name.toLowerCase()];
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
  }

  function normalizeSessionMetadata(sessionMetadata) {
    if (!sessionMetadata || typeof sessionMetadata !== 'object' || Array.isArray(sessionMetadata)) {
      return {};
    }
    return { ...sessionMetadata };
  }

  function resolveRequestControlPlaneContext(req, provided = {}, options = {}) {
    const metadata = normalizeSessionMetadata(provided.sessionMetadata);
    const allowImplicitRootCreate = options.allowImplicitRootCreate !== false;
    const originClient = provided.originClient
      || readHeaderValue(req, 'x-cliagents-origin-client')
      || null;
    const clientName = metadata.clientName
      || readHeaderValue(req, 'x-cliagents-client-name')
      || originClient
      || null;
    const externalSessionRef = provided.externalSessionRef
      || readHeaderValue(req, 'x-cliagents-session-ref')
      || metadata.externalSessionRef
      || metadata.clientSessionRef
      || null;
    let rootSessionId = provided.rootSessionId
      || readHeaderValue(req, 'x-cliagents-root-session-id')
      || null;
    let parentSessionId = provided.parentSessionId
      || readHeaderValue(req, 'x-cliagents-parent-session-id')
      || null;
    const sessionKind = provided.sessionKind
      || readHeaderValue(req, 'x-cliagents-session-kind')
      || options.defaultSessionKind
      || null;

    if (clientName && !metadata.clientName) {
      metadata.clientName = clientName;
    }
    if (externalSessionRef) {
      if (!metadata.externalSessionRef) {
        metadata.externalSessionRef = externalSessionRef;
      }
      if (!metadata.clientSessionRef) {
        metadata.clientSessionRef = externalSessionRef;
      }
    }

    let attachedRoot = false;
    let reusedAttachedRoot = false;

    if (!rootSessionId && db?.addSessionEvent && externalSessionRef) {
      const existing = typeof db.findLatestRootSessionByClientRef === 'function'
        ? db.findLatestRootSessionByClientRef({ originClient, externalSessionRef, clientName })
        : null;

      if (existing?.root_session_id) {
        rootSessionId = existing.root_session_id;
        reusedAttachedRoot = true;
      } else if (allowImplicitRootCreate) {
        rootSessionId = crypto.randomBytes(16).toString('hex');
        attachedRoot = true;
        db.addSessionEvent({
          rootSessionId,
          sessionId: rootSessionId,
          parentSessionId: null,
          eventType: 'session_started',
          originClient: originClient || 'system',
          idempotencyKey: `${rootSessionId}:${rootSessionId}:session_started:http-attach`,
          payloadSummary: `HTTP root attach via ${originClient || clientName || 'system'}`,
          payloadJson: {
            attachMode: 'implicit-http-first-use',
            sessionKind: 'attach',
            externalSessionRef,
            clientName
          },
          metadata: Object.keys(metadata).length > 0 ? metadata : null
        });
      }
    }

    if (!parentSessionId && rootSessionId && options.defaultParentToRoot) {
      parentSessionId = rootSessionId;
    }

    return {
      rootSessionId,
      parentSessionId,
      sessionKind,
      originClient,
      externalSessionRef,
      lineageDepth: provided.lineageDepth,
      sessionMetadata: Object.keys(metadata).length > 0 ? metadata : null,
      clientName,
      attachedRoot,
      reusedAttachedRoot
    };
  }

  function buildRootAttachError(endpoint, resolvedControlPlane) {
    const attachMode = resolvedControlPlane?.sessionMetadata?.attachMode || null;
    const implicitFirstUse = attachMode === 'implicit-first-use';
    const message = implicitFirstUse
      ? `A stable cliagents root session must be attached before calling ${endpoint}. Implicit first-use root creation is disabled in strict mode. Serena project activation or creating .cliagents config does not attach a cliagents root session.`
      : `A cliagents root session is required before calling ${endpoint}.`;

    return {
      error: {
        code: 'root_session_required',
        message,
        endpoint,
        nextAction: 'call ensure_root_session or attach_root_session first, or provide a stable externalSessionRef/rootSessionId',
        details: {
          rootSessionId: resolvedControlPlane?.rootSessionId || null,
          externalSessionRef: resolvedControlPlane?.externalSessionRef || null,
          attachMode
        }
      }
    };
  }

  function requireAttachedRoot(res, endpoint, resolvedControlPlane) {
    if (!requireRootAttach) {
      return false;
    }
    const attachMode = resolvedControlPlane?.sessionMetadata?.attachMode || null;
    const implicitFirstUse = attachMode === 'implicit-first-use';
    if (resolvedControlPlane?.rootSessionId && !implicitFirstUse) {
      return false;
    }
    res.status(428).json(buildRootAttachError(endpoint, resolvedControlPlane));
    return true;
  }

  // Mount shared memory routes at /orchestration/memory
  const memoryRouter = createMemoryRouter();
  router.use('/memory', memoryRouter);

  /**
   * POST /orchestration/handoff
   * Synchronous task delegation - wait for worker to complete
   *
   * Supports two APIs:
   * - Legacy: { agentProfile: 'planner', message: '...' }
   * - New:    { role: 'plan', adapter: 'gemini-cli', message: '...' }
   */
  router.post('/handoff', async (req, res) => {
    try {
      const {
        // Legacy API
        agentProfile,
        // New role+adapter API
        role,
        adapter,
        systemPrompt,
        // Common parameters
        message,
        timeout,
        returnSummary,
        maxSummaryLength,
        taskId,
        includeSharedContext,
        workingDirectory
      } = req.body;

      // Require either agentProfile (legacy) or role (new)
      if (!agentProfile && !role) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'Either agentProfile or role is required', param: 'agentProfile|role' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      // Resolve the profile from role+adapter or legacy profile name
      let resolvedProfile = null;
      let profileIdentifier = agentProfile;

      if (role) {
        // New API: resolve role+adapter to a profile
        resolvedProfile = resolveProfile({ role, adapter, systemPrompt });
        if (!resolvedProfile) {
          return res.status(404).json({
            error: {
              code: 'profile_not_found',
              message: `Could not resolve role '${role}'${adapter ? ` with adapter '${adapter}'` : ''}`
            }
          });
        }
        // Use role as the identifier for logging/tracing
        // Use underscore instead of colon to pass validation (alphanumeric, dash, underscore only)
        profileIdentifier = adapter ? `${role}_${adapter}` : role;
      }

      const result = await handoff(profileIdentifier, message, {
        timeout,
        returnSummary,
        maxSummaryLength,
        taskId,
        includeSharedContext,
        workDir: workingDirectory,
        context: { sessionManager, db },
        // Pass resolved profile if we have one (for new API)
        resolvedProfile
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/handoff] Error:', error.message);

      if (error.message.includes('Unknown agent profile')) {
        return res.status(404).json({
          error: { code: 'profile_not_found', message: error.message }
        });
      }

      if (error.message.includes('timed out')) {
        return res.status(504).json({
          error: { code: 'timeout_error', message: error.message, traceId: error.traceId }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message, traceId: error.traceId }
      });
    }
  });

  /**
   * POST /orchestration/assign
   * Asynchronous task delegation - returns immediately
   */
  router.post('/assign', async (req, res) => {
    try {
      const { agentProfile, message, callbackTerminalId } = req.body;

      if (!agentProfile) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentProfile is required', param: 'agentProfile' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await assign(agentProfile, message, {
        callbackTerminalId,
        context: { sessionManager, db, inboxService }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/assign] Error:', error.message);

      if (error.message.includes('Unknown agent profile')) {
        return res.status(404).json({
          error: { code: 'profile_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message, traceId: error.traceId }
      });
    }
  });

  /**
   * POST /orchestration/send_message
   * Inter-agent messaging
   */
  router.post('/send_message', async (req, res) => {
    try {
      // Sender can be specified in header or body
      const senderId = req.headers['x-terminal-id'] || req.body.senderId;
      const { receiverId, message, priority } = req.body;

      if (!receiverId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'receiverId is required', param: 'receiverId' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await sendMessage(senderId, receiverId, message, {
        priority,
        context: { sessionManager, inboxService, db }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/send_message] Error:', error.message);

      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/broadcast
   * Send message to multiple terminals
   */
  router.post('/broadcast', async (req, res) => {
    try {
      const senderId = req.headers['x-terminal-id'] || req.body.senderId;
      const { receiverIds, message, priority } = req.body;

      if (!receiverIds || !Array.isArray(receiverIds) || receiverIds.length === 0) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'receiverIds array is required', param: 'receiverIds' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await broadcastMessage(senderId, receiverIds, message, {
        priority,
        context: { sessionManager, inboxService, db }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/broadcast] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/discussion
   * Multi-round discussion with persisted round prompts, outputs, and optional judge synthesis.
   */
  router.post('/discussion', async (req, res) => {
    try {
      const {
        message,
        context: discussionContext,
        participants,
        rounds,
        judge,
        timeout,
        workingDirectory,
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      } = req.body || {};

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'participants array is required', param: 'participants' }
        });
      }

      if (rounds !== undefined && (!Array.isArray(rounds) || rounds.length === 0)) {
        return res.status(400).json({
          error: { code: 'invalid_parameter', message: 'rounds must be a non-empty array when provided', param: 'rounds' }
        });
      }

      const resolvedControlPlane = resolveRequestControlPlaneContext(req, {
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      }, {
        defaultSessionKind: 'discussion'
      });

      if (requireAttachedRoot(res, '/orchestration/discussion', resolvedControlPlane)) {
        return;
      }

      const result = await runDiscussion(apiSessionManager || sessionManager, message, {
        context: discussionContext,
        participants,
        rounds,
        judge,
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: resolvedControlPlane.rootSessionId,
        parentSessionId: resolvedControlPlane.parentSessionId,
        originClient: resolvedControlPlane.originClient,
        externalSessionRef: resolvedControlPlane.externalSessionRef,
        sessionMetadata: resolvedControlPlane.sessionMetadata
      });

      res.json({
        ...result,
        rootSessionId: resolvedControlPlane.rootSessionId || result.rootSessionId || null,
        attachedRoot: resolvedControlPlane.attachedRoot === true,
        reusedAttachedRoot: resolvedControlPlane.reusedAttachedRoot === true
      });
    } catch (error) {
      console.error('[orchestration/discussion] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/consensus
   * Safer bounded multi-agent consensus using direct adapter sessions instead of tmux terminals.
   */
  router.post('/consensus', async (req, res) => {
    try {
      const {
        message,
        participants,
        judge,
        timeout,
        workingDirectory,
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'participants array is required', param: 'participants' }
        });
      }

      const resolvedControlPlane = resolveRequestControlPlaneContext(req, {
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      }, {
        defaultSessionKind: 'consensus'
      });

      if (requireAttachedRoot(res, '/orchestration/consensus', resolvedControlPlane)) {
        return;
      }

      const result = await runConsensus(apiSessionManager || sessionManager, message, {
        participants,
        judge,
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: resolvedControlPlane.rootSessionId,
        parentSessionId: resolvedControlPlane.parentSessionId,
        originClient: resolvedControlPlane.originClient,
        externalSessionRef: resolvedControlPlane.externalSessionRef,
        sessionMetadata: resolvedControlPlane.sessionMetadata
      });

      res.json({
        ...result,
        rootSessionId: resolvedControlPlane.rootSessionId || result.rootSessionId || null,
        attachedRoot: resolvedControlPlane.attachedRoot === true,
        reusedAttachedRoot: resolvedControlPlane.reusedAttachedRoot === true
      });
    } catch (error) {
      console.error('[orchestration/consensus] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/plan-review
   * Run multi-agent implementation plan review using direct adapter sessions.
   */
  router.post('/plan-review', async (req, res) => {
    try {
      const {
        timeout,
        workingDirectory,
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      } = req.body || {};

      const resolvedControlPlane = resolveRequestControlPlaneContext(req, {
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      }, {
        defaultSessionKind: 'review'
      });

      if (requireAttachedRoot(res, '/orchestration/plan-review', resolvedControlPlane)) {
        return;
      }

      const result = await runPlanReview(apiSessionManager || sessionManager, req.body, {
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: resolvedControlPlane.rootSessionId,
        parentSessionId: resolvedControlPlane.parentSessionId,
        originClient: resolvedControlPlane.originClient,
        externalSessionRef: resolvedControlPlane.externalSessionRef,
        sessionMetadata: resolvedControlPlane.sessionMetadata
      });

      res.json({
        ...result,
        rootSessionId: resolvedControlPlane.rootSessionId || result.rootSessionId || null,
        attachedRoot: resolvedControlPlane.attachedRoot === true,
        reusedAttachedRoot: resolvedControlPlane.reusedAttachedRoot === true
      });
    } catch (error) {
      if (error.message === 'plan is required') {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: error.message, param: 'plan' }
        });
      }

      console.error('[orchestration/plan-review] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/pr-review
   * Run multi-agent pull request review using direct adapter sessions.
   */
  router.post('/pr-review', async (req, res) => {
    try {
      const {
        timeout,
        workingDirectory,
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      } = req.body || {};

      const resolvedControlPlane = resolveRequestControlPlaneContext(req, {
        rootSessionId,
        parentSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata
      }, {
        defaultSessionKind: 'review'
      });

      if (requireAttachedRoot(res, '/orchestration/pr-review', resolvedControlPlane)) {
        return;
      }

      const result = await runPrReview(apiSessionManager || sessionManager, req.body, {
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: resolvedControlPlane.rootSessionId,
        parentSessionId: resolvedControlPlane.parentSessionId,
        originClient: resolvedControlPlane.originClient,
        externalSessionRef: resolvedControlPlane.externalSessionRef,
        sessionMetadata: resolvedControlPlane.sessionMetadata
      });

      res.json({
        ...result,
        rootSessionId: resolvedControlPlane.rootSessionId || result.rootSessionId || null,
        attachedRoot: resolvedControlPlane.attachedRoot === true,
        reusedAttachedRoot: resolvedControlPlane.reusedAttachedRoot === true
      });
    } catch (error) {
      if (error.message === 'summary or diff is required') {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: error.message, param: 'summary|diff' }
        });
      }

      console.error('[orchestration/pr-review] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/runs
   * List persisted orchestration runs.
   */
  router.get('/runs', (req, res) => {
    try {
      if (!runLedgerReadsEnabled || !runLedger) {
        return res.status(404).json({
          error: { code: 'feature_disabled', message: 'Run-ledger read APIs are disabled' }
        });
      }

      const limit = Math.min(parseQueryInteger(req.query.limit, 50), 200);
      const offset = parseQueryInteger(req.query.offset, 0);
      const filters = {
        kind: req.query.kind || null,
        status: req.query.status || null,
        adapter: req.query.adapter || null,
        from: req.query.from ? parseQueryInteger(req.query.from, null) : null,
        to: req.query.to ? parseQueryInteger(req.query.to, null) : null,
        limit,
        offset
      };

      const runs = runLedger.listRuns(filters);
      const total = runLedger.countRuns(filters);

      res.json({
        runs,
        pagination: {
          limit,
          offset,
          total,
          returned: runs.length,
          hasMore: offset + runs.length < total
        }
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/runs/:id
   * Get persisted orchestration run detail.
   */
  router.get('/runs/:id', (req, res) => {
    try {
      if (!runLedgerReadsEnabled || !runLedger) {
        return res.status(404).json({
          error: { code: 'feature_disabled', message: 'Run-ledger read APIs are disabled' }
        });
      }

      const detail = runLedger.getRunDetail(req.params.id);
      if (!detail) {
        return res.status(404).json({
          error: { code: 'run_not_found', message: 'Run ' + req.params.id + ' not found' }
        });
      }

      res.json(detail);
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/discussions/:id
   * Get persisted discussion metadata and ordered messages.
   */
  router.get('/discussions/:id', (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          error: { code: 'db_unavailable', message: 'Database not initialized' }
        });
      }

      const discussion = db.getDiscussion(req.params.id);
      if (!discussion) {
        return res.status(404).json({
          error: { code: 'discussion_not_found', message: `Discussion ${req.params.id} not found` }
        });
      }

      const messages = db.getDiscussionMessages(req.params.id);
      res.json({
        discussion,
        messages
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals
   * List all persistent terminals
   */
  router.get('/terminals', (req, res) => {
    try {
      const terminals = sessionManager.listTerminals();

      res.json({
        count: terminals.length,
        terminals: terminals.map(t => ({
          terminalId: t.terminalId,
          adapter: t.adapter,
          agentProfile: t.agentProfile,
          role: t.role,
          status: t.status,
          createdAt: t.createdAt,
          lastActive: t.lastActive
        }))
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals/:id
   * Get terminal info
   */
  router.get('/terminals/:id', (req, res) => {
    try {
      const terminal = sessionManager.getTerminal(req.params.id);

      if (!terminal) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: `Terminal ${req.params.id} not found` }
        });
      }

      res.json({
        ...terminal,
        attachCommand: sessionManager.getAttachCommand(req.params.id)
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals/:id/output
   * Get terminal output
   */
  router.get('/terminals/:id/output', (req, res) => {
    try {
      const lines = parseInt(req.query.lines) || 200;
      const output = sessionManager.getOutput(req.params.id, lines);

      res.json({
        terminalId: req.params.id,
        lines,
        output
      });

    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals/:id/messages
   * Get conversation history for a terminal
   */
  router.get('/terminals/:id/messages', (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          error: { code: 'db_unavailable', message: 'Database not initialized' }
        });
      }

      const terminalId = req.params.id;
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;
      const traceId = req.query.traceId || null;
      const role = req.query.role || null;

      // Verify terminal exists
      const terminal = sessionManager.getTerminal(terminalId);
      if (!terminal) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: `Terminal ${terminalId} not found` }
        });
      }

      const messages = db.getHistory(terminalId, { limit, offset, traceId, role });
      const totalCount = db.getMessageCount(terminalId);

      res.json({
        terminalId,
        messages,
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + messages.length < totalCount
        }
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/terminals/:id/input
   * Send input to terminal
   */
  router.post('/terminals/:id/input', async (req, res) => {
    try {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      await sessionManager.sendInput(req.params.id, message);

      res.json({
        success: true,
        terminalId: req.params.id,
        status: sessionManager.getStatus(req.params.id)
      });

    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/terminals/:id
   * Destroy terminal
   */
  router.delete('/terminals/:id', async (req, res) => {
    try {
      await sessionManager.destroyTerminal(req.params.id);

      res.json({
        success: true,
        message: `Terminal ${req.params.id} destroyed`
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/terminals
   * Create a new persistent terminal
   */
  router.post('/terminals', async (req, res) => {
    try {
      const {
        adapter,
        agentProfile,
        role,
        workDir,
        systemPrompt,
        model,
        allowedTools,
        rootSessionId,
        parentSessionId,
        sessionKind,
        originClient,
        externalSessionRef,
        lineageDepth,
        sessionMetadata,
        preferReuse,
        forceFreshSession
      } = req.body;

      if (adapter === 'claude-code' && role !== 'main' && sessionKind !== 'main') {
        return res.status(400).json({
          error: {
            code: 'invalid_adapter',
            message: 'claude-code is reserved for managed root launch. Use /orchestration/root-sessions/launch for interactive Claude roots.'
          }
        });
      }

      const terminal = await sessionManager.createTerminal({
        adapter,
        agentProfile,
        role,
        workDir,
        systemPrompt,
        model,
        allowedTools,
        rootSessionId,
        parentSessionId,
        sessionKind,
        originClient,
        externalSessionRef,
        lineageDepth,
        sessionMetadata,
        preferReuse,
        forceFreshSession
      });

      res.json(terminal);

    } catch (error) {
      console.error('[orchestration/terminals] Create error:', error.message);

      if (error.message.includes('Unknown adapter') || error.message.includes('Unsupported adapter')) {
        return res.status(400).json({
          error: { code: 'invalid_adapter', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/runs/reconcile
   * Reconcile stale runs into partial/abandoned terminal states.
   */
  router.post('/runs/reconcile', (req, res) => {
    try {
      if (!runLedgerWritesEnabled || !runLedger) {
        return res.status(404).json({
          error: { code: 'feature_disabled', message: 'Run-ledger write APIs are disabled' }
        });
      }

      const staleMs = Math.max(parseQueryInteger(req.body?.staleMs, 15 * 60 * 1000), 1);
      const limit = Math.min(parseQueryInteger(req.body?.limit, 100), 500);
      const result = runLedger.reconcileStaleRuns({ staleMs, limit });

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/terminals/prune-orphaned
   * Remove historical orphaned terminal rows older than a threshold.
   */
  router.post('/terminals/prune-orphaned', (req, res) => {
    try {
      if (!db?.pruneOrphanedTerminals) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'terminal pruning is not configured' }
        });
      }

      const olderThanHours = Math.max(parseQueryInteger(req.body?.olderThanHours, 24 * 7), 1);
      const limit = Math.min(parseQueryInteger(req.body?.limit, 500), 2000);
      const dryRun = Boolean(req.body?.dryRun);
      const adapter = req.body?.adapter ? String(req.body.adapter) : null;

      if (dryRun) {
        const terminals = db.listOrphanedTerminals({ olderThanHours, adapter, limit });
        return res.json({
          dryRun: true,
          olderThanHours,
          deletedCount: 0,
          candidateCount: terminals.length,
          terminals
        });
      }

      const result = db.pruneOrphanedTerminals({ olderThanHours, adapter, limit });
      res.json({
        dryRun: false,
        olderThanHours,
        candidateCount: result.terminals.length,
        deletedCount: result.deletedCount,
        terminals: result.terminals
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/profiles
   * List available agent profiles
   */
  router.get('/profiles', (req, res) => {
    try {
      const service = getAgentProfiles();
      const profiles = service.getAllProfiles();

      res.json({
        count: Object.keys(profiles).length,
        profiles
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/roles
   * List available roles (v3 config)
   */
  router.get('/roles', (req, res) => {
    try {
      const service = getAgentProfiles();
      const roles = service.listRoles();

      // Get role details
      const roleDetails = {};
      for (const name of roles) {
        const role = service.getRole(name);
        if (role) {
          roleDetails[name] = {
            description: role.description,
            defaultAdapter: role.defaultAdapter,
            timeout: role.timeout
          };
        }
      }

      res.json({
        count: roles.length,
        roles: roleDetails
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/adapters
   * List available adapters (v3 config)
   */
  router.get('/adapters', async (req, res) => {
    try {
      const service = getAgentProfiles();
      const configuredAdapters = service.listAdapters();
      const runtimeAdapters = typeof apiSessionManager?.getAdapterNames === 'function'
        ? apiSessionManager.getAdapterNames()
        : [];
      const adapters = Array.from(new Set([...configuredAdapters, ...runtimeAdapters])).sort();

      const adapterDetails = {};
      for (const name of adapters) {
        const configuredAdapter = service.getAdapter(name);
        const runtimeAdapter = typeof apiSessionManager?.getAdapter === 'function'
          ? apiSessionManager.getAdapter(name)
          : null;
        let available = null;

        if (runtimeAdapter?.isAvailable) {
          try {
            available = await runtimeAdapter.isAvailable();
          } catch {
            available = false;
          }
        }

        const auth = isAdapterAuthenticated(name);

        adapterDetails[name] = {
          description: configuredAdapter?.description || runtimeAdapter?.name || null,
          configured: Boolean(configuredAdapter),
          runtimeRegistered: Boolean(runtimeAdapter),
          available,
          authenticated: auth.authenticated,
          authenticationReason: auth.reason,
          configuredCapabilities: configuredAdapter?.capabilities || [],
          runtimeCapabilities: typeof runtimeAdapter?.getCapabilities === 'function'
            ? runtimeAdapter.getCapabilities()
            : null,
          runtimeContract: typeof runtimeAdapter?.getContract === 'function'
            ? runtimeAdapter.getContract()
            : null,
          defaultAllowedTools: configuredAdapter?.defaultAllowedTools || null
        };
      }

      res.json({
        count: adapters.length,
        adapters: adapterDetails
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/profiles/:name
   * Get a specific agent profile
   */
  router.get('/profiles/:name', (req, res) => {
    try {
      const profile = getAgentProfiles().getProfile(req.params.name);

      if (!profile) {
        return res.status(404).json({
          error: { code: 'profile_not_found', message: `Profile ${req.params.name} not found` }
        });
      }

      res.json({
        name: req.params.name,
        ...profile
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/inbox/:terminalId
   * Get inbox for a terminal
   */
  router.get('/inbox/:terminalId', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const messages = inboxService.getPendingMessages(req.params.terminalId, limit);
      const stats = inboxService.getStats(req.params.terminalId);

      res.json({
        terminalId: req.params.terminalId,
        stats,
        messages
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/stats
   * Get orchestration statistics
   */
  router.get('/stats', (req, res) => {
    try {
      const dbStats = db ? db.getStats() : null;
      const terminals = sessionManager.listTerminals();

      res.json({
        terminals: {
          total: terminals.length,
          byStatus: terminals.reduce((acc, t) => {
            acc[t.status] = (acc[t.status] || 0) + 1;
            return acc;
          }, {}),
          byAdapter: terminals.reduce((acc, t) => {
            acc[t.adapter] = (acc[t.adapter] || 0) + 1;
            return acc;
          }, {})
        },
        database: dbStats
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/session-events
   * Replay session control-plane events by root/session linkage.
   */
  router.get('/session-events', (req, res) => {
    try {
      if (!db?.listSessionEvents) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'session event storage is not configured' }
        });
      }

      const { rootSessionId, sessionId, runId, discussionId } = req.query;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const events = db.listSessionEvents({
        rootSessionId,
        sessionId,
        runId,
        discussionId,
        limit: Number.isFinite(limit) ? limit : 200
      });

      res.json({ events });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/root-sessions
   * List recent root sessions with summarized status.
   */
  router.get('/root-sessions', (req, res) => {
    try {
      if (!db?.listRootSessions) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'root session storage is not configured' }
        });
      }

      const limit = parseQueryInteger(req.query.limit, 20);
      const eventLimit = parseQueryInteger(req.query.eventLimit, 120);
      const terminalLimit = parseQueryInteger(req.query.terminalLimit, 50);
      const includeArchived = parseQueryBoolean(req.query.includeArchived, false);
      const archiveAfterMs = parseQueryInteger(req.query.archiveAfterMs, undefined);
      const scope = req.query.scope ? String(req.query.scope) : 'user';
      const result = listRootSessionSummaries({
        db,
        limit,
        eventLimit,
        terminalLimit,
        includeArchived,
        archiveAfterMs,
        scope
      });

      res.json({
        roots: result.roots,
        archivedCount: result.archivedCount,
        hiddenDetachedCount: result.hiddenDetachedCount,
        hiddenNonUserCount: result.hiddenNonUserCount,
        includeArchived,
        scope: result.scope
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/root-sessions/launch
   * Launch a managed interactive root terminal owned by the broker.
   */
  router.post('/root-sessions/launch', async (req, res) => {
    try {
      if (!sessionGraphWritesEnabled) {
        return res.status(503).json({
          error: { code: 'feature_disabled', message: 'Managed root launch requires SESSION_GRAPH_WRITES_ENABLED=1' }
        });
      }

      const adapter = normalizeManagedRootAdapter(req.body?.adapter || 'codex-cli');
      const workDir = req.body?.workDir || req.body?.workingDirectory || process.cwd();
      const originClient = inferManagedRootOriginClient(adapter);
      const externalSessionRef = buildManagedRootExternalSessionRef(originClient, req.body?.externalSessionRef || null);
      const sessionMetadata = normalizeSessionMetadata(req.body?.sessionMetadata);

      if (!sessionMetadata.clientName) {
        sessionMetadata.clientName = originClient;
      }
      if (!sessionMetadata.clientSessionRef) {
        sessionMetadata.clientSessionRef = externalSessionRef;
      }
      if (!sessionMetadata.externalSessionRef) {
        sessionMetadata.externalSessionRef = externalSessionRef;
      }
      if (!sessionMetadata.workspaceRoot) {
        sessionMetadata.workspaceRoot = workDir;
      }
      sessionMetadata.attachMode = 'managed-root-launch';
      sessionMetadata.rootIdentitySource = req.body?.externalSessionRef
        ? 'explicit-external-session-ref'
        : 'managed-launch-generated';
      sessionMetadata.launchSource = 'http-root-launch';
      sessionMetadata.managedLaunch = true;

      const terminal = await sessionManager.createTerminal({
        adapter,
        agentProfile: null,
        role: 'main',
        workDir,
        systemPrompt: req.body?.systemPrompt || null,
        model: req.body?.model || null,
        allowedTools: Array.isArray(req.body?.allowedTools) ? req.body.allowedTools : null,
        permissionMode: req.body?.permissionMode || 'default',
        rootSessionId: null,
        parentSessionId: null,
        sessionKind: 'main',
        originClient,
        externalSessionRef,
        lineageDepth: 0,
        sessionMetadata,
        preferReuse: false,
        forceFreshSession: true
      });

      res.json({
        ...terminal,
        attachCommand: sessionManager.getAttachCommand(terminal.terminalId),
        consoleUrl: '/console',
        managedRoot: true
      });
    } catch (error) {
      console.error('[orchestration/root-sessions/launch] Error:', error.message);
      if (error.message.includes('Unsupported managed root adapter') || error.message.includes('Unsupported adapter') || error.message.includes('Unknown adapter')) {
        return res.status(400).json({
          error: { code: 'invalid_adapter', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/root-sessions/:rootSessionId
   * Return a detailed snapshot of one root session graph.
   */
  router.get('/root-sessions/:rootSessionId', (req, res) => {
    try {
      if (!db?.listSessionEvents || !db?.listTerminals) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'root session monitoring is not configured' }
        });
      }

      const eventLimit = parseQueryInteger(req.query.eventLimit, 400);
      const terminalLimit = parseQueryInteger(req.query.terminalLimit, 200);
      const snapshot = buildRootSessionSnapshot({
        db,
        rootSessionId: req.params.rootSessionId,
        eventLimit,
        terminalLimit
      });

      if (!snapshot) {
        return res.status(404).json({
          error: { code: 'root_session_not_found', message: `Root session ${req.params.rootSessionId} not found` }
        });
      }

      res.json(snapshot);
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/root-sessions/attach
   * Explicitly attach or resume a logical root session for an external client.
   */
  router.post('/root-sessions/attach', (req, res) => {
    try {
      const resolved = resolveRequestControlPlaneContext(req, req.body || {}, {
        defaultSessionKind: 'attach',
        defaultParentToRoot: false,
        allowImplicitRootCreate: false
      });

      let createdRoot = false;
      if (!resolved.rootSessionId) {
        const rootSessionId = crypto.randomBytes(16).toString('hex');
        const sessionMetadata = normalizeSessionMetadata(resolved.sessionMetadata);
        sessionMetadata.attachMode = 'explicit-http-attach';
        if (resolved.externalSessionRef) {
          if (!sessionMetadata.externalSessionRef) {
            sessionMetadata.externalSessionRef = resolved.externalSessionRef;
          }
          if (!sessionMetadata.clientSessionRef) {
            sessionMetadata.clientSessionRef = resolved.externalSessionRef;
          }
        }
        if (resolved.clientName && !sessionMetadata.clientName) {
          sessionMetadata.clientName = resolved.clientName;
        }

        if (!db?.addSessionEvent) {
          return res.status(503).json({
            error: { code: 'unavailable', message: 'root session storage is not configured' }
          });
        }

        db.addSessionEvent({
          rootSessionId,
          sessionId: rootSessionId,
          parentSessionId: null,
          eventType: 'session_started',
          originClient: resolved.originClient || 'system',
          idempotencyKey: `${rootSessionId}:${rootSessionId}:session_started:http-explicit-attach`,
          payloadSummary: `HTTP root attach via ${resolved.originClient || resolved.clientName || 'system'}`,
          payloadJson: {
            attachMode: 'explicit-http-attach',
            sessionKind: 'attach',
            externalSessionRef: resolved.externalSessionRef || null,
            clientName: resolved.clientName || null
          },
          metadata: Object.keys(sessionMetadata).length > 0 ? sessionMetadata : null
        });

        resolved.rootSessionId = rootSessionId;
        resolved.sessionMetadata = Object.keys(sessionMetadata).length > 0 ? sessionMetadata : null;
        createdRoot = true;
      }

      res.json({
        rootSessionId: resolved.rootSessionId,
        originClient: resolved.originClient || null,
        externalSessionRef: resolved.externalSessionRef || null,
        clientName: resolved.clientName || null,
        attachedRoot: createdRoot || resolved.attachedRoot === true,
        reusedAttachedRoot: !createdRoot && resolved.reusedAttachedRoot === true,
        sessionMetadata: resolved.sessionMetadata
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================
  // Task Routing & Workflow Endpoints
  // ============================================

  // Lazy-load TaskRouter to avoid circular dependencies
  let taskRouter = null;
  const getTaskRouter = () => {
    if (!taskRouter) {
      const { TaskRouter } = require('../orchestration/task-router');
      taskRouter = new TaskRouter(sessionManager, { apiSessionManager });
    }
    return taskRouter;
  };

  /**
   * POST /orchestration/route
   * Intelligently route a task to the appropriate agent
   *
   * Supports two APIs:
   * - Legacy: { forceProfile: 'planner' }
   * - New:    { forceRole: 'plan', forceAdapter: 'gemini-cli' }
   */
  router.post('/route', async (req, res) => {
    try {
      const {
        message,
        // Legacy API
        forceProfile,
        forceType,
        // New role+adapter API
        forceRole,
        forceAdapter,
        model,
        systemPrompt,
        workingDirectory,
        rootSessionId,
        parentSessionId,
        sessionKind,
        originClient,
        externalSessionRef,
        lineageDepth,
        sessionMetadata,
        preferReuse,
        forceFreshSession
      } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required' }
        });
      }

      // Convert new API to legacy format for now
      // (The task router can be updated later to handle role+adapter natively)
      let effectiveProfile = forceProfile;
      if (forceRole && !forceProfile) {
        // Resolve role+adapter to a profile-like identifier
        effectiveProfile = forceAdapter ? `${forceRole}_${forceAdapter}` : forceRole;
      }

      const resolvedControlPlane = resolveRequestControlPlaneContext(req, {
        rootSessionId,
        parentSessionId,
        sessionKind,
        originClient,
        externalSessionRef,
        lineageDepth,
        sessionMetadata
      }, {
        defaultParentToRoot: true
      });

      if (requireAttachedRoot(res, '/orchestration/route', resolvedControlPlane)) {
        return;
      }

      const router = getTaskRouter();
      const result = await router.routeTask(message, {
        forceProfile: effectiveProfile,
        forceType,
        // Pass role+adapter for native handling if task router supports it
        forceRole,
        forceAdapter,
        model,
        systemPrompt,
        workDir: workingDirectory,
        rootSessionId: resolvedControlPlane.rootSessionId,
        parentSessionId: resolvedControlPlane.parentSessionId,
        sessionKind: resolvedControlPlane.sessionKind,
        originClient: resolvedControlPlane.originClient,
        externalSessionRef: resolvedControlPlane.externalSessionRef,
        lineageDepth: resolvedControlPlane.lineageDepth,
        sessionMetadata: resolvedControlPlane.sessionMetadata,
        preferReuse,
        forceFreshSession
      });

      res.json({
        ...result,
        rootSessionId: resolvedControlPlane.rootSessionId || null,
        parentSessionId: resolvedControlPlane.parentSessionId || null,
        attachedRoot: resolvedControlPlane.attachedRoot === true,
        reusedAttachedRoot: resolvedControlPlane.reusedAttachedRoot === true
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'routing_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/route/detect
   * Detect task type without executing
   */
  router.get('/route/detect', (req, res) => {
    try {
      const { message } = req.query;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message query param is required' }
        });
      }

      const router = getTaskRouter();
      const detection = router.detectTaskType(message);

      res.json(detection);

    } catch (error) {
      res.status(500).json({
        error: { code: 'detection_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/route/types
   * List available task types and their default profiles
   */
  router.get('/route/types', (req, res) => {
    try {
      const router = getTaskRouter();
      res.json(router.getTaskTypes());
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/workflows/:name
   * Execute a predefined workflow
   */
  router.post('/workflows/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const {
        message,
        model,
        modelsByAdapter,
        workingDirectory,
        rootSessionId,
        parentSessionId,
        sessionKind,
        originClient,
        externalSessionRef,
        lineageDepth,
        sessionMetadata,
        preferReuse,
        forceFreshSession
      } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required' }
        });
      }

      const resolvedControlPlane = resolveRequestControlPlaneContext(req, {
        rootSessionId,
        parentSessionId,
        sessionKind,
        originClient,
        externalSessionRef,
        lineageDepth,
        sessionMetadata
      }, {
        defaultParentToRoot: true,
        defaultSessionKind: 'workflow'
      });

      if (requireAttachedRoot(res, `/orchestration/workflows/${name}`, resolvedControlPlane)) {
        return;
      }

      const router = getTaskRouter();
      const result = await router.executeWorkflow(name, message, {
        model,
        modelsByAdapter,
        workDir: workingDirectory,
        rootSessionId: resolvedControlPlane.rootSessionId,
        parentSessionId: resolvedControlPlane.parentSessionId,
        sessionKind: resolvedControlPlane.sessionKind,
        originClient: resolvedControlPlane.originClient,
        externalSessionRef: resolvedControlPlane.externalSessionRef,
        lineageDepth: resolvedControlPlane.lineageDepth,
        sessionMetadata: resolvedControlPlane.sessionMetadata,
        preferReuse,
        forceFreshSession
      });

      res.json({
        ...result,
        rootSessionId: resolvedControlPlane.rootSessionId || null,
        parentSessionId: resolvedControlPlane.parentSessionId || null,
        attachedRoot: resolvedControlPlane.attachedRoot === true,
        reusedAttachedRoot: resolvedControlPlane.reusedAttachedRoot === true
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'workflow_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/workflows
   * List available workflows
   */
  router.get('/workflows', (req, res) => {
    try {
      const router = getTaskRouter();
      res.json(router.getWorkflows());
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/workflows/:id/status
   * Get workflow execution status
   */
  router.get('/workflows/:id/status', (req, res) => {
    try {
      const { id } = req.params;
      const router = getTaskRouter();
      const status = router.getWorkflowStatus(id);

      if (!status) {
        return res.status(404).json({
          error: { code: 'workflow_not_found', message: `Workflow ${id} not found` }
        });
      }

      res.json(status);

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================
  // Skills System Endpoints
  // ============================================

  // Lazy-load SkillsService to avoid startup overhead
  let skillsService = null;
  const getSkillsService = () => {
    if (!skillsService) {
      const { getSkillsService: getService } = require('../services/skills-service');
      skillsService = getService();
    }
    return skillsService;
  };

  /**
   * GET /orchestration/skills
   * List all available skills
   *
   * Query params:
   * - tag: Filter by tag
   * - adapter: Filter by compatible adapter
   */
  router.get('/skills', (req, res) => {
    try {
      const { tag, adapter } = req.query;
      const service = getSkillsService();
      const skills = service.listSkills({ tag, adapter });

      res.json({
        count: skills.length,
        skills
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/skills/tags
   * List all available skill tags
   */
  router.get('/skills/tags', (req, res) => {
    try {
      const service = getSkillsService();
      const tags = service.getAllTags();

      res.json({
        count: tags.length,
        tags
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/skills/:name
   * Get a specific skill by name
   */
  router.get('/skills/:name', (req, res) => {
    try {
      const service = getSkillsService();
      const skill = service.loadSkill(req.params.name);

      if (!skill) {
        return res.status(404).json({
          error: { code: 'skill_not_found', message: `Skill '${req.params.name}' not found` }
        });
      }

      res.json({
        name: skill.name,
        description: skill.description,
        adapters: skill.adapters,
        tags: skill.tags,
        source: skill.source,
        path: skill.path,
        content: skill.content
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/skills/invoke
   * Invoke a skill with optional context
   *
   * Body:
   * - skill: Skill name (required)
   * - message: Task context/description
   * - adapter: Current adapter (for validation)
   */
  router.post('/skills/invoke', async (req, res) => {
    try {
      const { skill, message, adapter } = req.body;

      if (!skill) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'skill is required', param: 'skill' }
        });
      }

      const service = getSkillsService();
      const result = await service.invokeSkill(skill, { message, adapter });

      if (!result.success) {
        return res.status(404).json({
          error: { code: 'skill_error', message: result.error }
        });
      }

      res.json(result);

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/skills/refresh
   * Clear skills cache and force re-discovery
   */
  router.post('/skills/refresh', (req, res) => {
    try {
      const service = getSkillsService();
      service.clearCache();

      // Immediately rescan
      const skills = service.listSkills();

      res.json({
        success: true,
        message: 'Skills cache refreshed',
        count: skills.length
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  return router;
}

module.exports = { createOrchestrationRouter };
