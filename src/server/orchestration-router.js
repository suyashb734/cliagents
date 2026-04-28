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
const { getProviderSessionRegistry } = require('../orchestration/provider-session-registry');
const { RoomService } = require('../orchestration/room-service');
const {
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  buildManagedRootExternalSessionRef,
  composeManagedRootSystemPrompt
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
  const { sessionManager, apiSessionManager, db, inboxService, adapterAuthInspector } = context;
  const sessionGraphWritesEnabled = process.env.SESSION_GRAPH_WRITES_ENABLED === '1';
  const sessionEventsEnabled = process.env.SESSION_EVENTS_ENABLED === '1';
  const runLedgerWritesEnabled = process.env.RUN_LEDGER_ENABLED === '1';
  const runLedgerReadsEnabled = process.env.RUN_LEDGER_READS_ENABLED === '1';
  const requireRootAttach = process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH === '1';
  const runLedger = runLedgerWritesEnabled || runLedgerReadsEnabled ? new RunLedgerService(db) : null;
  const providerSessionRegistry = getProviderSessionRegistry();
  const roomService = db
    ? new RoomService({
        db,
        sessionManager: apiSessionManager || sessionManager,
        runLedger,
        sessionEventsEnabled,
        ...(typeof context.roomDiscussionRunner === 'function'
          ? { runDiscussion: context.roomDiscussionRunner }
          : {})
      })
    : null;

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

  function parseSessionMetadataValue(value) {
    if (!value) {
      return null;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return null;
    }
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function parseUsageBreakdownList(value) {
    if (!value) {
      return [];
    }
    const allowed = new Set(['adapter', 'provider', 'model', 'sourceConfidence']);
    return String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry === 'source_confidence' ? 'sourceConfidence' : entry))
      .filter((entry) => allowed.has(entry));
  }

  function buildUsageResponse(scopeKey, scopeValue, options = {}) {
    if (!db?.summarizeUsage || !db?.listUsageBreakdown) {
      throw new Error('usage observability is not configured');
    }

    const filters = { [scopeKey]: scopeValue };
    const summary = db.summarizeUsage(filters);
    const breakdowns = {};
    for (const breakdown of options.breakdowns || []) {
      breakdowns[breakdown] = db.listUsageBreakdown({
        ...filters,
        groupBy: breakdown,
        limit: options.breakdownLimit || 20
      });
    }

    return {
      scope: scopeKey,
      summary,
      breakdowns
    };
  }

  function mapChildTerminalSummary(terminalRow, liveTerminal = null) {
    const metadata = liveTerminal?.sessionMetadata
      || parseSessionMetadataValue(terminalRow?.session_metadata || terminalRow?.sessionMetadata)
      || {};
    const providerThreadRef = liveTerminal?.providerThreadRef
      || terminalRow?.provider_thread_ref
      || terminalRow?.providerThreadRef
      || null;

    return {
      terminalId: terminalRow?.terminal_id || terminalRow?.terminalId || null,
      parentSessionId: terminalRow?.parent_session_id || terminalRow?.parentSessionId || null,
      sessionKind: liveTerminal?.sessionKind || terminalRow?.session_kind || terminalRow?.sessionKind || null,
      sessionLabel: metadata.sessionLabel || liveTerminal?.sessionLabel || null,
      adapter: liveTerminal?.adapter || terminalRow?.adapter || null,
      role: liveTerminal?.role || terminalRow?.role || null,
      agentProfile: terminalRow?.agent_profile || terminalRow?.agentProfile || null,
      status: liveTerminal?.taskState || liveTerminal?.status || terminalRow?.status || null,
      lastActive: liveTerminal?.lastActive || terminalRow?.last_active || terminalRow?.lastActive || null,
      providerThreadRefPresent: Boolean(providerThreadRef)
    };
  }

  function isRootTerminalRecord(terminalRow, rootSessionId) {
    const terminalId = terminalRow?.terminal_id || terminalRow?.terminalId || null;
    const parentSessionId = terminalRow?.parent_session_id || terminalRow?.parentSessionId || null;
    const sessionKind = String(terminalRow?.session_kind || terminalRow?.sessionKind || '').trim().toLowerCase();
    return terminalId === rootSessionId || (!parentSessionId && sessionKind === 'main');
  }

  function getLiveTerminal(terminalId) {
    if (!terminalId || typeof sessionManager?.getTerminal !== 'function') {
      return null;
    }
    return sessionManager.getTerminal(terminalId);
  }

  function getLiveOutput(terminalId, options = {}) {
    if (!terminalId || typeof sessionManager?.getOutput !== 'function') {
      return '';
    }
    return sessionManager.getOutput(terminalId, options);
  }

  const ATTACHED_ROOT_BROKER_CHILD_SESSION_KINDS = new Set([
    'worker',
    'handoff',
    'discussion',
    'consensus',
    'review',
    'subagent'
  ]);

  function getRootSessionSnapshot(rootSessionId, options = {}) {
    if (!rootSessionId || !db?.listSessionEvents || !db?.listTerminals) {
      return null;
    }

    return buildRootSessionSnapshot({
      db,
      rootSessionId,
      eventLimit: options.eventLimit ?? 400,
      terminalLimit: options.terminalLimit ?? 200,
      liveTerminalResolver: getLiveTerminal,
      liveOutputResolver: getLiveOutput
    });
  }

  function resolveTerminalRootAccess(terminalId) {
    if (!terminalId) {
      return null;
    }

    const liveTerminal = getLiveTerminal(terminalId);
    const terminalRow = liveTerminal || (typeof db?.getTerminal === 'function' ? db.getTerminal(terminalId) : null);
    if (!terminalRow) {
      return null;
    }

    const rootSessionId = liveTerminal?.rootSessionId
      || terminalRow?.root_session_id
      || terminalRow?.rootSessionId
      || null;

    if (!rootSessionId) {
      return null;
    }

    return getRootSessionSnapshot(rootSessionId, {
      eventLimit: 120,
      terminalLimit: 200
    });
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

  const ALLOWED_LAUNCH_ENVIRONMENT_KEYS = new Set([
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'COLORTERM',
    'COLUMNS',
    'LINES',
    'LC_TERMINAL',
    'LC_TERMINAL_VERSION',
    'VTE_VERSION',
    'KITTY_WINDOW_ID',
    'KITTY_PUBLIC_KEY',
    'KITTY_INSTALLATION_DIR',
    'WT_SESSION',
    'WT_PROFILE_ID',
    'TERMUX_VERSION'
  ]);

  function normalizeLaunchEnvironment(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return null;
    }
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
      if (!ALLOWED_LAUNCH_ENVIRONMENT_KEYS.has(key)) {
        continue;
      }
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      normalized[key] = trimmed;
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  function resolveRequestControlPlaneContext(req, provided = {}, options = {}) {
    const metadata = normalizeSessionMetadata(provided.sessionMetadata);
    const allowImplicitRootCreate = options.allowImplicitRootCreate === true;
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
    const requestedBindingMetadata = Boolean(
      metadata.clientName
      || metadata.clientSessionRef
      || metadata.externalSessionRef
      || metadata.attachMode
      || metadata.rootIdentitySource
      || metadata.mcpSessionScope
      || metadata.workspaceRoot
    );
    const requestedBinding = Boolean(
      provided.rootSessionId
      || provided.parentSessionId
      || readHeaderValue(req, 'x-cliagents-root-session-id')
      || readHeaderValue(req, 'x-cliagents-parent-session-id')
      || originClient
      || externalSessionRef
      || requestedBindingMetadata
    );

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
    let conflictingRootSessionId = null;

    if (db?.addSessionEvent && externalSessionRef) {
      const existing = typeof db.findLatestRootSessionByClientRef === 'function'
        ? db.findLatestRootSessionByClientRef({ originClient, externalSessionRef, clientName })
        : null;

      if (existing?.root_session_id) {
        if (rootSessionId && existing.root_session_id !== rootSessionId) {
          conflictingRootSessionId = existing.root_session_id;
        } else if (!rootSessionId) {
          rootSessionId = existing.root_session_id;
          reusedAttachedRoot = true;
        }
      } else if (!rootSessionId && allowImplicitRootCreate) {
        rootSessionId = crypto.randomBytes(16).toString('hex');
        attachedRoot = true;
        ensureRootSessionStarted({
          rootSessionId,
          originClient: originClient || 'system',
          payloadSummary: `HTTP root attach via ${originClient || clientName || 'system'}`,
          externalSessionRef,
          clientName,
          sessionMetadata: Object.keys(metadata).length > 0 ? metadata : null,
          attachMode: 'implicit-http-first-use',
          model: metadata.model || null
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
      requestedBinding,
      attachedRoot,
      reusedAttachedRoot,
      conflictingRootSessionId
    };
  }

  function buildRootBindingConflictError(endpoint, resolvedControlPlane) {
    return {
      error: {
        code: 'root_session_binding_conflict',
        message: `The provided rootSessionId does not match the root already bound to this externalSessionRef for ${endpoint}.`,
        endpoint,
        nextAction: 'reset the stale MCP root binding or reattach the correct root session before delegating again',
        details: {
          rootSessionId: resolvedControlPlane?.rootSessionId || null,
          externalSessionRef: resolvedControlPlane?.externalSessionRef || null,
          conflictingRootSessionId: resolvedControlPlane?.conflictingRootSessionId || null
        }
      }
    };
  }

  function requireConsistentRootBinding(res, endpoint, resolvedControlPlane) {
    if (!resolvedControlPlane?.conflictingRootSessionId) {
      return false;
    }
    res.status(409).json(buildRootBindingConflictError(endpoint, resolvedControlPlane));
    return true;
  }

  function buildRootAttachError(endpoint, resolvedControlPlane) {
    const attachMode = resolvedControlPlane?.sessionMetadata?.attachMode || null;
    const implicitFirstUse = String(attachMode || '').trim().toLowerCase().startsWith('implicit');
    const message = implicitFirstUse
      ? `A stable cliagents root session must be attached before calling ${endpoint}. Implicit first-use root creation is disabled for this endpoint. Serena project activation or creating .cliagents config does not attach a cliagents root session.`
      : `A cliagents root session is required before calling ${endpoint}.`;

    return {
      error: {
        code: 'root_session_required',
        message,
        endpoint,
        nextAction: 'call ensure_root_session or attach_root_session first, or provide an already-attached rootSessionId',
        details: {
          rootSessionId: resolvedControlPlane?.rootSessionId || null,
          externalSessionRef: resolvedControlPlane?.externalSessionRef || null,
          attachMode
        }
      }
    };
  }

  function requireAttachedRoot(res, endpoint, resolvedControlPlane) {
    const attachMode = resolvedControlPlane?.sessionMetadata?.attachMode || null;
    const implicitFirstUse = String(attachMode || '').trim().toLowerCase().startsWith('implicit');
    if (resolvedControlPlane?.rootSessionId && !implicitFirstUse) {
      return false;
    }
    if (!resolvedControlPlane?.rootSessionId && resolvedControlPlane?.requestedBinding) {
      res.status(428).json(buildRootAttachError(endpoint, resolvedControlPlane));
      return true;
    }
    if (!requireRootAttach) {
      return false;
    }
    res.status(428).json(buildRootAttachError(endpoint, resolvedControlPlane));
    return true;
  }

  function projectExecutionControlPlane(resolvedControlPlane) {
    if (!resolvedControlPlane?.rootSessionId) {
      return {
        rootSessionId: null,
        parentSessionId: null,
        sessionKind: null,
        originClient: null,
        externalSessionRef: null,
        lineageDepth: null,
        sessionMetadata: null
      };
    }

    return {
      rootSessionId: resolvedControlPlane.rootSessionId,
      parentSessionId: resolvedControlPlane.parentSessionId || null,
      sessionKind: resolvedControlPlane.sessionKind || null,
      originClient: resolvedControlPlane.originClient || null,
      externalSessionRef: resolvedControlPlane.externalSessionRef || null,
      lineageDepth: resolvedControlPlane.lineageDepth ?? null,
      sessionMetadata: resolvedControlPlane.sessionMetadata || null
    };
  }

  function ensureLogicalRootTerminalRecord({
    rootSessionId,
    originClient,
    externalSessionRef,
    sessionMetadata,
    model = null,
    providerThreadRef = null,
    workDir = null
  }) {
    if (!db?.registerTerminal || !db?.updateTerminalBinding || !db?.getTerminal || !rootSessionId) {
      return;
    }

    const normalizedMetadata = normalizeSessionMetadata(sessionMetadata);
    const adapterSeed = normalizedMetadata.adapter
      || normalizedMetadata.clientName
      || originClient
      || 'codex-cli';
    let adapter = 'codex-cli';
    try {
      adapter = normalizeManagedRootAdapter(adapterSeed);
    } catch {
      adapter = 'codex-cli';
    }
    const resolvedWorkDir = workDir || normalizedMetadata.workspaceRoot || null;
    const binding = {
      adapter,
      role: 'main',
      workDir: resolvedWorkDir,
      rootSessionId,
      parentSessionId: null,
      sessionKind: 'attach',
      originClient: originClient || 'mcp',
      externalSessionRef: externalSessionRef || null,
      lineageDepth: 0,
      sessionMetadata: normalizedMetadata,
      harnessSessionId: rootSessionId,
      providerThreadRef,
      captureMode: 'raw-tty',
      model: model || normalizedMetadata.model || null,
      status: 'idle'
    };
    const existing = db.getTerminal(rootSessionId);

    if (existing) {
      db.updateTerminalBinding(rootSessionId, binding);
      return;
    }

    db.registerTerminal(
      rootSessionId,
      `attached-${rootSessionId.slice(0, 12)}`,
      'root',
      adapter,
      null,
      'main',
      resolvedWorkDir,
      null,
      binding
    );
  }

  function ensureRootSessionStarted({
    rootSessionId,
    originClient,
    externalSessionRef,
    clientName,
    sessionMetadata,
    attachMode,
    payloadSummary,
    model = null,
    providerThreadRef = null,
    workDir = null
  }) {
    if (!db?.addSessionEvent || !rootSessionId) {
      return;
    }

    ensureLogicalRootTerminalRecord({
      rootSessionId,
      originClient,
      externalSessionRef,
      sessionMetadata,
      model,
      providerThreadRef,
      workDir
    });

    db.addSessionEvent({
      rootSessionId,
      sessionId: rootSessionId,
      parentSessionId: null,
      eventType: 'session_started',
      originClient: originClient || 'system',
      idempotencyKey: `${rootSessionId}:${rootSessionId}:session_started:${attachMode || 'explicit'}`,
      payloadSummary: payloadSummary || `Root session started via ${attachMode || 'explicit'}`,
      payloadJson: {
        attachMode: attachMode || 'explicit',
        sessionKind: 'attach',
        externalSessionRef: externalSessionRef || null,
        clientName: clientName || null,
        model: model || null
      },
      metadata: sessionMetadata && Object.keys(sessionMetadata).length > 0 ? sessionMetadata : null
    });
  }

  function buildRoomPayload(roomId) {
    const snapshot = roomService?.getRoom(roomId);
    if (!snapshot) {
      return null;
    }

    return {
      room: snapshot.room,
      participants: snapshot.participants,
      latestTurn: snapshot.latestTurn
    };
  }

  function extractRequestId(req, body = {}) {
    return readHeaderValue(req, 'idempotency-key')
      || readHeaderValue(req, 'x-idempotency-key')
      || body.requestId
      || body.idempotencyKey
      || null;
  }

  // Mount shared memory routes at /orchestration/memory
  const memoryRouter = createMemoryRouter({ db });
  router.use('/memory', memoryRouter);

  /**
   * GET /orchestration/provider-sessions
   * Discover provider-local sessions that the broker can import or exact-resume.
   */
  router.get('/provider-sessions', (req, res) => {
    try {
      const adapter = req.query.adapter ? String(req.query.adapter) : 'codex-cli';
      const limit = parseQueryInteger(req.query.limit, 20);
      const includeArchived = parseQueryBoolean(req.query.includeArchived, false);
      const result = providerSessionRegistry.listSessions({
        adapter,
        limit,
        includeArchived
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/provider-sessions/import
   * Import a provider-local session as an attached, read-only root.
   */
  router.post('/provider-sessions/import', (req, res) => {
    try {
      if (!db?.addSessionEvent || !db?.registerTerminal || !db?.updateTerminalBinding) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'root session storage is not configured' }
        });
      }

      const adapter = normalizeManagedRootAdapter(req.body?.adapter || 'codex-cli');
      const providerSessionId = String(req.body?.providerSessionId || '').trim();
      if (!providerSessionId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'providerSessionId is required', param: 'providerSessionId' }
        });
      }

      const descriptor = providerSessionRegistry.getSession({ adapter, providerSessionId });
      if (!descriptor) {
        const supportInfo = providerSessionRegistry.listSessions({ adapter, limit: 1 });
        return res.status(supportInfo.supported ? 404 : 400).json({
          error: {
            code: supportInfo.supported ? 'provider_session_not_found' : 'not_supported',
            message: supportInfo.supported
              ? `No ${adapter} provider session found for ${providerSessionId}`
              : `Provider-session discovery is not supported for ${adapter}`
          }
        });
      }

      const existingRootTerminal = typeof db.findRootTerminalByProviderThreadRef === 'function'
        ? db.findRootTerminalByProviderThreadRef(adapter, providerSessionId)
        : null;
      const rootSessionId = req.body?.rootSessionId
        || existingRootTerminal?.root_session_id
        || crypto.randomBytes(16).toString('hex');
      const originClient = inferManagedRootOriginClient(adapter);
      const externalSessionRef = req.body?.externalSessionRef
        || existingRootTerminal?.external_session_ref
        || `provider-import:${adapter}:${providerSessionId}`;
      const sessionMetadata = normalizeSessionMetadata(req.body?.sessionMetadata);
      sessionMetadata.attachMode = 'provider-session-import';
      sessionMetadata.adapter = adapter;
      sessionMetadata.importedProviderSession = true;
      sessionMetadata.importedProviderSessionId = providerSessionId;
      sessionMetadata.importedProviderSessionTitle = descriptor.title || null;
      sessionMetadata.providerResumeCapability = descriptor.resumeCapability || 'exact';
      if (descriptor.cwd && !sessionMetadata.workspaceRoot) {
        sessionMetadata.workspaceRoot = descriptor.cwd;
      }
      if (descriptor.model && !sessionMetadata.model) {
        sessionMetadata.model = descriptor.model;
      }
      if (!sessionMetadata.externalSessionRef) {
        sessionMetadata.externalSessionRef = externalSessionRef;
      }
      if (!sessionMetadata.clientSessionRef) {
        sessionMetadata.clientSessionRef = externalSessionRef;
      }

      ensureRootSessionStarted({
        rootSessionId,
        originClient,
        externalSessionRef,
        clientName: originClient,
        sessionMetadata,
        attachMode: 'provider-session-import',
        payloadSummary: `Imported ${adapter} provider session ${descriptor.title || providerSessionId}`,
        model: descriptor.model || null,
        providerThreadRef: providerSessionId,
        workDir: descriptor.cwd || null
      });

      res.json({
        importedRoot: true,
        reusedImportedRoot: Boolean(existingRootTerminal),
        rootSessionId,
        adapter,
        providerSessionId,
        externalSessionRef,
        descriptor
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

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
        context: { sessionManager, apiSessionManager, db },
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

      if (requireConsistentRootBinding(res, '/orchestration/discussion', resolvedControlPlane)) {
        return;
      }
      if (requireAttachedRoot(res, '/orchestration/discussion', resolvedControlPlane)) {
        return;
      }
      const executionControlPlane = projectExecutionControlPlane(resolvedControlPlane);

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
        rootSessionId: executionControlPlane.rootSessionId,
        parentSessionId: executionControlPlane.parentSessionId,
        originClient: executionControlPlane.originClient,
        externalSessionRef: executionControlPlane.externalSessionRef,
        sessionMetadata: executionControlPlane.sessionMetadata
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

      if (requireConsistentRootBinding(res, '/orchestration/consensus', resolvedControlPlane)) {
        return;
      }
      if (requireAttachedRoot(res, '/orchestration/consensus', resolvedControlPlane)) {
        return;
      }
      const executionControlPlane = projectExecutionControlPlane(resolvedControlPlane);

      const result = await runConsensus(apiSessionManager || sessionManager, message, {
        participants,
        judge,
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: executionControlPlane.rootSessionId,
        parentSessionId: executionControlPlane.parentSessionId,
        originClient: executionControlPlane.originClient,
        externalSessionRef: executionControlPlane.externalSessionRef,
        sessionMetadata: executionControlPlane.sessionMetadata
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

      if (requireConsistentRootBinding(res, '/orchestration/plan-review', resolvedControlPlane)) {
        return;
      }
      if (requireAttachedRoot(res, '/orchestration/plan-review', resolvedControlPlane)) {
        return;
      }
      const executionControlPlane = projectExecutionControlPlane(resolvedControlPlane);

      const result = await runPlanReview(apiSessionManager || sessionManager, req.body, {
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: executionControlPlane.rootSessionId,
        parentSessionId: executionControlPlane.parentSessionId,
        originClient: executionControlPlane.originClient,
        externalSessionRef: executionControlPlane.externalSessionRef,
        sessionMetadata: executionControlPlane.sessionMetadata
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

      if (requireConsistentRootBinding(res, '/orchestration/pr-review', resolvedControlPlane)) {
        return;
      }
      if (requireAttachedRoot(res, '/orchestration/pr-review', resolvedControlPlane)) {
        return;
      }
      const executionControlPlane = projectExecutionControlPlane(resolvedControlPlane);

      const result = await runPrReview(apiSessionManager || sessionManager, req.body, {
        timeout,
        workDir: workingDirectory,
        runLedger: runLedgerWritesEnabled ? runLedger : null,
        db,
        sessionEventsEnabled: sessionGraphWritesEnabled && sessionEventsEnabled,
        rootSessionId: executionControlPlane.rootSessionId,
        parentSessionId: executionControlPlane.parentSessionId,
        originClient: executionControlPlane.originClient,
        externalSessionRef: executionControlPlane.externalSessionRef,
        sessionMetadata: executionControlPlane.sessionMetadata
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
   * GET /orchestration/rooms
   * List persisted rooms for operator discovery.
   */
  router.get('/rooms', (req, res) => {
    try {
      if (!roomService) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'room persistence is not configured' }
        });
      }

      const limit = parseQueryInteger(req.query.limit, 20);
      const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
      res.json({
        rooms: roomService.listRooms({
          limit,
          status
        })
      });
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/rooms
   * Create a persistent multi-agent room backed by direct-session participants.
   */
  router.post('/rooms', (req, res) => {
    try {
      if (!db || !roomService) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'room persistence is not configured' }
        });
      }

      const participants = Array.isArray(req.body?.participants) ? req.body.participants : [];
      if (participants.length === 0) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'participants array is required', param: 'participants' }
        });
      }

      const normalizedParticipants = participants.map((participant, index) => {
        const adapter = normalizeManagedRootAdapter(participant?.adapter || 'codex-cli');
        return {
          adapter,
          displayName: participant?.displayName || participant?.name || `${adapter}-${index + 1}`,
          model: participant?.model || null,
          systemPrompt: participant?.systemPrompt || null,
          workDir: participant?.workDir || req.body?.workDir || null,
          providerSessionId: participant?.providerSessionId || null,
          importedFromProviderSessionId: participant?.importedFromProviderSessionId || participant?.providerSessionId || null,
          metadata: participant?.metadata || {}
        };
      });

      const rootSessionId = req.body?.rootSessionId || crypto.randomBytes(16).toString('hex');
      const title = String(req.body?.title || req.body?.name || '').trim() || null;
      const originClient = String(req.body?.originClient || 'mcp').trim() || 'mcp';
      const externalSessionRef = String(req.body?.externalSessionRef || `room:${rootSessionId}`).trim();
      const sessionMetadata = normalizeSessionMetadata(req.body?.sessionMetadata);
      sessionMetadata.attachMode = 'room-root';
      sessionMetadata.room = true;
      sessionMetadata.roomTitle = title || null;
      if (req.body?.workDir && !sessionMetadata.workspaceRoot) {
        sessionMetadata.workspaceRoot = req.body.workDir;
      }

      ensureRootSessionStarted({
        rootSessionId,
        originClient,
        externalSessionRef,
        clientName: originClient,
        sessionMetadata,
        attachMode: 'room-root',
        payloadSummary: `Room ${title || rootSessionId} created`,
        workDir: req.body?.workDir || null
      });

      ensureLogicalRootTerminalRecord({
        rootSessionId,
        originClient,
        externalSessionRef,
        sessionMetadata,
        workDir: req.body?.workDir || null
      });

      const existingRoom = roomService.getRoomByRootSessionId(rootSessionId);
      if (existingRoom) {
        return res.status(409).json({
          error: {
            code: 'room_exists',
            message: `Room already exists for root session ${rootSessionId}`,
            roomId: existingRoom.room.id,
            rootSessionId
          }
        });
      }

      const created = roomService.createRoom({
        roomId: req.body?.roomId || null,
        rootSessionId,
        title,
        participants: normalizedParticipants,
        workDir: req.body?.workDir || null,
        metadata: req.body?.metadata || {}
      });

      res.json(created);
    } catch (error) {
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: rooms\.(id|root_session_id)/.test(String(error?.message || ''))) {
        const existingRoom = typeof roomService?.getRoomByRootSessionId === 'function'
          ? roomService.getRoomByRootSessionId(req.body?.rootSessionId || null)
          : null;
        return res.status(409).json({
          error: {
            code: 'room_exists',
            message: existingRoom
              ? `Room already exists for root session ${existingRoom.room.rootSessionId}`
              : 'Room already exists',
            roomId: existingRoom?.room?.id || null,
            rootSessionId: existingRoom?.room?.rootSessionId || req.body?.rootSessionId || null
          }
        });
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/rooms/:roomId
   * Get room metadata and participant state.
   */
  router.get('/rooms/:roomId', (req, res) => {
    try {
      if (!roomService) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'room persistence is not configured' }
        });
      }

      const payload = buildRoomPayload(req.params.roomId);
      if (!payload) {
        return res.status(404).json({
          error: { code: 'room_not_found', message: `Room ${req.params.roomId} not found` }
        });
      }

      res.json(payload);
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/rooms/:roomId/messages
   * Get durable room transcript messages.
   */
  router.get('/rooms/:roomId/messages', (req, res) => {
    try {
      if (!roomService) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'room persistence is not configured' }
        });
      }

      const afterId = parseQueryInteger(req.query.after_id, undefined);
      const limit = parseQueryInteger(req.query.limit, 100);
      const artifactMode = req.query.artifact_mode ? String(req.query.artifact_mode).trim().toLowerCase() : 'exclude';
      const payload = roomService.getRoomMessages(req.params.roomId, {
        afterId,
        limit,
        artifactMode
      });
      if (!payload) {
        return res.status(404).json({
          error: { code: 'room_not_found', message: `Room ${req.params.roomId} not found` }
        });
      }

      res.json(payload);
    } catch (error) {
      if (error.code === 'invalid_request') {
        return res.status(400).json({
          error: { code: error.code, message: error.message, param: error.param || null }
        });
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/rooms/:roomId/messages
   * Send one room turn to all active participants or an explicit mentions subset.
   */
  router.post('/rooms/:roomId/messages', async (req, res) => {
    try {
      if (!roomService) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'room persistence is not configured' }
        });
      }
      if (!req.body?.content) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'content is required', param: 'content' }
        });
      }

      const result = await roomService.sendRoomMessage(req.params.roomId, {
        content: req.body.content,
        mentions: Array.isArray(req.body.mentions) ? req.body.mentions : [],
        initiatorRole: req.body.initiatorRole || 'user',
        initiatorName: req.body.initiatorName || null,
        requestId: extractRequestId(req, req.body),
        metadata: req.body.metadata || {}
      });

      res.json(result);
    } catch (error) {
      if (error.code === 'not_found') {
        return res.status(404).json({
          error: { code: 'room_not_found', message: error.message }
        });
      }
      if (error.code === 'room_busy') {
        return res.status(409).json({
          error: { code: 'room_busy', message: error.message, roomId: error.roomId || req.params.roomId, turnId: error.turnId || null }
        });
      }
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/rooms/:roomId/discuss
   * Run a bounded multi-agent discussion over room participants.
   */
  router.post('/rooms/:roomId/discuss', async (req, res) => {
    try {
      if (!roomService) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'room persistence is not configured' }
        });
      }
      if (!req.body?.message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await roomService.discussRoom(req.params.roomId, {
        message: req.body.message,
        participantIds: Array.isArray(req.body.participantIds) ? req.body.participantIds : (Array.isArray(req.body.mentions) ? req.body.mentions : []),
        initiatorRole: req.body.initiatorRole || 'user',
        initiatorName: req.body.initiatorName || null,
        requestId: extractRequestId(req, req.body),
        rounds: Array.isArray(req.body.rounds) ? req.body.rounds : undefined,
        judge: req.body.judge === undefined ? null : req.body.judge,
        timeout: req.body.timeout || null,
        workDir: req.body.workDir || null,
        writebackMode: req.body.writebackMode || null,
        metadata: req.body.metadata || {}
      });

      res.json(result);
    } catch (error) {
      if (error.code === 'not_found') {
        return res.status(404).json({
          error: { code: 'room_not_found', message: error.message }
        });
      }
      if (error.code === 'room_busy') {
        return res.status(409).json({
          error: { code: 'room_busy', message: error.message, roomId: error.roomId || req.params.roomId, turnId: error.turnId || null }
        });
      }
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
          taskState: t.taskState || t.status,
          processState: t.processState || null,
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
      const lines = parseQueryInteger(req.query.lines, 200);
      const mode = String(req.query.mode || 'history').trim().toLowerCase() === 'visible'
        ? 'visible'
        : 'history';
      const format = String(req.query.format || 'plain').trim().toLowerCase() === 'ansi'
        ? 'ansi'
        : 'plain';
      const output = sessionManager.getOutput(req.params.id, {
        lines,
        mode,
        format
      });

      res.json({
        terminalId: req.params.id,
        lines,
        mode,
        format,
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
   * GET /orchestration/usage/roots/:rootSessionId
   * Aggregate usage for one root session.
   */
  router.get('/usage/roots/:rootSessionId', (req, res) => {
    try {
      const breakdowns = parseUsageBreakdownList(req.query.breakdown);
      const payload = buildUsageResponse('rootSessionId', req.params.rootSessionId, {
        breakdowns,
        breakdownLimit: parseQueryInteger(req.query.breakdownLimit, 20)
      });
      res.json({
        rootSessionId: req.params.rootSessionId,
        ...payload
      });
    } catch (error) {
      if (error.message.includes('not configured')) {
        return res.status(503).json({
          error: { code: 'unavailable', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/usage/runs/:runId
   * Aggregate usage for one orchestration run.
   */
  router.get('/usage/runs/:runId', (req, res) => {
    try {
      const breakdowns = parseUsageBreakdownList(req.query.breakdown);
      const payload = buildUsageResponse('runId', req.params.runId, {
        breakdowns,
        breakdownLimit: parseQueryInteger(req.query.breakdownLimit, 20)
      });
      res.json({
        runId: req.params.runId,
        ...payload
      });
    } catch (error) {
      if (error.message.includes('not configured')) {
        return res.status(503).json({
          error: { code: 'unavailable', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/usage/terminals/:terminalId
   * Aggregate usage and return usage-record history for one terminal.
   */
  router.get('/usage/terminals/:terminalId', (req, res) => {
    try {
      if (!db?.listUsageRecords) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'usage observability is not configured' }
        });
      }

      const breakdowns = parseUsageBreakdownList(req.query.breakdown);
      const payload = buildUsageResponse('terminalId', req.params.terminalId, {
        breakdowns,
        breakdownLimit: parseQueryInteger(req.query.breakdownLimit, 20)
      });
      const limit = parseQueryInteger(req.query.limit, 100);
      const offset = parseQueryInteger(req.query.offset, 0);

      res.json({
        terminalId: req.params.terminalId,
        ...payload,
        records: db.listUsageRecords({
          terminalId: req.params.terminalId,
          limit,
          offset
        }),
        pagination: {
          limit,
          offset
        }
      });
    } catch (error) {
      if (error.message.includes('not configured')) {
        return res.status(503).json({
          error: { code: 'unavailable', message: error.message }
        });
      }

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

      const rootSnapshot = resolveTerminalRootAccess(req.params.id);
      if (rootSnapshot?.rootMode === 'attached') {
        const terminalSession = (rootSnapshot.sessions || []).find(s => s.sessionId === req.params.id);
        const liveTerminal = getLiveTerminal(req.params.id);
        const isRoot = req.params.id === rootSnapshot.rootSessionId;
        const liveRootSessionId = liveTerminal?.rootSessionId || liveTerminal?.root_session_id || null;
        const liveParentSessionId = liveTerminal?.parentSessionId || liveTerminal?.parent_session_id || null;
        const dbParentSessionId = terminalSession?.parentSessionId || terminalSession?.parent_session_id || null;
        const dbOriginClient = String(terminalSession?.originClient || terminalSession?.origin_client || '').trim().toLowerCase();
        const liveOriginClient = String(liveTerminal?.originClient || liveTerminal?.origin_client || '').trim().toLowerCase();
        const dbSessionKind = String(terminalSession?.sessionKind || terminalSession?.session_kind || '').trim().toLowerCase();
        const liveSessionKind = String(liveTerminal?.sessionKind || liveTerminal?.session_kind || '').trim().toLowerCase();
        const hasBrokerChildRole = Boolean(terminalSession?.agentProfile || terminalSession?.agent_profile || liveTerminal?.agentProfile)
          || ATTACHED_ROOT_BROKER_CHILD_SESSION_KINDS.has(dbSessionKind || liveSessionKind);
        const isBrokerOwnedChild = Boolean(terminalSession && liveTerminal)
          && liveRootSessionId === rootSnapshot.rootSessionId
          && liveParentSessionId === rootSnapshot.rootSessionId
          && dbParentSessionId === rootSnapshot.rootSessionId
          && dbOriginClient === 'mcp'
          && liveOriginClient === 'mcp'
          && hasBrokerChildRole
          && (!dbSessionKind || !liveSessionKind || dbSessionKind === liveSessionKind);

        if (isRoot || !isBrokerOwnedChild) {
          return res.status(403).json({
            error: {
              code: 'root_read_only',
              message: `Root session ${rootSnapshot.rootSessionId} is attached and read-only. Remote execution requires a managed or adopted root.`,
              rootSessionId: rootSnapshot.rootSessionId,
              rootMode: rootSnapshot.rootMode,
              terminalId: req.params.id
            }
          });
        }
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

      if (error.code === 'terminal_busy' || error.statusCode === 409) {
        return res.status(409).json({
          error: {
            code: 'terminal_busy',
            message: error.message,
            terminalId: error.terminalId || req.params.id,
            status: error.terminalStatus || null,
            retryAfterMs: error.retryAfterMs || 1000,
            nextAction: 'wait for the terminal to finish, then retry the same input'
          }
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
      const destroyed = await sessionManager.destroyTerminal(req.params.id);
      if (!destroyed) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: `Terminal ${req.params.id} not found` }
        });
      }

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
        permissionMode,
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

      const terminal = await sessionManager.createTerminal({
        adapter,
        agentProfile,
        role,
        workDir,
        systemPrompt,
        model,
        allowedTools,
        permissionMode,
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
          models: typeof runtimeAdapter?.getAvailableModels === 'function'
            ? runtimeAdapter.getAvailableModels()
            : [],
          runtimeProviders: typeof runtimeAdapter?.getProviderSummary === 'function'
            ? runtimeAdapter.getProviderSummary()
            : [],
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
      const afterSequenceNo = parseQueryInteger(
        req.query.after_sequence_no ?? req.query.afterSequenceNo,
        undefined
      );
      const events = db.listSessionEvents({
        rootSessionId,
        sessionId,
        runId,
        discussionId,
        afterSequenceNo: Number.isInteger(afterSequenceNo) ? afterSequenceNo : undefined,
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
      const statusFilter = req.query.statusFilter ? String(req.query.statusFilter) : 'all';
      const result = listRootSessionSummaries({
        db,
        limit,
        eventLimit,
        terminalLimit,
        includeArchived,
        archiveAfterMs,
        scope,
        statusFilter,
        liveTerminalResolver: getLiveTerminal,
        liveOutputResolver: getLiveOutput
      });

      res.json({
        roots: result.roots,
        archivedCount: result.archivedCount,
        hiddenDetachedCount: result.hiddenDetachedCount,
        hiddenNonUserCount: result.hiddenNonUserCount,
        includeArchived,
        scope: result.scope,
        statusFilter: result.statusFilter
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
      const requestedResumeMode = String(req.body?.resumeMode || 'new').trim().toLowerCase() || 'new';
      const providerSessionId = String(req.body?.providerSessionId || '').trim() || null;
      const sourceRootSessionId = String(req.body?.sourceRootSessionId || '').trim() || null;
      if (!['new', 'reattach', 'exact', 'context'].includes(requestedResumeMode)) {
        return res.status(400).json({
          error: { code: 'invalid_request', message: `Unsupported resumeMode: ${requestedResumeMode}` }
        });
      }
      if (requestedResumeMode === 'exact' && !providerSessionId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'providerSessionId is required for resumeMode=exact', param: 'providerSessionId' }
        });
      }

      const sourceRootBundle = sourceRootSessionId && typeof db?.getMemoryBundle === 'function'
        ? db.getMemoryBundle(sourceRootSessionId, 'root', {
          recentRunsLimit: 3,
          includeRawPointers: true
        })
        : null;
      const sourceRootMessages = sourceRootSessionId && typeof db?.queryMessages === 'function'
        ? db.queryMessages({
          rootSessionId: sourceRootSessionId,
          limit: 12
        })
        : [];
      const carriedContextPrompt = requestedResumeMode === 'context' && sourceRootSessionId
        ? [
          'You are continuing prior cliagents work in a new managed root.',
          `Previous root session: ${sourceRootSessionId}.`,
          sourceRootBundle?.brief ? `Summary:\n${sourceRootBundle.brief}` : null,
          Array.isArray(sourceRootBundle?.keyDecisions) && sourceRootBundle.keyDecisions.length > 0
            ? `Key decisions:\n${sourceRootBundle.keyDecisions.map((entry) => `- ${entry}`).join('\n')}`
            : null,
          Array.isArray(sourceRootBundle?.pendingItems) && sourceRootBundle.pendingItems.length > 0
            ? `Pending items:\n${sourceRootBundle.pendingItems.map((entry) => `- ${entry}`).join('\n')}`
            : null,
          sourceRootMessages.length > 0
            ? `Recent conversation excerpts:\n${sourceRootMessages.slice(-8).map((entry) => `${entry.role}: ${String(entry.content || '').slice(0, 280)}`).join('\n')}`
            : null,
          'Treat this as carried context, not a full transcript replay.'
        ].filter(Boolean).join('\n\n')
        : null;

      const workDir = req.body?.workDir
        || req.body?.workingDirectory
        || sourceRootBundle?.rawPointers?.workDir
        || process.cwd();
      const originClient = inferManagedRootOriginClient(adapter);
      const externalSessionRef = buildManagedRootExternalSessionRef(originClient, req.body?.externalSessionRef || null);
      const sessionMetadata = normalizeSessionMetadata(req.body?.sessionMetadata);
      const launchEnvironment = normalizeLaunchEnvironment(req.body?.launchEnvironment || sessionMetadata.launchEnvironment);
      const deferProviderStartUntilAttached = req.body?.deferProviderStartUntilAttached === true;
      if (!sessionMetadata.launchProfile) {
        sessionMetadata.launchProfile = String(req.body?.profile || 'guarded-root').trim() || 'guarded-root';
      }
      const effectiveSystemPrompt = carriedContextPrompt
        ? [carriedContextPrompt, req.body?.systemPrompt || null].filter(Boolean).join('\n\n')
        : (req.body?.systemPrompt || null);
      const systemPrompt = composeManagedRootSystemPrompt(effectiveSystemPrompt, {
        profile: sessionMetadata.launchProfile
      });

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
      sessionMetadata.resumeMode = requestedResumeMode;
      if (providerSessionId) {
        sessionMetadata.providerResumeSessionId = providerSessionId;
        sessionMetadata.providerResumeLatest = false;
      }
      if (sourceRootSessionId) {
        sessionMetadata.sourceRootSessionId = sourceRootSessionId;
      }
      sessionMetadata.providerStartMode = deferProviderStartUntilAttached ? 'after-attach' : 'immediate';
      if (launchEnvironment) {
        sessionMetadata.launchEnvironment = launchEnvironment;
      }

      const terminal = await sessionManager.createTerminal({
        adapter,
        agentProfile: null,
        role: 'main',
        workDir,
        systemPrompt,
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
        launchEnvironment,
        deferProviderStartUntilAttached,
        preferReuse: false,
        forceFreshSession: true
      });

      res.json({
        ...terminal,
        attachCommand: sessionManager.getAttachCommand(terminal.terminalId),
        consoleUrl: '/console',
        providerStartMode: deferProviderStartUntilAttached ? 'after-attach' : 'immediate',
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
   * POST /orchestration/root-sessions/adopt
   * Adopt an existing tmux-backed terminal into the broker as a managed root.
   * First cut supports explicit tmux session/window targets.
   */
  router.post('/root-sessions/adopt', async (req, res) => {
    try {
      if (!sessionGraphWritesEnabled) {
        return res.status(503).json({
          error: { code: 'feature_disabled', message: 'Root adoption requires SESSION_GRAPH_WRITES_ENABLED=1' }
        });
      }

      const adapter = normalizeManagedRootAdapter(req.body?.adapter || 'codex-cli');
      const originClient = req.body?.originClient || inferManagedRootOriginClient(adapter);
      const workDir = req.body?.workDir || req.body?.workingDirectory || null;
      const tmuxTarget = String(req.body?.tmuxTarget || '').trim();
      let sessionName = String(req.body?.sessionName || '').trim();
      let windowName = String(req.body?.windowName || '').trim();

      if (tmuxTarget) {
        const separatorIndex = tmuxTarget.indexOf(':');
        if (separatorIndex <= 0 || separatorIndex === tmuxTarget.length - 1) {
          return res.status(400).json({
            error: { code: 'invalid_tmux_target', message: 'tmuxTarget must be in the form session:window' }
          });
        }
        sessionName = tmuxTarget.slice(0, separatorIndex).trim();
        windowName = tmuxTarget.slice(separatorIndex + 1).trim();
      }

      if (!sessionName || !windowName) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'tmuxTarget or sessionName/windowName is required' }
        });
      }

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
      if (workDir && !sessionMetadata.workspaceRoot) {
        sessionMetadata.workspaceRoot = workDir;
      }
      sessionMetadata.attachMode = 'root-adopt';
      sessionMetadata.rootIdentitySource = req.body?.externalSessionRef
        ? 'explicit-external-session-ref'
        : 'adopt-generated';
      sessionMetadata.launchSource = 'http-root-adopt';
      sessionMetadata.adoptedRoot = true;
      sessionMetadata.tmuxTarget = `${sessionName}:${windowName}`;

      const rootSessionId = req.body?.rootSessionId || crypto.randomBytes(16).toString('hex');
      ensureRootSessionStarted({
        rootSessionId,
        originClient,
        externalSessionRef,
        clientName: sessionMetadata.clientName || originClient,
        sessionMetadata,
        attachMode: 'root-adopt',
        payloadSummary: `Adopted root via ${originClient || 'system'}`
      });

      const terminal = await sessionManager.adoptTerminal({
        sessionName,
        windowName,
        adapter,
        role: 'main',
        workDir,
        model: req.body?.model || null,
        rootSessionId,
        parentSessionId: null,
        sessionKind: 'main',
        originClient,
        externalSessionRef,
        lineageDepth: 0,
        sessionMetadata,
        harnessSessionId: req.body?.harnessSessionId || null,
        providerThreadRef: req.body?.providerThreadRef || null,
        captureMode: req.body?.captureMode || 'raw-tty'
      });

      res.json({
        ...terminal,
        rootSessionId,
        tmuxTarget: `${sessionName}:${windowName}`,
        attachCommand: sessionManager.getAttachCommand(terminal.terminalId),
        consoleUrl: '/console',
        adoptedRoot: true
      });
    } catch (error) {
      console.error('[orchestration/root-sessions/adopt] Error:', error.message);
      if (
        error.message.includes('Unsupported adapter')
        || error.message.includes('Unknown adapter')
        || error.message.includes('tmux session not found')
        || error.message.includes('tmux window not found')
        || error.message.includes('adopt mode')
      ) {
        return res.status(400).json({
          error: { code: 'invalid_request', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/root-sessions/:rootSessionId/children
   * Return child terminals for one root session using DB-backed terminal records.
   */
  router.get('/root-sessions/:rootSessionId/children', (req, res) => {
    try {
      if (!db?.listTerminals || !db?.listSessionEvents) {
        return res.status(503).json({
          error: { code: 'unavailable', message: 'root session monitoring is not configured' }
        });
      }

      const rootSessionId = req.params.rootSessionId;
      const limit = parseQueryInteger(req.query.limit, 50);
      const rootHasEvents = db.listSessionEvents({ rootSessionId, limit: 1 }).length > 0;
      const terminalRows = db.listTerminals({
        rootSessionId,
        limit: Math.max(limit + 1, 1)
      });

      if (!rootHasEvents && terminalRows.length === 0) {
        return res.status(404).json({
          error: { code: 'root_session_not_found', message: `Root session ${rootSessionId} not found` }
        });
      }

      const children = terminalRows
        .filter((terminalRow) => !isRootTerminalRecord(terminalRow, rootSessionId))
        .map((terminalRow) => {
          const terminalId = terminalRow?.terminal_id || terminalRow?.terminalId || null;
          const liveTerminal = terminalId && typeof sessionManager?.getTerminal === 'function'
            ? sessionManager.getTerminal(terminalId)
            : null;
          return mapChildTerminalSummary(terminalRow, liveTerminal);
        })
        .slice(0, limit);

      res.json({
        rootSessionId,
        children,
        count: children.length
      });
    } catch (error) {
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
        terminalLimit,
        liveTerminalResolver: getLiveTerminal,
        liveOutputResolver: getLiveOutput
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

      if (requireConsistentRootBinding(res, '/orchestration/root-sessions/attach', resolved)) {
        return;
      }
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

        ensureRootSessionStarted({
          rootSessionId,
          originClient: resolved.originClient || 'system',
          payloadSummary: `HTTP root attach via ${resolved.originClient || resolved.clientName || 'system'}`,
          externalSessionRef: resolved.externalSessionRef || null,
          clientName: resolved.clientName || null,
          sessionMetadata: Object.keys(sessionMetadata).length > 0 ? sessionMetadata : null,
          attachMode: 'explicit-http-attach',
          model: sessionMetadata.model || null
        });

        resolved.rootSessionId = rootSessionId;
        resolved.sessionMetadata = Object.keys(sessionMetadata).length > 0 ? sessionMetadata : null;
        createdRoot = true;
      }

      if (resolved.rootSessionId) {
        ensureLogicalRootTerminalRecord({
          rootSessionId: resolved.rootSessionId,
          originClient: resolved.originClient || 'mcp',
          externalSessionRef: resolved.externalSessionRef || null,
          sessionMetadata: resolved.sessionMetadata || null,
          model: resolved.sessionMetadata?.model || null
        });
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
      taskRouter = new TaskRouter(sessionManager, { apiSessionManager, adapterAuthInspector });
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
        sessionLabel,
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

      if (requireConsistentRootBinding(res, '/orchestration/route', resolvedControlPlane)) {
        return;
      }
      if (requireAttachedRoot(res, '/orchestration/route', resolvedControlPlane)) {
        return;
      }
      const executionControlPlane = projectExecutionControlPlane(resolvedControlPlane);

      const router = getTaskRouter();
      const result = await router.routeTask(message, {
        forceProfile: effectiveProfile,
        forceType,
        // Pass role+adapter for native handling if task router supports it
        forceRole,
        forceAdapter,
        model,
        sessionLabel,
        systemPrompt,
        workDir: workingDirectory,
        rootSessionId: executionControlPlane.rootSessionId,
        parentSessionId: executionControlPlane.parentSessionId,
        sessionKind: executionControlPlane.sessionKind,
        originClient: executionControlPlane.originClient,
        externalSessionRef: executionControlPlane.externalSessionRef,
        lineageDepth: executionControlPlane.lineageDepth,
        sessionMetadata: executionControlPlane.sessionMetadata,
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
   * POST /orchestration/model-routing/recommend
   * Recommend a model for a given adapter/task combination using broker policy and live runtime catalogs.
   */
  router.post('/model-routing/recommend', async (req, res) => {
    try {
      const { adapter, role, taskType, message } = req.body || {};
      if (!adapter) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'adapter is required' }
        });
      }

      const router = getTaskRouter();
      let inferredTaskType = taskType || null;
      if (!inferredTaskType && !role && message) {
        inferredTaskType = router.detectTaskType(message).type;
      }

      const recommendation = await router.recommendModel({
        adapter,
        role: role || null,
        taskType: inferredTaskType
      });

      res.json(recommendation);
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

      if (requireConsistentRootBinding(res, `/orchestration/workflows/${name}`, resolvedControlPlane)) {
        return;
      }
      if (requireAttachedRoot(res, `/orchestration/workflows/${name}`, resolvedControlPlane)) {
        return;
      }
      const executionControlPlane = projectExecutionControlPlane(resolvedControlPlane);

      const router = getTaskRouter();
      const result = await router.executeWorkflow(name, message, {
        model,
        modelsByAdapter,
        workDir: workingDirectory,
        rootSessionId: executionControlPlane.rootSessionId,
        parentSessionId: executionControlPlane.parentSessionId,
        sessionKind: executionControlPlane.sessionKind,
        originClient: executionControlPlane.originClient,
        externalSessionRef: executionControlPlane.externalSessionRef,
        lineageDepth: executionControlPlane.lineageDepth,
        sessionMetadata: executionControlPlane.sessionMetadata,
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
