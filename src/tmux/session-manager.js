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

    // Skip permission prompts for non-interactive use
    if (options.dangerouslySkipPermissions !== false) {
      args.push('--dangerously-skip-permissions');
    }

    // Print output as JSON for parsing
    args.push('--output-format', 'stream-json');

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    // System prompt (if any - initial conversation prompt)
    if (options.systemPrompt) {
      args.push('--system-prompt', `"${options.systemPrompt.replace(/"/g, '\\"')}"`);
    }

    // Allowed tools restriction
    if (options.allowedTools && Array.isArray(options.allowedTools)) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    return args.join(' ');
  },

  'gemini-cli': (options = {}) => {
    const args = ['gemini'];

    // Sandbox mode (skip confirmations)
    if (options.yoloMode !== false) {
      args.push('--sandbox');
    }

    // Model selection (if supported)
    if (options.model) {
      args.push('-m', options.model);
    }

    return args.join(' ');
  },

  'codex-cli': (options = {}) => {
    const args = ['codex'];

    // Full auto mode
    if (options.autoApprove !== false) {
      args.push('--approval-mode', 'full-auto');
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

    // In-memory terminal registry (will be replaced by DB in Phase 3)
    this.terminals = new Map();

    // Status detectors (will be populated in Phase 2)
    this.statusDetectors = new Map();

    // Ensure directories exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
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
      allowedTools = null
    } = options;

    // Validate adapter
    if (!CLI_COMMANDS[adapter]) {
      throw new Error(`Unknown adapter: ${adapter}. Supported: ${Object.keys(CLI_COMMANDS).join(', ')}`);
    }

    // Generate IDs
    const terminalId = generateTerminalId();
    const sessionName = `cliagents-${terminalId.slice(0, 6)}`;
    const windowName = `${agentProfile || adapter}-${terminalId.slice(6)}`;

    // Ensure working directory exists
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Create tmux session
    this.tmux.createSession(sessionName, windowName, terminalId, { workDir });

    // Set up logging
    const logPath = path.join(this.logDir, `${terminalId}.log`);
    this.tmux.pipePaneToFile(sessionName, windowName, logPath);

    // Build and execute CLI command
    const cliCommand = CLI_COMMANDS[adapter]({
      systemPrompt,
      model,
      allowedTools,
      dangerouslySkipPermissions: true,
      yoloMode: true,
      autoApprove: true
    });

    // Change to working directory and start CLI
    this.tmux.sendKeys(sessionName, windowName, `cd "${workDir}" && ${cliCommand}`, true);

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

    // Register in database if available
    if (this.db) {
      this.db.registerTerminal(
        terminalId,
        sessionName,
        windowName,
        adapter,
        agentProfile,
        role
      );
    }

    // Emit creation event
    this.emit('terminal-created', { terminalId, adapter, role });

    // Wait for CLI to become ready
    try {
      await this.waitForStatus(terminalId, TerminalStatus.IDLE, 30000);
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
   * Send input to a terminal
   * @param {string} terminalId - Terminal ID
   * @param {string} message - Message to send
   */
  async sendInput(terminalId, message) {
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
   * @returns {Promise<void>}
   */
  async waitForStatus(terminalId, targetStatus, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const pollInterval = 500;

      const check = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          reject(new Error(`Timeout waiting for status '${targetStatus}' after ${timeoutMs}ms`));
          return;
        }

        const currentStatus = this.getStatus(terminalId);
        if (currentStatus === targetStatus) {
          resolve();
          return;
        }

        // Also accept 'completed' if waiting for 'idle' (completed implies ready for new input)
        if (targetStatus === TerminalStatus.IDLE && currentStatus === TerminalStatus.COMPLETED) {
          resolve();
          return;
        }

        // Error status should abort
        if (currentStatus === TerminalStatus.ERROR) {
          reject(new Error('Terminal entered error state'));
          return;
        }

        setTimeout(check, pollInterval);
      };

      check();
    });
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
  generateTerminalId
};
