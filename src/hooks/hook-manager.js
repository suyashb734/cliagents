/**
 * HookManager - Event-based hook system for CLI agents
 *
 * Provides PreToolUse/PostToolUse hooks similar to Claude Code subagents.
 *
 * Hook types:
 * - PreToolUse: Before tool execution (can block or modify)
 * - PostToolUse: After tool execution (can transform output)
 * - OnError: When errors occur
 * - OnComplete: When task completes
 * - OnStart: When task starts
 * - OnStatusChange: When terminal status changes
 *
 * @example
 * ```javascript
 * const manager = new HookManager();
 *
 * // Block bash execution
 * manager.register('PreToolUse', async (ctx) => {
 *   if (ctx.tool === 'Bash') return false;  // Block
 *   return true;  // Allow
 * });
 *
 * // Log all tool usage
 * manager.register('PostToolUse', (ctx) => {
 *   console.log(`Tool ${ctx.tool} completed in ${ctx.duration}ms`);
 * });
 *
 * // Run hooks
 * const result = await manager.run('PreToolUse', { tool: 'Bash', args: {} });
 * if (result.blocked) {
 *   console.log('Blocked:', result.reason);
 * }
 * ```
 */

'use strict';

const { EventEmitter } = require('events');

/**
 * Supported hook event types
 */
const HOOK_EVENTS = {
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  ON_ERROR: 'OnError',
  ON_COMPLETE: 'OnComplete',
  ON_START: 'OnStart',
  ON_STATUS_CHANGE: 'OnStatusChange',
  PRE_SKILL_INVOKE: 'PreSkillInvoke',
  POST_SKILL_INVOKE: 'PostSkillInvoke'
};

/**
 * Hook handler result
 * @typedef {Object} HookResult
 * @property {boolean} blocked - Whether execution was blocked
 * @property {string} [reason] - Reason for blocking
 * @property {Object} [context] - Modified context (for transforming hooks)
 */

class HookManager extends EventEmitter {
  constructor() {
    super();
    this.hooks = new Map();
    this.enabled = true;

    // Initialize empty arrays for each event type
    for (const event of Object.values(HOOK_EVENTS)) {
      this.hooks.set(event, []);
    }

    // Statistics
    this.stats = {
      registered: 0,
      executed: 0,
      blocked: 0,
      errors: 0
    };
  }

  /**
   * Register a hook handler
   *
   * @param {string} event - Event type (PreToolUse, PostToolUse, etc.)
   * @param {Function} handler - Handler function(context) -> boolean|object|void
   *   - Return false to block execution (PreToolUse only)
   *   - Return { modified: {...} } to modify context
   *   - Return void/true to continue
   * @param {Object} options
   * @param {number} options.priority - Higher priority runs first (default: 0)
   * @param {string} options.name - Name for debugging
   * @param {boolean} options.once - Run only once then unregister
   */
  register(event, handler, options = {}) {
    if (!this.hooks.has(event)) {
      throw new Error(`Unknown hook event: ${event}. Valid events: ${Object.values(HOOK_EVENTS).join(', ')}`);
    }

    const hookEntry = {
      handler,
      priority: options.priority || 0,
      name: options.name || `hook_${this.stats.registered}`,
      once: options.once || false,
      enabled: true
    };

    this.hooks.get(event).push(hookEntry);

    // Sort by priority (higher first)
    this.hooks.get(event).sort((a, b) => b.priority - a.priority);

    this.stats.registered++;
    this.emit('hook-registered', { event, name: hookEntry.name });

    // Return unregister function
    return () => this.unregister(event, hookEntry.name);
  }

  /**
   * Unregister a hook by name
   * @param {string} event - Event type
   * @param {string} name - Hook name
   * @returns {boolean} - Whether hook was found and removed
   */
  unregister(event, name) {
    if (!this.hooks.has(event)) return false;

    const hooks = this.hooks.get(event);
    const index = hooks.findIndex(h => h.name === name);

    if (index !== -1) {
      hooks.splice(index, 1);
      this.emit('hook-unregistered', { event, name });
      return true;
    }

    return false;
  }

  /**
   * Run all hooks for an event
   *
   * @param {string} event - Event type
   * @param {Object} context - Context passed to handlers
   * @returns {Promise<HookResult>}
   */
  async run(event, context = {}) {
    if (!this.enabled) {
      return { blocked: false, context };
    }

    const hooks = this.hooks.get(event) || [];
    let result = { ...context };
    const toRemove = [];

    for (const hook of hooks) {
      if (!hook.enabled) continue;

      try {
        this.stats.executed++;
        const response = await hook.handler(result);

        // Handle different response types
        if (response === false) {
          // Block execution
          this.stats.blocked++;
          this.emit('hook-blocked', { event, hook: hook.name, context: result });
          return {
            blocked: true,
            reason: `Blocked by hook: ${hook.name}`,
            context: result
          };
        }

        if (response && typeof response === 'object') {
          // Merge modified context
          if (response.modified) {
            result = { ...result, ...response.modified };
          } else if (response.context) {
            result = { ...result, ...response.context };
          }
        }

        // Mark for removal if once
        if (hook.once) {
          toRemove.push(hook.name);
        }

      } catch (error) {
        this.stats.errors++;
        this.emit('hook-error', { event, hook: hook.name, error });

        // Don't let hook errors block execution
        console.error(`[HookManager] Error in hook '${hook.name}':`, error.message);
      }
    }

    // Remove one-time hooks
    for (const name of toRemove) {
      this.unregister(event, name);
    }

    return { blocked: false, context: result };
  }

  /**
   * Create PreToolUse hook (convenience method)
   * @param {Function} handler
   * @param {Object} options
   */
  onPreToolUse(handler, options = {}) {
    return this.register(HOOK_EVENTS.PRE_TOOL_USE, handler, options);
  }

  /**
   * Create PostToolUse hook (convenience method)
   * @param {Function} handler
   * @param {Object} options
   */
  onPostToolUse(handler, options = {}) {
    return this.register(HOOK_EVENTS.POST_TOOL_USE, handler, options);
  }

  /**
   * Create OnError hook (convenience method)
   * @param {Function} handler
   * @param {Object} options
   */
  onError(handler, options = {}) {
    return this.register(HOOK_EVENTS.ON_ERROR, handler, options);
  }

  /**
   * Create OnComplete hook (convenience method)
   * @param {Function} handler
   * @param {Object} options
   */
  onComplete(handler, options = {}) {
    return this.register(HOOK_EVENTS.ON_COMPLETE, handler, options);
  }

  /**
   * Create OnStart hook (convenience method)
   * @param {Function} handler
   * @param {Object} options
   */
  onStart(handler, options = {}) {
    return this.register(HOOK_EVENTS.ON_START, handler, options);
  }

  /**
   * Create OnStatusChange hook (convenience method)
   * @param {Function} handler
   * @param {Object} options
   */
  onStatusChange(handler, options = {}) {
    return this.register(HOOK_EVENTS.ON_STATUS_CHANGE, handler, options);
  }

  /**
   * Create PreSkillInvoke hook (convenience method)
   * Called before a skill is invoked. Can modify context or block invocation.
   * @param {Function} handler - Receives { skillName, context }
   * @param {Object} options
   */
  onPreSkillInvoke(handler, options = {}) {
    return this.register(HOOK_EVENTS.PRE_SKILL_INVOKE, handler, options);
  }

  /**
   * Create PostSkillInvoke hook (convenience method)
   * Called after a skill has been invoked. Receives skill result.
   * @param {Function} handler - Receives { skillName, result, context }
   * @param {Object} options
   */
  onPostSkillInvoke(handler, options = {}) {
    return this.register(HOOK_EVENTS.POST_SKILL_INVOKE, handler, options);
  }

  /**
   * Enable all hooks
   */
  enable() {
    this.enabled = true;
    this.emit('hooks-enabled');
  }

  /**
   * Disable all hooks (bypass)
   */
  disable() {
    this.enabled = false;
    this.emit('hooks-disabled');
  }

  /**
   * Enable/disable specific hook by name
   * @param {string} event - Event type
   * @param {string} name - Hook name
   * @param {boolean} enabled - Enable state
   */
  setHookEnabled(event, name, enabled) {
    const hooks = this.hooks.get(event) || [];
    const hook = hooks.find(h => h.name === name);
    if (hook) {
      hook.enabled = enabled;
    }
  }

  /**
   * Get all registered hooks
   * @returns {Object} - Map of event -> hooks
   */
  getHooks() {
    const result = {};
    for (const [event, hooks] of this.hooks) {
      result[event] = hooks.map(h => ({
        name: h.name,
        priority: h.priority,
        once: h.once,
        enabled: h.enabled
      }));
    }
    return result;
  }

  /**
   * Get hook statistics
   * @returns {Object}
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Clear all hooks
   */
  clear() {
    for (const event of Object.values(HOOK_EVENTS)) {
      this.hooks.set(event, []);
    }
    this.stats = {
      registered: 0,
      executed: 0,
      blocked: 0,
      errors: 0
    };
    this.emit('hooks-cleared');
  }
}

module.exports = {
  HookManager,
  HOOK_EVENTS
};
