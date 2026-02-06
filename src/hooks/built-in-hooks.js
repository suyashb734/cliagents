/**
 * Built-in hooks for common use cases
 *
 * These hooks can be registered with HookManager for common scenarios:
 * - Logging and auditing
 * - Security filtering
 * - Rate limiting
 * - Metrics collection
 */

'use strict';

/**
 * Create a logging hook that logs all tool invocations
 *
 * @param {Object} options
 * @param {Function} options.logger - Custom logger (default: console.log)
 * @param {boolean} options.logArgs - Include args in log (default: false)
 * @param {string[]} options.tools - Only log these tools (default: all)
 * @returns {Function} - Hook handler
 */
function createLoggingHook(options = {}) {
  const logger = options.logger || console.log;
  const logArgs = options.logArgs || false;
  const tools = options.tools || null;

  return (ctx) => {
    if (tools && !tools.includes(ctx.tool)) {
      return true;
    }

    const timestamp = new Date().toISOString();
    const argsStr = logArgs ? ` args=${JSON.stringify(ctx.args).slice(0, 100)}` : '';
    logger(`[${timestamp}] Tool: ${ctx.tool}${argsStr}`);

    return true;
  };
}

/**
 * Create a tool filter hook that blocks specific tools
 *
 * @param {string[]} blockedTools - Tools to block
 * @param {Object} options
 * @param {Function} options.onBlocked - Callback when blocked
 * @returns {Function} - Hook handler
 */
function createToolFilterHook(blockedTools, options = {}) {
  return (ctx) => {
    if (blockedTools.includes(ctx.tool)) {
      if (options.onBlocked) {
        options.onBlocked(ctx.tool, ctx.args);
      }
      return false;  // Block
    }
    return true;
  };
}

/**
 * Create a path filter hook that restricts file access
 *
 * @param {string[]} allowedPaths - Allowed path prefixes
 * @param {Object} options
 * @param {string[]} options.fileTools - Tools to check (default: Read, Write, Edit)
 * @returns {Function} - Hook handler
 */
function createPathFilterHook(allowedPaths, options = {}) {
  const path = require('path');
  const fileTools = options.fileTools || ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  const resolvedPaths = allowedPaths.map(p => path.resolve(p));

  return (ctx) => {
    if (!fileTools.includes(ctx.tool)) {
      return true;
    }

    const targetPath = ctx.args.file_path || ctx.args.path;
    if (!targetPath) {
      return true;
    }

    const resolvedTarget = path.resolve(targetPath);
    const allowed = resolvedPaths.some(p => resolvedTarget.startsWith(p));

    return allowed;
  };
}

/**
 * Create a rate limit hook
 *
 * @param {number} maxPerMinute - Maximum invocations per minute
 * @param {Object} options
 * @param {Object} options.perTool - Tool-specific limits { toolName: maxPerMinute }
 * @returns {Function} - Hook handler
 */
function createRateLimitHook(maxPerMinute, options = {}) {
  const invocations = [];
  const perToolInvocations = new Map();
  const windowMs = 60000;

  return (ctx) => {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Global rate limit
    const recentGlobal = invocations.filter(t => t > windowStart);
    if (recentGlobal.length >= maxPerMinute) {
      return false;
    }

    // Per-tool rate limit
    if (options.perTool && options.perTool[ctx.tool]) {
      if (!perToolInvocations.has(ctx.tool)) {
        perToolInvocations.set(ctx.tool, []);
      }
      const toolHistory = perToolInvocations.get(ctx.tool);
      const recentTool = toolHistory.filter(t => t > windowStart);

      if (recentTool.length >= options.perTool[ctx.tool]) {
        return false;
      }

      perToolInvocations.set(ctx.tool, [...recentTool, now]);
    }

    // Record invocation
    invocations.push(now);
    // Cleanup old entries
    while (invocations.length > 0 && invocations[0] < windowStart) {
      invocations.shift();
    }

    return true;
  };
}

/**
 * Create a metrics collection hook
 *
 * @param {Object} options
 * @param {Function} options.onMetric - Callback with metric data
 * @returns {Object} - { preHook, postHook, getMetrics }
 */
function createMetricsHook(options = {}) {
  const metrics = {
    toolCounts: new Map(),
    totalDuration: 0,
    invocations: 0,
    errors: 0
  };
  const pending = new Map();

  return {
    preHook: (ctx) => {
      const id = `${ctx.tool}_${Date.now()}_${Math.random()}`;
      pending.set(id, { tool: ctx.tool, startTime: Date.now() });
      ctx._metricsId = id;
      return { modified: { _metricsId: id } };
    },

    postHook: (ctx) => {
      const id = ctx._metricsId;
      if (id && pending.has(id)) {
        const { tool, startTime } = pending.get(id);
        const duration = Date.now() - startTime;

        metrics.invocations++;
        metrics.totalDuration += duration;
        metrics.toolCounts.set(tool, (metrics.toolCounts.get(tool) || 0) + 1);

        if (ctx.error) {
          metrics.errors++;
        }

        if (options.onMetric) {
          options.onMetric({ tool, duration, error: ctx.error });
        }

        pending.delete(id);
      }
    },

    getMetrics: () => ({
      invocations: metrics.invocations,
      errors: metrics.errors,
      avgDuration: metrics.invocations > 0 ?
        Math.round(metrics.totalDuration / metrics.invocations) : 0,
      toolCounts: Object.fromEntries(metrics.toolCounts)
    }),

    reset: () => {
      metrics.toolCounts.clear();
      metrics.totalDuration = 0;
      metrics.invocations = 0;
      metrics.errors = 0;
    }
  };
}

/**
 * Create a timeout hook that tracks long-running operations
 *
 * @param {number} warningMs - Time in ms before warning
 * @param {Object} options
 * @param {Function} options.onTimeout - Callback when timeout warning fires
 * @returns {Object} - { preHook, cleanup }
 */
function createTimeoutHook(warningMs, options = {}) {
  const timeouts = new Map();

  return {
    preHook: (ctx) => {
      const id = `${ctx.tool}_${Date.now()}`;
      const timer = setTimeout(() => {
        console.warn(`[TimeoutHook] Tool '${ctx.tool}' running for >${warningMs}ms`);
        if (options.onTimeout) {
          options.onTimeout(ctx.tool, ctx.args);
        }
      }, warningMs);

      timeouts.set(id, timer);
      return { modified: { _timeoutId: id } };
    },

    postHook: (ctx) => {
      const id = ctx._timeoutId;
      if (id && timeouts.has(id)) {
        clearTimeout(timeouts.get(id));
        timeouts.delete(id);
      }
    },

    cleanup: () => {
      for (const timer of timeouts.values()) {
        clearTimeout(timer);
      }
      timeouts.clear();
    }
  };
}

/**
 * Create a content filter hook that blocks sensitive patterns
 *
 * @param {RegExp[]} blockedPatterns - Patterns to block in content
 * @param {Object} options
 * @param {string[]} options.tools - Tools to check (default: Write, Edit)
 * @returns {Function} - Hook handler
 */
function createContentFilterHook(blockedPatterns, options = {}) {
  const tools = options.tools || ['Write', 'Edit'];

  return (ctx) => {
    if (!tools.includes(ctx.tool)) {
      return true;
    }

    const content = ctx.args.content || ctx.args.new_string || '';

    for (const pattern of blockedPatterns) {
      if (pattern.test(content)) {
        return false;  // Block
      }
    }

    return true;
  };
}

/**
 * Create a confirmation hook that requires explicit approval
 *
 * @param {string[]} dangerousTools - Tools that require confirmation
 * @param {Function} confirmFn - Function that returns Promise<boolean>
 * @returns {Function} - Hook handler
 */
function createConfirmationHook(dangerousTools, confirmFn) {
  return async (ctx) => {
    if (!dangerousTools.includes(ctx.tool)) {
      return true;
    }

    const approved = await confirmFn(ctx.tool, ctx.args);
    return approved;
  };
}

module.exports = {
  createLoggingHook,
  createToolFilterHook,
  createPathFilterHook,
  createRateLimitHook,
  createMetricsHook,
  createTimeoutHook,
  createContentFilterHook,
  createConfirmationHook
};
