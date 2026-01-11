/**
 * TmuxClient - Wrapper for tmux commands
 *
 * Provides persistent terminal sessions for CLI agents using tmux.
 * Inspired by CAO's approach for multi-agent orchestration.
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

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
   * Build tmux command with optional socket path
   */
  _tmuxCmd(args) {
    const socketArg = this.socketPath ? `-S ${this.socketPath}` : '';
    return `tmux ${socketArg} ${args}`;
  }

  /**
   * Execute tmux command synchronously
   */
  _exec(args, options = {}) {
    const cmd = this._tmuxCmd(args);
    try {
      return execSync(cmd, {
        encoding: 'utf8',
        stdio: options.silent ? 'pipe' : undefined,
        ...options
      });
    } catch (error) {
      if (options.ignoreErrors) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Escape special characters for tmux send-keys
   */
  _escapeKeys(text) {
    // Escape characters that have special meaning in tmux
    return text
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
    const cdArg = workingDir ? `-c "${workingDir}"` : '';
    this._exec(`new-session -d -s "${sessionName}" -n "${windowName}" ${cdArg}`, {
      env: { ...process.env, ...envVars }
    });

    // Set environment variables in the session
    for (const [key, value] of Object.entries(envVars)) {
      this._exec(`set-environment -t "${sessionName}" ${key} "${value}"`);
    }

    return true;
  }

  /**
   * Check if a session exists
   * @param {string} sessionName - Session name to check
   * @returns {boolean}
   */
  sessionExists(sessionName) {
    const result = this._exec(`has-session -t "${sessionName}" 2>/dev/null`, {
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
    const escapedKeys = this._escapeKeys(keys);
    const target = `"${sessionName}:${windowName}"`;

    // Use literal mode (-l) for complex text
    this._exec(`send-keys -t ${target} -l "${escapedKeys}"`);

    if (pressEnter) {
      this._exec(`send-keys -t ${target} Enter`);
    }
  }

  /**
   * Send a special key (Enter, Tab, Escape, etc.)
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {string} key - Key name (Enter, Tab, Escape, C-c, etc.)
   */
  sendSpecialKey(sessionName, windowName, key) {
    const target = `"${sessionName}:${windowName}"`;
    this._exec(`send-keys -t ${target} ${key}`);
  }

  /**
   * Get terminal history/output
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   * @param {number} lines - Number of lines to capture (from end)
   * @returns {string} - Captured output
   */
  getHistory(sessionName, windowName, lines = this.defaultHistoryLimit) {
    const target = `"${sessionName}:${windowName}"`;
    try {
      // capture-pane with -p prints to stdout, -S -N captures last N lines
      const output = this._exec(`capture-pane -t ${target} -p -S -${lines}`, {
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
    const target = `"${sessionName}:${windowName}"`;
    try {
      return this._exec(`capture-pane -t ${target} -p`, { silent: true }) || '';
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
    const target = `"${sessionName}:${windowName}"`;
    const absolutePath = path.isAbsolute(logPath) ? logPath : path.join(this.logDir, logPath);

    // Ensure log directory exists
    const logDir = path.dirname(absolutePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // -o flag opens pipe without closing existing one
    this._exec(`pipe-pane -t ${target} -o "cat >> '${absolutePath}'"`);

    return absolutePath;
  }

  /**
   * Stop piping pane output
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name
   */
  stopPipePane(sessionName, windowName) {
    const target = `"${sessionName}:${windowName}"`;
    this._exec(`pipe-pane -t ${target}`, { ignoreErrors: true });
  }

  /**
   * Kill a tmux session
   * @param {string} sessionName - Session name to kill
   */
  killSession(sessionName) {
    if (this.sessionExists(sessionName)) {
      this._exec(`kill-session -t "${sessionName}"`, { ignoreErrors: true });
    }
  }

  /**
   * Kill a specific window within a session
   * @param {string} sessionName - Session name
   * @param {string} windowName - Window name to kill
   */
  killWindow(sessionName, windowName) {
    const target = `"${sessionName}:${windowName}"`;
    this._exec(`kill-window -t ${target}`, { ignoreErrors: true });
  }

  /**
   * List all cliagents sessions
   * @returns {Array} - List of session info objects
   */
  listSessions(prefix = 'cliagents-') {
    try {
      const output = this._exec('list-sessions -F "#{session_name}:#{session_created}:#{session_attached}"', {
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
      const output = this._exec(`list-windows -t "${sessionName}" -F "#{window_name}:#{window_active}"`, {
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

        const currentOutput = this.getHistory(sessionName, windowName);

        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastChangeTime = Date.now();
        } else if (Date.now() - lastChangeTime >= stableMs) {
          resolve(currentOutput);
          return;
        }

        setTimeout(check, 100);
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
    const target = `"${sessionName}:${windowName}"`;
    try {
      const output = this._exec(`display-message -t ${target} -p "#{pane_current_path}"`, {
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
    const target = `"${sessionName}:${windowName}"`;
    this._exec(`resize-pane -t ${target} -x ${width} -y ${height}`, { ignoreErrors: true });
  }
}

module.exports = TmuxClient;
