/**
 * Interceptor Module - Permission prompt interception for CLI agents
 *
 * This module provides automatic permission handling for CLIs that don't
 * support built-in permission control (like --allowedTools in Claude Code).
 *
 * Usage:
 * ```javascript
 * const { PermissionInterceptor } = require('./interceptor');
 * const { PermissionManager } = require('./permissions');
 *
 * const permissionManager = new PermissionManager({
 *   allowedTools: ['Read', 'Write'],
 *   deniedTools: ['Bash']
 * });
 *
 * const interceptor = new PermissionInterceptor({
 *   sessionManager,
 *   permissionManager
 * });
 *
 * // Start intercepting for a terminal
 * const stop = interceptor.start(terminalId);
 *
 * // ... terminal runs with permission prompts auto-handled ...
 *
 * // Stop when done
 * stop();
 * ```
 */

const { PermissionInterceptor, DEFAULT_CONFIG } = require('./permission-interceptor');
const {
  BasePromptParser,
  ClaudeCodePromptParser,
  GeminiPromptParser,
  CodexPromptParser,
  getParser
} = require('./prompt-parsers');

module.exports = {
  // Main class
  PermissionInterceptor,

  // Configuration
  DEFAULT_CONFIG,

  // Parsers
  BasePromptParser,
  ClaudeCodePromptParser,
  GeminiPromptParser,
  CodexPromptParser,
  getParser
};
