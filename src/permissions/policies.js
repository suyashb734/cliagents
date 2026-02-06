/**
 * Built-in permission policies for PermissionManager
 *
 * Policies are objects with a check(toolName, args, manager) method that returns:
 * - { allowed: true } to permit the action
 * - { allowed: false, reason: '...' } to deny
 * - { allowed: true, modifiedArgs: {...} } to permit with modified arguments
 */

'use strict';

/**
 * ReadOnlyPolicy - Denies all write/modify operations
 *
 * Useful for:
 * - Code review agents that should only read
 * - Research agents gathering information
 * - Plan-mode agents
 */
class ReadOnlyPolicy {
  constructor() {
    this.name = 'ReadOnlyPolicy';
    this.writeTools = ['Write', 'Edit', 'NotebookEdit', 'Bash'];
  }

  check(toolName, args) {
    if (this.writeTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `ReadOnlyPolicy: '${toolName}' is a write operation`
      };
    }
    return { allowed: true };
  }
}

/**
 * SandboxPolicy - Restricts file access to specific directories
 *
 * More restrictive than PermissionManager's path checks:
 * - Enforces absolute path resolution
 * - Blocks directory traversal attempts
 * - Logs access attempts for auditing
 */
class SandboxPolicy {
  /**
   * @param {string[]} sandboxPaths - Allowed directories
   * @param {Object} options
   * @param {boolean} options.allowTraversal - Allow .. in paths (default: false)
   * @param {Function} options.onViolation - Callback for violations
   */
  constructor(sandboxPaths, options = {}) {
    this.name = 'SandboxPolicy';
    this.sandboxPaths = sandboxPaths.map(p => require('path').resolve(p));
    this.allowTraversal = options.allowTraversal || false;
    this.onViolation = options.onViolation || null;
  }

  check(toolName, args) {
    const path = require('path');
    const targetPath = args.file_path || args.path || args.filePath || args.notebook_path;

    if (!targetPath) {
      return { allowed: true };
    }

    // Check for directory traversal
    if (!this.allowTraversal && targetPath.includes('..')) {
      this._reportViolation('Directory traversal attempt', toolName, targetPath);
      return {
        allowed: false,
        reason: `SandboxPolicy: Directory traversal not allowed`
      };
    }

    const resolvedPath = path.resolve(targetPath);

    // Check if within sandbox
    const inSandbox = this.sandboxPaths.some(sandbox =>
      resolvedPath.startsWith(sandbox)
    );

    if (!inSandbox) {
      this._reportViolation('Path outside sandbox', toolName, targetPath);
      return {
        allowed: false,
        reason: `SandboxPolicy: Path '${targetPath}' is outside sandbox`
      };
    }

    return { allowed: true };
  }

  _reportViolation(type, toolName, path) {
    if (this.onViolation) {
      this.onViolation({ type, toolName, path, timestamp: new Date() });
    }
  }
}

/**
 * RateLimitPolicy - Limits tool invocations per time window
 *
 * Useful for:
 * - Preventing runaway agents
 * - Controlling API costs
 * - Resource management
 */
class RateLimitPolicy {
  /**
   * @param {Object} limits - Tool-specific limits { toolName: { max: N, windowMs: M } }
   * @param {Object} options
   * @param {number} options.defaultMax - Default max invocations (100)
   * @param {number} options.defaultWindowMs - Default window in ms (60000)
   */
  constructor(limits = {}, options = {}) {
    this.name = 'RateLimitPolicy';
    this.limits = limits;
    this.defaultMax = options.defaultMax || 100;
    this.defaultWindowMs = options.defaultWindowMs || 60000;
    this.invocations = new Map(); // toolName -> [{timestamp}]
  }

  check(toolName, args) {
    const now = Date.now();
    const limit = this.limits[toolName] || {
      max: this.defaultMax,
      windowMs: this.defaultWindowMs
    };

    // Get invocation history for this tool
    if (!this.invocations.has(toolName)) {
      this.invocations.set(toolName, []);
    }
    const history = this.invocations.get(toolName);

    // Remove old invocations outside window
    const windowStart = now - limit.windowMs;
    const recentInvocations = history.filter(t => t > windowStart);
    this.invocations.set(toolName, recentInvocations);

    // Check if over limit
    if (recentInvocations.length >= limit.max) {
      return {
        allowed: false,
        reason: `RateLimitPolicy: '${toolName}' rate limit exceeded (${limit.max}/${limit.windowMs}ms)`
      };
    }

    // Record this invocation
    recentInvocations.push(now);
    return { allowed: true };
  }

  /**
   * Reset rate limit counters
   * @param {string} [toolName] - Specific tool to reset (all if omitted)
   */
  reset(toolName = null) {
    if (toolName) {
      this.invocations.delete(toolName);
    } else {
      this.invocations.clear();
    }
  }
}

/**
 * AuditPolicy - Logs all tool invocations for auditing
 *
 * Doesn't deny anything, just records for compliance/debugging.
 */
class AuditPolicy {
  /**
   * @param {Object} options
   * @param {Function} options.logger - Custom logger function
   * @param {boolean} options.logArgs - Include args in log (default: false for security)
   */
  constructor(options = {}) {
    this.name = 'AuditPolicy';
    this.logger = options.logger || console.log;
    this.logArgs = options.logArgs || false;
    this.log = [];
  }

  check(toolName, args) {
    const entry = {
      timestamp: new Date().toISOString(),
      toolName,
      args: this.logArgs ? args : undefined
    };

    this.log.push(entry);
    this.logger(`[Audit] ${entry.timestamp} - ${toolName}`);

    return { allowed: true };
  }

  /**
   * Get audit log
   * @param {Object} options
   * @param {number} options.limit - Max entries to return
   * @param {string} options.toolName - Filter by tool
   */
  getLog(options = {}) {
    let entries = this.log;

    if (options.toolName) {
      entries = entries.filter(e => e.toolName === options.toolName);
    }

    if (options.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Clear audit log
   */
  clearLog() {
    this.log = [];
  }
}

/**
 * ContentFilterPolicy - Filters tool arguments for sensitive content
 *
 * Useful for:
 * - Preventing secrets from being written
 * - Blocking dangerous patterns
 */
class ContentFilterPolicy {
  /**
   * @param {Object} options
   * @param {RegExp[]} options.blockedPatterns - Patterns to block
   * @param {string[]} options.blockedStrings - Exact strings to block
   */
  constructor(options = {}) {
    this.name = 'ContentFilterPolicy';
    this.blockedPatterns = options.blockedPatterns || [
      /password\s*[=:]\s*['"][^'"]+['"]/i,
      /api[_-]?key\s*[=:]\s*['"][^'"]+['"]/i,
      /secret\s*[=:]\s*['"][^'"]+['"]/i,
      /AWS_SECRET_ACCESS_KEY/,
      /-----BEGIN (?:RSA )?PRIVATE KEY-----/
    ];
    this.blockedStrings = options.blockedStrings || [];
  }

  check(toolName, args) {
    // Only check write operations
    if (!['Write', 'Edit'].includes(toolName)) {
      return { allowed: true };
    }

    const content = args.content || args.new_string || '';

    // Check blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(content)) {
        return {
          allowed: false,
          reason: `ContentFilterPolicy: Blocked pattern detected (potential secret)`
        };
      }
    }

    // Check blocked strings
    for (const str of this.blockedStrings) {
      if (content.includes(str)) {
        return {
          allowed: false,
          reason: `ContentFilterPolicy: Blocked content detected`
        };
      }
    }

    return { allowed: true };
  }
}

/**
 * CompositePolicy - Combines multiple policies with AND/OR logic
 */
class CompositePolicy {
  /**
   * @param {Object[]} policies - Array of policy objects
   * @param {string} mode - 'all' (AND) or 'any' (OR)
   */
  constructor(policies, mode = 'all') {
    this.name = 'CompositePolicy';
    this.policies = policies;
    this.mode = mode;
  }

  async check(toolName, args, manager) {
    const results = [];

    for (const policy of this.policies) {
      const result = await policy.check(toolName, args, manager);
      results.push(result);

      // Short-circuit based on mode
      if (this.mode === 'all' && !result.allowed) {
        return result; // First denial fails all
      }
      if (this.mode === 'any' && result.allowed) {
        return result; // First allow passes any
      }
    }

    // For 'all' mode: all passed (or empty)
    // For 'any' mode: all failed
    if (this.mode === 'all') {
      return { allowed: true };
    } else {
      return {
        allowed: false,
        reason: 'CompositePolicy: No policy allowed the action'
      };
    }
  }
}

module.exports = {
  ReadOnlyPolicy,
  SandboxPolicy,
  RateLimitPolicy,
  AuditPolicy,
  ContentFilterPolicy,
  CompositePolicy
};
