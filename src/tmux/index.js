/**
 * tmux module - Persistent session management for CLI agents
 */

const TmuxClient = require('./client');
const { PersistentSessionManager, TerminalStatus, generateTerminalId } = require('./session-manager');

module.exports = {
  TmuxClient,
  PersistentSessionManager,
  TerminalStatus,
  generateTerminalId
};
