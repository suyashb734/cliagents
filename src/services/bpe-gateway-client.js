'use strict';

const DEFAULT_TIMEOUT_MS = 30_000;

const FAILURE_CLASSIFICATION = Object.freeze({
  RETRYABLE: 'retryable',
  NON_RETRYABLE: 'non_retryable',
  OPERATOR_ACTION: 'operator_action'
});

const RECOMMENDED_ACTION = Object.freeze({
  RETRY_WITH_BACKOFF: 'retry_with_backoff',
  REFRESH_STATE_AND_RETRY: 'refresh_state_and_retry',
  RECREATE_SESSION: 'recreate_session',
  FIX_REQUEST_PAYLOAD: 'fix_request_payload',
  FIX_AUTH_CONFIGURATION: 'fix_auth_configuration',
  CHECK_GATEWAY_ENDPOINT: 'check_gateway_endpoint'
});

class BpeGatewayError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = 'BpeGatewayError';
    this.stage = metadata.stage || null;
    this.path = metadata.path || null;
    this.method = metadata.method || null;
    this.statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : null;
    this.code = metadata.code || null;
    this.classification = metadata.classification || FAILURE_CLASSIFICATION.NON_RETRYABLE;
    this.retryable = this.classification === FAILURE_CLASSIFICATION.RETRYABLE;
    this.recommendedAction = metadata.recommendedAction || RECOMMENDED_ACTION.FIX_REQUEST_PAYLOAD;
    this.details = metadata.details || null;
  }
}

function normalizeGatewayUrl(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new Error('gatewayUrl is required');
  }
  return rawValue.replace(/\/+$/, '');
}

function parseResponseBody(rawText) {
  if (!rawText) {
    return {};
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return { error: rawText };
  }
}

function getErrorCode(payload = {}) {
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  if (typeof payload?.code === 'string' && payload.code.trim()) {
    return payload.code.trim();
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  return null;
}

function classifyFailure({ statusCode = null, code = null, message = '' } = {}) {
  const normalizedCode = String(code || '').toLowerCase();
  const normalizedMessage = String(message || '').toLowerCase();

  if (
    statusCode === 409 ||
    normalizedCode.includes('state') ||
    normalizedMessage.includes('state version')
  ) {
    return {
      classification: FAILURE_CLASSIFICATION.RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.REFRESH_STATE_AND_RETRY
    };
  }

  if (statusCode === 404 || normalizedCode.includes('session_not_found')) {
    return {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.RECREATE_SESSION
    };
  }

  if (statusCode === 400 || statusCode === 422) {
    return {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.FIX_REQUEST_PAYLOAD
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      classification: FAILURE_CLASSIFICATION.OPERATOR_ACTION,
      recommendedAction: RECOMMENDED_ACTION.FIX_AUTH_CONFIGURATION
    };
  }

  if (statusCode === 429 || (statusCode !== null && statusCode >= 500)) {
    return {
      classification: FAILURE_CLASSIFICATION.RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.RETRY_WITH_BACKOFF
    };
  }

  return {
    classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
    recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
  };
}

function ensureObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BpeGatewayError(`Invalid ${fieldName}: expected object response`, {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
    });
  }
}

function ensureString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BpeGatewayError(`Invalid ${fieldName}: expected non-empty string`, {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
    });
  }
}

function ensureNumber(value, fieldName) {
  if (!Number.isFinite(value)) {
    throw new BpeGatewayError(`Invalid ${fieldName}: expected number`, {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
    });
  }
}

function validateSessionCreateResponse(payload) {
  ensureObject(payload, 'session create payload');
  ensureString(payload.sessionId, 'sessionId');
  ensureString(payload.browserWorkerId, 'browserWorkerId');
  ensureNumber(payload.stateVersion, 'stateVersion');
}

function validateNavigationResponse(payload) {
  ensureObject(payload, 'navigation payload');
  ensureString(payload.sessionId, 'sessionId');
  ensureString(payload.url, 'url');
  ensureNumber(payload.stateVersion, 'stateVersion');
}

function validateStateResponse(payload) {
  ensureObject(payload, 'state payload');
  ensureString(payload.sessionId, 'sessionId');
  ensureNumber(payload.stateVersion, 'stateVersion');
  if (!Array.isArray(payload.elements)) {
    throw new BpeGatewayError('Invalid elements: expected array', {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
    });
  }
}

function validateResolveActionResponse(payload) {
  ensureObject(payload, 'resolve-action payload');
  ensureString(payload.type, 'type');
  ensureNumber(payload.confidence, 'confidence');
}

function validateActionExecutionResponse(payload) {
  ensureObject(payload, 'action execution payload');
  ensureString(payload.executionId, 'executionId');
  ensureString(payload.status, 'status');
  ensureNumber(payload.newStateVersion, 'newStateVersion');
}

function validateExtractionResponse(payload) {
  ensureObject(payload, 'extract payload');
  ensureString(payload.sessionId, 'sessionId');
  ensureString(payload.schemaName, 'schemaName');
  if (!Array.isArray(payload.collections)) {
    throw new BpeGatewayError('Invalid extract response: collections must be an array', {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
    });
  }
}

function validateSessionCloseResponse(payload) {
  ensureObject(payload, 'session close payload');
  ensureString(payload.sessionId, 'sessionId');
  if (typeof payload.closed !== 'boolean') {
    throw new BpeGatewayError('Invalid close response: closed must be a boolean', {
      classification: FAILURE_CLASSIFICATION.NON_RETRYABLE,
      recommendedAction: RECOMMENDED_ACTION.CHECK_GATEWAY_ENDPOINT
    });
  }
}

class BpeGatewayClient {
  constructor(options = {}) {
    this.gatewayUrl = normalizeGatewayUrl(options.gatewayUrl || '');
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('BpeGatewayClient requires a fetch implementation');
    }
  }

  async request(method, path, payload, metadata = {}) {
    const url = `${this.gatewayUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal
      });

      const rawText = await response.text();
      const parsedBody = parseResponseBody(rawText);

      if (!response.ok) {
        const code = getErrorCode(parsedBody);
        const details = parsedBody?.details || null;
        const message = parsedBody?.message || parsedBody?.error || `${response.status} ${response.statusText}`;
        const classification = classifyFailure({
          statusCode: response.status,
          code,
          message
        });
        throw new BpeGatewayError(String(message), {
          stage: metadata.stage || null,
          path,
          method,
          statusCode: response.status,
          code,
          details,
          classification: classification.classification,
          recommendedAction: classification.recommendedAction
        });
      }

      return parsedBody;
    } catch (error) {
      if (error instanceof BpeGatewayError) {
        throw error;
      }

      if (error?.name === 'AbortError') {
        throw new BpeGatewayError(`Gateway request timed out after ${this.timeoutMs}ms`, {
          stage: metadata.stage || null,
          path,
          method,
          statusCode: null,
          code: 'gateway_timeout',
          classification: FAILURE_CLASSIFICATION.RETRYABLE,
          recommendedAction: RECOMMENDED_ACTION.RETRY_WITH_BACKOFF
        });
      }

      throw new BpeGatewayError(`Gateway request failed: ${error?.message || String(error)}`, {
        stage: metadata.stage || null,
        path,
        method,
        statusCode: null,
        code: 'gateway_unreachable',
        classification: FAILURE_CLASSIFICATION.RETRYABLE,
        recommendedAction: RECOMMENDED_ACTION.RETRY_WITH_BACKOFF
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSession(payload) {
    const data = await this.request('POST', '/v1/sessions', payload, { stage: 'create_session' });
    validateSessionCreateResponse(data);
    return data;
  }

  async navigate(sessionId, url) {
    const data = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/navigate`,
      { url },
      { stage: 'navigate' }
    );
    validateNavigationResponse(data);
    return data;
  }

  async getState(sessionId) {
    const data = await this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/state`,
      null,
      { stage: 'state' }
    );
    validateStateResponse(data);
    return data;
  }

  async resolveAction(sessionId, intent) {
    const data = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/resolve-action`,
      { intent },
      { stage: 'resolve_action' }
    );
    validateResolveActionResponse(data);
    return data;
  }

  async executeActions(sessionId, payload) {
    const data = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
      payload,
      { stage: 'execute_actions' }
    );
    validateActionExecutionResponse(data);
    return data;
  }

  async extract(sessionId, payload) {
    const data = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/extract`,
      payload,
      { stage: 'extract' }
    );
    validateExtractionResponse(data);
    return data;
  }

  async closeSession(sessionId) {
    const data = await this.request(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      null,
      { stage: 'close_session' }
    );
    validateSessionCloseResponse(data);
    return data;
  }
}

module.exports = {
  BpeGatewayClient,
  BpeGatewayError,
  FAILURE_CLASSIFICATION,
  RECOMMENDED_ACTION
};
