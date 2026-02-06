/**
 * PersistentSessionManager - Manages persistent CLI sessions via tmux
 *
 * This manager creates long-running tmux sessions for CLI agents,
 * enabling multi-agent orchestration with message passing and status tracking.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const TmuxClient = require('./client');
const { extractOutput, stripAnsiCodes } = require('../utils/output-extractor');

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
 * Generate an 8-character terminal ID
 */
function generateTerminalId() {
  return crypto.randomBytes(4).toString('hex');
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
    if (options.allowedTools && Array.isArray(options.allowedTools)) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    return args.join(' ');
  },

  'gemini-cli': (options = {}) => {
    const args = ['gemini'];

    // Start Gemini in interactive mode WITHOUT -i flag
    // The -i flag sends the prompt as the first message, causing Gemini to respond to it
    // Instead, just start `gemini` which enters interactive mode, then send messages via tmux
    // System prompt will be sent as the first message if needed

    // Permission mode handling:
    // - 'auto' (default) or 'bypassPermissions': Use yolo mode (auto-approve all)
    // - 'default' or 'interceptor': Don't use yolo mode (will prompt for confirmations)
    // - Other modes: Gemini doesn't support fine-grained modes, fall back to yolo
    // NOTE: Gemini CLI doesn't have --allowedTools or read-only mode like Claude
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode === 'default' || permissionMode === 'interceptor') {
      // Don't add yolo mode - will prompt for confirmations
      // 'interceptor' mode: PermissionInterceptor will auto-respond to prompts
    } else if (options.yoloMode !== false) {
      args.push('--approval-mode', 'yolo');
    }

    // Model selection
    if (options.model) {
      args.push('-m', options.model);
    }

    return args.join(' ');
  },

  'codex-cli': (options = {}) => {
    // Prefix with CI=true to skip interactive prompts like update checks
    // Then use interactive mode with bypass flag for full automation
    const args = ['CI=true', 'codex'];

    // Permission mode handling:
    // - 'auto' (default) or 'bypassPermissions': Use bypass mode (auto-approve all)
    // - 'default' or 'interceptor': Don't use bypass mode (will prompt for confirmations)
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode === 'default' || permissionMode === 'interceptor') {
      // Don't add bypass flag - will prompt for confirmations
    } else {
      // Use --dangerously-bypass-approvals-and-sandbox to skip ALL interactive prompts
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    // Model selection
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
        // Check if tmux session still exists
        if (activeSessionNames.has(dbTerminal.sessionName)) {
          // Recover this terminal into memory
          this.terminals.set(dbTerminal.terminalId, {
            terminalId: dbTerminal.terminalId,
            sessionName: dbTerminal.sessionName,
            windowName: dbTerminal.windowName,
            adapter: dbTerminal.adapter,
            agentProfile: dbTerminal.agentProfile,
            role: dbTerminal.role || 'worker',
            workDir: dbTerminal.workDir || this.workDir,
            logPath: path.join(this.logDir, `${dbTerminal.terminalId}.log`),
            status: TerminalStatus.IDLE,
            createdAt: new Date(dbTerminal.createdAt),
            lastActive: new Date(dbTerminal.lastActive || dbTerminal.createdAt),
            recovered: true
          });
          recovered++;
        } else {
          // Session no longer exists, mark as orphaned in DB
          if (this.db.updateStatus) {
            this.db.updateStatus(dbTerminal.terminalId, 'orphaned');
          }
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
   * Create a new persistent terminal
   * @param {Object} options
   * @param {string} options.adapter - Adapter name (claude-code, gemini-cli, codex-cli)
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
      adapter = 'claude-code',
      agentProfile = null,
      role = 'worker',
      workDir = this.workDir,
      systemPrompt = null,
      model = null,
      allowedTools = null,
      // Permission mode support (Gap #4 resolution)
      // Modes: 'plan', 'default', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk', 'auto'
      // 'auto' (default) = skip permissions for automated use
      permissionMode = 'auto'
    } = options;

    // Validate adapter
    if (!CLI_COMMANDS[adapter]) {
      throw new Error(`Unknown adapter: ${adapter}. Supported: ${Object.keys(CLI_COMMANDS).join(', ')}`);
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

    // Generate IDs
    const terminalId = generateTerminalId();
    const sessionName = `cliagents-${terminalId.slice(0, 6)}`;
    const windowName = `${agentProfile || adapter}-${terminalId.slice(6)}`;

    // SECURITY: Validate working directory path
    if (!isPathSafe(workDir)) {
      throw new Error('Invalid working directory: contains dangerous characters');
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
      logPath,
      status: TerminalStatus.IDLE,
      createdAt: new Date(),
      lastActive: new Date()
    };

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
        logPath
      );
    }

    // Emit creation event
    this.emit('terminal-created', { terminalId, adapter, role });

    // Wait for CLI to become ready
    // Use 60s timeout since CLIs can take a while to initialize (loading plugins, MCP servers, etc.)
    try {
      await this.waitForStatus(terminalId, TerminalStatus.IDLE, 60000);
    } catch (error) {
      console.warn(`Terminal ${terminalId} may not be fully ready:`, error.message);
    }

    return {
      terminalId,
      sessionName,
      windowName,
      adapter,
      agentProfile,
      role,
      logPath,
      status: this.getStatus(terminalId)
    };
  }

  /**
   * Recover existing sessions from tmux
   * @returns {Promise<number>} - Number of sessions recovered
   */
  async recoverSessions() {
    const sessions = this.tmux.listSessions('cliagents-');
    let recoveredCount = 0;

    for (const session of sessions) {
      // Session name format: cliagents-{terminalId}
      // terminalId is hex, so we extract it.
      // Expected format: cliagents-123456 (first 6 chars of ID used in name construction)
      // Wait, in createTerminal: sessionName = `cliagents-${terminalId.slice(0, 6)}`
      // We can't recover the FULL terminalId from just the session name if it was truncated!
      // However, let's look at how we store state.
      // If we can't get the full ID, we might have issues if other systems expect the full 8-byte hex.
      // Let's check createTerminal again.
      // terminalId = crypto.randomBytes(4).toString('hex'); -> 8 chars.
      // sessionName uses slice(0,6).
      
      // We need a way to store metadata.
      // Tmux user options (@options) are perfect for this.
      // But since we are "recovering" from code that DIDN'T set those, we might be limited.
      
      // Actually, let's look at the window name: `${agentProfile || adapter}-${terminalId.slice(6)}`
      // So session name has first 6 chars, window has the rest?
      // createTerminal: windowName = `${agentProfile || adapter}-${terminalId.slice(6)}`;
      
      // So we can reconstruct the ID!
      // sessionName gives part 1, windowName gives part 2.
      
      const sessionName = session.name;
      const windows = this.tmux.listWindows(sessionName);
      if (windows.length === 0) continue;
      
      // We assume one window per session for this agent
      const windowName = windows[0].name;
      
      // Parse ID parts
      // sessionName: cliagents-XXXXXX
      const idPart1 = sessionName.replace('cliagents-', '');
      
      // windowName: adapter-YY
      // The suffix is the last 2 chars
      const idPart2 = windowName.slice(-2);
      
      // Verify lengths to be sure
      if (idPart1.length !== 6 || idPart2.length !== 2) {
        console.warn(`Skipping session ${sessionName}: Cannot reconstruct ID from names`);
        continue;
      }
      
      const terminalId = idPart1 + idPart2;
      
      // Parse adapter/profile from window name
      // windowName format: {adapter/profile}-{idPart2}
      const prefix = windowName.slice(0, -3); // remove -YY
      
      // We can't easily distinguish between agentProfile and adapter if they overlap,
      // but for recovery we can default to 'unknown' or try to guess.
      // Ideally we would have stored this in tmux env vars.
      // Let's check if we set env vars in createTerminal.
      // Yes: CLIAGENTS_TERMINAL_ID is set.
      // We can inspect the pane environment to get the full ID and potentially other vars!
      
      // Let's try to get the ID from environment to be safe.
      // We can use `tmux show-environment -t session`
      
      // For now, let's reconstruct the object.
      
      const workDir = this.tmux.getPaneDirectory(sessionName, windowName) || this.workDir;
      const logPath = path.join(this.logDir, `${terminalId}.log`);
      
      // Attempt to guess adapter from prefix
      let adapter = prefix; 
      let agentProfile = null;
      
      // If the prefix matches a known adapter, assume it is one.
      if (CLI_COMMANDS[prefix]) {
         adapter = prefix;
      } else {
         // Assume it's a profile, default adapter to claude-code (or we need to look at the running command)
         agentProfile = prefix;
         adapter = 'claude-code'; // Fallback
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
        lastActive: new Date()
      };
      
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

    // Send the message
    this.tmux.sendKeys(terminal.sessionName, terminal.windowName, message, true);

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

    // Use status detector if available
    const detector = this.statusDetectors.get(terminal.adapter);
    if (detector) {
      const output = this.getOutput(terminalId);
      const detectedStatus = detector.detectStatus(output);

      // Update cached status
      if (detectedStatus !== terminal.status) {
        terminal.status = detectedStatus;
        if (this.db) {
          this.db.updateStatus(terminalId, detectedStatus);
        }
        this.emit('status-change', { terminalId, status: detectedStatus });
      }

      return detectedStatus;
    }

    // Return cached status if no detector
    return terminal.status;
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
      'claude-code': 2000   // Claude is fast
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

    return {
      ...terminal,
      status: this.getStatus(terminalId)
    };
  }

  /**
   * List all terminals
   * @returns {Array} - List of terminal info objects
   */
  listTerminals() {
    return Array.from(this.terminals.values()).map(terminal => ({
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

  /**
   * Destroy all terminals
   */
  async destroyAllTerminals() {
    for (const terminalId of this.terminals.keys()) {
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
