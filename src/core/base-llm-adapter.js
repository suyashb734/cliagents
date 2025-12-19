/**
 * Base LLM Adapter
 *
 * Abstract class that defines the interface for all CLI Large Language Model (LLM) adapters.
 * Each adapter (Claude, Gemini, Codex, etc.) implements this interface.
 */

const { EventEmitter } = require('events');

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
  }

  /**
   * Get adapter info
   */
  getInfo() {
    return {
      name: this.name,
      version: this.version,
      config: this.config
    };
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

    for await (const chunk of this.send(sessionId, message, options)) {
      if (chunk.type === 'text') {
        // Protect against "Invalid string length" error
        if (fullResponse.length + (chunk.content?.length || 0) < maxSize) {
          fullResponse += chunk.content;
        } else if (!truncated) {
          truncated = true;
          this.emit('warning', { sessionId, message: 'Response truncated due to size limit' });
        }
        this.emit('chunk', { sessionId, chunk });
      } else if (chunk.type === 'result') {
        result = chunk;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.content);
      }
    }

    return {
      text: fullResponse,
      result: result?.content || fullResponse,
      metadata: { ...result?.metadata, truncated } || { truncated },
      structuredOutput: result?.structuredOutput  // Pass through for JSON schema responses
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
  }
}

module.exports = BaseLLMAdapter;
