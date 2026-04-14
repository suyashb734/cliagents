/**
 * PersistentSessionManager - Manages persistent CLI sessions via tmux
 *
 * This manager creates long-running tmux sessions for CLI agents,
 * enabling multi-agent orchestration with message passing and status tracking.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const TmuxClient = require('./client');
const { MANAGED_ROOT_ADAPTERS } = require('../adapters/active-surface');
const GeminiCliAdapter = require('../adapters/gemini-cli');
const { extractOutput, stripAnsiCodes } = require('../utils/output-extractor');

const inferGeminiBrokerDefaultModel = GeminiCliAdapter.inferGeminiBrokerDefaultModel;

function parseSessionMetadata(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return rawValue || null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

/**
 * SECURITY: Escape a string for use in shell double quotes
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeForDoubleQuotes(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\\/g, '\\\\')     // Backslashes first
    .replace(/"/g, '\\"')       // Double quotes
    .replace(/\$/g, '\\$')      // Dollar signs (variable expansion)
    .replace(/`/g, '\\`')       // Backticks (command substitution)
    .replace(/!/g, '\\!')       // History expansion
    .replace(/\n/g, '\\n')      // Newlines
    .replace(/\r/g, '\\r');     // Carriage returns
}

/**
 * SECURITY: Validate a path doesn't contain dangerous characters
 * @param {string} pathStr - Path to validate
 * @returns {boolean} - Whether the path is safe
 */
function isPathSafe(pathStr) {
  if (typeof pathStr !== 'string') return false;
  // Disallow command substitution, shell metacharacters
  const dangerousPatterns = [
    /\$\(/,       // Command substitution $(...)
    /`/,          // Backtick substitution
    /;/,          // Command separator
    /\|/,         // Pipe
    /&/,          // Background/AND
    /\n/,         // Newlines
    /\r/,         // Carriage returns
    /\0/,         // Null bytes
  ];
  return !dangerousPatterns.some(pattern => pattern.test(pathStr));
}

/**
 * Generate a 32-character terminal ID (128-bit entropy)
 */
function generateTerminalId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a short run identifier for tracked one-shot orchestration commands.
 */
function generateRunId() {
  return crypto.randomBytes(8).toString('hex');
}

function hashSessionShape(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

/**
 * Terminal status enum
 */
const TerminalStatus = {
  IDLE: 'idle',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  WAITING_PERMISSION: 'waiting_permission',
  WAITING_USER_ANSWER: 'waiting_user_answer',
  ERROR: 'error'
};

const SUPPORTED_ORCHESTRATION_ADAPTERS = new Set(MANAGED_ROOT_ADAPTERS);

function resolveGeminiCommandModel(model) {
  if (model && model !== 'default') {
    return model;
  }
  return inferGeminiBrokerDefaultModel() || null;
}

function buildGeminiOneShotRunnerCommand(message, terminal) {
  const runnerPath = path.join(__dirname, '../scripts/run-gemini-oneshot.js');
  const workDir = terminal.workDir || process.cwd();
  const resolvedModel = resolveGeminiCommandModel(terminal.model);

  const args = [
    `"${escapeForDoubleQuotes(process.execPath)}"`,
    `"${escapeForDoubleQuotes(runnerPath)}"`,
    '--message',
    `"${escapeForDoubleQuotes(message)}"`,
    '--workdir',
    `"${escapeForDoubleQuotes(workDir)}"`
  ];

  if (resolvedModel) {
    args.push('--model', `"${escapeForDoubleQuotes(resolvedModel)}"`);
  }

  return args.join(' ');
}

/**
 * CLI command builders for each adapter
 */
const CLI_COMMANDS = {
  'claude-code': (options = {}) => {
    const args = ['claude'];

    // Permission mode: plan, default, acceptEdits, bypassPermissions, interceptor, etc.
    // 'plan' mode creates plans without executing (read-only)
    // 'interceptor' mode: don't skip permissions, let PermissionInterceptor handle prompts
    if (options.permissionMode) {
      const validModes = ['plan', 'default', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk'];
      if (validModes.includes(options.permissionMode)) {
        args.push('--permission-mode', options.permissionMode);
      } else if (options.permissionMode === 'interceptor') {
        // Interceptor mode: use 'default' permission mode so prompts appear
        args.push('--permission-mode', 'default');
      }
    } else if (options.dangerouslySkipPermissions !== false) {
      // Default: skip permission prompts for non-interactive use
      args.push('--dangerously-skip-permissions');
    }

    // Print output as JSON for parsing
    args.push('--output-format', 'stream-json');

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    // System prompt (if any - initial conversation prompt)
    // SECURITY: Properly escape all shell metacharacters
    if (options.systemPrompt) {
      const escapedPrompt = escapeForDoubleQuotes(options.systemPrompt);
      args.push('--system-prompt', `"${escapedPrompt}"`);
    }

    // Allowed tools restriction
    if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    return args.join(' ');
  },

  'gemini-cli': (options = {}) => {
    // For orchestration contexts (handoff/delegation), Gemini interactive mode shows
    // "untrusted folder" banners that block automation. Solution: don't start interactive
    // Gemini at all. Instead, print a ready marker and handle -p invocations in sendInput().
    const isOrchestration = options.role === 'worker' || options.orchestration;

    if (isOrchestration) {
      // Orchestration mode: don't start interactive CLI
      // Just echo a ready marker so waitForStatus(IDLE) succeeds
      // Actual gemini -p commands will be run per-message in sendInput()
      return 'echo "GEMINI_READY_FOR_ORCHESTRATION"';
    }

    // User-facing session: normal interactive mode
    const args = ['gemini'];

    // Permission mode handling:
    // - 'auto' (default) or 'bypassPermissions': Use yolo mode (auto-approve all)
    // - 'default' or 'interceptor': Don't use yolo mode (will prompt for confirmations)
    // - Other modes: Gemini doesn't support fine-grained modes, fall back to yolo
    // NOTE: Gemini CLI doesn't have --allowedTools or read-only mode like Claude
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode === 'default') {
      // Don't add yolo mode - will prompt for confirmations
    } else if (options.yoloMode !== false) {
      // 'auto', 'interceptor', 'bypassPermissions' all use yolo for Gemini
      // (PermissionInterceptor only works for Claude Code, not Gemini)
      args.push('--approval-mode', 'yolo');
    }

    const resolvedModel = resolveGeminiCommandModel(options.model);
    if (resolvedModel) {
      args.push('-m', resolvedModel);
    }

    return args.join(' ');
  },

  'codex-cli': (options = {}) => {
    // For orchestration contexts (handoff/delegation), Codex interactive mode can show
    // pre-filled prompts and conversational "What would you like me to do?" responses
    // that get detected as WAITING_USER_ANSWER, blocking automation.
    // Solution: don't start interactive Codex at all. Use non-interactive `codex exec` instead.
    const isOrchestration = options.role === 'worker' || options.orchestration;

    if (isOrchestration) {
      // Orchestration mode: don't start interactive CLI
      // Just echo a ready marker so waitForStatus(IDLE) succeeds
      // Actual codex exec commands will be run per-message in sendInput()
      return 'echo "CODEX_READY_FOR_ORCHESTRATION"';
    }

    // User-facing session: normal interactive mode
    // Prefix with CI=true to skip interactive prompts like update checks
    // Then use interactive mode with bypass flag for full automation
    const args = ['CI=true', 'codex'];

    // Permission mode handling:
    // - 'auto' (default) or 'bypassPermissions': Use bypass mode (auto-approve all)
    // - 'default' or 'interceptor': Don't use bypass mode (will prompt for confirmations)
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode === 'default') {
      // Don't add bypass flag - will prompt for confirmations
    } else {
      // 'auto', 'interceptor', 'bypassPermissions' all use bypass for Codex
      // (PermissionInterceptor only works for Claude Code, not Codex)
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    return args.join(' ');
  },

  'qwen-cli': (options = {}) => {
    // For orchestration contexts, run one-shot qwen commands per message
    // instead of keeping an interactive shell open.
    const isOrchestration = options.role === 'worker' || options.orchestration;

    if (isOrchestration) {
      return 'echo "QWEN_READY_FOR_ORCHESTRATION"';
    }

    const args = ['qwen'];

    // Permission handling: default to yolo for automation unless explicitly default mode.
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode !== 'default') {
      args.push('-y');
    }

    if (options.model) {
      args.push('-m', options.model);
    }

    return args.join(' ');
  },

  'opencode-cli': (options = {}) => {
    const isOrchestration = options.role === 'worker' || options.orchestration;
    if (isOrchestration) {
      return 'echo "OPENCODE_READY_FOR_ORCHESTRATION"';
    }

    const args = ['opencode'];
    if (options.model) {
      args.push('--model', options.model);
    }
    return args.join(' ');
  }
};

class PersistentSessionManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.db - Database instance (optional, for Phase 3)
   * @param {TmuxClient} options.tmuxClient - TmuxClient instance (optional)
   * @param {string} options.logDir - Directory for log files
   * @param {string} options.workDir - Default working directory
   */
  constructor(options = {}) {
    super();

    this.db = options.db || null;
    this.tmux = options.tmuxClient || new TmuxClient({
      logDir: options.logDir || path.join(process.cwd(), 'logs')
    });
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.workDir = options.workDir || process.cwd();

    // In-memory terminal registry
    this.terminals = new Map();

    // Status detectors (will be populated in Phase 2)
    this.statusDetectors = new Map();
    this.sessionGraphWritesEnabled = options.sessionGraphWritesEnabled ?? process.env.SESSION_GRAPH_WRITES_ENABLED === '1';
    this.sessionEventsEnabled = options.sessionEventsEnabled ?? process.env.SESSION_EVENTS_ENABLED === '1';
    this.shellCommands = new Set(['bash', 'sh', 'zsh', 'fish']);
    this.reuseReservationTtlMs = Math.max(Number(options.reuseReservationTtlMs || 60000), 1000);

    // Ensure directories exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Recover terminals from database on startup
    this._recoverFromDatabase();
  }

  /**
   * Recover terminals from database that still have active tmux sessions
   * This handles Node.js restarts while tmux sessions persist
   */
  _recoverFromDatabase() {
    if (!this.db) {
      return;
    }

    try {
      const dbTerminals = this.db.listTerminals ? this.db.listTerminals() : [];
      const activeSessions = this.tmux.listSessions('cliagents-');
      const activeSessionNames = new Set(activeSessions.map(s => s.name));

      let recovered = 0;
      let orphaned = 0;

      for (const dbTerminal of dbTerminals) {
        const terminalId = dbTerminal.terminalId || dbTerminal.terminal_id;
        const sessionName = dbTerminal.sessionName || dbTerminal.session_name;
        const windowName = dbTerminal.windowName || dbTerminal.window_name;
        const adapter = dbTerminal.adapter;
        const agentProfile = dbTerminal.agentProfile || dbTerminal.agent_profile;
        const role = dbTerminal.role || 'worker';
        const workDir = dbTerminal.workDir || dbTerminal.work_dir || this.workDir;
        const createdAt = dbTerminal.createdAt || dbTerminal.created_at;
        const lastActive = dbTerminal.lastActive || dbTerminal.last_active || createdAt;
        const rootSessionId = dbTerminal.rootSessionId || dbTerminal.root_session_id || terminalId;
        const parentSessionId = dbTerminal.parentSessionId || dbTerminal.parent_session_id || null;
        const sessionKind = dbTerminal.sessionKind || dbTerminal.session_kind || 'legacy';
        const originClient = dbTerminal.originClient || dbTerminal.origin_client || 'legacy';
        const externalSessionRef = dbTerminal.externalSessionRef || dbTerminal.external_session_ref || null;
        const lineageDepth = Number.isInteger(dbTerminal.lineageDepth)
          ? dbTerminal.lineageDepth
          : (Number.isInteger(dbTerminal.lineage_depth) ? dbTerminal.lineage_depth : 0);
        const sessionMetadata = parseSessionMetadata(dbTerminal.sessionMetadata || dbTerminal.session_metadata);

        if (!terminalId || !sessionName || !windowName || !adapter) {
          continue;
        }

        if (dbTerminal.status === 'orphaned' && !activeSessionNames.has(sessionName)) {
          continue;
        }

        // Check if tmux session still exists
        if (activeSessionNames.has(sessionName)) {
          // Recover this terminal into memory
          const recoveredTerminal = {
            terminalId,
            sessionName,
            windowName,
            adapter,
            agentProfile,
            role,
            workDir,
            logPath: path.join(this.logDir, `${terminalId}.log`),
            status: TerminalStatus.IDLE,
            createdAt: new Date(createdAt),
            lastActive: new Date(lastActive),
            activeRun: null,
            rootSessionId,
            parentSessionId,
            sessionKind,
            originClient,
            externalSessionRef,
            lineageDepth,
            sessionMetadata,
            recovered: true
          };
          this._attachReuseInternals(recoveredTerminal, this._buildReuseContext({
            adapter: recoveredTerminal.adapter,
            agentProfile: recoveredTerminal.agentProfile,
            role: recoveredTerminal.role,
            workDir: recoveredTerminal.workDir,
            model: recoveredTerminal.model || null,
            allowedTools: recoveredTerminal.allowedTools || null,
            permissionMode: recoveredTerminal.permissionMode || 'auto',
            rootSessionId: recoveredTerminal.rootSessionId,
            parentSessionId: recoveredTerminal.parentSessionId,
            sessionKind: recoveredTerminal.sessionKind
          }));
          this.terminals.set(terminalId, recoveredTerminal);
          recovered++;
        } else {
          // Session no longer exists, mark as orphaned in DB
          if (this.db.updateStatus) {
            this.db.updateStatus(terminalId, 'orphaned');
          }
          this._recordSessionTerminated({
            terminalId,
            adapter,
            activeRun: null,
            rootSessionId,
            parentSessionId,
            originClient,
            sessionMetadata
          }, 'orphaned');
          orphaned++;
        }
      }

      if (recovered > 0 || orphaned > 0) {
        console.log(`[SessionManager] Startup recovery: ${recovered} terminals recovered, ${orphaned} orphaned`);
      }
    } catch (error) {
      console.error('[SessionManager] Failed to recover terminals:', error.message);
    }
  }

  /**
   * Register a status detector for an adapter
   * @param {string} adapter - Adapter name
   * @param {Object} detector - Status detector instance
   */
  registerStatusDetector(adapter, detector) {
    this.statusDetectors.set(adapter, detector);
  }

  /**
   * Return the last non-empty line from captured terminal output.
   * @param {string} output
   * @returns {string}
   */
  _getLastNonEmptyLine(output) {
    const lines = String(output || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : '';
  }

  _isShellLikeCommand(command) {
    return !!command && this.shellCommands.has(String(command).trim());
  }

  _buildSessionEventIdempotencyKey(rootSessionId, sessionId, eventType, stableStepKey) {
    return `${rootSessionId}:${sessionId}:${eventType}:${stableStepKey}`;
  }

  _recordSessionEvent(event) {
    if (!this.sessionEventsEnabled || !this.db?.addSessionEvent) {
      return null;
    }

    try {
      return this.db.addSessionEvent(event);
    } catch (error) {
      console.warn('[SessionManager] Failed to record session event:', error.message);
      return null;
    }
  }

  _ensureImplicitRootAttach(terminal) {
    if (!terminal || !this.sessionEventsEnabled || !terminal.rootSessionId) {
      return null;
    }

    if (terminal.rootSessionId === terminal.terminalId || !terminal.parentSessionId) {
      return null;
    }

    if (typeof this.db?.listSessionEvents === 'function') {
      try {
        const existingRootEvents = this.db.listSessionEvents({
          rootSessionId: terminal.rootSessionId,
          limit: 25
        });
        const hasRootAttach = existingRootEvents.some((event) => (
          event.session_id === terminal.rootSessionId
          && event.event_type === 'session_started'
        ));
        if (hasRootAttach) {
          return null;
        }
      } catch (error) {
        console.warn('[SessionManager] Failed to inspect existing root-session events:', error.message);
      }
    }

    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId,
      sessionId: terminal.rootSessionId,
      parentSessionId: null,
      eventType: 'session_started',
      originClient: terminal.originClient,
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId,
        terminal.rootSessionId,
        'session_started',
        'implicit-root-attach'
      ),
      payloadSummary: `Implicit root attach via ${terminal.originClient || 'unknown'}`,
      payloadJson: {
        attachMode: 'implicit-first-use',
        externalSessionRef: terminal.externalSessionRef || null,
        sessionKind: 'attach'
      },
      metadata: terminal.sessionMetadata || null
    });
  }

  _recordSessionStarted(terminal) {
    if (!terminal) {
      return null;
    }

    this._ensureImplicitRootAttach(terminal);
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_started',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_started',
        'terminal-created'
      ),
      payloadSummary: `${terminal.adapter} session started`,
      payloadJson: {
        adapter: terminal.adapter,
        agentProfile: terminal.agentProfile || null,
        role: terminal.role || 'worker',
        model: terminal.model || null,
        workDir: terminal.workDir || null,
        sessionKind: terminal.sessionKind || 'legacy'
      },
      metadata: terminal.sessionMetadata || null
    });
  }

  _recordSessionResumed(terminal, extra = {}) {
    if (!terminal) {
      return null;
    }

    terminal._resumeCount = (terminal._resumeCount || 0) + 1;
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_resumed',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_resumed',
        `resume-${terminal._resumeCount}`
      ),
      payloadSummary: `${terminal.adapter} session resumed`,
      payloadJson: {
        adapter: terminal.adapter,
        agentProfile: terminal.agentProfile || null,
        role: terminal.role || 'worker',
        model: terminal.model || null,
        workDir: terminal.workDir || null,
        sessionKind: terminal.sessionKind || 'legacy',
        reuseReason: extra.reuseReason || 'compatible-root-session'
      },
      metadata: extra.metadata || terminal.sessionMetadata || null
    });
  }

  _recordSessionTerminated(terminal, status, extra = {}) {
    if (!terminal || !['completed', 'error', 'orphaned'].includes(status)) {
      return null;
    }

    const stableStepKey = terminal.activeRun?.runId
      ? `run-${terminal.activeRun.runId}`
      : `status-${status}`;
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: status === 'orphaned' ? 'session_stale' : 'session_terminated',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        status === 'orphaned' ? 'session_stale' : 'session_terminated',
        stableStepKey
      ),
      payloadSummary: `${terminal.adapter} session ${status}`,
      payloadJson: {
        adapter: terminal.adapter,
        status,
        exitCode: extra.exitCode ?? null,
        runId: terminal.activeRun?.runId || null
      },
      metadata: extra.metadata || null
    });
  }

  _applyStatusUpdate(terminal, nextStatus, extra = {}) {
    if (!terminal || !nextStatus || terminal.status === nextStatus) {
      return nextStatus;
    }

    terminal.status = nextStatus;
    if (this.db) {
      this.db.updateStatus(terminal.terminalId, nextStatus);
    }
    this.emit('status-change', { terminalId: terminal.terminalId, status: nextStatus });

    if ([TerminalStatus.COMPLETED, TerminalStatus.ERROR].includes(nextStatus)) {
      this._recordSessionTerminated(terminal, nextStatus, extra);
    } else if (nextStatus === 'orphaned') {
      this._recordSessionTerminated(terminal, 'orphaned', extra);
    }

    return nextStatus;
  }

  _resolveMissingSessionStatus(terminal, detector) {
    const dbTerminal = this.db?.getTerminal ? this.db.getTerminal(terminal.terminalId) : null;
    const dbStatus = dbTerminal?.status || null;
    if (dbStatus && dbStatus !== TerminalStatus.PROCESSING) {
      return dbStatus;
    }

    const trackedRunStatus = this._detectTrackedRunStatus(terminal, '', detector);
    if (trackedRunStatus && trackedRunStatus !== TerminalStatus.PROCESSING) {
      return trackedRunStatus;
    }

    return 'orphaned';
  }

  _reconcileTerminalBacking(terminal) {
    if (!terminal) {
      return null;
    }

    if (typeof this.tmux.sessionExists !== 'function') {
      return terminal;
    }

    if (this.tmux.sessionExists(terminal.sessionName)) {
      return terminal;
    }

    const detector = this.statusDetectors.get(terminal.adapter);
    const resolvedStatus = this._resolveMissingSessionStatus(terminal, detector);
    this._applyStatusUpdate(terminal, resolvedStatus, {
      exitCode: terminal.activeRun?.exitCode ?? null
    });

    if (['completed', 'error', 'orphaned'].includes(resolvedStatus)) {
      terminal.activeRun = null;
    }

    const dbTerminal = this.db?.getTerminal ? this.db.getTerminal(terminal.terminalId) : null;
    if (!dbTerminal) {
      this.terminals.delete(terminal.terminalId);
      return null;
    }

    terminal.status = dbTerminal.status || terminal.status;
    terminal.lastActive = dbTerminal.last_active ? new Date(dbTerminal.last_active) : terminal.lastActive;
    return terminal;
  }

  /**
   * Wrap a one-shot orchestration command with explicit run lifecycle markers.
   * @param {Object} terminal
   * @param {string} command
   * @returns {string}
   */
  _wrapTrackedOneShotCommand(terminal, command) {
    const runId = generateRunId();
    const startMarker = `__CLIAGENTS_RUN_START__${runId}`;
    const exitMarkerPrefix = `__CLIAGENTS_RUN_EXIT__${runId}__`;
    const baselineOutput = this.tmux.getHistory(terminal.sessionName, terminal.windowName, 500);

    terminal.activeRun = {
      runId,
      startMarker,
      exitMarkerPrefix,
      baselineOutputLength: baselineOutput.length,
      startedAt: new Date(),
      command
    };

    return `printf '\\n${startMarker}\\n'; ${command}; __cliagents_status=$?; printf '\\n${exitMarkerPrefix}%s\\n' "$__cliagents_status"`;
  }

  /**
   * Detect state for the currently tracked one-shot run, if any.
   * @param {Object} terminal
   * @param {string} output
   * @param {Object} detector
   * @returns {string|null}
   */
  _detectTrackedRunStatus(terminal, output, detector) {
    const run = terminal.activeRun;
    if (!run) {
      return null;
    }

    const tail = String(output || '').slice(run.baselineOutputLength);
    const exitPattern = new RegExp(`${run.exitMarkerPrefix}(\\d+)`);
    const exitMatch = tail.match(exitPattern);

    if (exitMatch) {
      const exitCode = Number.parseInt(exitMatch[1], 10);
      run.exitCode = exitCode;
      run.completedAt = new Date();
      return exitCode === 0 ? TerminalStatus.COMPLETED : TerminalStatus.ERROR;
    }

    const logTail = terminal.logPath ? this.readLogTail(terminal.terminalId, 12000) : '';
    const logExitMatch = logTail.match(exitPattern);
    if (logExitMatch) {
      const exitCode = Number.parseInt(logExitMatch[1], 10);
      run.exitCode = exitCode;
      run.completedAt = new Date();
      return exitCode === 0 ? TerminalStatus.COMPLETED : TerminalStatus.ERROR;
    }

    if (detector) {
      const detected = detector.detectStatus(tail);
      if (detected === TerminalStatus.WAITING_PERMISSION || detected === TerminalStatus.WAITING_USER_ANSWER) {
        return detected;
      }
      if (detected === TerminalStatus.ERROR) {
        return TerminalStatus.ERROR;
      }
    }

    const lastNonEmptyLine = this._getLastNonEmptyLine(tail);
    if (lastNonEmptyLine && /^[\w.-]+@[\w.-]+.*[#$%>]\s*$/.test(lastNonEmptyLine)) {
      return TerminalStatus.COMPLETED;
    }

    const currentCommand = this.tmux.getPaneCurrentCommand?.(terminal.sessionName, terminal.windowName);
    if (this._isShellLikeCommand(currentCommand) && logTail.includes(run.startMarker)) {
      if (run.exitCode == null) {
        run.exitCode = 0;
      }
      run.completedAt = new Date();
      return run.exitCode != null && run.exitCode !== 0
        ? TerminalStatus.ERROR
        : TerminalStatus.COMPLETED;
    }

    return TerminalStatus.PROCESSING;
  }

  _buildReuseContext(options = {}) {
    const parentSessionId = options.parentSessionId || null;
    const normalizedAllowedTools = Array.isArray(options.allowedTools)
      ? [...options.allowedTools].map((tool) => String(tool || '').trim()).filter(Boolean).sort()
      : [];

    return {
      rootSessionId: options.rootSessionId || null,
      adapter: options.adapter || 'codex-cli',
      agentProfile: options.agentProfile || null,
      role: options.role || 'worker',
      workDir: path.resolve(options.workDir || this.workDir),
      model: options.model || null,
      sessionKind: options.sessionKind || (parentSessionId ? 'subagent' : 'main'),
      permissionMode: options.permissionMode || 'auto',
      allowedTools: normalizedAllowedTools,
      systemPromptHash: hashSessionShape(options.systemPrompt || '')
    };
  }

  _buildReuseSignature(reuseContext) {
    return hashSessionShape(JSON.stringify(reuseContext || {}));
  }

  _attachReuseInternals(terminal, reuseContext) {
    Object.defineProperty(terminal, '_reuseContext', {
      value: reuseContext,
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_reuseSignature', {
      value: this._buildReuseSignature(reuseContext),
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_resumeCount', {
      value: 0,
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_reservationId', {
      value: null,
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_reservationExpiresAt', {
      value: 0,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  _reserveTerminal(terminal) {
    if (!terminal) {
      return null;
    }

    terminal._reservationId = generateRunId();
    terminal._reservationExpiresAt = Date.now() + this.reuseReservationTtlMs;
    return terminal._reservationId;
  }

  _releaseTerminalReservation(terminal) {
    if (!terminal) {
      return;
    }

    terminal._reservationId = null;
    terminal._reservationExpiresAt = 0;
  }

  _isTerminalReserved(terminal) {
    if (!terminal || !terminal._reservationId) {
      return false;
    }

    if (terminal._reservationExpiresAt > Date.now()) {
      return true;
    }

    this._releaseTerminalReservation(terminal);
    return false;
  }

  _isReusableTerminalStatus(status) {
    return status === TerminalStatus.IDLE || status === TerminalStatus.COMPLETED;
  }

  _findReusableTerminal(options = {}) {
    const preferReuse = options.preferReuse ?? !!options.rootSessionId;
    if (!preferReuse || options.forceFreshSession || !options.rootSessionId) {
      return null;
    }

    const requestedSignature = this._buildReuseSignature(this._buildReuseContext(options));
    for (const terminal of this.terminals.values()) {
      if (!terminal || terminal.rootSessionId !== options.rootSessionId) {
        continue;
      }
      if (!terminal._reuseSignature || terminal._reuseSignature !== requestedSignature) {
        continue;
      }
      if (this._isTerminalReserved(terminal)) {
        continue;
      }

      const currentStatus = this.getStatus(terminal.terminalId);
      if (!this._isReusableTerminalStatus(currentStatus)) {
        continue;
      }

      return terminal;
    }

    return null;
  }

  _buildTerminalResponse(terminal, extra = {}) {
    return {
      terminalId: terminal.terminalId,
      sessionName: terminal.sessionName,
      windowName: terminal.windowName,
      adapter: terminal.adapter,
      agentProfile: terminal.agentProfile,
      role: terminal.role,
      rootSessionId: terminal.rootSessionId,
      parentSessionId: terminal.parentSessionId,
      sessionKind: terminal.sessionKind,
      originClient: terminal.originClient,
      externalSessionRef: terminal.externalSessionRef,
      logPath: terminal.logPath,
      status: this.getStatus(terminal.terminalId),
      reused: false,
      reuseReason: null,
      ...extra
    };
  }

  _reuseTerminal(terminal, options = {}) {
    terminal.lastActive = new Date();
    this._reserveTerminal(terminal);
    if (this.db) {
      this.db.updateStatus(terminal.terminalId, terminal.status || TerminalStatus.IDLE);
    }

    const reuseReason = options.reuseReason || 'matching-root-session-shape';
    this._recordSessionResumed(terminal, {
      reuseReason,
      metadata: options.sessionMetadata || terminal.sessionMetadata || null
    });
    this.emit('terminal-reused', {
      terminalId: terminal.terminalId,
      adapter: terminal.adapter,
      rootSessionId: terminal.rootSessionId,
      reuseReason
    });

    return this._buildTerminalResponse(terminal, {
      reused: true,
      reuseReason
    });
  }

  /**
   * Create a new persistent terminal
   * @param {Object} options
   * @param {string} options.adapter - Adapter name (gemini-cli, codex-cli, qwen-cli)
   * @param {string} options.agentProfile - Agent profile name (optional)
   * @param {string} options.role - Role (supervisor, worker)
   * @param {string} options.workDir - Working directory
   * @param {string} options.systemPrompt - System prompt
   * @param {string} options.model - Model to use
   * @param {Array<string>} options.allowedTools - Allowed tools list
   * @param {string} options.permissionMode - Permission mode ('auto'|'plan'|'default'|'acceptEdits'|'bypassPermissions'|'delegate'|'dontAsk')
   *   - 'auto' (default): Skip permissions for automated orchestration
   *   - 'plan': Read-only mode, creates plans without executing
   *   - 'default': Use CLI's default permission behavior
   *   - 'bypassPermissions': Skip all permission prompts
   *   - Others: Pass through to CLI
   * @returns {Promise<Object>} - Terminal info
   */
  async createTerminal(options = {}) {
    const {
      adapter = 'codex-cli',
      agentProfile = null,
      role = 'worker',
      workDir = this.workDir,
      systemPrompt = null,
      model = null,
      allowedTools = null,
      // Permission mode support (Gap #4 resolution)
      // Modes: 'plan', 'default', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk', 'auto'
      // 'auto' (default) = skip permissions for automated use
      permissionMode = 'auto',
      rootSessionId = null,
      parentSessionId = null,
      sessionKind = null,
      originClient = null,
      externalSessionRef = null,
      lineageDepth = null,
      sessionMetadata = null,
      preferReuse = undefined,
      forceFreshSession = false
    } = options;

    const controlPlaneEnabled = this.sessionGraphWritesEnabled && (
      !!rootSessionId ||
      !!parentSessionId ||
      !!sessionKind ||
      !!originClient ||
      !!externalSessionRef ||
      sessionMetadata != null
    );

    // Validate adapter
    if (!CLI_COMMANDS[adapter]) {
      throw new Error(`Unknown adapter: ${adapter}. Supported: ${Array.from(SUPPORTED_ORCHESTRATION_ADAPTERS).join(', ')}`);
    }

    if (!SUPPORTED_ORCHESTRATION_ADAPTERS.has(adapter)) {
      throw new Error(`Unsupported adapter: ${adapter}. Managed terminal surface only supports: ${Array.from(SUPPORTED_ORCHESTRATION_ADAPTERS).join(', ')}`);
    }

    // SECURITY: Validate agentProfile if provided (used in window name)
    if (agentProfile) {
      const SAFE_PROFILE_PATTERN = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_PROFILE_PATTERN.test(agentProfile) || agentProfile.length > 30) {
        throw new Error('Invalid agent profile: only alphanumeric, dash, underscore allowed (max 30 chars)');
      }
    }

    // SECURITY: Validate model name if provided (used as CLI argument)
    if (model) {
      const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;
      if (!SAFE_MODEL_PATTERN.test(model) || model.length > 100) {
        throw new Error('Invalid model name: only alphanumeric, dot, dash, underscore allowed (max 100 chars)');
      }
    }

    // SECURITY: Validate allowedTools if provided (used as CLI arguments)
    if (allowedTools && Array.isArray(allowedTools)) {
      const SAFE_TOOL_PATTERN = /^[a-zA-Z0-9_-]+$/;
      for (const tool of allowedTools) {
        if (!SAFE_TOOL_PATTERN.test(tool) || tool.length > 50) {
          throw new Error(`Invalid tool name: "${tool}". Only alphanumeric, dash, underscore allowed (max 50 chars)`);
        }
      }
    }

    const reusableTerminal = this._findReusableTerminal({
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
      preferReuse,
      forceFreshSession
    });
    if (reusableTerminal) {
      return this._reuseTerminal(reusableTerminal, {
        reuseReason: 'matching-root-session-shape',
        sessionMetadata
      });
    }

    // Generate IDs
    const terminalId = generateTerminalId();
    const sessionName = `cliagents-${terminalId.slice(0, 6)}`;
    // Truncate prefix to ensure window name stays under 50-char tmux limit
    // Format: prefix (max 23 chars) + dash + terminalId suffix (26 chars) = max 50
    const windowPrefix = (agentProfile || adapter).slice(0, 23);
    const windowName = `${windowPrefix}-${terminalId.slice(6)}`;

    // SECURITY: Validate working directory path
    if (!isPathSafe(workDir)) {
      throw new Error('Invalid working directory: contains dangerous characters');
    }

    // SECURITY: Reject system paths for workDir
    const resolvedWorkDir = path.resolve(workDir);
    const systemPaths = [
      '/etc',
      '/System',
      '/usr',
      '/var',
      '/root',
      '/bin',
      '/sbin',
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.aws'),
      path.join(os.homedir(), '.gnupg'),
      path.join(os.homedir(), '.config')
    ];
    for (const sysPath of systemPaths) {
      if (resolvedWorkDir === sysPath || resolvedWorkDir.startsWith(sysPath + path.sep)) {
        throw new Error(`Invalid working directory: System path ${sysPath} is not allowed`);
      }
    }

    // Ensure working directory exists
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Create tmux session with NO_COLOR to suppress ANSI codes in output
    // Many modern CLIs respect NO_COLOR (https://no-color.org/)
    this.tmux.createSession(sessionName, windowName, terminalId, {
      workingDir: workDir,
      env: { NO_COLOR: '1' }
    });

    // Set up logging
    const logPath = path.join(this.logDir, `${terminalId}.log`);
    this.tmux.pipePaneToFile(sessionName, windowName, logPath);

    // Build and execute CLI command
    // Permission mode handling (Gap #4 resolution):
    // - 'auto' (default) or null/undefined: skip permissions for automated orchestration
    // - Other modes: pass through to CLI (e.g., 'plan', 'default', 'bypassPermissions')
    // Treat null/undefined as 'auto' for backwards compatibility
    const effectivePermissionMode = permissionMode || 'auto';
    const cliCommand = CLI_COMMANDS[adapter]({
      role,              // CRITICAL: needed for orchestration mode detection
      systemPrompt,
      model,
      allowedTools,
      // Pass permissionMode if not 'auto', otherwise use legacy skip behavior
      permissionMode: effectivePermissionMode !== 'auto' ? effectivePermissionMode : null,
      dangerouslySkipPermissions: effectivePermissionMode === 'auto',
      yoloMode: true,
      autoApprove: true
    });

    // Wait for shell initialization before sending command
    // Some shells (like zsh) take time to initialize, source config files, and set up prompts
    // 8000ms is needed for zsh with oh-my-zsh plugins, Java version check, and other init scripts
    // (6000ms was still too short - tested empirically that 8s is reliable)
    await new Promise(resolve => setTimeout(resolve, 8000));

    // Start CLI directly (working directory already set via -c in createSession)
    // NOTE: Using "cd && command" causes some CLIs (like gemini) to exit immediately
    // because they don't work well as part of a shell command chain
    this.tmux.sendKeys(sessionName, windowName, cliCommand, true);

    // Store terminal info
    const terminal = {
      terminalId,
      sessionName,
      windowName,
      adapter,
      agentProfile,
      role,
      workDir,
      model,
      logPath,
      status: TerminalStatus.IDLE,
      createdAt: new Date(),
      lastActive: new Date(),
      activeRun: null,
      rootSessionId: controlPlaneEnabled ? (rootSessionId || terminalId) : terminalId,
      parentSessionId: controlPlaneEnabled ? (parentSessionId || null) : null,
      sessionKind: controlPlaneEnabled ? (sessionKind || (parentSessionId ? 'subagent' : 'main')) : 'legacy',
      originClient: controlPlaneEnabled ? (originClient || 'system') : 'legacy',
      externalSessionRef: controlPlaneEnabled ? (externalSessionRef || null) : null,
      lineageDepth: Number.isInteger(lineageDepth)
        ? lineageDepth
        : (controlPlaneEnabled && parentSessionId ? 1 : 0),
      sessionMetadata: sessionMetadata || null
    };

    this._attachReuseInternals(terminal, this._buildReuseContext({
      adapter,
      agentProfile,
      role,
      workDir,
      systemPrompt,
      model,
      allowedTools,
      permissionMode: effectivePermissionMode,
      rootSessionId: terminal.rootSessionId,
      parentSessionId: terminal.parentSessionId,
      sessionKind: terminal.sessionKind
    }));
    this._reserveTerminal(terminal);

    this.terminals.set(terminalId, terminal);

    // Register in database if available (include workDir and logPath)
    if (this.db) {
      this.db.registerTerminal(
        terminalId,
        sessionName,
        windowName,
        adapter,
        agentProfile,
        role,
        workDir,
        logPath,
        {
          rootSessionId: terminal.rootSessionId,
          parentSessionId: terminal.parentSessionId,
          sessionKind: terminal.sessionKind,
          originClient: terminal.originClient,
          externalSessionRef: terminal.externalSessionRef,
          lineageDepth: terminal.lineageDepth,
          sessionMetadata: terminal.sessionMetadata
        }
      );
    }

    this._recordSessionStarted(terminal);

    // Emit creation event
    this.emit('terminal-created', { terminalId, adapter, role });

    // Auto-dismiss Gemini's trust prompts if they appear (user-facing sessions only)
    // For orchestration terminals, we use -p mode which bypasses these prompts entirely
    // Old format: "Do you trust this folder? [1] Yes [2] No" (Enter accepts pre-selected option 1)
    if (adapter === 'gemini-cli' && role !== 'worker') {
      // Give Gemini a moment to show the trust prompt (appears within first few seconds)
      await new Promise(resolve => setTimeout(resolve, 5000));
      const earlyOutput = this.tmux.getHistory(sessionName, windowName, 1000);
      if (earlyOutput && (earlyOutput.includes('Do you trust') || earlyOutput.includes('Trust folder'))) {
        console.log(`[SessionManager] Gemini trust prompt detected for ${terminalId}, auto-trusting...`);
        this.tmux.sendKeys(sessionName, windowName, '', true); // Press Enter to accept pre-selected option
      }
    }

    // Wait for CLI to become ready
    // Use 60s timeout since CLIs can take a while to initialize (loading plugins, MCP servers, etc.)
    // For orchestration terminals using echo markers, this should be instant
    try {
      await this.waitForStatus(terminalId, TerminalStatus.IDLE, 60000);
    } catch (error) {
      // If user-facing Gemini still stuck on trust prompt, try dismissing again
      if (adapter === 'gemini-cli' && role !== 'worker') {
        const output = this.tmux.getHistory(sessionName, windowName, 1000);
        if (output && (output.includes('Do you trust') || output.includes('Trust folder'))) {
          console.log(`[SessionManager] Retrying Gemini trust prompt dismiss for ${terminalId}`);
          this.tmux.sendKeys(sessionName, windowName, '', true);
          try {
            await this.waitForStatus(terminalId, TerminalStatus.IDLE, 30000);
          } catch (retryError) {
            console.warn(`Terminal ${terminalId} may not be fully ready:`, retryError.message);
          }
        } else {
          console.warn(`Terminal ${terminalId} may not be fully ready:`, error.message);
        }
      } else {
        console.warn(`Terminal ${terminalId} may not be fully ready:`, error.message);
      }
    }

    return this._buildTerminalResponse(terminal);
  }

  /**
   * Recover existing sessions from tmux
   * @returns {Promise<number>} - Number of sessions recovered
   */
  async recoverSessions() {
    const sessions = this.tmux.listSessions('cliagents-');
    let recoveredCount = 0;

    for (const session of sessions) {
      const sessionName = session.name;
      const windows = this.tmux.listWindows(sessionName);
      if (windows.length === 0) continue;
      
      // We assume one window per session for this agent
      const windowName = windows[0].name;

      const envOutput = this.tmux._exec(
        ['show-environment', '-t', sessionName, 'CLIAGENTS_TERMINAL_ID'],
        { ignoreErrors: true, silent: true }
      );
      const envMatch = envOutput ? envOutput.match(/CLIAGENTS_TERMINAL_ID=([^\n]+)/) : null;
      const terminalId = envMatch ? envMatch[1].trim() : null;

      if (!terminalId || terminalId.length !== 32) {
        console.warn(`Skipping session ${sessionName}: Missing CLIAGENTS_TERMINAL_ID`);
        continue;
      }

      const suffix = terminalId.slice(6);
      let prefix = windowName;
      if (windowName.endsWith(`-${suffix}`)) {
        prefix = windowName.slice(0, -(suffix.length + 1));
      } else if (windowName.includes('-')) {
        prefix = windowName.split('-')[0];
      }
      
      const workDir = this.tmux.getPaneDirectory(sessionName, windowName) || this.workDir;
      const logPath = path.join(this.logDir, `${terminalId}.log`);
      
      // Attempt to guess adapter from prefix
      let adapter = prefix; 
      let agentProfile = null;
      
      // If the prefix matches a known adapter, assume it is one.
      if (CLI_COMMANDS[prefix]) {
         adapter = prefix;
      } else {
         // Assume it's a profile and fall back to the default supported coding adapter.
         agentProfile = prefix;
         adapter = 'codex-cli'; // Fallback
      }

      const terminal = {
        terminalId,
        sessionName,
        windowName,
        adapter,
        agentProfile,
        role: 'worker', // Default
        workDir,
        logPath,
        status: TerminalStatus.IDLE, // Reset to IDLE on recovery
        createdAt: session.created,
        lastActive: new Date(),
        activeRun: null
      };
      this._attachReuseInternals(terminal, this._buildReuseContext({
        adapter: terminal.adapter,
        agentProfile: terminal.agentProfile,
        role: terminal.role,
        workDir: terminal.workDir,
        model: terminal.model || null,
        allowedTools: terminal.allowedTools || null,
        permissionMode: terminal.permissionMode || 'auto',
        rootSessionId: terminal.rootSessionId || null,
        parentSessionId: terminal.parentSessionId || null,
        sessionKind: terminal.sessionKind || 'legacy'
      }));
      this.terminals.set(terminalId, terminal);
      recoveredCount++;
    }
    
    return recoveredCount;
  }

  /**
   * Send input to a terminal
   * @param {string} terminalId - Terminal ID
   * @param {string} message - Message to send
   * @param {Object} options - Additional options
   * @param {string} options.traceId - Trace ID for multi-agent workflows
   * @param {Object} options.metadata - Additional metadata
   */
  async sendInput(terminalId, message, options = {}) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    this._releaseTerminalReservation(terminal);

    // For orchestration terminals, use non-interactive mode to avoid blocking prompts
    const isGeminiOrchestration = terminal.adapter === 'gemini-cli' && terminal.role === 'worker';
    const isCodexOrchestration = terminal.adapter === 'codex-cli' && terminal.role === 'worker';
    const isQwenOrchestration = terminal.adapter === 'qwen-cli' && terminal.role === 'worker';
    const isOpencodeOrchestration = terminal.adapter === 'opencode-cli' && terminal.role === 'worker';

    if (isGeminiOrchestration) {
      // Run Gemini one-shot work through the helper so tmux workers get the same
      // model fallback behavior as the direct-session adapter path.
      const geminiCommand = buildGeminiOneShotRunnerCommand(message, terminal);

      // Send the tracked one-shot command
      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, geminiCommand),
        true
      );
    } else if (isCodexOrchestration) {
      // Build codex exec command with proper escaping
      // Use CI=true to skip update prompts even in non-interactive mode
      const escapedMessage = message.replace(/'/g, "'\\''"); // Escape single quotes for shell
      const codexCommand = `CI=true codex exec --dangerously-bypass-approvals-and-sandbox '${escapedMessage}'`;

      // Send the tracked one-shot command
      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, codexCommand),
        true
      );
    } else if (isQwenOrchestration) {
      // Build qwen one-shot command with proper escaping
      const escapedMessage = message.replace(/'/g, "'\\''");
      const qwenCommand = `qwen -p '${escapedMessage}' -o stream-json -y`;

      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, qwenCommand),
        true
      );
    } else if (isOpencodeOrchestration) {
      const escapedMessage = message.replace(/'/g, "'\\''");
      const modelArg = terminal.model ? ` --model ${terminal.model}` : '';
      const opencodeCommand = `opencode run '${escapedMessage}' --format json --dangerously-skip-permissions${modelArg}`;

      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, opencodeCommand),
        true
      );
    } else {
      // Normal interactive mode: just send the message
      terminal.activeRun = null;
      this.tmux.sendKeys(terminal.sessionName, terminal.windowName, message, true);
    }

    // Update status
    terminal.status = TerminalStatus.PROCESSING;
    terminal.lastActive = new Date();

    if (this.db) {
      this.db.updateStatus(terminalId, TerminalStatus.PROCESSING);

      // Store input message in conversation history
      this.db.addMessage(terminalId, 'user', message, {
        traceId: options.traceId || null,
        metadata: {
          agentProfile: terminal.agentProfile,
          adapter: terminal.adapter,
          ...options.metadata
        }
      });
    }

    this.emit('input-sent', { terminalId, message });
  }

  /**
   * Send a special key to a terminal
   * @param {string} terminalId - Terminal ID
   * @param {string} key - Key to send (Enter, Tab, C-c, etc.)
   */
  sendSpecialKey(terminalId, key) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    this.tmux.sendSpecialKey(terminal.sessionName, terminal.windowName, key);
    terminal.lastActive = new Date();
  }

  /**
   * Get terminal output/history
   * @param {string} terminalId - Terminal ID
   * @param {number} lines - Number of lines to retrieve
   * @returns {string} - Terminal output
   */
  getOutput(terminalId, lines = 200) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    return this.tmux.getHistory(terminal.sessionName, terminal.windowName, lines);
  }

  /**
   * Get current status of a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {string} - Status
   */
  getStatus(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    const reconciledTerminal = this._reconcileTerminalBacking(terminal);
    if (!reconciledTerminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    const output = this.getOutput(terminalId);
    // Use status detector if available
    const detector = this.statusDetectors.get(reconciledTerminal.adapter);
    const trackedRunStatus = this._detectTrackedRunStatus(reconciledTerminal, output, detector);
    if (trackedRunStatus) {
      this._applyStatusUpdate(reconciledTerminal, trackedRunStatus, {
        exitCode: reconciledTerminal.activeRun?.exitCode ?? null
      });
      return trackedRunStatus;
    }

    if (detector) {
      const detectedStatus = detector.detectStatus(output);

      // Update cached status
      this._applyStatusUpdate(reconciledTerminal, detectedStatus);

      return detectedStatus;
    }

    // Return cached status if no detector
    return reconciledTerminal.status;
  }

  /**
   * Wait for a specific status
   * @param {string} terminalId - Terminal ID
   * @param {string} targetStatus - Status to wait for
   * @param {number} timeoutMs - Timeout in milliseconds
   * @param {Object} options - Additional options
   * @param {boolean} options.assumeProcessingStarted - If true, assume processing has started
   *   (useful when there's been a delay after sending input)
   * @returns {Promise<void>}
   */
  async waitForStatus(terminalId, targetStatus, timeoutMs = 60000, options = {}) {
    const { assumeProcessingStarted = false } = options;
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const pollInterval = 500;
      let consecutiveErrors = 0;
      const errorThreshold = 3; // Require 3 consecutive ERROR readings before aborting
      let sawProcessing = assumeProcessingStarted; // Track if we've seen PROCESSING state

      const check = () => {
        try {
          const elapsed = Date.now() - startTime;
          if (elapsed > timeoutMs) {
            reject(new Error(`Timeout waiting for status '${targetStatus}' after ${timeoutMs}ms`));
            return;
          }

          const currentStatus = this.getStatus(terminalId);

          // Track if we've seen PROCESSING (important for IDLE-as-COMPLETED detection)
          if (currentStatus === TerminalStatus.PROCESSING) {
            sawProcessing = true;
          }

          if (currentStatus === targetStatus) {
            resolve();
            return;
          }

          // Also accept 'completed' if waiting for 'idle' (completed implies ready for new input)
          if (targetStatus === TerminalStatus.IDLE && currentStatus === TerminalStatus.COMPLETED) {
            resolve();
            return;
          }

          // Also accept 'idle' if waiting for 'completed' (idle after task means task is done)
          // BUT only if we've seen PROCESSING first - this prevents accepting the initial
          // IDLE state before the CLI starts processing the input
          if (targetStatus === TerminalStatus.COMPLETED && currentStatus === TerminalStatus.IDLE && sawProcessing) {
            resolve();
            return;
          }

          // Error status should abort only if sustained (3 consecutive checks)
          // This prevents false positives from transient ERROR-looking output during CLI startup
          if (currentStatus === TerminalStatus.ERROR) {
            consecutiveErrors++;
            // Log what the detector is seeing for debugging
            const termInfo = this.terminals.get(terminalId);
            if (termInfo) {
              const output = this.tmux.getHistory(termInfo.sessionName, termInfo.windowName, 500);
              console.log(`[DEBUG] Terminal ${terminalId} (${termInfo.adapter}) ERROR detected (${consecutiveErrors}/${errorThreshold}), waiting for ${targetStatus}`);

              // Show which patterns are matching
              const detector = this.statusDetectors.get(termInfo.adapter);
              if (detector && detector.getMatchingPatterns) {
                const matchingPatterns = detector.getMatchingPatterns(output);
                console.log(`[DEBUG] Matching patterns:`, matchingPatterns);
              }

              console.log(`[DEBUG] Last 500 chars:`, JSON.stringify(output.slice(-500)));
            }
            if (consecutiveErrors >= errorThreshold) {
              reject(new Error('Terminal entered error state'));
              return;
            }
          } else {
            if (consecutiveErrors > 0) {
              console.log(`[DEBUG] Terminal ${terminalId} status=${currentStatus}, resetting error count from ${consecutiveErrors}`);
            }
            consecutiveErrors = 0; // Reset on non-error status
          }

          setTimeout(check, pollInterval);
        } catch (error) {
          reject(error);
        }
      };

      check();
    });
  }

  /**
   * Wait for a terminal to complete its current task and return output
   * @param {string} terminalId - Terminal ID
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<string>} - Terminal output
   */
  async waitForCompletion(terminalId, timeoutMs = 300000) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    // Wait for CLI to start processing the input
    // This prevents accepting IDLE as "completed" before the CLI starts working
    // Different CLIs have different response times
    const processingDelays = {
      'codex-cli': 5000,    // Codex is slower to start processing
      'gemini-cli': 3000,   // Gemini is moderate
      'qwen-cli': 3000      // Qwen is moderate
    };
    const processingDelay = processingDelays[terminal.adapter] || 3000;
    await new Promise(resolve => setTimeout(resolve, processingDelay));

    // Wait for idle or completed status
    await this.waitForStatus(terminalId, TerminalStatus.COMPLETED, timeoutMs);

    // Capture and return output
    const output = this.tmux.getHistory(terminal.sessionName, terminal.windowName, 500);

    // Try to extract just the response (adapter-specific parsing)
    return this._extractResponse(output, terminal.adapter);
  }

  /**
   * Extract response from terminal output (adapter-specific)
   * @param {string} output - Raw terminal output
   * @param {string} adapter - Adapter name
   * @returns {string} - Extracted response
   */
  _extractResponse(output, adapter) {
    // Use unified output extractor utility
    return extractOutput(output, adapter);
  }

  /**
   * Extract response from Codex CLI output
   * Codex shows responses after "• " bullet markers
   * Skip processing indicators like "Explored", "Working", "Reading"
   */
  _extractCodexResponse(output) {
    const lines = output.split('\n');
    const responseLines = [];
    let inResponse = false;
    let foundResponse = false;

    // Processing indicators to skip (these appear during work, not in final response)
    const skipPatterns = [
      /^•\s*(Explored|Working|Reading|Exploring|Acknowledging)/i,
      /^\s*└/,  // Tree structure indicators
      /esc to interrupt/i,
      /^─.*Worked for/  // Progress separator
    ];

    for (const line of lines) {
      // Skip processing indicators
      if (skipPatterns.some(p => p.test(line))) {
        continue;
      }

      // Start capturing at bullet points (Codex response format)
      if (line.startsWith('•')) {
        inResponse = true;
        foundResponse = true;
        responseLines.push(line);
      } else if (inResponse) {
        // Stop at the next prompt indicator
        if (line.startsWith('›') || line.includes('context left') || line.includes('? for shortcuts')) {
          inResponse = false;
        } else {
          responseLines.push(line);
        }
      }
    }

    return foundResponse ? responseLines.join('\n').trim() : output;
  }

  /**
   * Extract response from Gemini CLI output
   * Gemini shows responses with ✦ markers or plain text after prompts
   */
  _extractGeminiResponse(output) {
    const lines = output.split('\n');
    const responseLines = [];
    let foundResponse = false;

    for (const line of lines) {
      // Gemini response markers
      if (line.startsWith('✦') || line.startsWith('✓')) {
        foundResponse = true;
        responseLines.push(line);
      } else if (foundResponse) {
        // Stop at input box indicators
        if (line.includes('Type your message') || line.includes('╭─') || line.includes('╰─')) {
          break;
        }
        responseLines.push(line);
      }
    }

    return foundResponse ? responseLines.join('\n').trim() : output;
  }

  /**
   * Extract response from Claude Code output
   * Claude shows responses with ⏺ markers
   */
  _extractClaudeResponse(output) {
    const lines = output.split('\n');
    const responseLines = [];
    let inResponse = false;
    let foundResponse = false;

    for (const line of lines) {
      // Claude response markers
      if (line.includes('⏺')) {
        inResponse = true;
        foundResponse = true;
        responseLines.push(line);
      } else if (inResponse) {
        // Stop at prompt indicators
        if (line.startsWith('❯') || line.includes('────────') && !line.includes('⏺')) {
          inResponse = false;
        } else {
          responseLines.push(line);
        }
      }
    }

    return foundResponse ? responseLines.join('\n').trim() : output;
  }

  /**
   * Get terminal info
   * @param {string} terminalId - Terminal ID
   * @returns {Object} - Terminal info
   */
  getTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return null;
    }

    const reconciledTerminal = this._reconcileTerminalBacking(terminal);
    if (!reconciledTerminal) {
      return null;
    }

    return {
      ...reconciledTerminal,
      status: this.getStatus(terminalId)
    };
  }

  /**
   * List all terminals
   * @returns {Array} - List of terminal info objects
   */
  listTerminals() {
    return Array.from(this.terminals.values())
      .map((terminal) => this._reconcileTerminalBacking(terminal))
      .filter(Boolean)
      .map(terminal => ({
        ...terminal,
        status: this.getStatus(terminal.terminalId)
      }));
  }

  /**
   * Destroy a terminal
   * @param {string} terminalId - Terminal ID
   */
  async destroyTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return;
    }

    this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_destroyed',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_destroyed',
        terminal.activeRun?.runId || 'destroy'
      ),
      payloadSummary: `${terminal.adapter} session destroyed`,
      payloadJson: {
        adapter: terminal.adapter,
        status: terminal.status
      },
      metadata: terminal.sessionMetadata || null
    });

    // Kill tmux session
    this.tmux.killSession(terminal.sessionName);

    // Remove from registry
    this.terminals.delete(terminalId);

    // Remove from database if available
    if (this.db) {
      this.db.deleteTerminal(terminalId);
    }

    this.emit('terminal-destroyed', { terminalId });
  }

  _shouldPreserveTerminalOnStop(terminal) {
    if (!terminal) {
      return false;
    }
    const sessionKind = String(terminal.sessionKind || '').trim().toLowerCase();
    const metadata = terminal.sessionMetadata && typeof terminal.sessionMetadata === 'object'
      ? terminal.sessionMetadata
      : null;
    return Boolean(
      metadata?.managedLaunch
      || sessionKind === 'main'
      || sessionKind === 'attach'
    );
  }

  /**
   * Destroy all terminals
   */
  async destroyAllTerminals(options = {}) {
    const preserveManagedRoots = options.preserveManagedRoots === true;
    for (const terminalId of Array.from(this.terminals.keys())) {
      const terminal = this.terminals.get(terminalId);
      if (preserveManagedRoots && this._shouldPreserveTerminalOnStop(terminal)) {
        continue;
      }
      await this.destroyTerminal(terminalId);
    }
  }

  /**
   * Clean up stale terminals
   * @param {number} maxAgeMs - Maximum age in milliseconds
   * @returns {number} - Number of terminals cleaned up
   */
  cleanupStaleTerminals(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;

    for (const [terminalId, terminal] of this.terminals) {
      const age = now - terminal.createdAt.getTime();
      if (age > maxAgeMs) {
        this.destroyTerminal(terminalId);
        cleaned++;
      }
    }

    // Also clean up orphan tmux sessions
    cleaned += this.tmux.cleanupStaleSessions(maxAgeMs);

    return cleaned;
  }

  /**
   * Read log file for a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {string} - Log content
   */
  readLog(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || !terminal.logPath) {
      return '';
    }

    try {
      return fs.readFileSync(terminal.logPath, 'utf8');
    } catch (error) {
      return '';
    }
  }

  /**
   * Read last N bytes from log file
   * @param {string} terminalId - Terminal ID
   * @param {number} bytes - Number of bytes
   * @returns {string} - Log tail
   */
  readLogTail(terminalId, bytes = 5000) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || !terminal.logPath) {
      return '';
    }

    try {
      const stats = fs.statSync(terminal.logPath);
      const size = stats.size;
      const start = Math.max(0, size - bytes);

      const fd = fs.openSync(terminal.logPath, 'r');
      const buffer = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);

      return buffer.toString('utf8');
    } catch (error) {
      return '';
    }
  }

  /**
   * Attach to a terminal (for debugging)
   * Returns the tmux attach command
   * @param {string} terminalId - Terminal ID
   * @returns {string} - Command to attach
   */
  getAttachCommand(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    return `tmux attach -t "${terminal.sessionName}"`;
  }
}

module.exports = {
  PersistentSessionManager,
  TerminalStatus,
  generateTerminalId,
  // Export for testing
  CLI_COMMANDS
};
