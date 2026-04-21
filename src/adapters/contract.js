const REQUIRED_ADAPTER_METHODS = Object.freeze([
  'isAvailable',
  'spawn',
  'send',
  'terminate',
  'classifyFailure',
  'isSessionActive',
  'getActiveSessions'
]);

const OPTIONAL_ADAPTER_METHODS = Object.freeze([
  'interrupt',
  'getAvailableModels',
  'getCapabilities',
  'getContract',
  'getTimeoutInfo',
  'getSessionLiveness',
  'recordHeartbeat'
]);

const TIMEOUT_TYPES = Object.freeze({
  CONNECTION: 'connection',
  RESPONSE: 'response',
  IDLE: 'idle',
  SPAWN: 'spawn'
});

const EXECUTION_MODES = Object.freeze({
  DIRECT_SESSION: 'direct-session',
  PERSISTENT_WORKER: 'persistent-worker',
  API: 'api'
});

const DEFAULT_READINESS = Object.freeze({
  initTimeoutMs: 45000,
  promptMaxWaitMs: 8000,
  promptPollIntervalMs: 250,
  promptSettleDelayMs: 750,
  promptMaxRounds: 3,
  promptFallbackAction: 'Enter',
  promptHandlers: Object.freeze([])
});

const RUN_STATES = Object.freeze([
  'ready',
  'running',
  'completed',
  'blocked',
  'failed',
  'abandoned'
]);

const LIVENESS_STATES = Object.freeze({
  ALIVE: 'alive',
  STALE: 'stale',
  DEAD: 'dead'
});

const FAILURE_CLASSES = Object.freeze([
  'auth',
  'timeout',
  'rate_limit',
  'tool_error',
  'process_exit',
  'protocol_parse',
  'validation',
  'cancelled',
  'unknown'
]);

const MUST_OVERRIDE_REQUIRED_METHODS = Object.freeze([
  'isAvailable',
  'spawn',
  'send',
  'terminate',
  'isSessionActive',
  'getActiveSessions'
]);

const DEFAULT_CAPABILITIES = Object.freeze({
  usesOfficialCli: false,
  executionMode: EXECUTION_MODES.DIRECT_SESSION,
  supportsMultiTurn: false,
  supportsResume: false,
  supportsStreaming: false,
  supportsInterrupt: false,
  supportsPolling: false,
  supportsSystemPrompt: false,
  supportsAllowedTools: false,
  supportsModelSelection: false,
  supportsWorkingDirectory: true,
  supportsTools: false,
  supportsFilesystemRead: false,
  supportsFilesystemWrite: false,
  supportsImages: false,
  supportsJsonMode: false,
  supportsJsonSchema: false
});

function defineAdapterCapabilities(overrides = {}) {
  return Object.freeze({
    ...DEFAULT_CAPABILITIES,
    ...overrides
  });
}

function normalizePromptHandler(handler = {}) {
  const matchAny = Array.isArray(handler.matchAny)
    ? handler.matchAny
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];

  const actions = Array.isArray(handler.actions)
    ? handler.actions
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];

  return Object.freeze({
    matchAny,
    actions,
    description: String(handler.description || '').trim() || null
  });
}

function defineAdapterReadiness(overrides = {}) {
  const normalizedHandlers = Array.isArray(overrides.promptHandlers)
    ? overrides.promptHandlers
        .map((handler) => normalizePromptHandler(handler))
        .filter((handler) => handler.matchAny.length > 0 && handler.actions.length > 0)
    : [...DEFAULT_READINESS.promptHandlers];

  return Object.freeze({
    initTimeoutMs: Number.isFinite(overrides.initTimeoutMs)
      ? Math.max(1000, overrides.initTimeoutMs)
      : DEFAULT_READINESS.initTimeoutMs,
    promptMaxWaitMs: Number.isFinite(overrides.promptMaxWaitMs)
      ? Math.max(0, overrides.promptMaxWaitMs)
      : DEFAULT_READINESS.promptMaxWaitMs,
    promptPollIntervalMs: Number.isFinite(overrides.promptPollIntervalMs)
      ? Math.max(10, overrides.promptPollIntervalMs)
      : DEFAULT_READINESS.promptPollIntervalMs,
    promptSettleDelayMs: Number.isFinite(overrides.promptSettleDelayMs)
      ? Math.max(0, overrides.promptSettleDelayMs)
      : DEFAULT_READINESS.promptSettleDelayMs,
    promptMaxRounds: Number.isFinite(overrides.promptMaxRounds)
      ? Math.max(0, Math.floor(overrides.promptMaxRounds))
      : DEFAULT_READINESS.promptMaxRounds,
    promptFallbackAction: overrides.promptFallbackAction === null
      ? null
      : String(overrides.promptFallbackAction || DEFAULT_READINESS.promptFallbackAction).trim() || null,
    promptHandlers: Object.freeze(normalizedHandlers)
  });
}

function createAdapterContract(options = {}) {
  const capabilities = defineAdapterCapabilities(options.capabilities || {});
  const readiness = defineAdapterReadiness(options.readiness || {});

  return Object.freeze({
    version: options.version || '2026-04-11',
    executionMode: capabilities.executionMode,
    requiredMethods: [...REQUIRED_ADAPTER_METHODS],
    optionalMethods: [...OPTIONAL_ADAPTER_METHODS],
    runStates: [...RUN_STATES],
    failureClasses: [...FAILURE_CLASSES],
    timeoutTypes: { ...TIMEOUT_TYPES },
    livenessStates: { ...LIVENESS_STATES },
    capabilities,
    readiness,
    notes: Array.isArray(options.notes) ? [...options.notes] : []
  });
}

function usesInheritedRequiredMethod(adapter, methodName) {
  if (!adapter || typeof adapter[methodName] !== 'function') {
    return false;
  }

  const adapterPrototype = Object.getPrototypeOf(adapter);
  const parentPrototype = adapterPrototype ? Object.getPrototypeOf(adapterPrototype) : null;

  return Boolean(
    adapterPrototype &&
    parentPrototype &&
    typeof adapterPrototype[methodName] === 'function' &&
    typeof parentPrototype[methodName] === 'function' &&
    adapterPrototype[methodName] === parentPrototype[methodName]
  );
}

function validateAdapterContract(adapter) {
  const missingMethods = REQUIRED_ADAPTER_METHODS.filter((methodName) => typeof adapter?.[methodName] !== 'function');
  const inheritedRequiredMethods = MUST_OVERRIDE_REQUIRED_METHODS.filter((methodName) =>
    usesInheritedRequiredMethod(adapter, methodName)
  );
  const warnings = [];

  const capabilities = typeof adapter?.getCapabilities === 'function'
    ? adapter.getCapabilities()
    : null;

  const contract = typeof adapter?.getContract === 'function'
    ? adapter.getContract()
    : null;

  if (!capabilities) {
    warnings.push('Adapter does not publish capability metadata');
  } else if (!Object.values(EXECUTION_MODES).includes(capabilities.executionMode)) {
    warnings.push(`Unknown execution mode '${capabilities.executionMode}'`);
  }

  if (!contract) {
    warnings.push('Adapter does not publish an explicit contract descriptor');
  } else if (!contract.readiness) {
    warnings.push('Adapter does not publish readiness metadata');
  }

  for (const methodName of inheritedRequiredMethods) {
    warnings.push(`${methodName} is inherited from the parent prototype; concrete adapters must override required methods`);
  }

  return {
    valid: missingMethods.length === 0 && inheritedRequiredMethods.length === 0,
    missingMethods,
    inheritedRequiredMethods,
    warnings,
    capabilities,
    contract
  };
}

module.exports = {
  REQUIRED_ADAPTER_METHODS,
  OPTIONAL_ADAPTER_METHODS,
  EXECUTION_MODES,
  RUN_STATES,
  FAILURE_CLASSES,
  TIMEOUT_TYPES,
  LIVENESS_STATES,
  DEFAULT_CAPABILITIES,
  DEFAULT_READINESS,
  defineAdapterCapabilities,
  defineAdapterReadiness,
  createAdapterContract,
  validateAdapterContract
};
