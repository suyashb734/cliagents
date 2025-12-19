/**
 * Session Wrapper Utility
 *
 * Provides session management for stateless CLI tools.
 * Maintains conversation history and injects context into each prompt.
 */

class SessionWrapper {
  constructor(options = {}) {
    this.sessions = new Map();
    this.maxHistory = options.maxHistory || 10;
    this.maxTokensPerTurn = options.maxTokensPerTurn || 4000;  // Approximate token limit per turn
  }

  /**
   * Create a new wrapped session
   */
  createSession(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    this.sessions.set(sessionId, {
      history: [],
      systemPrompt: options.systemPrompt || '',
      createdAt: Date.now(),
      lastUsed: Date.now(),
      messageCount: 0
    });

    return { sessionId, status: 'ready' };
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId) {
    return this.sessions.has(sessionId);
  }

  /**
   * Get session info
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Build prompt with conversation context
   * Injects history into the new message for stateless CLIs
   */
  buildPromptWithContext(sessionId, newMessage) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.lastUsed = Date.now();

    // If no history, just return the message with optional system prompt
    if (session.history.length === 0) {
      if (session.systemPrompt) {
        return `${session.systemPrompt}\n\n${newMessage}`;
      }
      return newMessage;
    }

    // Build context from history
    let context = '';

    // Add system prompt if present
    if (session.systemPrompt) {
      context += `System: ${session.systemPrompt}\n\n`;
    }

    // Add conversation history
    context += 'Previous conversation:\n';
    for (const turn of session.history) {
      context += `User: ${this._truncate(turn.user, 500)}\n`;
      context += `Assistant: ${this._truncate(turn.assistant, 1000)}\n\n`;
    }

    // Add current message
    context += `Current request:\n${newMessage}`;

    return context;
  }

  /**
   * Build a minimal context prompt (for token-limited CLIs)
   */
  buildMinimalContext(sessionId, newMessage) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.lastUsed = Date.now();

    // Only include system prompt and last turn
    let context = '';

    if (session.systemPrompt) {
      context += `Context: ${session.systemPrompt}\n\n`;
    }

    if (session.history.length > 0) {
      const lastTurn = session.history[session.history.length - 1];
      context += `Previous:\nQ: ${this._truncate(lastTurn.user, 200)}\nA: ${this._truncate(lastTurn.assistant, 500)}\n\n`;
    }

    context += newMessage;

    return context;
  }

  /**
   * Add a conversation turn to history
   */
  addTurn(sessionId, userMessage, assistantResponse) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.history.push({
      user: userMessage,
      assistant: assistantResponse,
      timestamp: Date.now()
    });

    session.messageCount++;
    session.lastUsed = Date.now();

    // Trim history if too long
    if (session.history.length > this.maxHistory) {
      session.history = session.history.slice(-this.maxHistory);
    }
  }

  /**
   * Clear conversation history (but keep session)
   */
  clearHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.history = [];
    }
  }

  /**
   * Terminate a wrapped session
   */
  terminateSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }

  /**
   * Cleanup old sessions (call periodically)
   */
  cleanupOldSessions(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    const toDelete = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastUsed > maxAgeMs) {
        toDelete.push(sessionId);
      }
    }

    for (const sessionId of toDelete) {
      this.sessions.delete(sessionId);
    }

    return toDelete.length;
  }

  /**
   * Truncate text to max length
   */
  _truncate(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Estimate token count (rough approximation)
   */
  _estimateTokens(text) {
    if (!text) return 0;
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}

module.exports = SessionWrapper;
