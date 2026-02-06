/**
 * Warm Agent Pool
 *
 * Maintains a pool of pre-started agent terminals to eliminate 30-90 second
 * startup times. When a handoff needs a terminal, it acquires one from the
 * pool instead of creating a new one.
 *
 * Architecture:
 * - Pool per adapter type (claude-code, gemini-cli, codex-cli)
 * - Background replenishment keeps pool at target size
 * - Terminals are "warmed" - started and ready at IDLE state
 * - Acquired terminals are removed from pool, returned or destroyed after use
 */

const EventEmitter = require('events');
const { TerminalStatus } = require('../models/terminal-status');

// Default pool configuration
const DEFAULT_CONFIG = {
  // Pool sizes per adapter (adjust based on expected workload)
  poolSizes: {
    'claude-code': 2,
    'gemini-cli': 2,
    'codex-cli': 1,
    'amazon-q': 1
  },
  // How long to wait for terminal initialization
  initTimeout: 90000,
  // Interval for checking pool health
  healthCheckInterval: 30000,
  // Max age for pooled terminal before refresh (10 min)
  maxTerminalAge: 10 * 60 * 1000,
  // Interval for background replenishment
  replenishInterval: 5000,
  // Enable automatic replenishment
  autoReplenish: true
};

/**
 * Warm Pool Manager
 */
class WarmPool extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.sessionManager - SessionManager instance
   * @param {Object} options.config - Pool configuration
   */
  constructor(options = {}) {
    super();

    if (!options.sessionManager) {
      throw new Error('WarmPool requires sessionManager');
    }

    this.sessionManager = options.sessionManager;
    this.config = { ...DEFAULT_CONFIG, ...options.config };

    // Pool storage: Map<adapter, Array<{terminalId, createdAt, status}>>
    this.pools = new Map();

    // Track which terminals are currently being created
    this.warming = new Map(); // adapter -> count

    // Track acquired terminals (for return/cleanup)
    this.acquired = new Map(); // terminalId -> {adapter, acquiredAt}

    // Background tasks
    this.replenishInterval = null;
    this.healthCheckInterval = null;

    // Stats
    this.stats = {
      acquired: 0,
      returned: 0,
      created: 0,
      destroyed: 0,
      poolHits: 0,
      poolMisses: 0
    };

    // Initialize pools
    for (const adapter of Object.keys(this.config.poolSizes)) {
      this.pools.set(adapter, []);
      this.warming.set(adapter, 0);
    }
  }

  /**
   * Start the warm pool (begin pre-warming and background tasks)
   */
  async start() {
    console.log('[WarmPool] Starting...');

    // Initial warm-up
    await this._warmAll();

    // Start background replenishment
    if (this.config.autoReplenish) {
      this.replenishInterval = setInterval(
        () => this._replenish(),
        this.config.replenishInterval
      );
    }

    // Start health checks
    this.healthCheckInterval = setInterval(
      () => this._healthCheck(),
      this.config.healthCheckInterval
    );

    this.emit('started', this.getStats());
    console.log('[WarmPool] Started:', this.getStats());
  }

  /**
   * Stop the warm pool and clean up
   */
  async stop() {
    console.log('[WarmPool] Stopping...');

    // Stop background tasks
    if (this.replenishInterval) {
      clearInterval(this.replenishInterval);
      this.replenishInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Destroy all pooled terminals
    const destroyPromises = [];
    for (const [adapter, pool] of this.pools) {
      for (const entry of pool) {
        destroyPromises.push(
          this._destroyTerminal(entry.terminalId).catch(e => {
            console.warn(`[WarmPool] Failed to destroy ${entry.terminalId}:`, e.message);
          })
        );
      }
      pool.length = 0;
    }

    // Destroy acquired terminals that weren't returned
    for (const [terminalId] of this.acquired) {
      destroyPromises.push(
        this._destroyTerminal(terminalId).catch(e => {
          console.warn(`[WarmPool] Failed to destroy acquired ${terminalId}:`, e.message);
        })
      );
    }
    this.acquired.clear();

    await Promise.all(destroyPromises);

    this.emit('stopped');
    console.log('[WarmPool] Stopped');
  }

  /**
   * Acquire a warm terminal from the pool
   *
   * @param {string} adapter - Adapter type
   * @param {Object} options - Additional options
   * @returns {Promise<{terminalId: string, fromPool: boolean}>}
   */
  async acquire(adapter, options = {}) {
    const pool = this.pools.get(adapter);

    if (!pool) {
      // Unknown adapter - create on demand
      console.log(`[WarmPool] Unknown adapter ${adapter}, creating on demand`);
      const terminal = await this._createTerminal(adapter, options);
      this.stats.poolMisses++;
      this.acquired.set(terminal.terminalId, {
        adapter,
        acquiredAt: Date.now()
      });
      this.stats.acquired++;
      this.emit('acquired', { terminalId: terminal.terminalId, fromPool: false });
      return { terminalId: terminal.terminalId, fromPool: false };
    }

    // Try to get from pool
    if (pool.length > 0) {
      // Get oldest terminal (FIFO to prevent staleness)
      const entry = pool.shift();

      // Verify it's still healthy
      const status = this.sessionManager.getStatus(entry.terminalId);
      if (status === TerminalStatus.IDLE) {
        this.acquired.set(entry.terminalId, {
          adapter,
          acquiredAt: Date.now()
        });
        this.stats.acquired++;
        this.stats.poolHits++;
        console.log(`[WarmPool] Acquired ${entry.terminalId} from pool (${pool.length} remaining)`);
        this.emit('acquired', { terminalId: entry.terminalId, fromPool: true });
        return { terminalId: entry.terminalId, fromPool: true };
      } else {
        // Terminal became unhealthy, destroy and try again
        console.warn(`[WarmPool] Pooled terminal ${entry.terminalId} unhealthy (${status}), destroying`);
        await this._destroyTerminal(entry.terminalId);
      }
    }

    // Pool empty - create on demand
    console.log(`[WarmPool] Pool empty for ${adapter}, creating on demand`);
    this.stats.poolMisses++;
    const terminal = await this._createTerminal(adapter, options);
    this.acquired.set(terminal.terminalId, {
      adapter,
      acquiredAt: Date.now()
    });
    this.stats.acquired++;
    this.emit('acquired', { terminalId: terminal.terminalId, fromPool: false });
    return { terminalId: terminal.terminalId, fromPool: false };
  }

  /**
   * Release a terminal back to the pool or destroy it
   *
   * @param {string} terminalId - Terminal to release
   * @param {Object} options
   * @param {boolean} options.destroy - Force destroy instead of returning to pool
   * @param {boolean} options.clearContext - Clear context before returning (not implemented yet)
   */
  async release(terminalId, options = {}) {
    const entry = this.acquired.get(terminalId);
    if (!entry) {
      console.warn(`[WarmPool] Unknown terminal ${terminalId}, destroying`);
      await this._destroyTerminal(terminalId);
      return;
    }

    this.acquired.delete(terminalId);

    // Check if we should return to pool
    const pool = this.pools.get(entry.adapter);
    const targetSize = this.config.poolSizes[entry.adapter] || 0;

    // Return to pool if:
    // 1. Pool exists and not full
    // 2. Not explicitly asked to destroy
    // 3. Terminal is still healthy
    if (
      !options.destroy &&
      pool &&
      pool.length < targetSize
    ) {
      const status = this.sessionManager.getStatus(terminalId);
      if (status === TerminalStatus.IDLE) {
        pool.push({
          terminalId,
          createdAt: Date.now(), // Reset age
          status
        });
        this.stats.returned++;
        console.log(`[WarmPool] Returned ${terminalId} to pool (${pool.length}/${targetSize})`);
        this.emit('returned', { terminalId, adapter: entry.adapter });
        return;
      }
    }

    // Destroy the terminal
    await this._destroyTerminal(terminalId);
    this.emit('destroyed', { terminalId, adapter: entry.adapter });
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const poolStats = {};
    for (const [adapter, pool] of this.pools) {
      const target = this.config.poolSizes[adapter] || 0;
      const warming = this.warming.get(adapter) || 0;
      poolStats[adapter] = {
        available: pool.length,
        target,
        warming
      };
    }

    return {
      ...this.stats,
      pools: poolStats,
      acquiredCount: this.acquired.size
    };
  }

  /**
   * Create a new terminal
   * @private
   */
  async _createTerminal(adapter, options = {}) {
    this.stats.created++;
    const terminal = await this.sessionManager.createTerminal({
      adapter,
      role: 'worker',
      ...options
    });

    // Wait for IDLE state
    try {
      await this.sessionManager.waitForStatus(
        terminal.terminalId,
        TerminalStatus.IDLE,
        this.config.initTimeout
      );
    } catch (error) {
      await this._destroyTerminal(terminal.terminalId).catch(() => {});
      throw error;
    }

    return terminal;
  }

  /**
   * Destroy a terminal
   * @private
   */
  async _destroyTerminal(terminalId) {
    this.stats.destroyed++;
    await this.sessionManager.destroyTerminal(terminalId);
  }

  /**
   * Warm up all pools to target sizes
   * @private
   */
  async _warmAll() {
    const promises = [];

    for (const [adapter, targetSize] of Object.entries(this.config.poolSizes)) {
      const pool = this.pools.get(adapter);
      const needed = targetSize - pool.length - (this.warming.get(adapter) || 0);

      for (let i = 0; i < needed; i++) {
        promises.push(this._warmOne(adapter));
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * Warm up a single terminal for an adapter
   * @private
   */
  async _warmOne(adapter) {
    const pool = this.pools.get(adapter);
    const targetSize = this.config.poolSizes[adapter] || 0;

    // Check if we still need more
    const warming = this.warming.get(adapter) || 0;
    if (pool.length + warming >= targetSize) {
      return;
    }

    // Mark as warming
    this.warming.set(adapter, warming + 1);

    try {
      console.log(`[WarmPool] Warming ${adapter} terminal...`);
      const terminal = await this._createTerminal(adapter);

      // Double-check we still need it
      if (pool.length < targetSize) {
        pool.push({
          terminalId: terminal.terminalId,
          createdAt: Date.now(),
          status: TerminalStatus.IDLE
        });
        console.log(`[WarmPool] Warmed ${adapter} terminal: ${terminal.terminalId} (${pool.length}/${targetSize})`);
        this.emit('warmed', { terminalId: terminal.terminalId, adapter });
      } else {
        // Pool filled while we were creating, destroy
        await this._destroyTerminal(terminal.terminalId);
      }
    } catch (error) {
      console.error(`[WarmPool] Failed to warm ${adapter}:`, error.message);
      this.emit('warmError', { adapter, error });
    } finally {
      this.warming.set(adapter, (this.warming.get(adapter) || 1) - 1);
    }
  }

  /**
   * Replenish pools that are below target
   * @private
   */
  async _replenish() {
    for (const [adapter, targetSize] of Object.entries(this.config.poolSizes)) {
      const pool = this.pools.get(adapter);
      const warming = this.warming.get(adapter) || 0;
      const needed = targetSize - pool.length - warming;

      if (needed > 0) {
        // Don't await - let it run in background
        this._warmOne(adapter).catch(e => {
          console.error(`[WarmPool] Replenish error for ${adapter}:`, e.message);
        });
      }
    }
  }

  /**
   * Check health of pooled terminals
   * @private
   */
  async _healthCheck() {
    const now = Date.now();

    for (const [adapter, pool] of this.pools) {
      // Check each terminal in pool
      for (let i = pool.length - 1; i >= 0; i--) {
        const entry = pool[i];

        try {
          // Check age
          if (now - entry.createdAt > this.config.maxTerminalAge) {
            console.log(`[WarmPool] Terminal ${entry.terminalId} too old, refreshing`);
            pool.splice(i, 1);
            this._destroyTerminal(entry.terminalId).catch(() => {});
            continue;
          }

          // Check status
          const status = this.sessionManager.getStatus(entry.terminalId);
          if (status !== TerminalStatus.IDLE) {
            console.log(`[WarmPool] Terminal ${entry.terminalId} unhealthy (${status}), removing`);
            pool.splice(i, 1);
            this._destroyTerminal(entry.terminalId).catch(() => {});
          }
        } catch (error) {
          console.warn(`[WarmPool] Health check failed for ${entry.terminalId}:`, error.message);
          pool.splice(i, 1);
          this._destroyTerminal(entry.terminalId).catch(() => {});
        }
      }
    }
  }
}

module.exports = { WarmPool, DEFAULT_CONFIG };
