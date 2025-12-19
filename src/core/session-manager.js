/**
 * Session Manager
 *
 * Manages agent sessions across multiple adapters.
 * Provides a unified interface for creating, using, and cleaning up sessions.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapters = new Map();  // name -> adapter instance
    this.sessions = new Map();  // sessionId -> { adapter, createdAt, lastActivity }
    this.defaultAdapter = options.defaultAdapter || 'claude-code';
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 minutes
    this.maxSessions = options.maxSessions || 10;
    this._isShuttingDown = false;

    // Start cleanup interval with proper error handling
    this.cleanupInterval = setInterval(() => {
      this._cleanupStaleSessions().catch(err => {
        console.error('[SessionManager] Cleanup error:', err.message);
        this.emit('error', { type: 'cleanup_error', error: err });
      });
    }, 60000);
  }

  /**
   * Register an adapter
   */
  registerAdapter(name, adapter) {
    this.adapters.set(name, adapter);

    // Forward adapter events
    adapter.on('chunk', (data) => this.emit('chunk', { ...data, adapterName: name }));
    adapter.on('message', (data) => this.emit('message', { ...data, adapterName: name }));
    adapter.on('error', (data) => this.emit('error', { ...data, adapterName: name }));
    adapter.on('exit', (data) => {
      this.emit('exit', { ...data, adapterName: name });
      // Remove session from our tracking
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.sessionId === data.sessionId) {
          this.sessions.delete(sessionId);
          break;
        }
      }
    });

    this.emit('adapter:registered', { name, adapter: adapter.getInfo() });
    return this;
  }

  /**
   * Get registered adapter names
   */
  getAdapterNames() {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get adapter by name
   */
  getAdapter(name) {
    return this.adapters.get(name);
  }

  /**
   * Check adapter availability
   */
  async checkAdapterAvailability(name) {
    const adapter = this.adapters.get(name);
    if (!adapter) return false;
    return adapter.isAvailable();
  }

  /**
   * Generate unique session ID
   */
  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Create a new session
   */
  async createSession(options = {}) {
    const adapterName = options.adapter || this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);

    if (!adapter) {
      throw new Error(`Adapter '${adapterName}' not registered`);
    }

    // Check availability
    const available = await adapter.isAvailable();
    if (!available) {
      throw new Error(`Adapter '${adapterName}' CLI not available`);
    }

    // Check session limit
    if (this.sessions.size >= this.maxSessions) {
      await this._cleanupOldestSession();
    }

    const sessionId = options.sessionId || this.generateSessionId();

    // Spawn the session
    const result = await adapter.spawn(sessionId, {
      systemPrompt: options.systemPrompt,
      allowedTools: options.allowedTools,
      workDir: options.workDir,
      model: options.model,           // Model selection (adapter-specific)
      jsonSchema: options.jsonSchema, // JSON Schema for structured output (Claude only)
      // Generation parameters (Gemini only - writes to ~/.gemini/config.yaml)
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      max_output_tokens: options.max_output_tokens
    });

    // Track the session with status
    this.sessions.set(sessionId, {
      sessionId,
      adapterName,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'stable',         // 'stable' | 'running' | 'error'
      messageCount: 0
    });

    this.emit('session:created', { sessionId, adapterName, result });

    return {
      sessionId,
      adapter: adapterName,
      status: 'ready'
    };
  }

  /**
   * Send message to a session
   */
  async send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const adapter = this.adapters.get(session.adapterName);
    if (!adapter) {
      throw new Error(`Adapter '${session.adapterName}' not found`);
    }

    // Update activity timestamp and status
    session.lastActivity = Date.now();
    session.status = 'running';
    session.messageCount++;

    try {
      // Use sendAndWait for simpler API
      const response = await adapter.sendAndWait(sessionId, message, options);

      session.status = 'stable';
      session.lastActivity = Date.now();

      this.emit('session:message', { sessionId, message, response });

      return response;
    } catch (error) {
      session.status = 'error';
      session.lastActivity = Date.now();
      throw error;
    }
  }

  /**
   * Send message and stream responses
   */
  async *sendStream(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const adapter = this.adapters.get(session.adapterName);
    if (!adapter) {
      throw new Error(`Adapter '${session.adapterName}' not found`);
    }

    // Update activity timestamp and status
    session.lastActivity = Date.now();
    session.status = 'running';
    session.messageCount++;

    try {
      for await (const chunk of adapter.send(sessionId, message, options)) {
        yield chunk;
      }
      session.status = 'stable';
      session.lastActivity = Date.now();
    } catch (error) {
      session.status = 'error';
      session.lastActivity = Date.now();
      throw error;
    }
  }

  /**
   * Get session info
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session status with detailed info
   */
  getSessionStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const adapter = this.adapters.get(session.adapterName);
    const hasActiveProcess = adapter?.activeProcesses?.has(sessionId) || false;

    return {
      sessionId,
      status: session.status,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      adapterName: session.adapterName,
      hasActiveProcess,
      idleMs: Date.now() - session.lastActivity
    };
  }

  /**
   * Interrupt an active session (kill running process)
   */
  async interruptSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { interrupted: false, reason: 'session_not_found' };
    }

    const adapter = this.adapters.get(session.adapterName);
    if (!adapter) {
      return { interrupted: false, reason: 'adapter_not_found' };
    }

    const previousStatus = session.status;

    // Check if there's an active process to interrupt
    if (typeof adapter.interrupt === 'function') {
      const interrupted = await adapter.interrupt(sessionId);
      if (interrupted) {
        session.status = 'stable';
        session.lastActivity = Date.now();
        this.emit('session:interrupted', { sessionId, previousStatus });
        return { interrupted: true, previousStatus };
      }
    }

    // Fallback: check activeProcesses map directly
    const proc = adapter.activeProcesses?.get(sessionId);
    if (proc && !proc.killed) {
      proc.kill('SIGINT');
      session.status = 'stable';
      session.lastActivity = Date.now();
      this.emit('session:interrupted', { sessionId, previousStatus });
      return { interrupted: true, previousStatus };
    }

    return { interrupted: false, reason: 'no_active_process', previousStatus };
  }

  /**
   * List all active sessions
   */
  listSessions() {
    const sessions = [];
    for (const [sessionId, info] of this.sessions.entries()) {
      const adapter = this.adapters.get(info.adapterName);
      sessions.push({
        sessionId,
        adapter: info.adapterName,
        active: adapter ? adapter.isSessionActive(sessionId) : false,
        createdAt: info.createdAt,
        lastActivity: info.lastActivity,
        ageMs: Date.now() - info.createdAt,
        idleMs: Date.now() - info.lastActivity
      });
    }
    return sessions;
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const adapter = this.adapters.get(session.adapterName);
    if (adapter) {
      await adapter.terminate(sessionId);
    }

    this.sessions.delete(sessionId);
    this.emit('session:terminated', { sessionId });
    return true;
  }

  /**
   * Parse response from a session
   */
  parseResponse(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const adapter = this.adapters.get(session.adapterName);
    if (!adapter) {
      throw new Error(`Adapter '${session.adapterName}' not found`);
    }

    return adapter.parseResponse(text);
  }

  /**
   * Clean up stale sessions
   */
  async _cleanupStaleSessions() {
    const now = Date.now();
    const stale = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTimeout) {
        stale.push(sessionId);
      }
    }

    for (const sessionId of stale) {
      await this.terminateSession(sessionId);
      this.emit('session:timeout', { sessionId });
    }

    return stale.length;
  }

  /**
   * Clean up oldest session to make room
   */
  async _cleanupOldestSession() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastActivity < oldestTime) {
        oldest = sessionId;
        oldestTime = session.lastActivity;
      }
    }

    if (oldest) {
      await this.terminateSession(oldest);
      this.emit('session:evicted', { sessionId: oldest, reason: 'max_sessions_reached' });
    }
  }

  /**
   * Shutdown manager and all sessions
   */
  async shutdown() {
    if (this._isShuttingDown) return;
    this._isShuttingDown = true;

    console.log('[SessionManager] Shutting down...');
    clearInterval(this.cleanupInterval);

    // Terminate all sessions
    const sessions = Array.from(this.sessions.keys());
    console.log(`[SessionManager] Terminating ${sessions.length} active sessions...`);
    await Promise.all(sessions.map(id => this.terminateSession(id).catch(err => {
      console.error(`[SessionManager] Error terminating session ${id}:`, err.message);
    })));

    // Cleanup all adapters
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.cleanup();
      } catch (err) {
        console.error(`[SessionManager] Error cleaning up adapter:`, err.message);
      }
    }

    console.log('[SessionManager] Shutdown complete');
    this.emit('shutdown');
  }
}

module.exports = SessionManager;
