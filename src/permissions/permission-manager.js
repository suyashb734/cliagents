/**
 * PermissionManager - Fine-grained permission control for CLI agents
 *
 * Implements an interceptor model for controlling agent tool access:
 * - Tool allow/deny lists
 * - Path restrictions for file operations
 * - Custom policy hooks
 *
 * This enables Claude Code-style permission controls for delegated agents.
 *
 * @example
 * ```javascript
 * const pm = new PermissionManager({
 *   allowedTools: ['Read', 'Grep', 'Glob'],  // Whitelist
 *   deniedTools: ['Bash'],                    // Blacklist (takes precedence)
 *   allowedPaths: ['/project/src'],           // Restrict file access
 *   policies: [new ReadOnlyPolicy()]          // Custom policy
 * });
 *
 * const result = await pm.checkPermission('Write', { file_path: '/etc/passwd' });
 * // { allowed: false, reason: 'Path not allowed: /etc/passwd' }
 * ```
 */

'use strict';

const path = require('path');
const { EventEmitter } = require('events');

/**
 * Permission check result
 * @typedef {Object} PermissionResult
 * @property {boolean} allowed - Whether the action is permitted
 * @property {string} [reason] - Explanation if denied
 * @property {Object} [modifiedArgs] - Modified arguments (for transforming policies)
 */

/**
 * Tool names that operate on files
 */
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

/**
 * Tool names that execute code/commands
 */
const EXECUTION_TOOLS = ['Bash', 'Task'];

/**
 * Tool names that are generally safe (read-only, no side effects)
 */
const SAFE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

class PermissionManager extends EventEmitter {
  /**
   * Create a new PermissionManager
   * @param {Object} options - Configuration options
   * @param {string[]} [options.allowedTools] - Whitelist of allowed tools (null = all allowed)
   * @param {string[]} [options.deniedTools] - Blacklist of denied tools (takes precedence)
   * @param {string[]} [options.allowedPaths] - Allowed file paths (defaults to cwd)
   * @param {string[]} [options.deniedPaths] - Explicitly denied paths (takes precedence)
   * @param {Object[]} [options.policies] - Custom policy objects with check() method
   * @param {boolean} [options.logDenials] - Whether to log permission denials
   */
  constructor(options = {}) {
    super();

    this.allowedTools = options.allowedTools || null;  // null = all allowed
    this.deniedTools = options.deniedTools || [];
    this.allowedPaths = options.allowedPaths || [process.cwd()];
    this.deniedPaths = options.deniedPaths || [];
    this.policies = options.policies || [];
    this.logDenials = options.logDenials !== false;

    // Statistics
    this.stats = {
      checked: 0,
      allowed: 0,
      denied: 0,
      byTool: new Map(),
      denialReasons: new Map()
    };
  }

  /**
   * Check if a tool invocation is permitted
   *
   * Evaluation order:
   * 1. Deny list (immediate deny)
   * 2. Allow list (must be in list if specified)
   * 3. Path restrictions (for file tools)
   * 4. Custom policies (in order)
   *
   * @param {string} toolName - Name of the tool being invoked
   * @param {Object} args - Tool arguments
   * @returns {Promise<PermissionResult>}
   */
  async checkPermission(toolName, args = {}) {
    this.stats.checked++;
    this._incrementToolStat(toolName);

    // 1. Check deny list first (takes precedence)
    if (this.deniedTools.includes(toolName)) {
      return this._deny(`Tool '${toolName}' is in deny list`, toolName);
    }

    // 2. Check allow list (if specified)
    if (this.allowedTools && !this.allowedTools.includes(toolName)) {
      return this._deny(`Tool '${toolName}' is not in allow list`, toolName);
    }

    // 3. Check path restrictions for file tools
    if (FILE_TOOLS.includes(toolName)) {
      const pathResult = this._checkPathPermission(toolName, args);
      if (!pathResult.allowed) {
        return pathResult;
      }
    }

    // SECURITY: Check path restrictions for Bash commands
    if (toolName === 'Bash' && args.command) {
      const bashResult = this._checkBashCommand(args.command, toolName);
      if (!bashResult.allowed) {
        return bashResult;
      }
    }

    // 4. Run custom policies
    for (const policy of this.policies) {
      if (typeof policy.check === 'function') {
        const result = await policy.check(toolName, args, this);
        if (!result.allowed) {
          return this._deny(result.reason || 'Denied by policy', toolName);
        }
        // Allow policies to modify args
        if (result.modifiedArgs) {
          args = result.modifiedArgs;
        }
      }
    }

    // All checks passed
    this.stats.allowed++;
    this.emit('permission-allowed', { toolName, args });
    return { allowed: true, modifiedArgs: args };
  }

  /**
   * Check if a path is allowed for file operations
   * @private
   */
  _checkPathPermission(toolName, args) {
    // Extract path from arguments (different tools use different parameter names)
    const targetPath = args.file_path || args.path || args.filePath || args.notebook_path;

    if (!targetPath) {
      // No path in args - allow (path validation will happen in tool)
      return { allowed: true };
    }

    // Resolve to absolute path for comparison
    const resolvedPath = path.resolve(targetPath);

    // Check denied paths first (takes precedence)
    for (const denied of this.deniedPaths) {
      const resolvedDenied = path.resolve(denied);
      if (resolvedPath.startsWith(resolvedDenied)) {
        return this._deny(`Path explicitly denied: ${targetPath}`, toolName);
      }
    }

    // Check if path is within allowed paths
    const isAllowed = this.allowedPaths.some(allowed => {
      const resolvedAllowed = path.resolve(allowed);
      return resolvedPath.startsWith(resolvedAllowed);
    });

    if (!isAllowed) {
      return this._deny(`Path not allowed: ${targetPath}`, toolName);
    }

    return { allowed: true };
  }

  /**
   * Check Bash command arguments for path violations
   * @private
   */
  _checkBashCommand(command, toolName) {
    if (!command || typeof command !== 'string') return { allowed: true };
    
    // Check redirections (e.g. echo "text" > file)
    if (command.includes('>')) {
      const parts = command.split('>');
      if (parts[1]) {
        // Get the first token after >
        const target = parts[1].trim().split(/\s+/)[0];
        if (target) {
          const res = this._checkPathPermission(toolName, { path: target });
          if (!res.allowed) return res;
        }
      }
    }
    
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    const restricted = ['cat', 'rm', 'cp', 'mv', 'cd'];
    
    if (restricted.includes(cmd)) {
      for (let i = 1; i < parts.length; i++) {
        const arg = parts[i];
        // Skip flags and operators
        if (!arg.startsWith('-') && !['>', '>>', '|', '&', ';'].includes(arg)) {
          const res = this._checkPathPermission(toolName, { path: arg });
          if (!res.allowed) return res;
        }
      }
    }
    
    return { allowed: true };
  }

  /**
   * Record a denial and emit event
   * @private
   */
  _deny(reason, toolName) {
    this.stats.denied++;

    // Track denial reasons
    const count = this.stats.denialReasons.get(reason) || 0;
    this.stats.denialReasons.set(reason, count + 1);

    if (this.logDenials) {
      console.warn(`[PermissionManager] Denied: ${reason}`);
    }

    this.emit('permission-denied', { toolName, reason });
    return { allowed: false, reason };
  }

  /**
   * Increment tool usage stat
   * @private
   */
  _incrementToolStat(toolName) {
    const count = this.stats.byTool.get(toolName) || 0;
    this.stats.byTool.set(toolName, count + 1);
  }

  /**
   * Add a tool to the allow list
   * @param {string} toolName - Tool to allow
   */
  allowTool(toolName) {
    if (this.allowedTools === null) {
      this.allowedTools = [];
    }
    if (!this.allowedTools.includes(toolName)) {
      this.allowedTools.push(toolName);
    }
    // Also remove from deny list
    this.deniedTools = this.deniedTools.filter(t => t !== toolName);
  }

  /**
   * Add a tool to the deny list
   * @param {string} toolName - Tool to deny
   */
  denyTool(toolName) {
    if (!this.deniedTools.includes(toolName)) {
      this.deniedTools.push(toolName);
    }
  }

  /**
   * Add an allowed path
   * @param {string} pathStr - Path to allow
   */
  allowPath(pathStr) {
    const resolved = path.resolve(pathStr);
    if (!this.allowedPaths.includes(resolved)) {
      this.allowedPaths.push(resolved);
    }
  }

  /**
   * Add a denied path
   * @param {string} pathStr - Path to deny
   */
  denyPath(pathStr) {
    const resolved = path.resolve(pathStr);
    if (!this.deniedPaths.includes(resolved)) {
      this.deniedPaths.push(resolved);
    }
  }

  /**
   * Add a custom policy
   * @param {Object} policy - Policy object with check() method
   */
  addPolicy(policy) {
    if (typeof policy.check !== 'function') {
      throw new Error('Policy must have a check() method');
    }
    this.policies.push(policy);
  }

  /**
   * Create a read-only permission manager (no Write, Edit, Bash)
   * @param {Object} options - Additional options
   * @returns {PermissionManager}
   */
  static createReadOnly(options = {}) {
    return new PermissionManager({
      ...options,
      deniedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit', ...(options.deniedTools || [])],
      allowedTools: options.allowedTools || SAFE_TOOLS
    });
  }

  /**
   * Create a permission manager that only allows safe tools
   * @param {Object} options - Additional options
   * @returns {PermissionManager}
   */
  static createSafeOnly(options = {}) {
    return new PermissionManager({
      ...options,
      allowedTools: SAFE_TOOLS
    });
  }

  /**
   * Create a permission manager from an agent profile
   * @param {Object} profile - Agent profile with allowedTools, deniedTools
   * @param {string} workDir - Working directory for path restrictions
   * @returns {PermissionManager}
   */
  static fromProfile(profile, workDir) {
    const resolvedWorkDir = workDir || process.cwd();
    const resolvePathTemplates = (paths) => {
      return paths
        .filter(p => typeof p === 'string' && p.length > 0)
        .map(p => p.replace(/\$\{workDir\}/g, resolvedWorkDir))
        .map(p => path.resolve(p));
    };

    const options = {
      allowedPaths: [resolvedWorkDir],
      logDenials: true
    };

    if (profile.allowedTools) {
      options.allowedTools = profile.allowedTools;
    }

    if (profile.deniedTools) {
      options.deniedTools = profile.deniedTools;
    }

    if (Array.isArray(profile.allowedPaths) && profile.allowedPaths.length > 0) {
      options.allowedPaths = resolvePathTemplates(profile.allowedPaths);
    }

    // Use denied paths from profile if specified
    if (Array.isArray(profile.deniedPaths) && profile.deniedPaths.length > 0) {
      options.deniedPaths = resolvePathTemplates(profile.deniedPaths);
    }

    return new PermissionManager(options);
  }

  /**
   * Get permission statistics
   * @returns {Object}
   */
  getStats() {
    return {
      checked: this.stats.checked,
      allowed: this.stats.allowed,
      denied: this.stats.denied,
      allowRate: this.stats.checked > 0 ?
        (this.stats.allowed / this.stats.checked * 100).toFixed(1) + '%' : '0%',
      byTool: Object.fromEntries(this.stats.byTool),
      topDenialReasons: Array.from(this.stats.denialReasons.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      checked: 0,
      allowed: 0,
      denied: 0,
      byTool: new Map(),
      denialReasons: new Map()
    };
  }
}

module.exports = {
  PermissionManager,
  FILE_TOOLS,
  EXECUTION_TOOLS,
  SAFE_TOOLS
};
