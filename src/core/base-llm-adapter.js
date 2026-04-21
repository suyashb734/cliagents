/**
 * Base LLM Adapter
 *
 * Abstract class that defines the interface for all CLI Large Language Model (LLM) adapters.
 * Each adapter (Claude, Gemini, Codex, etc.) implements this interface.
 */

const { EventEmitter } = require('events');
const {
  FAILURE_CLASSES,
  TIMEOUT_TYPES,
  LIVENESS_STATES
} = require('../adapters/contract');

class BaseLLMAdapter extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      timeout: 60000,        // Default 60s timeout
      workDir: '/tmp/agent', // Default working directory
      ...config
    };
    this.name = 'base';      // Override in subclass
    this.version = '1.0.0';
    this._lastHeartbeat = new Map();
    this._livenessStaleThreshold = 30000;
  }

  /**
   * Get adapter info
   */
  getInfo() {
    const info = {
      name: this.name,
      version: this.version,
      config: this.config
    };

    if (typeof this.getCapabilities === 'function') {
      info.capabilities = this.getCapabilities();
    }

    if (typeof this.getContract === 'function') {
      info.contract = this.getContract();
    }

    return info;
  }

  /**
   * Check if the CLI tool is available
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    throw new Error('isAvailable() must be implemented by subclass');
  }

  /**
   * Spawn a new agent session
   * @param {string} sessionId - Unique session identifier
   * @param {object} options - Session options
   * @param {string} options.systemPrompt - Optional system prompt
   * @param {string[]} options.allowedTools - Optional list of allowed tools
   * @param {string} options.workDir - Working directory for the session
   * @returns {Promise<object>} Session info
   */
  async spawn(sessionId, options = {}) {
    throw new Error('spawn() must be implemented by subclass');
  }

  /**
   * Send a message to an active session
   * @param {string} sessionId - Session identifier
   * @param {string} message - Message to send
   * @param {object} options - Additional options
   * @returns {AsyncGenerator<object>} Yields response chunks
   */
  async *send(sessionId, message, options = {}) {
    throw new Error('send() must be implemented by subclass');
  }

  /**
   * Send a message and wait for complete response
   * @param {string} sessionId - Session identifier
   * @param {string} message - Message to send
   * @param {object} options - Additional options
   * @returns {Promise<object>} Complete response
   */
  async sendAndWait(sessionId, message, options = {}) {
    let fullResponse = '';
    let result = null;
    let truncated = false;
    const maxSize = this.config.maxResponseSize || 10 * 1024 * 1024; // 10MB default

    this.recordHeartbeat(sessionId);

    for await (const chunk of this.send(sessionId, message, options)) {
      this.recordHeartbeat(sessionId);
      if (chunk.type === 'text') {
        const chunkText = typeof chunk.content === 'string'
          ? chunk.content
          : typeof chunk.text === 'string'
            ? chunk.text
            : typeof chunk.chunk === 'string'
              ? chunk.chunk
              : '';

        if (fullResponse.length + chunkText.length < maxSize) {
          fullResponse += chunkText;
        } else if (!truncated) {
          truncated = true;
          this.emit('warning', { sessionId, message: 'Response truncated due to size limit' });
        }
        this.emit('chunk', { sessionId, chunk });
      } else if (chunk.type === 'progress') {
        if (chunk.progressType === 'assistant') {
          const chunkText = typeof chunk.content === 'string'
            ? chunk.content
            : typeof chunk.text === 'string'
              ? chunk.text
              : typeof chunk.chunk === 'string'
                ? chunk.chunk
              : '';

          if (chunkText && fullResponse.length + chunkText.length < maxSize) {
            fullResponse += chunkText;
          } else if (chunkText && !truncated) {
            truncated = true;
            this.emit('warning', { sessionId, message: 'Response truncated due to size limit' });
          }
        }
        this.emit('chunk', { sessionId, chunk });
      } else if (chunk.type === 'result') {
        result = chunk;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.content ?? chunk.message ?? 'unknown adapter error');
      }
    }

    const normalizedText = fullResponse || (typeof result?.content === 'string' ? result.content : '');

    return {
      text: normalizedText,
      result: result?.content ?? normalizedText,
      metadata: {
        ...result?.metadata,
        truncated,
        missingResult: !result
      },
      structuredOutput: result?.structuredOutput
    };
  }

  /**
   * Terminate a session
   * @param {string} sessionId - Session identifier
   * @returns {Promise<void>}
   */
  async terminate(sessionId) {
    throw new Error('terminate() must be implemented by subclass');
  }

  /**
   * Interrupt an active process for a session (graceful interrupt)
   * @param {string} sessionId - Session identifier
   * @returns {Promise<boolean>} True if a process was interrupted
   */
  async interrupt(sessionId) {
    // Default implementation using activeProcesses map if available
    if (this.activeProcesses?.has(sessionId)) {
      const proc = this.activeProcesses.get(sessionId);
      if (proc && !proc.killed) {
        proc.kill('SIGINT');
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a session is active
   * @param {string} sessionId - Session identifier
   * @returns {boolean}
   */
  isSessionActive(sessionId) {
    throw new Error('isSessionActive() must be implemented by subclass');
  }

  /**
   * Get all active session IDs
   * @returns {string[]}
   */
  getActiveSessions() {
    throw new Error('getActiveSessions() must be implemented by subclass');
  }

  /**
   * Describe the adapter's default timeout semantics for broker introspection.
   * @returns {{defaultTimeoutMs: number, defaultTimeoutType: string, timeoutTypes: object, supportsTimeoutOverride: boolean}}
   */
  getTimeoutInfo() {
    return {
      defaultTimeoutMs: this.config.timeout,
      defaultTimeoutType: TIMEOUT_TYPES.RESPONSE,
      timeoutTypes: { ...TIMEOUT_TYPES },
      supportsTimeoutOverride: true
    };
  }

  /**
   * Get the liveness state of a session
   * @param {string} sessionId - Session identifier
   * @returns {object} Liveness metadata { state: 'alive'|'stale'|'dead', lastHeartbeat: timestamp, msSinceHeartbeat: number }
   */
  getSessionLiveness(sessionId) {
    const lastHeartbeat = this._lastHeartbeat.get(sessionId);
    if (!lastHeartbeat) {
      return {
        state: LIVENESS_STATES.DEAD,
        lastHeartbeat: null,
        msSinceHeartbeat: null
      };
    }
    const msSinceHeartbeat = Date.now() - lastHeartbeat;
    const state = msSinceHeartbeat > this._livenessStaleThreshold
      ? LIVENESS_STATES.STALE
      : LIVENESS_STATES.ALIVE;
    return { state, lastHeartbeat, msSinceHeartbeat };
  }

  /**
   * Record a heartbeat for a session to indicate liveness
   * @param {string} sessionId - Session identifier
   * @returns {void}
   */
  recordHeartbeat(sessionId) {
    this._lastHeartbeat.set(sessionId, Date.now());
  }

  /**
   * Clear heartbeat state for a session (call in terminate() implementations)
   * @param {string} sessionId - Session identifier
   * @returns {void}
   */
  _clearHeartbeat(sessionId) {
    this._lastHeartbeat.delete(sessionId);
  }

  /**
   * Classify a provider/runtime failure into the broker's standard enum.
   * @param {Error|string|object} error - Error-like value to classify
   * @returns {string}
   */
  classifyFailure(error) {
    const explicitClass = String(error?.failureClass || error?.code || '')
      .trim()
      .toLowerCase();

    if (FAILURE_CLASSES.includes(explicitClass)) {
      return explicitClass;
    }

    const message = String(error?.message || error?.content || error || '').toLowerCase();

    if (error?.timedOut || message.includes('timeout') || message.includes('timed out') || message.includes('deadline exceeded')) {
      return 'timeout';
    }
    if (
      message.includes('auth') ||
      message.includes('credential') ||
      message.includes('login') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('subscription')
    ) {
      return 'auth';
    }
    if (
      message.includes('quota') ||
      message.includes('rate limit') ||
      message.includes('resourceexhausted') ||
      message.includes('capacity') ||
      message.includes('overloaded')
    ) {
      return 'rate_limit';
    }
    if (
      message.includes('tool error') ||
      message.includes('tool failed') ||
      message.includes('tool call failed') ||
      message.includes('tool rejected')
    ) {
      return 'tool_error';
    }
    if (
      message.includes('exit code') ||
      message.includes('process exited') ||
      message.includes('terminated') ||
      message.includes('killed') ||
      message.includes('sigterm')
    ) {
      return 'process_exit';
    }
    if (
      (message.includes('parse') && message.includes('json')) ||
      message.includes('invalid response format') ||
      message.includes('malformed')
    ) {
      return 'protocol_parse';
    }
    if (
      message.includes('validation') ||
      message.includes('missing_parameter') ||
      message.includes('required') ||
      message.includes('invalid argument') ||
      message.includes('bad request')
    ) {
      return 'validation';
    }
    if (
      message.includes('cancelled') ||
      message.includes('canceled') ||
      message.includes('interrupted') ||
      message.includes('aborted by user') ||
      message.includes('sigint')
    ) {
      return 'cancelled';
    }

    return 'unknown';
  }

  /**
   * Parse agent response into structured format
   * Subclasses should override this for agent-specific parsing
   * @param {string} text - Raw response text
   * @returns {object} Parsed response
   */
  parseResponse(text) {
    // Default implementation - try to extract JSON
    const jsonMatches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    if (jsonMatches) {
      for (const jsonMatch of jsonMatches) {
        try {
          return JSON.parse(jsonMatch);
        } catch (e) {
          // Continue to next match
        }
      }
    }
    return { text };
  }

  /**
   * Clean up all sessions
   * @returns {Promise<void>}
   */
  async cleanup() {
    const sessions = this.getActiveSessions();
    await Promise.all(sessions.map(id => this.terminate(id)));
    this._lastHeartbeat.clear();
  }
}

module.exports = BaseLLMAdapter;
