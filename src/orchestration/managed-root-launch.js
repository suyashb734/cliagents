'use strict';

const crypto = require('crypto');
const { MANAGED_ROOT_ADAPTERS } = require('../adapters/active-surface');

const MANAGED_ROOT_ADAPTER_ALIASES = Object.freeze({
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  qwen: 'qwen-cli',
  'qwen-cli': 'qwen-cli',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  opencode: 'opencode-cli',
  'opencode-cli': 'opencode-cli',
  claude: 'claude-code',
  'claude-code': 'claude-code'
});

const ORIGIN_CLIENT_BY_ADAPTER = Object.freeze({
  'codex-cli': 'codex',
  'qwen-cli': 'qwen',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'claude-code': 'claude'
});

function normalizeManagedRootAdapter(adapter) {
  const normalized = String(adapter || 'codex-cli').trim().toLowerCase();
  const resolved = MANAGED_ROOT_ADAPTER_ALIASES[normalized] || normalized;
  if (!MANAGED_ROOT_ADAPTERS.includes(resolved)) {
    throw new Error(
      `Unsupported managed root adapter: ${adapter}. Supported: ${MANAGED_ROOT_ADAPTERS.join(', ')}`
    );
  }
  return resolved;
}

function inferManagedRootOriginClient(adapter) {
  const normalizedAdapter = normalizeManagedRootAdapter(adapter);
  return ORIGIN_CLIENT_BY_ADAPTER[normalizedAdapter] || 'system';
}

function buildManagedRootExternalSessionRef(originClient, providedExternalSessionRef = null) {
  if (providedExternalSessionRef) {
    return String(providedExternalSessionRef).trim();
  }
  const normalizedOriginClient = String(originClient || 'system').trim().toLowerCase() || 'system';
  return `${normalizedOriginClient}:managed:${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  MANAGED_ROOT_ADAPTER_ALIASES,
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  buildManagedRootExternalSessionRef
};
