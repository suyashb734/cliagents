/**
 * Circuit Breaker
 *
 * Prevents cascade failures in multi-agent orchestration by detecting
 * when an agent/adapter is failing and stopping requests to it temporarily.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failures exceeded threshold, requests fail immediately
 * - HALF_OPEN: Testing if service recovered, allowing limited requests
 *
 * Pattern: closed → open (after threshold failures) → half-open (after timeout) → closed/open
 */

const EventEmitter = require('events');

const CircuitState = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open'
};

class CircuitBreaker extends EventEmitter {
  /**
   * Create a circuit breaker
   *
   * @param {Object} options
   * @param {number} options.failureThreshold - Failures before opening (default: 3)
   * @param {number} options.resetTimeout - Ms to wait before half-open (default: 30000)
   * @param {number} options.successThreshold - Successes in half-open to close (default: 2)
   * @param {number} options.timeout - Request timeout in ms (default: 60000)
   * @param {string} options.name - Circuit name for logging (default: 'circuit')
   */
  constructor(options = {}) {
    super();

    this.name = options.name || 'circuit';
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeout = options.resetTimeout || 30000;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 60000;

    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.resetTimer = null;

    // Stats
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      timeouts: 0,
      stateChanges: []
    };
  }

  /**
   * Execute a function through the circuit breaker
   *
   * @param {Function} fn - Async function to execute
   * @param {*} fallback - Fallback value if circuit is open (optional)
   * @returns {Promise<*>} - Result of fn or fallback
   * @throws {Error} - If circuit is open and no fallback provided
   */
  async execute(fn, fallback = null) {
    this.stats.totalRequests++;

    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      // Check if reset timeout has passed
      if (this._shouldAttemptReset()) {
        this._transitionTo(CircuitState.HALF_OPEN);
      } else {
        this.stats.rejectedRequests++;
        if (fallback !== null) {
          return typeof fallback === 'function' ? fallback() : fallback;
        }
        throw new CircuitOpenError(`Circuit breaker ${this.name} is open`, {
          state: this.state,
          failures: this.failures,
          lastFailure: this.lastFailure,
          resetIn: this.resetTimeout - (Date.now() - this.lastFailure)
        });
      }
    }

    // Execute with timeout
    try {
      const result = await this._executeWithTimeout(fn);
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  /**
   * Record a successful request outcome without executing a wrapped function.
   * Useful when the caller already executed work elsewhere but still wants the
   * circuit state machine to observe the outcome.
   */
  recordSuccess() {
    this.stats.totalRequests++;
    this._onSuccess();
    return this.getState();
  }

  /**
   * Record a failed request outcome without executing a wrapped function.
   * Useful for external orchestration feedback loops.
   * @param {Error|string|object} error
   */
  recordFailure(error) {
    this.stats.totalRequests++;
    this._onFailure(error);
    return this.getState();
  }

  /**
   * Execute function with timeout
   */
  async _executeWithTimeout(fn) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.stats.timeouts++;
        reject(new TimeoutError(`Circuit breaker ${this.name} timeout after ${this.timeout}ms`));
      }, this.timeout);

      Promise.resolve(fn())
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Handle successful execution
   */
  _onSuccess() {
    this.stats.successfulRequests++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this._transitionTo(CircuitState.CLOSED);
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success
      this.failures = 0;
    }
  }

  /**
   * Handle failed execution
   */
  _onFailure(error) {
    this.stats.failedRequests++;
    this.lastFailure = Date.now();
    this.failures++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open goes back to open
      this._transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failures >= this.failureThreshold) {
        this._transitionTo(CircuitState.OPEN);
      }
    }
  }

  /**
   * Check if we should attempt reset
   */
  _shouldAttemptReset() {
    return this.lastFailure && (Date.now() - this.lastFailure >= this.resetTimeout);
  }

  /**
   * Transition to new state
   */
  _transitionTo(newState) {
    const oldState = this.state;
    if (oldState === newState) {
      if (newState === CircuitState.CLOSED) {
        this.failures = 0;
        this.successes = 0;
      } else if (newState === CircuitState.HALF_OPEN) {
        this.successes = 0;
      }
      return;
    }

    this.state = newState;

    // Record state change
    this.stats.stateChanges.push({
      from: oldState,
      to: newState,
      timestamp: new Date().toISOString(),
      failures: this.failures
    });

    // Keep only last 10 state changes
    if (this.stats.stateChanges.length > 10) {
      this.stats.stateChanges.shift();
    }

    // Reset counters based on new state
    if (newState === CircuitState.CLOSED) {
      this.failures = 0;
      this.successes = 0;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successes = 0;
    }

    // Emit state change event
    this.emit('stateChange', {
      circuit: this.name,
      from: oldState,
      to: newState,
      failures: this.failures
    });

    console.log(`[CircuitBreaker:${this.name}] ${oldState} → ${newState} (failures: ${this.failures})`);
  }

  /**
   * Get current state
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      isOpen: this.state === CircuitState.OPEN,
      stats: { ...this.stats }
    };
  }

  /**
   * Force circuit to closed state (manual recovery)
   */
  reset() {
    this._transitionTo(CircuitState.CLOSED);
    this.lastFailure = null;
  }

  /**
   * Force circuit to open state (manual trip)
   */
  trip() {
    this.lastFailure = Date.now();
    this._transitionTo(CircuitState.OPEN);
  }
}

/**
 * Circuit open error
 */
class CircuitOpenError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CircuitOpenError';
    this.details = details;
    this.isCircuitOpen = true;
  }
}

/**
 * Timeout error
 */
class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.isTimeout = true;
  }
}

/**
 * Circuit Breaker Registry - manages multiple circuits
 */
class CircuitBreakerRegistry {
  constructor(defaultOptions = {}) {
    this.circuits = new Map();
    this.defaultOptions = defaultOptions;
  }

  /**
   * Get or create a circuit breaker for a key
   */
  getCircuit(key, options = {}) {
    if (!this.circuits.has(key)) {
      this.circuits.set(key, new CircuitBreaker({
        ...this.defaultOptions,
        ...options,
        name: key
      }));
    }
    return this.circuits.get(key);
  }

  /**
   * Execute through a named circuit
   */
  async execute(key, fn, fallback = null, options = {}) {
    const circuit = this.getCircuit(key, options);
    return circuit.execute(fn, fallback);
  }

  /**
   * Record a successful outcome for a named circuit.
   */
  recordSuccess(key, options = {}) {
    const circuit = this.getCircuit(key, options);
    return circuit.recordSuccess();
  }

  /**
   * Record a failed outcome for a named circuit.
   * @param {string} key
   * @param {Error|string|object} error
   */
  recordFailure(key, error, options = {}) {
    const circuit = this.getCircuit(key, options);
    return circuit.recordFailure(error);
  }

  /**
   * Get all circuit states
   */
  getAllStates() {
    const states = {};
    for (const [key, circuit] of this.circuits) {
      states[key] = circuit.getState();
    }
    return states;
  }

  /**
   * Reset all circuits
   */
  resetAll() {
    for (const circuit of this.circuits.values()) {
      circuit.reset();
    }
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitState,
  CircuitOpenError,
  TimeoutError
};
