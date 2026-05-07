'use strict';

const crypto = require('crypto');
const net = require('net');

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_SCENARIO_ACTION_TIMEOUT_MS = 10000;
const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACTION_CAP_PER_SESSION = 5;
const DEFAULT_MAX_ACTION_PAYLOAD_BYTES = 32 * 1024;
const DEFAULT_MAX_ACTIONS_PER_MINUTE = 20;
const DEFAULT_MAX_RETRIES = 1;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const FAILURE_CLASSES = Object.freeze({
  TRANSPORT_ERROR: 'transport_error',
  TIMEOUT: 'timeout',
  INVALID_STATE_PAYLOAD: 'invalid_state_payload',
  ACTION_REJECTION: 'action_rejection',
  VALIDATION_ERROR: 'validation_error',
  AUTHZ_ERROR: 'authz_error',
  NOT_CONFIGURED: 'not_configured'
});

const ACTION_REJECTION_STATUSES = new Set([
  'blocked',
  'rejected',
  'denied',
  'failed_policy',
  'policy_blocked'
]);
const CANONICAL_DETERMINISTIC_TARGET_NAME = 'more information...';
const RISKY_TARGET_NAME_PATTERN = /\b(delete|remove|destroy|drop|purchase|pay|transfer|confirm|submit|execute)\b/i;

function parseMaybeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseMaybeInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
      .filter(Boolean);
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeBaseUrl(input) {
  const value = String(input || '').trim();
  if (!value) {
    return null;
  }
  return value.replace(/\/+$/, '');
}

function normalizeHost(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!value) {
    return '';
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1);
  }
  return value;
}

function isPrivateIpv4Address(hostname) {
  const value = normalizeHost(hostname);
  if (net.isIP(value) !== 4) {
    return false;
  }

  const octets = value.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isFinite(part))) {
    return false;
  }

  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 0) {
    return true;
  }
  return false;
}

function isPrivateIpv6Address(hostname) {
  const value = normalizeHost(hostname);
  if (net.isIP(value) !== 6) {
    return false;
  }

  if (value === '::1' || value === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (value.startsWith('fe80:')) {
    return true;
  }
  if (value.startsWith('fc') || value.startsWith('fd')) {
    return true;
  }
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    return isPrivateIpv4Address(mapped);
  }

  return false;
}

function buildPayloadHash(payload) {
  const stable = JSON.stringify(sortObjectKeys(payload));
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortObjectKeys(value[key]);
        return result;
      }, {});
  }
  return value;
}

function parseTargetUrlOrThrow(rawUrl, options = {}) {
  const value = firstString(rawUrl);
  if (!value) {
    throw new BrowserPerceptionEngineError('target.url is required', {
      failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
      terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR
    });
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserPerceptionEngineError(`Invalid target URL: ${value}`, {
      failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
      terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserPerceptionEngineError(`Unsupported target URL protocol: ${parsed.protocol}`, {
      failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
      terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR
    });
  }

  if (parsed.username || parsed.password) {
    throw new BrowserPerceptionEngineError('Target URL must not include credentials', {
      failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
      terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR
    });
  }

  const hostname = normalizeHost(parsed.hostname);
  const loopbackAllowed = options.allowLoopbackHosts === true;
  const allowedHosts = options.allowedHosts || null;

  const privateNetworkHost = isPrivateIpv4Address(hostname) || isPrivateIpv6Address(hostname);
  const deniedHostnames = new Set([
    'localhost',
    'metadata.google.internal',
    '169.254.169.254'
  ]);
  const suspiciousSuffix = hostname.endsWith('.local') || hostname.endsWith('.internal');
  const denyByHostRule = deniedHostnames.has(hostname) || suspiciousSuffix;

  if ((privateNetworkHost || denyByHostRule) && !loopbackAllowed) {
    throw new BrowserPerceptionEngineError(`Target URL host is not allowed: ${hostname}`, {
      failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
      terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR,
      details: {
        reason: privateNetworkHost ? 'private_or_loopback_host_denied' : 'restricted_hostname_denied',
        host: hostname
      }
    });
  }

  if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new BrowserPerceptionEngineError(`Target URL host is outside allowlist: ${hostname}`, {
      failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
      terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR,
      details: {
        reason: 'host_not_in_allowlist',
        host: hostname
      }
    });
  }

  parsed.hash = '';
  return parsed;
}

function normalizeOwnershipContext(input = {}) {
  const companyId = firstString(input.companyId, input.company_id);
  const runId = firstString(input.runId, input.run_id);
  const agentId = firstString(input.agentId, input.agent_id);
  if (!companyId || !runId || !agentId) {
    throw new BrowserPerceptionEngineError('Missing ownership context (company_id, run_id, agent_id)', {
      failureClass: FAILURE_CLASSES.AUTHZ_ERROR,
      terminalFailureReason: FAILURE_CLASSES.AUTHZ_ERROR,
      details: {
        companyId: companyId || null,
        runId: runId || null,
        agentId: agentId || null
      }
    });
  }
  return { companyId, runId, agentId };
}

function ownershipKey(owner) {
  return `${owner.companyId}:${owner.runId}:${owner.agentId}`;
}

function normalizeErrorMessage(payload, fallback) {
  if (payload && typeof payload === 'object') {
    const nested = firstString(
      payload.error?.message,
      payload.error?.detail,
      payload.message,
      payload.detail
    );
    if (nested) {
      return nested;
    }
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  return fallback;
}

function parseResponseBody(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function classifyHttpFailure(statusCode, payload) {
  if (statusCode === 400) {
    return FAILURE_CLASSES.VALIDATION_ERROR;
  }
  if (statusCode === 401 || statusCode === 403) {
    return FAILURE_CLASSES.AUTHZ_ERROR;
  }
  if (statusCode === 409) {
    return FAILURE_CLASSES.ACTION_REJECTION;
  }
  if (statusCode >= 500) {
    return FAILURE_CLASSES.TRANSPORT_ERROR;
  }
  return FAILURE_CLASSES.TRANSPORT_ERROR;
}

class BrowserPerceptionEngineError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BrowserPerceptionEngineError';
    this.failureClass = options.failureClass || FAILURE_CLASSES.TRANSPORT_ERROR;
    this.statusCode = Number.isInteger(options.statusCode) ? options.statusCode : null;
    this.sessionId = options.sessionId || null;
    this.actionId = options.actionId || null;
    this.terminalFailureReason = options.terminalFailureReason || this.failureClass;
    this.details = options.details || null;
    this.retryable = options.retryable === true;
    this.cause = options.cause || null;
  }
}

function normalizeStatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new BrowserPerceptionEngineError('State payload must be an object', {
      failureClass: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      terminalFailureReason: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      details: { payloadType: typeof payload }
    });
  }

  const stateVersion = parseMaybeNumber(payload.state_version ?? payload.stateVersion);
  const url = firstString(payload.url);
  const title = firstString(payload.title) || null;
  const elementsRaw = Array.isArray(payload.elements) ? payload.elements : [];

  if (!Number.isFinite(stateVersion)) {
    throw new BrowserPerceptionEngineError('State payload is missing numeric state_version', {
      failureClass: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      terminalFailureReason: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      details: { stateVersion: payload.state_version ?? payload.stateVersion ?? null }
    });
  }
  if (!url) {
    throw new BrowserPerceptionEngineError('State payload is missing url', {
      failureClass: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      terminalFailureReason: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      details: { url: payload.url ?? null }
    });
  }

  const elements = elementsRaw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: firstString(entry.id, entry.element_id, entry.elementId) || null,
      role: firstString(entry.role) || null,
      name: firstString(entry.name, entry.label, entry.text) || null,
      confidence: parseMaybeNumber(entry.confidence)
    }));

  return {
    stateVersion,
    url,
    title,
    elements
  };
}

function normalizeActionPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new BrowserPerceptionEngineError('Action payload must be an object', {
      failureClass: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      terminalFailureReason: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      details: { payloadType: typeof payload }
    });
  }

  const actionId = firstString(payload.action_id, payload.actionId) || null;
  const status = firstString(payload.status, payload.result)?.toLowerCase() || null;
  const stateVersion = parseMaybeNumber(payload.state_version ?? payload.stateVersion);
  const events = Array.isArray(payload.events)
    ? payload.events
      .map((event) => (typeof event === 'string' ? event : firstString(event?.type, event?.name)))
      .filter(Boolean)
    : [];

  if (!status) {
    throw new BrowserPerceptionEngineError('Action payload is missing status', {
      failureClass: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      terminalFailureReason: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
      details: { payload }
    });
  }

  return {
    actionId,
    status,
    stateVersion,
    events
  };
}

function buildScenarioTarget(interaction = {}, state = {}) {
  const explicitTarget = interaction && typeof interaction.target === 'object' && interaction.target
    ? interaction.target
    : null;
  const stateElements = Array.isArray(state.elements) ? state.elements : [];

  const explicitElementId = firstString(
    explicitTarget?.element_id,
    explicitTarget?.elementId,
    explicitTarget?.id
  );
  if (explicitElementId) {
    const explicitIdMatches = stateElements.filter((element) => firstString(element?.id) === explicitElementId);
    if (explicitIdMatches.length !== 1 || !explicitIdMatches[0]?.id) {
      const reason = explicitIdMatches.length > 1
        ? 'explicit_element_id_ambiguous'
        : 'explicit_element_id_not_resolved';
      throw new BrowserPerceptionEngineError('Explicit element_id target was not found in state payload', {
        failureClass: FAILURE_CLASSES.ACTION_REJECTION,
        terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
        details: {
          reason,
          elementId: explicitElementId,
          matchCount: explicitIdMatches.length
        }
      });
    }
    return {
      target: { element_id: explicitIdMatches[0].id },
      resolvedElement: explicitIdMatches[0],
      selectionSource: 'explicit_element_id'
    };
  }

  const explicitName = firstString(explicitTarget?.name, explicitTarget?.label, interaction?.targetName);
  const explicitRole = firstString(explicitTarget?.role, interaction?.targetRole);

  const hasExplicitSelector = Boolean(explicitName || explicitRole);
  if (hasExplicitSelector) {
    const explicitNameLower = explicitName ? explicitName.toLowerCase() : null;
    const explicitRoleLower = explicitRole ? explicitRole.toLowerCase() : null;
    const explicitMatches = stateElements.filter((element) => {
      if (!element || typeof element !== 'object') {
        return false;
      }
      const nameMatches = explicitNameLower
        ? String(element.name || '').trim().toLowerCase() === explicitNameLower
        : true;
      const roleMatches = explicitRoleLower
        ? String(element.role || '').trim().toLowerCase() === explicitRoleLower
        : true;
      return nameMatches && roleMatches;
    });
    if (explicitMatches.length !== 1 || !explicitMatches[0]?.id) {
      const reason = explicitMatches.length > 1 ? 'explicit_target_ambiguous' : 'explicit_target_not_resolved';
      throw new BrowserPerceptionEngineError('Requested interaction target could not be resolved safely', {
        failureClass: FAILURE_CLASSES.ACTION_REJECTION,
        terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
        details: {
          reason,
          requestedTarget: explicitTarget || null,
          explicitName: explicitName || null,
          explicitRole: explicitRole || null,
          matchCount: explicitMatches.length
        }
      });
    }
    return {
      target: { element_id: explicitMatches[0].id },
      resolvedElement: explicitMatches[0],
      selectionSource: 'explicit_name_role'
    };
  }

  const canonicalDeterministicCandidates = stateElements.filter((element) => {
    return String(element?.name || '').trim().toLowerCase() === CANONICAL_DETERMINISTIC_TARGET_NAME;
  });
  if (canonicalDeterministicCandidates.length === 1 && canonicalDeterministicCandidates[0]?.id) {
    return {
      target: { element_id: canonicalDeterministicCandidates[0].id },
      resolvedElement: canonicalDeterministicCandidates[0],
      selectionSource: 'canonical_deterministic'
    };
  }
  if (canonicalDeterministicCandidates.length > 1) {
    throw new BrowserPerceptionEngineError('Canonical deterministic target is ambiguous in state payload', {
      failureClass: FAILURE_CLASSES.ACTION_REJECTION,
      terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
      details: {
        reason: 'canonical_target_ambiguous',
        requestedTarget: explicitTarget || null,
        canonicalTargetName: CANONICAL_DETERMINISTIC_TARGET_NAME,
        matchCount: canonicalDeterministicCandidates.length
      }
    });
  }

  throw new BrowserPerceptionEngineError('No actionable target found in state payload', {
    failureClass: FAILURE_CLASSES.ACTION_REJECTION,
    terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
    details: {
      reason: 'no_action_target',
      requestedTarget: explicitTarget || null
    }
  });
}

function requiresRiskyTargetOverride(elementName) {
  return typeof elementName === 'string' && RISKY_TARGET_NAME_PATTERN.test(elementName);
}

class BrowserPerceptionEngineClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl
      || process.env.CLIAGENTS_BPE_BASE_URL
      || process.env.BROWSER_PERCEPTION_ENGINE_URL
    );
    this.apiKey = firstString(
      options.apiKey,
      process.env.CLIAGENTS_BPE_API_KEY,
      process.env.BROWSER_PERCEPTION_ENGINE_API_KEY
    );
    this.defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs)
      ? Number(options.defaultTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.requireApiKey = options.requireApiKey ?? parseBooleanEnv(process.env.CLIAGENTS_BPE_REQUIRE_AUTH, true);
    this.allowLoopbackTargets = options.allowLoopbackTargets ?? parseBooleanEnv(process.env.CLIAGENTS_BPE_ALLOW_LOOPBACK_TARGETS, false);
    this.allowedTargetHosts = new Set(
      normalizeStringList(options.allowedTargetHosts ?? process.env.CLIAGENTS_BPE_ALLOWED_TARGET_HOSTS)
    );
    this.allowedScenarioActionTypes = new Set(
      normalizeStringList(
        (options.allowedScenarioActionTypes ?? process.env.CLIAGENTS_BPE_ALLOWED_ACTION_TYPES) || 'click'
      )
    );
    this.sessionTtlMs = Math.max(
      1000,
      parseMaybeInteger(options.sessionTtlMs ?? process.env.CLIAGENTS_BPE_SESSION_TTL_MS) || DEFAULT_SESSION_TTL_MS
    );
    this.maxActionsPerSession = Math.max(
      1,
      parseMaybeInteger(options.maxActionsPerSession ?? process.env.CLIAGENTS_BPE_ACTION_CAP_PER_SESSION) || DEFAULT_ACTION_CAP_PER_SESSION
    );
    this.maxActionPayloadBytes = Math.max(
      512,
      parseMaybeInteger(options.maxActionPayloadBytes ?? process.env.CLIAGENTS_BPE_MAX_ACTION_PAYLOAD_BYTES) || DEFAULT_MAX_ACTION_PAYLOAD_BYTES
    );
    this.maxActionsPerMinute = Math.max(
      1,
      parseMaybeInteger(options.maxActionsPerMinute ?? process.env.CLIAGENTS_BPE_MAX_ACTIONS_PER_MINUTE) || DEFAULT_MAX_ACTIONS_PER_MINUTE
    );
    this.maxRetries = Math.max(
      0,
      parseMaybeInteger(options.maxRetries ?? process.env.CLIAGENTS_BPE_MAX_RETRIES) || DEFAULT_MAX_RETRIES
    );
    this.sessionBindings = new Map();
    this.idempotencyRecords = new Map();
    this.ownerRateLimits = new Map();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('BrowserPerceptionEngineClient requires global fetch support');
    }
  }

  isConfigured() {
    return Boolean(this.baseUrl);
  }

  _resolveUrl(routePath) {
    const normalizedPath = String(routePath || '').startsWith('/')
      ? String(routePath)
      : `/${String(routePath || '')}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  _assertServiceAuth() {
    if (!this.requireApiKey) {
      return;
    }
    if (this.apiKey) {
      return;
    }
    throw new BrowserPerceptionEngineError(
      'BPE service authentication is required (set CLIAGENTS_BPE_API_KEY or BROWSER_PERCEPTION_ENGINE_API_KEY)',
      {
        failureClass: FAILURE_CLASSES.NOT_CONFIGURED,
        terminalFailureReason: FAILURE_CLASSES.NOT_CONFIGURED
      }
    );
  }

  _buildOwnershipHeaders(owner) {
    if (!owner) {
      return {};
    }
    return {
      'X-BPE-Company-Id': owner.companyId,
      'X-BPE-Run-Id': owner.runId,
      'X-BPE-Agent-Id': owner.agentId
    };
  }

  _touchRateLimit(owner) {
    const key = ownershipKey(owner);
    const now = Date.now();
    const existing = this.ownerRateLimits.get(key);
    if (!existing || now - existing.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      this.ownerRateLimits.set(key, { windowStartMs: now, count: 1 });
      return;
    }
    if (existing.count >= this.maxActionsPerMinute) {
      throw new BrowserPerceptionEngineError(
        `Per-minute action rate limit exceeded (${this.maxActionsPerMinute})`,
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          details: {
            reason: 'rate_limit_exceeded',
            maxActionsPerMinute: this.maxActionsPerMinute
          }
        }
      );
    }
    existing.count += 1;
  }

  _assertSessionOwnership(sessionId, owner) {
    const binding = this.sessionBindings.get(sessionId);
    if (!binding) {
      throw new BrowserPerceptionEngineError('Unknown or expired BPE session binding', {
        failureClass: FAILURE_CLASSES.AUTHZ_ERROR,
        terminalFailureReason: FAILURE_CLASSES.AUTHZ_ERROR,
        sessionId,
        details: { reason: 'missing_session_binding' }
      });
    }
    if (binding.expiresAtMs <= Date.now()) {
      this.sessionBindings.delete(sessionId);
      throw new BrowserPerceptionEngineError('BPE session expired', {
        failureClass: FAILURE_CLASSES.ACTION_REJECTION,
        terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
        sessionId,
        details: {
          reason: 'session_ttl_expired',
          expiresAtMs: binding.expiresAtMs
        }
      });
    }

    const ownerKey = ownershipKey(owner);
    if (binding.ownerKey !== ownerKey) {
      throw new BrowserPerceptionEngineError('Session ownership check failed', {
        failureClass: FAILURE_CLASSES.AUTHZ_ERROR,
        terminalFailureReason: FAILURE_CLASSES.AUTHZ_ERROR,
        sessionId,
        details: {
          reason: 'ownership_mismatch',
          expected: binding.ownerKey,
          received: ownerKey
        }
      });
    }
    return binding;
  }

  _claimIdempotencyRecord(sessionId, owner, actionRequest) {
    const idempotencyKey = firstString(actionRequest?.idempotency_key, actionRequest?.idempotencyKey);
    if (!idempotencyKey) {
      throw new BrowserPerceptionEngineError('idempotency_key is required for action requests', {
        failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
        terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR,
        sessionId
      });
    }
    const payloadHash = buildPayloadHash(actionRequest || {});
    const scope = `${owner.companyId}:${owner.runId}:${sessionId}:${idempotencyKey}`;
    const existing = this.idempotencyRecords.get(scope);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new BrowserPerceptionEngineError('idempotency_key replay attempted with different payload hash', {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId,
          details: {
            reason: 'idempotency_payload_mismatch',
            idempotencyKey
          }
        });
      }
      if (existing.result) {
        return {
          replay: true,
          result: existing.result
        };
      }
      return {
        replay: false,
        scope,
        payloadHash
      };
    }

    this.idempotencyRecords.set(scope, {
      payloadHash,
      createdAtMs: Date.now(),
      result: null
    });
    return {
      replay: false,
      scope,
      payloadHash
    };
  }

  _persistIdempotencyResult(scope, result) {
    if (!scope) {
      return;
    }
    const record = this.idempotencyRecords.get(scope);
    if (!record) {
      return;
    }
    record.result = result;
  }

  _releaseIdempotencyClaim(scope) {
    if (!scope) {
      return;
    }
    this.idempotencyRecords.delete(scope);
  }

  async _request(method, routePath, options = {}) {
    if (!this.isConfigured()) {
      throw new BrowserPerceptionEngineError(
        'Browser Perception Engine URL is not configured',
        {
          failureClass: FAILURE_CLASSES.NOT_CONFIGURED,
          terminalFailureReason: FAILURE_CLASSES.NOT_CONFIGURED
        }
      );
    }
    this._assertServiceAuth();

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Number(options.timeoutMs)
      : this.defaultTimeoutMs;
    const requestBody = options.body == null ? undefined : JSON.stringify(options.body);
    if (requestBody && Buffer.byteLength(requestBody, 'utf8') > this.maxActionPayloadBytes) {
      throw new BrowserPerceptionEngineError(
        `Request payload exceeds max size (${this.maxActionPayloadBytes} bytes)`,
        {
          failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
          terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR,
          details: {
            routePath,
            maxActionPayloadBytes: this.maxActionPayloadBytes
          }
        }
      );
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      let response;
      let payloadText = '';
      try {
        response = await this.fetchImpl(this._resolveUrl(routePath), {
          method,
          headers: {
            ...this._buildHeaders(),
            ...(options.headers || {})
          },
          body: requestBody,
          signal: AbortSignal.timeout(Math.max(1, timeoutMs))
        });
        payloadText = await response.text();
      } catch (error) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        if (attempt < this.maxRetries) {
          attempt += 1;
          continue;
        }
        throw new BrowserPerceptionEngineError(
          isTimeout
            ? `BPE request timed out for ${method} ${routePath}`
            : `BPE transport failure for ${method} ${routePath}: ${error.message}`,
          {
            failureClass: isTimeout ? FAILURE_CLASSES.TIMEOUT : FAILURE_CLASSES.TRANSPORT_ERROR,
            terminalFailureReason: isTimeout ? FAILURE_CLASSES.TIMEOUT : FAILURE_CLASSES.TRANSPORT_ERROR,
            retryable: isTimeout || true,
            details: { method, routePath },
            cause: error
          }
        );
      }

      const payload = parseResponseBody(payloadText);
      if (!response.ok) {
        const failureClass = classifyHttpFailure(response.status, payload);
        const shouldRetry = attempt < this.maxRetries && (response.status >= 500 || response.status === 429);
        if (shouldRetry) {
          attempt += 1;
          continue;
        }
        throw new BrowserPerceptionEngineError(
          normalizeErrorMessage(payload, `BPE request failed with status ${response.status}`),
          {
            failureClass,
            terminalFailureReason: failureClass,
            statusCode: response.status,
            details: {
              method,
              routePath,
              payload
            },
            retryable: response.status >= 500 || response.status === 429
          }
        );
      }

      return payload;
    }

    throw new BrowserPerceptionEngineError('Unexpected BPE request retry state', {
      failureClass: FAILURE_CLASSES.TRANSPORT_ERROR,
      terminalFailureReason: FAILURE_CLASSES.TRANSPORT_ERROR,
      details: { method, routePath }
    });
  }

  async createSession(options = {}) {
    const owner = normalizeOwnershipContext(options.owner || {});
    const parsedTarget = parseTargetUrlOrThrow(options.target?.url, {
      allowLoopbackHosts: this.allowLoopbackTargets,
      allowedHosts: this.allowedTargetHosts
    });

    const payload = {
      target: {
        ...(options.target || {}),
        url: parsedTarget.toString()
      },
      runtime: options.runtime || {},
      trace: {
        ...(options.trace || {}),
        ownership: {
          company_id: owner.companyId,
          run_id: owner.runId,
          agent_id: owner.agentId
        }
      }
    };
    const resumeSessionId = firstString(options.resumeSessionId, options.resume_session_id);
    if (resumeSessionId) {
      payload.resume_session_id = resumeSessionId;
    }

    const raw = await this._request('POST', '/bpe/sessions', {
      body: payload,
      timeoutMs: options.timeoutMs,
      headers: this._buildOwnershipHeaders(owner)
    });
    const sessionId = firstString(raw?.session_id, raw?.sessionId, resumeSessionId);
    if (!sessionId) {
      throw new BrowserPerceptionEngineError('Session payload missing session_id', {
        failureClass: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
        terminalFailureReason: FAILURE_CLASSES.INVALID_STATE_PAYLOAD,
        details: { payload: raw }
      });
    }

    this.sessionBindings.set(sessionId, {
      ownerKey: ownershipKey(owner),
      owner,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + this.sessionTtlMs,
      actionCount: 0,
      targetHost: parsedTarget.hostname.toLowerCase()
    });

    return {
      sessionId,
      resumed: Boolean(raw?.resumed || resumeSessionId),
      createdAt: firstString(raw?.created_at, raw?.createdAt),
      capabilities: raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {},
      raw
    };
  }

  async readState(sessionId, options = {}) {
    const owner = normalizeOwnershipContext(options.owner || {});
    const normalizedSessionId = firstString(sessionId);
    if (!normalizedSessionId) {
      throw new BrowserPerceptionEngineError('sessionId is required', {
        failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
        terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR
      });
    }
    this._assertSessionOwnership(normalizedSessionId, owner);

    const raw = await this._request(
      'GET',
      `/bpe/sessions/${encodeURIComponent(normalizedSessionId)}/state`,
      {
        timeoutMs: options.timeoutMs,
        headers: this._buildOwnershipHeaders(owner)
      }
    );
    const normalized = normalizeStatePayload(raw);
    const parsedStateUrl = parseTargetUrlOrThrow(normalized.url, {
      allowLoopbackHosts: this.allowLoopbackTargets,
      allowedHosts: this.allowedTargetHosts
    });
    const binding = this.sessionBindings.get(normalizedSessionId);
    if (binding && parsedStateUrl.hostname.toLowerCase() !== binding.targetHost) {
      throw new BrowserPerceptionEngineError('BPE state URL host drift detected', {
        failureClass: FAILURE_CLASSES.ACTION_REJECTION,
        terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
        sessionId: normalizedSessionId,
        details: {
          reason: 'state_target_host_mismatch',
          expectedHost: binding.targetHost,
          receivedHost: parsedStateUrl.hostname.toLowerCase()
        }
      });
    }
    return {
      ...normalized,
      raw
    };
  }

  async issueAction(sessionId, actionRequest, options = {}) {
    const owner = normalizeOwnershipContext(options.owner || {});
    const normalizedSessionId = firstString(sessionId);
    if (!normalizedSessionId) {
      throw new BrowserPerceptionEngineError('sessionId is required', {
        failureClass: FAILURE_CLASSES.VALIDATION_ERROR,
        terminalFailureReason: FAILURE_CLASSES.VALIDATION_ERROR
      });
    }

    const binding = this._assertSessionOwnership(normalizedSessionId, owner);
    if (binding.actionCount >= this.maxActionsPerSession) {
      throw new BrowserPerceptionEngineError(
        `Per-session action cap exceeded (${this.maxActionsPerSession})`,
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId: normalizedSessionId,
          details: {
            reason: 'action_cap_exceeded',
            maxActionsPerSession: this.maxActionsPerSession
          }
        }
      );
    }
    this._touchRateLimit(owner);

    const claim = this._claimIdempotencyRecord(normalizedSessionId, owner, actionRequest || {});
    if (claim.replay) {
      return claim.result;
    }

    const raw = await this._request(
      'POST',
      `/bpe/sessions/${encodeURIComponent(normalizedSessionId)}/actions`,
      {
        body: actionRequest || {},
        timeoutMs: options.timeoutMs,
        headers: this._buildOwnershipHeaders(owner)
      }
    ).catch((error) => {
      this._releaseIdempotencyClaim(claim.scope);
      throw error;
    });

    const normalized = normalizeActionPayload(raw);
    if (ACTION_REJECTION_STATUSES.has(normalized.status)) {
      throw new BrowserPerceptionEngineError(
        `BPE action rejected with status ${normalized.status}`,
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId: normalizedSessionId,
          actionId: normalized.actionId,
          details: {
            status: normalized.status,
            response: raw
          }
        }
      );
    }

    binding.actionCount += 1;
    const result = {
      ...normalized,
      raw
    };
    this._persistIdempotencyResult(claim.scope, result);
    return result;
  }

  async runDeterministicScenario(options = {}) {
    const owner = normalizeOwnershipContext(options.owner || {});
    const parsedTarget = parseTargetUrlOrThrow(firstString(options.targetUrl, options.target?.url) || 'https://example.com', {
      allowLoopbackHosts: this.allowLoopbackTargets,
      allowedHosts: this.allowedTargetHosts
    });
    const targetUrl = parsedTarget.toString();
    const session = await this.createSession({
      target: { url: targetUrl, ...(options.target || {}) },
      runtime: options.runtime || {},
      trace: options.trace || {},
      owner,
      resumeSessionId: firstString(options.resumeSessionId),
      timeoutMs: options.timeoutMs
    });

    const state = await this.readState(session.sessionId, {
      owner,
      timeoutMs: options.timeoutMs
    });
    const interaction = options.interaction && typeof options.interaction === 'object'
      ? options.interaction
      : {};
    const actionType = firstString(interaction.type) || 'click';
    if (!this.allowedScenarioActionTypes.has(actionType.toLowerCase())) {
      throw new BrowserPerceptionEngineError(
        `Action type "${actionType}" is blocked by BPE policy`,
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId: session.sessionId,
          details: {
            reason: 'action_type_not_allowlisted',
            allowedActionTypes: Array.from(this.allowedScenarioActionTypes)
          }
        }
      );
    }
    const selectedTarget = buildScenarioTarget(interaction, state);
    const selectedElementName = firstString(selectedTarget?.resolvedElement?.name);
    const requestedTargetName = firstString(
      interaction?.target?.name,
      interaction?.target?.label,
      interaction?.targetName
    );
    const riskyPolicyOverride = (options.interactionPolicy && typeof options.interactionPolicy === 'object')
      ? options.interactionPolicy
      : (interaction?.policyOverride && typeof interaction.policyOverride === 'object')
        ? interaction.policyOverride
        : (interaction?.policy && typeof interaction.policy === 'object' ? interaction.policy : {});
    const riskyElement = requiresRiskyTargetOverride(selectedElementName);
    const allowRiskyOverride = riskyPolicyOverride?.allowRiskyTarget === true;
    const riskyOverrideReason = firstString(
      riskyPolicyOverride?.reason,
      riskyPolicyOverride?.justification,
      riskyPolicyOverride?.ticket
    );
    if (!selectedElementName) {
      throw new BrowserPerceptionEngineError(
        'Resolved target is missing name metadata required for policy evaluation',
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId: session.sessionId,
          details: {
            reason: 'target_metadata_missing',
            selectionSource: selectedTarget.selectionSource,
            targetId: selectedTarget?.resolvedElement?.id || null
          }
        }
      );
    }
    if (riskyElement && !allowRiskyOverride) {
      throw new BrowserPerceptionEngineError(
        `Target "${selectedElementName}" blocked by untrusted-state action policy`,
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId: session.sessionId,
          details: {
            reason: 'resolved_target_blocked_by_policy',
            selectionSource: selectedTarget.selectionSource,
            targetName: selectedElementName,
            targetId: selectedTarget?.resolvedElement?.id || null,
            requestedTargetName: requestedTargetName || null
          }
        }
      );
    }
    if (riskyElement && allowRiskyOverride && !riskyOverrideReason) {
      throw new BrowserPerceptionEngineError(
        'Risky target override requires a justification',
        {
          failureClass: FAILURE_CLASSES.ACTION_REJECTION,
          terminalFailureReason: FAILURE_CLASSES.ACTION_REJECTION,
          sessionId: session.sessionId,
          details: {
            reason: 'risky_target_override_justification_required',
            selectionSource: selectedTarget.selectionSource,
            targetName: selectedElementName,
            targetId: selectedTarget?.resolvedElement?.id || null
          }
        }
      );
    }
    if (riskyElement && allowRiskyOverride && riskyOverrideReason) {
      console.warn(
        `[orchestration][bpe][risky_target_override] ${JSON.stringify({
          session_id: session.sessionId,
          owner_company_id: owner.companyId,
          owner_run_id: owner.runId,
          owner_agent_id: owner.agentId,
          target_id: selectedTarget?.resolvedElement?.id || null,
          target_name: selectedElementName,
          selection_source: selectedTarget.selectionSource,
          reason: riskyOverrideReason
        })}`
      );
    }
    const actionPayload = {
      idempotency_key: firstString(options.idempotencyKey) || `bpe-${Date.now()}`,
      expected_state_version: Number.isFinite(options.expectedStateVersion)
        ? Number(options.expectedStateVersion)
        : state.stateVersion,
      action: {
        type: actionType,
        target: selectedTarget.target
      },
      timeout_ms: Number.isFinite(options.actionTimeoutMs)
        ? Number(options.actionTimeoutMs)
        : DEFAULT_SCENARIO_ACTION_TIMEOUT_MS
    };
    if (allowRiskyOverride && riskyOverrideReason) {
      actionPayload.policy_override = {
        allow_risky_target: true,
        reason: riskyOverrideReason,
        selection_source: selectedTarget.selectionSource,
        target_name: selectedElementName || requestedTargetName || null
      };
    }
    const action = await this.issueAction(session.sessionId, actionPayload, {
      owner,
      timeoutMs: options.timeoutMs
    });

    return {
      provider: 'browser_perception_engine',
      scenario: {
        kind: 'deterministic_single_interaction',
        targetUrl,
        interactionType: actionType,
        targetSource: selectedTarget.selectionSource,
        riskyTargetOverrideUsed: riskyElement && allowRiskyOverride && Boolean(riskyOverrideReason)
      },
      session: {
        sessionId: session.sessionId,
        resumed: session.resumed,
        createdAt: session.createdAt,
        capabilities: session.capabilities
      },
      state: {
        stateVersion: state.stateVersion,
        url: state.url,
        title: state.title,
        elementCount: state.elements.length
      },
      action: {
        actionId: action.actionId,
        status: action.status,
        stateVersion: action.stateVersion,
        events: action.events
      },
      evidence: {
        session_id: session.sessionId,
        action_id: action.actionId,
        terminal_failure_reason: null,
        risky_target_override_used: riskyElement && allowRiskyOverride && Boolean(riskyOverrideReason)
      },
      raw: {
        session: session.raw,
        state: state.raw,
        action: action.raw
      }
    };
  }
}

function createBrowserPerceptionEngineClient(options = {}) {
  return new BrowserPerceptionEngineClient(options);
}

module.exports = {
  FAILURE_CLASSES,
  BrowserPerceptionEngineError,
  BrowserPerceptionEngineClient,
  createBrowserPerceptionEngineClient,
  normalizeStatePayload,
  normalizeActionPayload,
  buildScenarioTarget
};
