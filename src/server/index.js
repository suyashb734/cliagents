/**
 * cliagents
 *
 * HTTP + WebSocket server that exposes agent adapters via REST API and real-time streaming.
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const SessionManager = require('../core/session-manager');

// First-party CLI adapters (from AI companies with their own LLMs)
const { DEFAULT_BROKER_ADAPTER } = require('../adapters/active-surface');
const { registerActiveAdapters } = require('../adapters/runtime-registry');

// Utilities
const { sendError, errorHandler, ErrorCodes } = require('../utils/errors');
const { validateWorkDir, validateMessage, validateJsonSchema, validateFileName } = require('../utils/validation');
const {
  getAdapterStatus,
  getAllAdapterStatuses,
  testAdapterAuth,
  setEnvVar,
  getAuthConfig,
  isAdapterAuthenticated
} = require('../utils/adapter-auth');
const { createOpenAIRouter } = require('./openai-compat');
const {
  authenticateRequest,
  validateApiKey,
  getConfiguredApiKey,
  getConfiguredApiKeySource,
  configureAuth,
  ensureLocalApiKey,
  isLoopbackHost,
  isUnauthenticatedLocalhostModeEnabled,
  assertAuthConfigurationForHost
} = require('./auth');

// Orchestration components
const { PersistentSessionManager } = require('../tmux/session-manager');
const { createAllDetectors } = require('../status-detectors/factory');
const { getDB, closeDB } = require('../database/db');
const { RunLedgerService } = require('../orchestration/run-ledger');
const { getMemoryMaintenanceService, resetMemoryMaintenanceService } = require('../orchestration/memory-maintenance-service');
const { getMemorySnapshotService, resetMemorySnapshotService } = require('../orchestration/memory-snapshot-service');
const { getChildSessionSupport } = require('../orchestration/child-session-support');
const InboxService = require('../services/inbox-service');
const { createOrchestrationRouter } = require('./orchestration-router');

function isProviderCapacityError(message) {
  const text = String(message || '');
  return /rate.?limit|quota|resourceexhausted|quota_exhausted|exhausted your capacity|capacity on this model/i.test(text);
}

const API_CORS_ALLOWED_ORIGINS_ENV = 'CLIAGENTS_API_CORS_ALLOWED_ORIGINS';
const API_CORS_ALLOW_LOOPBACK_ENV = 'CLIAGENTS_API_CORS_ALLOW_LOOPBACK';
const DASHBOARD_ENV_MUTATION_DISABLED_ENV = 'CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION';
const DASHBOARD_ENV_MUTATION_EXTRA_KEYS_ENV = 'CLIAGENTS_DASHBOARD_ENV_MUTATION_EXTRA_KEYS';

const API_ROUTE_PREFIXES = [
  '/health',
  '/openapi.json',
  '/adapters',
  '/sessions',
  '/ask',
  '/dashboard/adapters',
  '/orchestration',
  '/v1'
];

function normalizeEnvList(value) {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isValidEnvVarName(name) {
  return typeof name === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(name);
}

function shouldApplyApiCors(pathname) {
  if (typeof pathname !== 'string' || !pathname) {
    return false;
  }
  return API_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function parseOriginHost(origin) {
  if (typeof origin !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname;
  } catch {
    return null;
  }
}

function isAllowedApiCorsOrigin(origin, explicitOrigins, allowLoopbackOrigins) {
  if (typeof origin !== 'string' || !origin.trim()) {
    return true;
  }

  const normalizedOrigin = origin.trim();
  if (explicitOrigins.has(normalizedOrigin)) {
    return true;
  }

  if (allowLoopbackOrigins) {
    const originHost = parseOriginHost(normalizedOrigin);
    if (originHost && isLoopbackHost(originHost)) {
      return true;
    }
  }

  return false;
}

function buildApiCorsPolicy() {
  const explicitOrigins = new Set(normalizeEnvList(process.env[API_CORS_ALLOWED_ORIGINS_ENV]));
  const allowLoopbackOrigins = process.env[API_CORS_ALLOW_LOOPBACK_ENV] !== '0';
  const isOriginAllowed = (origin) => isAllowedApiCorsOrigin(origin, explicitOrigins, allowLoopbackOrigins);

  const middleware = cors({
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key']
  });

  return { middleware, isOriginAllowed };
}

function isDashboardEnvMutationDisabled() {
  return process.env[DASHBOARD_ENV_MUTATION_DISABLED_ENV] === '1';
}

function getDashboardEnvMutationAllowlist(adapterName) {
  const config = getAuthConfig(adapterName);
  if (!config) {
    return null;
  }

  const allowedKeys = new Set();
  for (const key of (Array.isArray(config.envVars) ? config.envVars : [])) {
    if (isValidEnvVarName(key)) {
      allowedKeys.add(key);
    }
  }

  for (const key of normalizeEnvList(process.env[DASHBOARD_ENV_MUTATION_EXTRA_KEYS_ENV])) {
    if (isValidEnvVarName(key)) {
      allowedKeys.add(key);
    }
  }

  return allowedKeys;
}

class AgentServer {
  constructor(options = {}) {
    this.port = options.port ?? 4001;
    this.host = options.host ?? '127.0.0.1';
    this.dataDir = options.orchestration?.dataDir || process.env.CLIAGENTS_DATA_DIR || path.join(process.cwd(), 'data');
    this.localApiKey = ensureLocalApiKey({ dataDir: this.dataDir });
    configureAuth({ localApiKeyFilePath: this.localApiKey.filePath });
    this.cleanupOrphans = options.cleanupOrphans ?? process.env.CLI_AGENTS_CLEANUP_ORPHANS === '1';
    this.destroyOrchestrationTerminalsOnStop = options.orchestration?.destroyTerminalsOnStop
      ?? process.env.CLI_AGENTS_DESTROY_TERMINALS_ON_STOP === '1';
    const pruneEnabledOption = options.orchestration?.pruneOrphanedTerminals;
    const pruneOlderThanHoursOption = options.orchestration?.pruneOrphanedTerminalHours;
    const pruneLimitOption = options.orchestration?.pruneOrphanedTerminalLimit;
    this.orphanedTerminalPruneConfig = {
      enabled: pruneEnabledOption ?? process.env.CLI_AGENTS_PRUNE_ORPHANED_TERMINALS === '1',
      olderThanHours: Number(pruneOlderThanHoursOption ?? process.env.CLI_AGENTS_PRUNE_ORPHANED_TERMINALS_HOURS ?? 24),
      limit: Number(pruneLimitOption ?? process.env.CLI_AGENTS_PRUNE_ORPHANED_TERMINALS_LIMIT ?? 1000)
    };
    this.runLedgerSweepTimer = null;
    this.runLedgerSweepConfig = {
      enabled: process.env.RUN_LEDGER_ENABLED === '1' && (
        Number(options.orchestration?.runLedgerReconcileIntervalMs || 0) > 0 ||
        process.env.RUN_LEDGER_SWEEP_ENABLED === '1'
      ),
      intervalMs: Number(options.orchestration?.runLedgerReconcileIntervalMs || process.env.RUN_LEDGER_RECONCILE_INTERVAL_MS || 0),
      staleMs: Number(options.orchestration?.runLedgerReconcileStaleMs || process.env.RUN_LEDGER_RECONCILE_STALE_MS || 15 * 60 * 1000),
      limit: Number(options.orchestration?.runLedgerReconcileLimit || process.env.RUN_LEDGER_RECONCILE_LIMIT || 100)
    };

    // Initialize session manager
    this.sessionManager = new SessionManager({
      defaultAdapter: options.defaultAdapter || DEFAULT_BROKER_ADAPTER,
      sessionTimeout: options.sessionTimeout || 30 * 60 * 1000,
      maxSessions: options.maxSessions || 10
    });

    // Register the active broker adapters
    registerActiveAdapters(this.sessionManager, options);

    // Express app
    this.app = express();
    const apiCorsPolicy = buildApiCorsPolicy();
    this.app.use((req, res, next) => {
      if (!shouldApplyApiCors(req.path)) {
        return next();
      }
      const requestOrigin = req.headers.origin;
      if (requestOrigin && !apiCorsPolicy.isOriginAllowed(requestOrigin)) {
        return res.status(403).json({
          success: false,
          error: `Origin is not allowed by ${API_CORS_ALLOWED_ORIGINS_ENV}`
        });
      }
      return apiCorsPolicy.middleware(req, res, next);
    });
    this.app.use(express.json({ limit: '50mb' }));

    // Security: Add authentication middleware
    this.app.use(authenticateRequest);

    // Serve static files from public directory
    const publicPath = path.join(__dirname, '../../public');
    this.app.use(express.static(publicPath));

    // Setup routes
    this._setupRoutes();

    // Mount OpenAI-compatible routes at /v1
    const openaiRouter = createOpenAIRouter(this.sessionManager);
    this.app.use('/v1', openaiRouter);

    // Initialize orchestration components (optional feature)
    this._initOrchestration(options);

    // WebSocket clients
    this.wsClients = new Map(); // sessionId -> Set<ws>
  }

  /**
   * Initialize orchestration components for multi-agent coordination
   */
  _initOrchestration(options = {}) {
    // Check if orchestration is enabled (default: true if tmux available)
    const orchestrationEnabled = options.orchestration?.enabled ?? true;

    if (!orchestrationEnabled) {
      console.log('[AgentServer] Orchestration disabled');
      this.orchestration = null;
      return;
    }

    try {
      // Check for tmux
      const { execSync } = require('child_process');
      try {
        execSync('which tmux', { stdio: 'pipe' });
      } catch (e) {
        console.warn('[AgentServer] tmux not found - orchestration disabled');
        console.warn('[AgentServer] Install with: brew install tmux');
        this.orchestration = null;
        return;
      }

      // Initialize database
      const db = getDB({
        dataDir: this.dataDir
      });

      // Initialize persistent session manager
      const persistentSessionManager = new PersistentSessionManager({
        db,
        logDir: options.orchestration?.logDir || path.join(process.cwd(), 'logs'),
        workDir: options.orchestration?.workDir || process.cwd(),
        tmuxSocketPath: options.orchestration?.tmuxSocketPath || null
      });

      // Register status detectors
      const detectors = createAllDetectors();
      for (const [adapter, detector] of detectors) {
        persistentSessionManager.registerStatusDetector(adapter, detector);
      }

      // Initialize inbox service
      const inboxService = new InboxService({
        db,
        sessionManager: persistentSessionManager,
        pollInterval: options.orchestration?.inboxPollInterval || 500
      });

      // Start inbox delivery loop
      inboxService.start();

      // Bind snapshot/maintenance services to this DB instance so restart/test cycles
      // do not retain stale singleton state from a previous server instance.
      const memorySnapshotService = getMemorySnapshotService(db, console);
      const memoryMaintenance = getMemoryMaintenanceService({
        sweepIntervalMs: options.orchestration?.memoryRepairSweepMs,
        snapshotService: memorySnapshotService,
        logger: console
      });
      memoryMaintenance.start();
      memoryMaintenance.runOnce().catch((error) => {
        console.warn('[AgentServer] Initial memory repair sweep failed:', error.message);
      });

      const runLedger = process.env.RUN_LEDGER_ENABLED === '1'
        ? new RunLedgerService(db)
        : null;

      // Store orchestration context
      this.orchestration = {
        db,
        runLedger,
        memoryMaintenance,
        sessionManager: persistentSessionManager,
        inboxService,
        enabled: true
      };

      this._startRunLedgerSweep();

      // Mount orchestration routes
      const orchestrationRouter = createOrchestrationRouter({
        sessionManager: persistentSessionManager,
        apiSessionManager: this.sessionManager,
        db,
        inboxService,
        host: this.host
      });
      this.app.use('/orchestration', orchestrationRouter);

      // Forward orchestration events to WebSocket clients
      this._setupOrchestrationEvents();

      console.log('[AgentServer] Orchestration enabled');
      console.log('[AgentServer]   - Database: data/cliagents.db');
      console.log('[AgentServer]   - Logs: logs/');
      if (options.orchestration?.tmuxSocketPath) {
        console.log(`[AgentServer]   - tmux socket: ${options.orchestration.tmuxSocketPath}`);
      }
      console.log('[AgentServer]   - Endpoints: /orchestration/*');

    } catch (error) {
      console.error('[AgentServer] Failed to initialize orchestration:', error.message);
      this.orchestration = null;
    }
  }

  _startRunLedgerSweep() {
    if (!this.orchestration?.runLedger || !this.runLedgerSweepConfig.enabled) {
      return;
    }

    const intervalMs = Math.max(1, Number(this.runLedgerSweepConfig.intervalMs || 0));
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    const staleMs = Math.max(1, Number(this.runLedgerSweepConfig.staleMs || 15 * 60 * 1000));
    const limit = Math.max(1, Number(this.runLedgerSweepConfig.limit || 100));

    const sweep = () => {
      try {
        const result = this.orchestration.runLedger.reconcileStaleRuns({ staleMs, limit });
        if (result.reconciledCount > 0) {
          console.log(`[AgentServer] Reconciled ${result.reconciledCount} stale run(s)`);
        }
      } catch (error) {
        console.warn('[AgentServer] Run-ledger reconciliation sweep failed:', error.message);
      }
    };

    this.runLedgerSweepTimer = setInterval(sweep, intervalMs);
    if (typeof this.runLedgerSweepTimer.unref === 'function') {
      this.runLedgerSweepTimer.unref();
    }
  }

  _stopRunLedgerSweep() {
    if (!this.runLedgerSweepTimer) {
      return;
    }

    clearInterval(this.runLedgerSweepTimer);
    this.runLedgerSweepTimer = null;
  }

  /**
   * Set up WebSocket events for orchestration
   */
  _setupOrchestrationEvents() {
    if (!this.orchestration) return;

    const { sessionManager, inboxService } = this.orchestration;

    // Terminal events
    sessionManager.on('terminal-created', (data) => {
      this._broadcastOrchestrationEvent('terminal-created', data);
    });

    sessionManager.on('terminal-destroyed', (data) => {
      this._broadcastOrchestrationEvent('terminal-destroyed', data);
    });

    sessionManager.on('status-change', (data) => {
      this._broadcastOrchestrationEvent('status-change', data);
    });

    // Inbox events
    inboxService.on('message-queued', (data) => {
      this._broadcastOrchestrationEvent('message-queued', data);
    });

    inboxService.on('message-delivered', (data) => {
      this._broadcastOrchestrationEvent('message-delivered', data);
    });

    inboxService.on('message-failed', (data) => {
      this._broadcastOrchestrationEvent('message-failed', data);
    });
  }

  /**
   * Broadcast orchestration event to all connected WebSocket clients
   */
  _broadcastOrchestrationEvent(type, data) {
    if (!this.wss) return;

    const message = JSON.stringify({
      type: `orchestration:${type}`,
      ...data,
      timestamp: Date.now()
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    });
  }

  _setupRoutes() {
    const app = this.app;

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // OpenAPI specification
    app.get('/openapi.json', (req, res) => {
      const specPath = path.join(__dirname, '../../openapi.json');
      if (fs.existsSync(specPath)) {
        res.setHeader('Content-Type', 'application/json');
        res.sendFile(specPath);
      } else {
        sendError(res, 'INTERNAL_ERROR', { message: 'OpenAPI specification not found' });
      }
    });

    // List available adapters
    app.get('/adapters', async (req, res) => {
      try {
        const adapters = [];
        for (const name of this.sessionManager.getAdapterNames()) {
          const adapter = this.sessionManager.getAdapter(name);
          const available = await adapter.isAvailable();
          const auth = isAdapterAuthenticated(name);
          const capabilities = typeof adapter.getCapabilities === 'function'
            ? adapter.getCapabilities()
            : null;
          const adapterInfo = {
            name,
            ...adapter.getInfo(),
            available,
            authenticated: auth.authenticated,
            authenticationReason: auth.reason,
            childSessionSupport: getChildSessionSupport(name, capabilities)
          };
          // Include available models if adapter supports them
          if (typeof adapter.getAvailableModels === 'function') {
            adapterInfo.models = adapter.getAvailableModels();
          }
          adapters.push(adapterInfo);
        }
        res.json({ adapters });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create session
    app.post('/sessions', async (req, res) => {
      try {
        const {
          adapter, systemPrompt, allowedTools, workDir, model, jsonSchema,
          // Generation parameters (Gemini only)
          temperature, top_p, top_k, max_output_tokens
        } = req.body;

        // Validate workDir to prevent path traversal
        const workDirValidation = validateWorkDir(workDir);
        if (!workDirValidation.valid) {
          return sendError(res, 'INVALID_PARAMETER', { message: workDirValidation.error, param: 'workDir' });
        }

        // Validate jsonSchema if provided
        const schemaValidation = validateJsonSchema(jsonSchema);
        if (!schemaValidation.valid) {
          return sendError(res, 'INVALID_PARAMETER', { message: schemaValidation.error, param: 'jsonSchema' });
        }

        const session = await this.sessionManager.createSession({
          adapter,
          systemPrompt,
          allowedTools,
          workDir: workDirValidation.sanitized,
          model,
          jsonSchema,  // JSON Schema for structured output (Claude only)
          // Generation parameters (Gemini only - writes to ~/.gemini/config.yaml)
          temperature,
          top_p,
          top_k,
          max_output_tokens
        });
        res.json(session);
      } catch (error) {
        if (error.message?.includes('not registered')) {
          return sendError(res, 'ADAPTER_NOT_FOUND', { message: error.message });
        }
        if (error.message?.includes('not available')) {
          return sendError(res, 'ADAPTER_UNAVAILABLE', { message: error.message });
        }
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // List sessions
    app.get('/sessions', (req, res) => {
      try {
        const sessions = this.sessionManager.listSessions();
        res.json({ sessions });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get session info
    app.get('/sessions/:sessionId', (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json(session);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Get session status (running/stable/error)
    app.get('/sessions/:sessionId/status', (req, res) => {
      try {
        const status = this.sessionManager.getSessionStatus(req.params.sessionId);
        if (!status) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json(status);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Interrupt session (kill active process)
    app.post('/sessions/:sessionId/interrupt', async (req, res) => {
      try {
        const result = await this.sessionManager.interruptSession(req.params.sessionId);
        if (result.reason === 'session_not_found') {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json(result);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Send message to session (non-streaming, waits for full response)
    app.post('/sessions/:sessionId/messages', async (req, res) => {
      try {
        const { message, timeout, stream, jsonSchema, allowedTools } = req.body;

        // Validate message
        const messageValidation = validateMessage(message);
        if (!messageValidation.valid) {
          return sendError(res, 'INVALID_PARAMETER', { param: 'message', message: messageValidation.error });
        }

        // Validate jsonSchema if provided
        if (jsonSchema) {
          const schemaValidation = validateJsonSchema(jsonSchema);
          if (!schemaValidation.valid) {
            return sendError(res, 'INVALID_PARAMETER', { message: schemaValidation.error, param: 'jsonSchema' });
          }
        }

        const options = {
          timeout,
          jsonSchema,      // Per-message JSON schema override (Claude only)
          allowedTools     // Per-message allowed tools override
        };

        // If stream=true, use SSE streaming
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
          res.flushHeaders();

          try {
            for await (const chunk of this.sessionManager.sendStream(req.params.sessionId, message, options)) {
              if (chunk.type === 'chunk') {
                res.write(`event: chunk\ndata: ${JSON.stringify({ content: chunk.content })}\n\n`);
              } else if (chunk.type === 'result') {
                res.write(`event: result\ndata: ${JSON.stringify(chunk)}\n\n`);
              } else if (chunk.type === 'error') {
                // Send standardized error in SSE format
                const errorCode = chunk.timedOut ? 'timeout_error' : 'cli_error';
                res.write(`event: error\ndata: ${JSON.stringify({
                  error: { code: errorCode, message: chunk.content, type: errorCode }
                })}\n\n`);
              }
            }
            res.write('event: done\ndata: {}\n\n');
            res.end();
          } catch (error) {
            const errorCode = error.message?.includes('not found') ? 'session_not_found' : 'internal_error';
            res.write(`event: error\ndata: ${JSON.stringify({
              error: { code: errorCode, message: error.message, type: errorCode }
            })}\n\n`);
            res.end();
          }
          return;
        }

        // Non-streaming: collect full response
        const response = await this.sessionManager.send(
          req.params.sessionId,
          message,
          options
        );

        res.json(response);
      } catch (error) {
        if (error.message?.includes('not found')) {
          return sendError(res, 'SESSION_NOT_FOUND', { message: error.message });
        }
        if (error.message?.includes('timed out')) {
          return sendError(res, 'TIMEOUT', { message: error.message });
        }
        if (isProviderCapacityError(error.message)) {
          return res.status(429).json({
            error: {
              code: 'rate_limit_exceeded',
              message: error.message,
              type: 'rate_limit_error'
            }
          });
        }
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Parse response
    app.post('/sessions/:sessionId/parse', (req, res) => {
      try {
        const { text } = req.body;
        if (!text) {
          return sendError(res, 'MISSING_PARAMETER', { message: 'Text is required', param: 'text' });
        }

        const parsed = this.sessionManager.parseResponse(req.params.sessionId, text);
        res.json(parsed);
      } catch (error) {
        if (error.message.includes('not found')) {
          return sendError(res, 'SESSION_NOT_FOUND', { message: error.message });
        }
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Terminate session
    app.delete('/sessions/:sessionId', async (req, res) => {
      try {
        const terminated = await this.sessionManager.terminateSession(req.params.sessionId);
        if (!terminated) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json({ status: 'terminated' });
      } catch (error) {
        if (isProviderCapacityError(error.message)) {
          return res.status(429).json({
            error: {
              code: 'rate_limit_exceeded',
              message: error.message,
              type: 'rate_limit_error'
            }
          });
        }
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Upload files to session working directory
    // Accepts: { files: [{ name: "file.txt", content: "base64...", encoding: "base64" | "utf8" }] }
    app.post('/sessions/:sessionId/files', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }

        const { files } = req.body;
        if (!files || !Array.isArray(files) || files.length === 0) {
          return sendError(res, 'MISSING_PARAMETER', { message: 'Files array is required', param: 'files' });
        }

        // Get session's working directory from adapter
        const adapter = this.sessionManager.getAdapter(session.adapterName);
        const sessionInfo = adapter.sessions.get(req.params.sessionId);
        const workDir = sessionInfo?.workDir || '/tmp/agent';

        // Ensure work directory exists
        if (!fs.existsSync(workDir)) {
          fs.mkdirSync(workDir, { recursive: true });
        }

        const results = [];
        for (const file of files) {
          // Validate file name
          const fileNameValidation = validateFileName(file.name);
          if (!fileNameValidation.valid) {
            results.push({ name: file.name, error: fileNameValidation.error, status: 'failed' });
            continue;
          }

          const safeName = fileNameValidation.sanitized;
          const filePath = path.join(workDir, safeName);

          try {
            // Decode content based on encoding
            let content;
            if (file.encoding === 'base64') {
              content = Buffer.from(file.content, 'base64');
            } else {
              content = file.content || '';
            }

            // Limit file size (10MB max per file)
            const MAX_FILE_SIZE = 10 * 1024 * 1024;
            if (content.length > MAX_FILE_SIZE) {
              results.push({
                name: safeName,
                error: `File size exceeds maximum allowed (${MAX_FILE_SIZE / 1024 / 1024}MB)`,
                status: 'failed'
              });
              continue;
            }

            fs.writeFileSync(filePath, content);
            results.push({
              name: safeName,
              path: filePath,
              size: content.length,
              status: 'uploaded'
            });
          } catch (writeError) {
            results.push({
              name: safeName,
              error: writeError.message,
              status: 'failed'
            });
          }
        }

        res.json({
          sessionId: req.params.sessionId,
          workDir,
          files: results
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // List files in session working directory
    app.get('/sessions/:sessionId/files', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }

        // Get session's working directory from adapter
        const adapter = this.sessionManager.getAdapter(session.adapterName);
        const sessionInfo = adapter.sessions.get(req.params.sessionId);
        const workDir = sessionInfo?.workDir || '/tmp/agent';

        if (!fs.existsSync(workDir)) {
          return res.json({ sessionId: req.params.sessionId, workDir, files: [] });
        }

        const files = fs.readdirSync(workDir).map(name => {
          const filePath = path.join(workDir, name);
          const stats = fs.statSync(filePath);
          return {
            name,
            path: filePath,
            size: stats.size,
            isDirectory: stats.isDirectory(),
            modified: stats.mtime
          };
        });

        res.json({
          sessionId: req.params.sessionId,
          workDir,
          files
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Simple one-shot ask (creates session, sends message, returns response, terminates)
    app.post('/ask', async (req, res) => {
      let ephemeralWorkDir = null;
      let session = null;
      try {
        const {
          message, adapter, systemPrompt, timeout, jsonSchema, allowedTools, model,
          workDir, workingDirectory,
          temperature, top_p, top_k, max_output_tokens
        } = req.body;
        if (!message) {
          return sendError(res, 'MISSING_PARAMETER', { message: 'Message is required', param: 'message' });
        }

        // Validate message
        const messageValidation = validateMessage(message);
        if (!messageValidation.valid) {
          return sendError(res, 'INVALID_PARAMETER', { param: 'message', message: messageValidation.error });
        }

        const resolvedWorkDir = workDir ?? workingDirectory;
        if (!resolvedWorkDir) {
          const adapterLabel = String(adapter || this.sessionManager.defaultAdapter || 'session')
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'session';
          ephemeralWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), `cliagents-ask-${adapterLabel}-`));
        }
        const validationTarget = resolvedWorkDir || ephemeralWorkDir;
        const workDirValidation = validateWorkDir(validationTarget);
        const effectiveWorkDir = workDirValidation.valid ? workDirValidation.sanitized : validationTarget;
        if (!workDirValidation.valid) {
          if (ephemeralWorkDir && fs.existsSync(ephemeralWorkDir)) {
            fs.rmSync(ephemeralWorkDir, { recursive: true, force: true });
          }
          return sendError(res, 'INVALID_PARAMETER', { message: workDirValidation.error, param: validationTarget === workingDirectory ? 'workingDirectory' : 'workDir' });
        }

        // Create session with JSON schema support
        session = await this.sessionManager.createSession({
          adapter,
          systemPrompt,
          jsonSchema,      // JSON schema for structured output (Claude only)
          allowedTools,    // Allowed tools
          model,           // Model selection
          workDir: effectiveWorkDir,
          temperature,
          top_p,
          top_k,
          max_output_tokens
        });

        const response = await this.sessionManager.send(session.sessionId, message, {
          timeout,
          jsonSchema      // Also pass per-message for Claude
        });

        res.json(response);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      } finally {
        if (session?.sessionId) {
          try {
            await this.sessionManager.terminateSession(session.sessionId);
          } catch {}
        }
        if (ephemeralWorkDir && fs.existsSync(ephemeralWorkDir)) {
          fs.rmSync(ephemeralWorkDir, { recursive: true, force: true });
        }
      }
    });

    // ==========================================
    // Dashboard Routes
    // ==========================================

    // Serve dashboard page
    app.get('/dashboard', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
    });

    // Serve run inspector page
    app.get('/runs', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/runs.html'));
    });

    // Serve live orchestration console
    app.get('/console', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/console.html'));
    });

    // Get status for all adapters
    app.get('/dashboard/adapters/status', async (req, res) => {
      try {
        const adapters = [];

        for (const name of this.sessionManager.getAdapterNames()) {
          const adapter = this.sessionManager.getAdapter(name);
          const status = await getAdapterStatus(name, adapter);

          // Determine auth status from the status object
          let authStatus = 'unknown';
          if (status.authenticated === true) {
            authStatus = 'authenticated';
          } else if (status.authenticated === 'likely') {
            authStatus = 'likely';
          } else if (status.authenticated === false) {
            authStatus = 'failed';
          }

          adapters.push({
            name: status.name,
            displayName: status.displayName,
            authType: status.authType,
            installed: status.installed,
            authStatus,
            models: typeof adapter.getAvailableModels === 'function'
              ? adapter.getAvailableModels()
              : [],
            runtimeProviders: typeof adapter.getProviderSummary === 'function'
              ? adapter.getProviderSummary()
              : [],
            envVarsSet: status.envVarsSet,
            configFileExists: status.configFileExists,
            configFilePath: status.configFilePath,
            loginCommand: status.loginCommand,
            loginInstructions: status.loginInstructions,
            docsUrl: status.docsUrl
          });
        }

        res.json({ adapters });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Test adapter authentication
    app.post('/dashboard/adapters/:name/test', async (req, res) => {
      try {
        const adapterName = req.params.name;
        const adapter = this.sessionManager.getAdapter(adapterName);

        if (!adapter) {
          return res.status(404).json({ success: false, error: 'Adapter not found' });
        }

        const isAvailable = await adapter.isAvailable();
        if (!isAvailable) {
          return res.json({ success: false, error: 'CLI not installed' });
        }

        const result = await testAdapterAuth(adapterName, adapter, 60000); // 60s timeout
        res.json(result);
      } catch (error) {
        res.json({ success: false, error: error.message });
      }
    });

    // Set environment variables for adapter
    app.post('/dashboard/adapters/:name/env', async (req, res) => {
      try {
        const adapterName = req.params.name;
        if (isDashboardEnvMutationDisabled()) {
          return res.status(403).json({
            success: false,
            error: `${DASHBOARD_ENV_MUTATION_DISABLED_ENV}=1 disabled this endpoint`
          });
        }

        const allowedKeys = getDashboardEnvMutationAllowlist(adapterName);
        if (!allowedKeys) {
          return res.status(404).json({ success: false, error: 'Adapter not found' });
        }

        const { envVars } = req.body;

        if (!envVars || typeof envVars !== 'object' || Array.isArray(envVars)) {
          return res.status(400).json({ success: false, error: 'envVars object required' });
        }

        const rejectedKeys = [];
        const invalidValueKeys = [];
        const acceptedEntries = [];

        for (const [key, value] of Object.entries(envVars)) {
          if (!allowedKeys.has(key)) {
            rejectedKeys.push(key);
            continue;
          }
          if (typeof value !== 'string') {
            invalidValueKeys.push(key);
            continue;
          }
          acceptedEntries.push([key, value]);
        }

        if (rejectedKeys.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Unsupported environment variable key(s)',
            rejectedKeys
          });
        }

        if (invalidValueKeys.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Environment variable values must be strings',
            invalidValueKeys
          });
        }

        for (const [key, value] of acceptedEntries) {
          setEnvVar(key, value);
        }

        const acceptedKeys = acceptedEntries.map(([key]) => key);
        console.info(
          `[Security] dashboard env mutation accepted adapter=${adapterName} keys=${
            acceptedKeys.length > 0 ? acceptedKeys.join(',') : '(none)'
          }`
        );

        res.json({ success: true, message: 'Environment variables set', acceptedKeys });
      } catch (error) {
        res.json({ success: false, error: error.message });
      }
    });

    // Get auth configuration for adapter
    app.get('/dashboard/adapters/:name/auth-config', (req, res) => {
      try {
        const config = getAuthConfig(req.params.name);
        if (!config) {
          return sendError(res, 'ADAPTER_NOT_FOUND');
        }
        res.json(config);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });
  }

  _setupWebSocket(server) {
    this.wss = new WebSocketServer({ 
      server, 
      path: '/ws',
      verifyClient: (info, cb) => {
        const url = new URL(info.req.url, 'http://localhost');
        const queryKey = url.searchParams.get('apiKey');
        const protocols = info.req.headers['sec-websocket-protocol'];

        // Explicit localhost-only development override.
        if (isUnauthenticatedLocalhostModeEnabled()) {
          return cb(true);
        }

        // Check query param
        if (queryKey && validateApiKey(queryKey)) {
          return cb(true);
        }

        // Check protocol header (often used for token passing in browsers)
        if (protocols) {
          const parts = protocols.split(',').map(p => p.trim());
          for (const p of parts) {
            if (validateApiKey(p)) {
              return cb(true);
            }
          }
        }

        cb(false, 401, 'Unauthorized');
      }
    });

    this.wss.on('connection', (ws) => {
      let sessionId = null;

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          switch (msg.type) {
            case 'create_session':
              const session = await this.sessionManager.createSession({
                adapter: msg.adapter,
                systemPrompt: msg.systemPrompt,
                allowedTools: msg.allowedTools,
                workDir: msg.workDir,
                model: msg.model,
                jsonSchema: msg.jsonSchema,  // JSON Schema for structured output (Claude only)
                // Generation parameters (Gemini only - writes to ~/.gemini/config.yaml)
                temperature: msg.temperature,
                top_p: msg.top_p,
                top_k: msg.top_k,
                max_output_tokens: msg.max_output_tokens
              });
              sessionId = session.sessionId;

              // Track this WebSocket for the session
              if (!this.wsClients.has(sessionId)) {
                this.wsClients.set(sessionId, new Set());
              }
              this.wsClients.get(sessionId).add(ws);

              ws.send(JSON.stringify({ type: 'session_created', session }));
              break;

            case 'join_session':
              sessionId = msg.sessionId;
              const existingSession = this.sessionManager.getSession(sessionId);
              if (!existingSession) {
                ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
                return;
              }

              if (!this.wsClients.has(sessionId)) {
                this.wsClients.set(sessionId, new Set());
              }
              this.wsClients.get(sessionId).add(ws);

              ws.send(JSON.stringify({ type: 'session_joined', sessionId }));
              break;

            case 'send_message':
              if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', error: 'No session. Create or join first.' }));
                return;
              }

              // Stream response
              ws.send(JSON.stringify({ type: 'thinking' }));

              try {
                for await (const chunk of this.sessionManager.sendStream(sessionId, msg.message, { timeout: msg.timeout })) {
                  // Broadcast to all clients watching this session
                  const clients = this.wsClients.get(sessionId);
                  if (clients) {
                    const chunkMsg = JSON.stringify({ type: 'chunk', chunk });
                    for (const client of clients) {
                      if (client.readyState === 1) {
                        client.send(chunkMsg);
                      }
                    }
                  }
                }

                ws.send(JSON.stringify({ type: 'complete' }));
              } catch (error) {
                ws.send(JSON.stringify({ type: 'error', error: error.message }));
              }
              break;

            case 'terminate_session':
              if (sessionId) {
                await this.sessionManager.terminateSession(sessionId);
                this.wsClients.delete(sessionId);
                ws.send(JSON.stringify({ type: 'session_terminated' }));
                sessionId = null;
              }
              break;

            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
              break;
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', error: error.message }));
        }
      });

      ws.on('close', () => {
        if (sessionId && this.wsClients.has(sessionId)) {
          this.wsClients.get(sessionId).delete(ws);
          if (this.wsClients.get(sessionId).size === 0) {
            this.wsClients.delete(sessionId);
          }
        }
      });

      ws.send(JSON.stringify({ type: 'connected', message: 'cliagents' }));
    });

    // Forward session manager events to WebSocket clients
    this.sessionManager.on('chunk', (data) => {
      const clients = this.wsClients.get(data.sessionId);
      if (clients) {
        const msg = JSON.stringify({ type: 'chunk', chunk: data.chunk });
        for (const client of clients) {
          if (client.readyState === 1) {
            client.send(msg);
          }
        }
      }
    });
  }

  /**
   * Clean up orphaned CLI processes from previous runs
   * @private
   */
  _cleanupOrphanProcesses() {
    if (!this.cleanupOrphans) {
      console.log('[Cleanup] Skipping orphan cleanup (disabled)');
      return;
    }

    console.log('[Cleanup] Checking for orphaned CLI processes...');
    let killed = 0;

    try {
      // Kill orphaned Gemini CLI processes (spawned with -p flag)
      execSync('pkill -f "gemini.*-p" 2>/dev/null || true', { stdio: 'ignore' });
      killed++;
    } catch (e) {
      // Ignore - process may not exist
    }

    try {
      // Kill orphaned Claude CLI processes (spawned with -p flag)
      execSync('pkill -f "claude -p" 2>/dev/null || true', { stdio: 'ignore' });
      killed++;
    } catch (e) {
      // Ignore - process may not exist
    }

    console.log('[Cleanup] Orphan cleanup complete');
  }

  _pruneHistoricalOrphanedTerminals() {
    const config = this.orphanedTerminalPruneConfig || {};
    if (!config.enabled) {
      console.log('[Cleanup] Skipping historical orphaned terminal prune (disabled)');
      return;
    }

    const db = this.orchestration?.db;
    if (!db || typeof db.pruneOrphanedTerminals !== 'function') {
      console.log('[Cleanup] Skipping historical orphaned terminal prune (DB unavailable)');
      return;
    }

    const olderThanHours = Number.isFinite(config.olderThanHours) && config.olderThanHours > 0
      ? Math.floor(config.olderThanHours)
      : 24;
    const limit = Number.isFinite(config.limit) && config.limit > 0
      ? Math.floor(config.limit)
      : 1000;

    try {
      const result = db.pruneOrphanedTerminals({ olderThanHours, limit });
      console.log(
        `[Cleanup] Historical orphaned terminal prune removed ${result.deletedCount} rows older than ${olderThanHours}h`
      );
    } catch (error) {
      console.warn('[Cleanup] Failed to prune historical orphaned terminals:', error.message);
    }
  }

  /**
   * Start the server
   */
  async start() {
    // Clean up orphaned CLI processes from previous runs
    this._cleanupOrphanProcesses();
    this._pruneHistoricalOrphanedTerminals();

    // Ensure insecure localhost override cannot be combined with non-loopback bind hosts.
    assertAuthConfigurationForHost(this.host);

    // Setup graceful shutdown handlers
    this._setupShutdownHandlers();

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        const address = this.server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }

        console.log(`cliagents running at http://${this.host}:${this.port}`);
        console.log(`WebSocket available at ws://${this.host}:${this.port}/ws`);
        console.log(`Chat UI available at http://${this.host}:${this.port}/`);
        console.log(`Dashboard available at http://${this.host}:${this.port}/dashboard`);
        console.log(`Live console available at http://${this.host}:${this.port}/console`);
        console.log(`Run inspector available at http://${this.host}:${this.port}/runs`);
        console.log(`OpenAI-compatible API at http://${this.host}:${this.port}/v1/chat/completions`);

        this._setupWebSocket(this.server);

        // Log registered adapters
        console.log('\nRegistered adapters:');
        for (const name of this.sessionManager.getAdapterNames()) {
          console.log(`  - ${name}`);
        }
        console.log('');

        const configuredApiKey = getConfiguredApiKey();
        const configuredApiKeySource = getConfiguredApiKeySource();
        if (configuredApiKey) {
          if (configuredApiKeySource === 'local-file') {
            console.log(`[Security] API key authentication is enabled via local broker token: ${this.localApiKey.filePath}`);
          } else {
            console.log('[Security] API key authentication is enabled.');
          }
        } else if (isUnauthenticatedLocalhostModeEnabled()) {
          console.warn('\n[SECURITY WARNING] CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1 is enabled.');
          console.warn(`Unauthenticated access is allowed only on loopback host "${this.host}" for local development.`);
          console.warn('Unset CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST and configure CLIAGENTS_API_KEY for normal use.\n');
        } else {
          console.warn('\n[SECURITY WARNING] No API key configured.');
          console.warn('Protected routes require authentication and currently fail closed (401).');
          console.warn('Set CLIAGENTS_API_KEY (or CLI_AGENTS_API_KEY) to allow authenticated clients.\n');
        }

        resolve(this.server);
      });
    });
  }

  /**
   * Setup graceful shutdown signal handlers
   */
  _setupShutdownHandlers() {
    let isShuttingDown = false;

    const shutdown = async (signal) => {
      if (isShuttingDown) {
        console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
        return;
      }
      isShuttingDown = true;

      console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

      // Set a timeout to force exit if graceful shutdown takes too long
      const forceExitTimeout = setTimeout(() => {
        console.error('[Shutdown] Forced exit after timeout');
        process.exit(1);
      }, 10000); // 10 second timeout

      try {
        await this.stop();
        clearTimeout(forceExitTimeout);
        console.log('[Shutdown] Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('[Shutdown] Error during shutdown:', error);
        clearTimeout(forceExitTimeout);
        process.exit(1);
      }
    };

    // Handle termination signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('[Fatal] Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Fatal] Unhandled rejection at:', promise, 'reason:', reason);
      // Don't shutdown for unhandled rejections, just log them
    });
  }

  /**
   * Stop the server
   */
  async stop() {
    this._stopRunLedgerSweep();
    if (this.orchestration?.memoryMaintenance && typeof this.orchestration.memoryMaintenance.stop === 'function') {
      this.orchestration.memoryMaintenance.stop();
    }
    resetMemoryMaintenanceService();
    resetMemorySnapshotService();

    // Stop orchestration background loops first (prevents hanging process on tests/shutdown)
    if (this.orchestration?.inboxService && typeof this.orchestration.inboxService.stop === 'function') {
      this.orchestration.inboxService.stop();
    }

    // Best-effort teardown of orchestration tmux terminals
    if (this.orchestration?.sessionManager && typeof this.orchestration.sessionManager.destroyAllTerminals === 'function') {
      try {
        await this.orchestration.sessionManager.destroyAllTerminals({
          preserveManagedRoots: !this.destroyOrchestrationTerminalsOnStop
        });
      } catch (error) {
        console.warn('[Shutdown] Failed to destroy orchestration terminals:', error.message);
      }
    }

    // Close all WebSocket connections and server
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.close();
        } catch {}
      }

      await new Promise((resolve) => this.wss.close(resolve));
      this.wss = null;
      this.wsClients.clear();
    }

    // Kill all active CLI processes in adapters
    console.log('[Shutdown] Killing active CLI processes...');
    for (const name of this.sessionManager.getAdapterNames()) {
      const adapter = this.sessionManager.getAdapter(name);
      if (typeof adapter.killAllProcesses === 'function') {
        adapter.killAllProcesses();
      }
    }

    // Shutdown session manager
    await this.sessionManager.shutdown();

    if (this.orchestration?.db) {
      closeDB();
    }

    // Close HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Get the session manager (for programmatic access)
   */
  getSessionManager() {
    return this.sessionManager;
  }

  /**
   * Register additional adapter
   */
  registerAdapter(name, adapter) {
    this.sessionManager.registerAdapter(name, adapter);
    return this;
  }
}

module.exports = AgentServer;
