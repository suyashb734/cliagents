'use strict';

const ACTIVE_BROKER_ADAPTERS = Object.freeze([
  'gemini-cli',
  'codex-cli',
  'qwen-cli',
  'opencode-cli',
  'claude-code'
]);

const MANAGED_ROOT_ADAPTERS = Object.freeze([
  ...ACTIVE_BROKER_ADAPTERS
]);

const DEFAULT_BROKER_ADAPTER = 'codex-cli';

function getActiveBrokerAdapters() {
  return [...ACTIVE_BROKER_ADAPTERS];
}

function isActiveBrokerAdapter(adapter) {
  return ACTIVE_BROKER_ADAPTERS.includes(adapter);
}

function getManagedRootAdapters() {
  return [...MANAGED_ROOT_ADAPTERS];
}

function isManagedRootAdapter(adapter) {
  return MANAGED_ROOT_ADAPTERS.includes(adapter);
}

module.exports = {
  ACTIVE_BROKER_ADAPTERS,
  MANAGED_ROOT_ADAPTERS,
  DEFAULT_BROKER_ADAPTER,
  getActiveBrokerAdapters,
  isActiveBrokerAdapter,
  getManagedRootAdapters,
  isManagedRootAdapter
};
