/**
 * Orchestration Module
 *
 * Exports all orchestration primitives for multi-agent coordination.
 */

const { handoff, extractOutput, generateTraceId, truncate } = require('./handoff');
const { assign, setupCompletionMonitor } = require('./assign');
const { sendMessage, broadcastMessage, sendUrgentMessage } = require('./send-message');

module.exports = {
  // Synchronous delegation
  handoff,

  // Asynchronous delegation
  assign,

  // Inter-agent messaging
  sendMessage,
  broadcastMessage,
  sendUrgentMessage,

  // Utilities
  extractOutput,
  generateTraceId,
  truncate,
  setupCompletionMonitor
};
