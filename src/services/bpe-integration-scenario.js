'use strict';

const {
  BpeGatewayClient,
  BpeGatewayError
} = require('./bpe-gateway-client');

const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const DEFAULT_QUERY = 'Alan Turing';
const DEFAULT_BROWSER = 'chromium';
const DEFAULT_TENANT_ID = 'cliagents-bpe-scenario';
const DEFAULT_CONNECTION_MODE = 'launch';
const SUPPORTED_CONNECTION_MODES = new Set(['launch', 'connect_cdp', 'launch_persistent']);

function ensureNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  return Boolean(fallback);
}

function normalizeConnection(options = {}) {
  const mode = ensureNonEmptyString(options.mode || DEFAULT_CONNECTION_MODE, 'connection.mode');
  if (!SUPPORTED_CONNECTION_MODES.has(mode)) {
    throw new Error(`Unsupported connection.mode: ${mode}`);
  }

  const connection = { mode };
  if (typeof options.cdpUrl === 'string' && options.cdpUrl.trim()) {
    connection.cdpUrl = options.cdpUrl.trim();
  }
  if (typeof options.pageStrategy === 'string' && options.pageStrategy.trim()) {
    connection.pageStrategy = options.pageStrategy.trim();
  }
  if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    connection.userDataDir = options.userDataDir.trim();
  }
  if (typeof options.browserChannel === 'string' && options.browserChannel.trim()) {
    connection.browserChannel = options.browserChannel.trim();
  }
  return connection;
}

function buildSessionPayload(options = {}) {
  const viewport = options.viewport || DEFAULT_VIEWPORT;
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw new Error('viewport.width and viewport.height must be numbers');
  }

  return {
    browser: ensureNonEmptyString(options.browser || DEFAULT_BROWSER, 'browser'),
    viewport: {
      width: Number(viewport.width),
      height: Number(viewport.height)
    },
    tenantId: ensureNonEmptyString(options.tenantId || DEFAULT_TENANT_ID, 'tenantId'),
    headless: asBoolean(options.headless, true),
    enableVisionFallback: false,
    connection: normalizeConnection(options.connection || {})
  };
}

function getSearchTextbox(elements = []) {
  const candidates = elements.filter((element) => {
    if (!element || typeof element !== 'object') {
      return false;
    }
    if (element.visible === false || element.enabled === false) {
      return false;
    }
    const role = String(element.role || '').toLowerCase();
    const controlType = String(element.controlType || '').toLowerCase();
    return element.typeable === true || role === 'textbox' || controlType === 'input';
  });

  const ranked = candidates.sort((left, right) => {
    const scoreLeft = Number(left.importance || 0);
    const scoreRight = Number(right.importance || 0);
    return scoreRight - scoreLeft;
  });

  return ranked[0] || null;
}

function getSearchButton(elements = []) {
  const candidates = elements.filter((element) => {
    if (!element || typeof element !== 'object') {
      return false;
    }
    if (element.visible === false || element.enabled === false) {
      return false;
    }
    const role = String(element.role || '').toLowerCase();
    const text = `${element.name || ''} ${element.label || ''}`.toLowerCase();
    return element.clickable === true || role === 'button' || /search|submit|go|find/.test(text);
  });

  const ranked = candidates.sort((left, right) => {
    const scoreLeft = Number(left.importance || 0);
    const scoreRight = Number(right.importance || 0);
    return scoreRight - scoreLeft;
  });

  return ranked[0] || null;
}

function buildActionPlan(state, query, resolvedAction) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const textbox = getSearchTextbox(elements);
  const button = getSearchButton(elements);
  const actions = [];

  if (textbox?.id) {
    actions.push({ type: 'type', target: textbox.id, value: query });
  }

  if (button?.id) {
    actions.push({ type: 'click', target: button.id });
  } else if (resolvedAction?.selectedElementId) {
    actions.push({ type: 'click', target: resolvedAction.selectedElementId });
  }

  return actions;
}

function buildExtractionSchema() {
  return {
    schemaName: 'cliagents_bpe_search_confirmation',
    includePage: true,
    collections: [
      {
        name: 'search_controls',
        entity: 'elements',
        fields: [
          { key: 'id', source: 'id' },
          { key: 'name', source: 'name' },
          { key: 'role', source: 'role' },
          { key: 'controlType', source: 'controlType' }
        ],
        filters: {
          clickable: true
        },
        limit: 10,
        sortBy: 'importance'
      },
      {
        name: 'search_text_inputs',
        entity: 'elements',
        fields: [
          { key: 'id', source: 'id' },
          { key: 'name', source: 'name' },
          { key: 'role', source: 'role' },
          { key: 'value', source: 'value' }
        ],
        filters: {
          typeable: true
        },
        limit: 5,
        sortBy: 'importance'
      }
    ]
  };
}

function summarizeStep(step, payload) {
  if (step === 'state') {
    return {
      sessionId: payload.sessionId,
      stateVersion: payload.stateVersion,
      elementCount: Array.isArray(payload.elements) ? payload.elements.length : 0
    };
  }

  if (step === 'extract') {
    return {
      sessionId: payload.sessionId,
      schemaName: payload.schemaName,
      collectionCount: Array.isArray(payload.collections) ? payload.collections.length : 0
    };
  }

  return payload;
}

async function runBpeIntegrationScenario(options = {}) {
  const gatewayUrl = ensureNonEmptyString(options.gatewayUrl, 'gatewayUrl');
  const targetUrl = ensureNonEmptyString(options.targetUrl, 'targetUrl');
  const searchQuery = ensureNonEmptyString(options.searchQuery || DEFAULT_QUERY, 'searchQuery');
  const client = new BpeGatewayClient({
    gatewayUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  });

  const timeline = [];
  const startedAt = new Date().toISOString();
  let sessionId = null;
  let closedSession = null;

  try {
    const createPayload = buildSessionPayload(options);
    const created = await client.createSession(createPayload);
    timeline.push({ step: 'create_session', data: summarizeStep('create_session', created) });
    sessionId = created.sessionId;

    const navigated = await client.navigate(sessionId, targetUrl);
    timeline.push({ step: 'navigate', data: summarizeStep('navigate', navigated) });

    const state = await client.getState(sessionId);
    timeline.push({ step: 'state', data: summarizeStep('state', state) });

    const intent = `Search for "${searchQuery}" and submit the query`;
    const resolvedAction = await client.resolveAction(sessionId, intent);
    timeline.push({ step: 'resolve_action', data: summarizeStep('resolve_action', resolvedAction) });

    const actions = buildActionPlan(state, searchQuery, resolvedAction);
    if (actions.length === 0) {
      throw new BpeGatewayError('Scenario failed: no actionable search elements were detected', {
        stage: 'plan_actions',
        code: 'no_search_actions',
        classification: 'non_retryable',
        recommendedAction: 'fix_request_payload'
      });
    }

    const executed = await client.executeActions(sessionId, {
      actions,
      requireConfirmation: false,
      expectedStateVersion: state.stateVersion
    });
    timeline.push({ step: 'execute_actions', data: summarizeStep('execute_actions', executed) });

    const extractSchema = buildExtractionSchema();
    const extracted = await client.extract(sessionId, extractSchema);
    timeline.push({ step: 'extract', data: summarizeStep('extract', extracted) });

    closedSession = await client.closeSession(sessionId);
    timeline.push({ step: 'close_session', data: summarizeStep('close_session', closedSession) });
    sessionId = null;

    return {
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      gatewayUrl,
      targetUrl,
      searchQuery,
      timeline,
      close: closedSession
    };
  } catch (error) {
    let cleanup = null;
    if (sessionId) {
      try {
        cleanup = await client.closeSession(sessionId);
      } catch (cleanupError) {
        cleanup = {
          closed: false,
          sessionId,
          error: cleanupError?.message || String(cleanupError)
        };
      }
    }

    if (error instanceof BpeGatewayError) {
      return {
        ok: false,
        startedAt,
        completedAt: new Date().toISOString(),
        gatewayUrl,
        targetUrl,
        searchQuery,
        timeline,
        cleanup,
        error: {
          name: error.name,
          message: error.message,
          stage: error.stage,
          method: error.method,
          path: error.path,
          statusCode: error.statusCode,
          code: error.code,
          classification: error.classification,
          retryable: error.retryable,
          recommendedAction: error.recommendedAction,
          details: error.details
        }
      };
    }

    return {
      ok: false,
      startedAt,
      completedAt: new Date().toISOString(),
      gatewayUrl,
      targetUrl,
      searchQuery,
      timeline,
      cleanup,
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        stage: 'scenario',
        classification: 'non_retryable',
        retryable: false,
        recommendedAction: 'check_gateway_endpoint'
      }
    };
  }
}

module.exports = {
  runBpeIntegrationScenario,
  buildSessionPayload,
  buildExtractionSchema,
  buildActionPlan
};
