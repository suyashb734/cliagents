/**
 * Hooks module for cliagents
 *
 * Provides event-based hooks for CLI agent tool invocations.
 */

'use strict';

const { HookManager, HOOK_EVENTS } = require('./hook-manager');

const {
  createLoggingHook,
  createToolFilterHook,
  createPathFilterHook,
  createRateLimitHook,
  createMetricsHook,
  createTimeoutHook,
  createContentFilterHook,
  createConfirmationHook
} = require('./built-in-hooks');

module.exports = {
  // Manager
  HookManager,
  HOOK_EVENTS,

  // Built-in hook creators
  createLoggingHook,
  createToolFilterHook,
  createPathFilterHook,
  createRateLimitHook,
  createMetricsHook,
  createTimeoutHook,
  createContentFilterHook,
  createConfirmationHook
};
