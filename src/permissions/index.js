/**
 * Permissions module for cliagents
 *
 * Provides fine-grained permission control for CLI agent tool invocations.
 */

'use strict';

const {
  PermissionManager,
  FILE_TOOLS,
  EXECUTION_TOOLS,
  SAFE_TOOLS
} = require('./permission-manager');

const {
  ReadOnlyPolicy,
  SandboxPolicy,
  RateLimitPolicy,
  AuditPolicy,
  ContentFilterPolicy,
  CompositePolicy
} = require('./policies');

module.exports = {
  // Manager
  PermissionManager,

  // Tool categories
  FILE_TOOLS,
  EXECUTION_TOOLS,
  SAFE_TOOLS,

  // Built-in policies
  ReadOnlyPolicy,
  SandboxPolicy,
  RateLimitPolicy,
  AuditPolicy,
  ContentFilterPolicy,
  CompositePolicy
};
