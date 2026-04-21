/**
 * Permission Interceptor - Auto-responds to CLI permission prompts
 *
 * This interceptor watches terminals running in non-yolo mode and automatically
 * responds to permission prompts based on PermissionManager rules.
 *
 * SECURITY NOTES (from Gemini review):
 * - Only responds when CLI is in WAITING_PERMISSION state (contextual validation)
 * - Uses strict regex patterns to avoid prompt spoofing
 * - Adds delay before responding to ensure prompt is stable
 *
 * PERFORMANCE NOTES (from Codex review):
 * - Uses adaptive polling (faster when waiting for permission)
 * - Tracks output offset to avoid reprocessing
 * - Supports event-driven notification to reduce polling
 */

const EventEmitter = require('events');
const { getParser } = require('./prompt-parsers');
const { TerminalStatus } = require('../models/terminal-status');

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  // Polling intervals (adaptive based on status)
  pollIntervalIdle: 1000,      // When terminal is idle
  pollIntervalActive: 200,     // When terminal is processing
  pollIntervalWaiting: 100,    // When waiting for permission (fastest)

  // Security settings
  responseDelayMs: 50,         // Delay before sending response (anti-spoofing)
  maxRetries: 3,               // Max retries for failed responses

  // Performance settings
  maxOutputScan: 2048,         // Only scan last N bytes of output
  debounceMs: 100              // Debounce rapid status changes
};

/**
 * PermissionInterceptor - Auto-responds to CLI permission prompts
 */
class PermissionInterceptor extends EventEmitter {
  /**
   * @param {Object} options
   * @param {PersistentSessionManager} options.sessionManager
   * @param {PermissionManager} options.permissionManager
   * @param {Object} [options.config] - Override default config
   */
  constructor(options) {
    super();

    const { sessionManager, permissionManager, config = {} } = options;

    if (!sessionManager) {
      throw new Error('sessionManager is required');
    }
    if (!permissionManager) {
      throw new Error('permissionManager is required');
    }

    this.sessionManager = sessionManager;
    this.permissionManager = permissionManager;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Active interceptors: terminalId -> InterceptorState
    this.interceptors = new Map();

    // Statistics
    this.stats = {
      promptsDetected: 0,
      promptsAllowed: 0,
      promptsDenied: 0,
      errors: 0
    };
  }

  /**
   * Start intercepting for a terminal
   * @param {string} terminalId
   * @returns {Function} Cleanup function to stop intercepting
   */
  start(terminalId) {
    if (this.interceptors.has(terminalId)) {
      console.warn(`Interceptor already running for terminal ${terminalId}`);
      return () => this.stop(terminalId);
    }

    const terminal = this.sessionManager.getTerminal(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    // Get parser for this adapter.
    // Some adapters (e.g. qwen-cli in one-shot/yolo mode) do not currently
    // expose interactive permission prompts we can intercept.
    // In that case, skip interceptor startup instead of failing handoff.
    let parser;
    try {
      parser = getParser(terminal.adapter);
    } catch (error) {
      const message = error?.message || String(error);
      console.warn(`[interceptor] Skipping for adapter ${terminal.adapter}: ${message}`);
      return () => {};
    }

    // Create interceptor state
    const state = {
      terminalId,
      adapter: terminal.adapter,
      parser,
      intervalId: null,
      lastOutputLength: 0,
      lastPromptHash: null,
      retryCount: 0,
      stopped: false
    };

    this.interceptors.set(terminalId, state);

    // Start polling loop
    this._startPolling(state);

    this.emit('interceptor-started', { terminalId, adapter: terminal.adapter });

    // Return cleanup function
    return () => this.stop(terminalId);
  }

  /**
   * Stop intercepting for a terminal
   * @param {string} terminalId
   */
  stop(terminalId) {
    const state = this.interceptors.get(terminalId);
    if (!state) {
      return;
    }

    state.stopped = true;

    if (state.intervalId) {
      clearTimeout(state.intervalId);
      state.intervalId = null;
    }

    this.interceptors.delete(terminalId);
    this.emit('interceptor-stopped', { terminalId });
  }

  /**
   * Stop all interceptors
   */
  stopAll() {
    for (const terminalId of this.interceptors.keys()) {
      this.stop(terminalId);
    }
  }

  /**
   * Start adaptive polling loop
   * @private
   */
  _startPolling(state) {
    if (state.stopped) return;

    const poll = async () => {
      if (state.stopped) return;

      try {
        await this._pollOnce(state);
      } catch (error) {
        console.error(`Interceptor error for ${state.terminalId}:`, error.message);
        this.stats.errors++;
        this.emit('interceptor-error', { terminalId: state.terminalId, error });
      }

      if (state.stopped) return;

      // Schedule next poll with adaptive interval
      const interval = this._getAdaptiveInterval(state);
      state.intervalId = setTimeout(poll, interval);
    };

    // Start immediately
    poll();
  }

  /**
   * Single poll iteration
   * @private
   */
  async _pollOnce(state) {
    const { terminalId, parser } = state;

    // Get current status
    const status = this.sessionManager.getStatus(terminalId);

    // Only process if waiting for permission
    if (status !== TerminalStatus.WAITING_PERMISSION) {
      state.retryCount = 0;
      return;
    }

    // Get output (only if we might need it)
    const output = this.sessionManager.getOutput(terminalId);
    if (!output) return;

    // Performance: Skip if output hasn't changed significantly
    if (output.length === state.lastOutputLength) {
      return;
    }
    state.lastOutputLength = output.length;

    // Parse permission prompt
    const promptInfo = parser.parse(output, status);
    if (!promptInfo) {
      return;
    }

    // Deduplicate: Don't respond to same prompt twice
    const promptHash = this._hashPrompt(promptInfo);
    if (promptHash === state.lastPromptHash) {
      state.retryCount++;
      if (state.retryCount > this.config.maxRetries) {
        this.emit('interceptor-max-retries', { terminalId, promptInfo });
        state.lastPromptHash = null; // Reset to allow retry
        state.retryCount = 0;
      }
      return;
    }

    this.stats.promptsDetected++;
    this.emit('prompt-detected', { terminalId, promptInfo });

    // Handle the prompt
    const result = await this.handlePrompt(terminalId, promptInfo);

    // Record that we handled this prompt
    state.lastPromptHash = promptHash;
    state.retryCount = 0;

    // Send response after security delay
    await this._delay(this.config.responseDelayMs);
    await this._respond(terminalId, result.allowed);

    // Emit result
    if (result.allowed) {
      this.stats.promptsAllowed++;
      this.emit('permission-allowed', { terminalId, promptInfo, result });
    } else {
      this.stats.promptsDenied++;
      this.emit('permission-denied', { terminalId, promptInfo, result });
    }
  }

  /**
   * Handle detected permission prompt
   * @param {string} terminalId
   * @param {PromptInfo} promptInfo
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async handlePrompt(terminalId, promptInfo) {
    try {
      const result = await this.permissionManager.checkPermission(
        promptInfo.toolName,
        promptInfo.args
      );
      return result;
    } catch (error) {
      console.error(`Permission check error for ${promptInfo.toolName}:`, error);
      // Default to deny on error (fail-safe)
      return { allowed: false, reason: `Error: ${error.message}` };
    }
  }

  /**
   * Send response to terminal
   * @private
   */
  async _respond(terminalId, allowed) {
    const response = allowed ? 'y' : 'n';

    try {
      // Send the response character
      this.sessionManager.sendSpecialKey(terminalId, response);

      // Small delay then send Enter
      await this._delay(50);
      this.sessionManager.sendSpecialKey(terminalId, 'Enter');
    } catch (error) {
      console.error(`Failed to send response to ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Get adaptive polling interval based on terminal state
   * @private
   */
  _getAdaptiveInterval(state) {
    const status = this.sessionManager.getStatus(state.terminalId);

    switch (status) {
      case TerminalStatus.WAITING_PERMISSION:
        return this.config.pollIntervalWaiting;
      case TerminalStatus.PROCESSING:
        return this.config.pollIntervalActive;
      default:
        return this.config.pollIntervalIdle;
    }
  }

  /**
   * Create hash of prompt for deduplication
   * @private
   */
  _hashPrompt(promptInfo) {
    return `${promptInfo.toolName}:${JSON.stringify(promptInfo.args)}`;
  }

  /**
   * Delay helper
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get interceptor statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeInterceptors: this.interceptors.size
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      promptsDetected: 0,
      promptsAllowed: 0,
      promptsDenied: 0,
      errors: 0
    };
  }

  /**
   * Check if interceptor is running for a terminal
   */
  isRunning(terminalId) {
    return this.interceptors.has(terminalId);
  }

  /**
   * Get list of terminals being intercepted
   */
  getActiveTerminals() {
    return Array.from(this.interceptors.keys());
  }
}

module.exports = { PermissionInterceptor, DEFAULT_CONFIG };
