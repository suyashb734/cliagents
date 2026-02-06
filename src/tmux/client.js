/**
 * TmuxClient - Wrapper for tmux commands
 *
 * Provides persistent terminal sessions for CLI agents using tmux.
 * Inspired by CAO's approach for multi-agent orchestration.
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Regex for validating session/window names (alphanumeric, dash, underscore only)
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

class TmuxClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || null;
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.defaultHistoryLimit = options.historyLimit || 2000;

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Verify tmux is available
    this._verifyTmux();
  }

  /**
   * Verify tmux is installed and accessible
   */
  _verifyTmux() {
    try {
      execSync('which tmux', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('tmux is not installed or not in PATH. Install with: brew install tmux');
    }
  }

  /**
   * Build tmux command arguments with optional socket path
   * @param {string[]} args - Tmux arguments
   * @returns {string[]} - Full command arguments including socket option
   */
  _tmuxArgs(args) {
    const fullArgs = [];
    if (this.socketPath) {
      fullArgs.push('-S', this.socketPath);
    }
    return fullArgs.concat(args);
  }

  /**
   * Execute tmux command synchronously using spawnSync
   * @param {string[]} args - Command arguments
   * @param {object} options - Options for spawnSync
   */
  _exec(args, options = {}) {
    const tmuxArgs = this._tmuxArgs(args);
    
    // Default options
    const spawnOptions = {
      encoding: 'utf8',
      env: options.env || process.env,
      stdio: options.silent ? 'pipe' : undefined,
      cwd: options.cwd || process.cwd()
    };

    const result = spawnSync('tmux', tmuxArgs, spawnOptions);

    if (result.error) {
      if (options.ignoreErrors) return null;
      throw result.error;
    }

    if (result.status !== 0) {
      if (options.ignoreErrors) return null;
      const stderr = result.stderr ? result.stderr.toString() : '';
      throw new Error(`tmux command failed (exit code ${result.status}): ${stderr}`);
    }

    return result.stdout ? result.stdout.toString() : '';
  }

  /**
   * Validate session/window names to prevent injection
   * @param {string} name - Name to validate
   * @param {string} type - Type for error message ('session' or 'window')
   * @throws {Error} If name contains unsafe characters
   */
  _validateName(name, type = 'name') {
    if (!name || typeof name !== 'string') {
      throw new Error(`${type} name is required`);
    }
    if (!SAFE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid ${type} name: "${name}". Only alphanumeric characters, dashes, and underscores are allowed.`);
    }
    if (name.length > 50) {
      throw new Error(`${type} name too long (max 50 characters)`);
    }
  }

  /**
   * Escape string for use in shell single quotes
   * Single quotes cannot be escaped inside single quotes, so we:
   * 'text' + \' + 'more text' = 'text'\''more text'
   * @param {string} str - String to escape
   * @returns {string} - Escaped string safe for single-quoted shell context
   */
  _escapeForShell(str) {
    if (typeof str !== 'string') {
      return '';
    }
    // Replace single quotes with: end quote, escaped quote, start quote
    return str.replace(/'/g, "'\\''");
  }

  /**
   * Escape keys for use in double-quoted shell string for send-keys
   * @param {string} str - String to escape
   * @returns {string} - Escaped string
   */
  _escapeKeys(str) {
    if (typeof str !== 'string') {
      return '';
    }
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/!/g, '\\!');
  }

  /**
   * Create a new tmux session with a window
   * @param {string} sessionName - Unique session name
   * @param {string} windowName - Window name within session
   * @param {string} terminalId - Terminal ID for environment variable
   * @param {object} options - Additional options
   * @returns {boolean} - Success status
   */
  createSession(sessionName, windowName, terminalId, options = {}) {
    // SECURITY: Validate names to prevent command injection
    this._validateName(sessionName, 'session');
    this._validateName(windowName, 'window');

    const { workingDir, env = {} } = options;

    // Check if session already exists
    if (this.sessionExists(sessionName)) {
      throw new Error(`Session ${sessionName} already exists`);
    }

    // Build environment string
    const envVars = {
      CLIAGENTS_TERMINAL_ID: terminalId,
      ...env
    };

    // Create detached session
    const args = ['new-session', '-d', '-s', sessionName, '-n', windowName];
    
    if (workingDir) {
      args.push('-c', workingDir);
    }
    
    this._exec(args, {
      env: { ...process.env, ...envVars }
    });

    // Set environment variables in the session
    for (const [key, value] of Object.entries(envVars)) {
      // Use set-environment which handles escaping safely when passed as args
      this._exec(['set-environment', '-t', sessionName, key, value]);
    }

    return true;
  }

  /**
   * Check if a session exists
   * @param {string} sessionName - Session name to check
   * @returns {boolean}
   */
  sessionExists(sessionName) {
    // has-session returns 0 if exists, 1 if not
    const result = this._exec(['has-session', '-t', sessionName], {
      ignoreErrors: true,
      silent: true
    });
    return result !== null;
  }

  /**
   * Send keys (text input) to a tmux window
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {string} keys - Text to send
   * @param {boolean} pressEnter - Whether to press Enter after
   */
  sendKeys(sessionName, windowName, keys, pressEnter = true) {
    this._validateName(sessionName, 'session');
    this._validateName(windowName, 'window');

    const target = `${sessionName}:${windowName}`;

    // For long messages (>200 chars), use load-buffer + paste-buffer
    // to avoid tmux send-keys truncation issues with large inputs.
    // Short messages use send-keys -l directly for simplicity.
    if (keys.length > 200) {
      // Write to a temp file, load into tmux buffer, paste into pane
      const tmpFile = path.join(this.logDir, `.tmux-input-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
      const bufferName = `cli-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmpFile, keys);
        this._exec(['load-buffer', '-b', bufferName, tmpFile]);
        this._exec(['paste-buffer', '-t', target, '-b', bufferName, '-d', '-p']);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore cleanup errors */ }
      }
    } else {
      // Send text using -l (literal) flag which handles special characters safely
      this._exec(['send-keys', '-t', target, '-l', keys]);
    }

    if (pressEnter) {
      // Add delay to ensure text is fully processed before pressing Enter
      // Longer delay for longer messages to allow terminal processing
      const delay = keys.length > 200 ? 0.5 : 0.1;
      spawnSync('sleep', [String(delay)]);
      this._exec(['send-keys', '-t', target, 'Enter']);
    }
  }

  /**
   * Send a special key (Enter, Tab, Escape, etc.)
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {string} key - Key name (Enter, Tab, Escape, C-c, etc.)
   */
  sendSpecialKey(sessionName, windowName, key) {
    this._validateName(sessionName, 'session');
    this._validateName(windowName, 'window');
    
    const target = `${sessionName}:${windowName}`;
    this._exec(['send-keys', '-t', target, key]);
  }

  /**
   * Get terminal history/output
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {number} lines - Number of lines to capture (from end)
   * @returns {string} - Captured output
   */
  getHistory(sessionName, windowName, lines = this.defaultHistoryLimit) {
    const target = `${sessionName}:${windowName}`;
    try {
      // capture-pane with -p prints to stdout, -S -N captures last N lines
      const output = this._exec(['capture-pane', '-t', target, '-p', '-S', `-${lines}`], {
        silent: true
      });
      return output || '';
    } catch (error) {
      console.error(`Failed to capture pane for ${sessionName}:${windowName}:`, error.message);
      return '';
    }
  }

  /**
   * Get visible pane content only (current screen)
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @returns {string} - Visible content
   */
  getVisibleContent(sessionName, windowName) {
    const target = `${sessionName}:${windowName}`;
    try {
      return this._exec(['capture-pane', '-t', target, '-p'], { silent: true }) || '';
    } catch (error) {
      return '';
    }
  }

  /**
   * Pipe pane output to a log file for persistent logging
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {string} logPath - Path to log file
   */
  pipePaneToFile(sessionName, windowName, logPath) {
    // SECURITY: Validate session/window names
    this._validateName(sessionName, 'session');
    this._validateName(windowName, 'window');

    const target = `${sessionName}:${windowName}`;
    const absolutePath = path.isAbsolute(logPath) ? logPath : path.join(this.logDir, logPath);

    // SECURITY: Validate log path doesn't contain path traversal
    const normalizedPath = path.normalize(absolutePath);
    const normalizedLogDir = path.normalize(this.logDir);
    if (!normalizedPath.startsWith(normalizedLogDir)) {
      throw new Error('Invalid log path: path traversal detected');
    }

    // Ensure log directory exists
    const logDir = path.dirname(absolutePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // SECURITY: Escape the path for shell single quotes
    const escapedPath = this._escapeForShell(absolutePath);
    
    // pipe-pane takes a SHELL COMMAND string as an argument.
    // We construct this string carefully: cat >> 'escaped_path'
    const command = `cat >> '${escapedPath}'`;
    
    // -o flag opens pipe without closing existing one
    this._exec(['pipe-pane', '-t', target, '-o', command]);

    return absolutePath;
  }

  /**
   * Stop piping pane output
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   */
  stopPipePane(sessionName, windowName) {
    const target = `${sessionName}:${windowName}`;
    this._exec(['pipe-pane', '-t', target], { ignoreErrors: true });
  }

  /**
   * Kill a tmux session
   * @param {string} sessionName - Session name to kill
   */
  killSession(sessionName) {
    if (this.sessionExists(sessionName)) {
      this._exec(['kill-session', '-t', sessionName], { ignoreErrors: true });
    }
  }

  /**
   * Kill a specific window within a session
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name to kill
   */
  killWindow(sessionName, windowName) {
    const target = `${sessionName}:${windowName}`;
    this._exec(['kill-window', '-t', target], { ignoreErrors: true });
  }

  /**
   * List all cliagents sessions
   * @returns {Array} - List of session info objects
   */
  listSessions(prefix = 'cliagents-') {
    try {
      const output = this._exec(['list-sessions', '-F', '#{session_name}:#{session_created}:#{session_attached}'], {
        silent: true
      });

      if (!output) return [];

      return output.trim().split('\n')
        .filter(line => line.startsWith(prefix))
        .map(line => {
          const [name, created, attached] = line.split(':');
          return {
            name,
            created: new Date(parseInt(created) * 1000),
            attached: attached === '1'
          };
        });
    } catch (error) {
      return [];
    }
  }

  /**
   * List windows in a session
   * @param {string} sessionName - Session name
   * @returns {Array} - List of window info objects
   */
  listWindows(sessionName) {
    try {
      const output = this._exec(['list-windows', '-t', sessionName, '-F', '#{window_name}:#{window_active}'], {
        silent: true
      });

      if (!output) return [];

      return output.trim().split('\n').map(line => {
        const [name, active] = line.split(':');
        return { name, active: active === '1' };
      });
    } catch (error) {
      return [];
    }
  }

  /**
   * Check if a pane is responsive (has recent activity)
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @returns {boolean}
   */
  isPaneResponsive(sessionName, windowName) {
    const content = this.getVisibleContent(sessionName, windowName);
    // A responsive pane should have some content
    return content.trim().length > 0;
  }

  /**
   * Wait for output to stabilize (no new output for duration)
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {number} stableMs - Milliseconds of stability required
   * @param {number} timeoutMs - Maximum wait time
   * @returns {Promise<string>} - Final output
   */
  async waitForStableOutput(sessionName, windowName, stableMs = 500, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let lastOutput = '';
      let lastChangeTime = startTime;

      const check = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          reject(new Error(`Timeout waiting for stable output after ${timeoutMs}ms`));
          return;
        }

        // Optimization: Check only last 100 lines for stability to reduce memory usage
        const currentOutput = this.getHistory(sessionName, windowName, 100);

        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastChangeTime = Date.now();
        } else if (Date.now() - lastChangeTime >= stableMs) {
          // Return full history upon completion
          resolve(this.getHistory(sessionName, windowName));
          return;
        }

        setTimeout(check, 250);
      };

      check();
    });
  }

  /**
   * Clean up stale sessions (older than maxAge)
   * @param {number} maxAgeMs - Maximum age in milliseconds
   * @param {string} prefix - Session name prefix to filter
   * @returns {number} - Number of sessions cleaned up
   */
  cleanupStaleSessions(maxAgeMs = 24 * 60 * 60 * 1000, prefix = 'cliagents-') {
    const sessions = this.listSessions(prefix);
    const now = Date.now();
    let cleaned = 0;

    for (const session of sessions) {
      const age = now - session.created.getTime();
      if (age > maxAgeMs && !session.attached) {
        this.killSession(session.name);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get the pane's current working directory
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @returns {string|null} - Current directory or null
   */
  getPaneDirectory(sessionName, windowName) {
    const target = `${sessionName}:${windowName}`;
    try {
      const output = this._exec(['display-message', '-t', target, '-p', '#{pane_current_path}'], {
        silent: true
      });
      return output?.trim() || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Resize pane
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {number} width - New width in columns
   * @param {number} height - New height in rows
   */
  resizePane(sessionName, windowName, width = 200, height = 50) {
    const target = `${sessionName}:${windowName}`;
    this._exec(['resize-pane', '-t', target, '-x', width, '-y', height], { ignoreErrors: true });
  }
}

module.exports = TmuxClient;
