#!/usr/bin/env node

'use strict';

const assert = require('assert');
const http = require('http');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

const BPE_ENV_KEYS = [
  'CLIAGENTS_BPE_BASE_URL',
  'CLIAGENTS_BPE_API_KEY',
  'CLIAGENTS_BPE_REQUIRE_AUTH',
  'CLIAGENTS_BPE_ALLOW_LOOPBACK_TARGETS',
  'CLIAGENTS_BPE_ALLOWED_TARGET_HOSTS'
];

function snapshotEnv(keys) {
  const snapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

async function request(baseUrl, method, route, body = null) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

async function startFakeBpeServer() {
  const buildDefaultElements = () => ([
    { id: 'el_more', role: 'link', name: 'More information...' },
    { id: 'danger_delete_btn', role: 'button', name: 'Delete Account' }
  ]);
  const state = {
    mode: 'success',
    lastSessionBody: null,
    lastActionBody: null,
    sessionCounter: 0,
    actionCalls: 0,
    elements: buildDefaultElements()
  };

  const server = http.createServer(async (req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const readBody = async () => {
      let data = '';
      for await (const chunk of req) {
        data += chunk;
      }
      return data ? JSON.parse(data) : {};
    };

    if (req.method === 'POST' && req.url === '/bpe/sessions') {
      state.lastSessionBody = await readBody();
      const sessionId = state.lastSessionBody.resume_session_id || `sess_det_${++state.sessionCounter}`;
      return writeJson(200, {
        session_id: sessionId,
        created_at: '2026-05-07T12:00:00.000Z',
        capabilities: { actions: ['click'] }
      });
    }

    const statePathMatch = req.method === 'GET'
      ? req.url.match(/^\/bpe\/sessions\/([^/]+)\/state$/)
      : null;
    if (statePathMatch) {
      if (state.mode === 'timeout') {
        setTimeout(() => {
          writeJson(200, {
            state_version: 4,
            url: 'https://example.com',
            title: 'Example Domain',
            elements: state.elements
          });
        }, 120);
        return;
      }
      if (state.mode === 'transport_error') {
        req.socket.destroy();
        return;
      }
      if (state.mode === 'invalid_state_payload') {
        return writeJson(200, {
          url: 'https://example.com',
          title: 'Broken state payload',
          elements: []
        });
      }
      return writeJson(200, {
        state_version: 4,
        url: 'https://example.com',
        title: 'Example Domain',
        elements: state.elements
      });
    }

    const actionPathMatch = req.method === 'POST'
      ? req.url.match(/^\/bpe\/sessions\/([^/]+)\/actions$/)
      : null;
    if (actionPathMatch) {
      state.lastActionBody = await readBody();
      state.actionCalls += 1;
      if (state.mode === 'action_rejection') {
        return writeJson(200, {
          action_id: 'act_1',
          status: 'blocked',
          state_version: 4,
          events: ['policy_blocked']
        });
      }
      return writeJson(200, {
        action_id: 'act_1',
        status: 'succeeded',
        state_version: 5,
        events: ['navigation_started', 'navigation_completed']
      });
    }

    return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function run() {
  const envSnapshot = snapshotEnv(BPE_ENV_KEYS);
  const fakeBpe = await startFakeBpeServer();
  process.env.CLIAGENTS_BPE_BASE_URL = fakeBpe.baseUrl;
  process.env.CLIAGENTS_BPE_API_KEY = 'test-bpe-api-key';
  process.env.CLIAGENTS_BPE_REQUIRE_AUTH = '1';
  delete process.env.CLIAGENTS_BPE_ALLOW_LOOPBACK_TARGETS;
  delete process.env.CLIAGENTS_BPE_ALLOWED_TARGET_HOSTS;

  const testServer = await startTestServer({
    orchestration: {
      enabled: true
    }
  });
  let noAuthServer = null;

  try {
    const baseUrl = testServer.baseUrl;

    const sessionRes = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/session', {
      target: { url: 'https://example.com' },
      runtime: { headless: true }
    });
    assert.strictEqual(sessionRes.status, 200);
    assert.strictEqual(sessionRes.data.ok, true);
    const sessionId = sessionRes.data.session.sessionId;
    assert.ok(/^sess_det_/.test(sessionId), `Expected deterministic session id format, received ${sessionId}`);

    const stateRes = await request(baseUrl, 'GET', `/orchestration/browser-perception-engine/sessions/${sessionId}/state`);
    assert.strictEqual(stateRes.status, 200);
    assert.strictEqual(stateRes.data.ok, true);
    assert.strictEqual(stateRes.data.state.stateVersion, 4);

    const actionPayload = {
      idempotency_key: 'test-action-1',
      expected_state_version: 4,
      action: {
        type: 'click',
        target: { element_id: 'el_more' }
      }
    };
    const actionRes = await request(baseUrl, 'POST', `/orchestration/browser-perception-engine/sessions/${sessionId}/action`, actionPayload);
    assert.strictEqual(actionRes.status, 200);
    assert.strictEqual(actionRes.data.ok, true);
    assert.strictEqual(actionRes.data.action.actionId, 'act_1');
    assert.strictEqual(actionRes.data.action.status, 'succeeded');
    const actionCallsAfterInitial = fakeBpe.state.actionCalls;

    const replayActionRes = await request(baseUrl, 'POST', `/orchestration/browser-perception-engine/sessions/${sessionId}/action`, actionPayload);
    assert.strictEqual(replayActionRes.status, 200);
    assert.strictEqual(replayActionRes.data.ok, true);
    assert.strictEqual(fakeBpe.state.actionCalls, actionCallsAfterInitial, 'Expected identical idempotency replay to reuse cached result');

    const mismatchReplay = await request(baseUrl, 'POST', `/orchestration/browser-perception-engine/sessions/${sessionId}/action`, {
      idempotency_key: 'test-action-1',
      expected_state_version: 9,
      action: {
        type: 'click',
        target: { element_id: 'el_more' }
      }
    });
    assert.strictEqual(mismatchReplay.status, 409);
    assert.strictEqual(mismatchReplay.data.failureClass, 'action_rejection');
    assert.strictEqual(mismatchReplay.data.terminalFailureReason, 'action_rejection');

    const ownershipMismatchState = await request(
      baseUrl,
      'GET',
      `/orchestration/browser-perception-engine/sessions/${sessionId}/state?runId=other-run-context`
    );
    assert.strictEqual(ownershipMismatchState.status, 403);
    assert.strictEqual(ownershipMismatchState.data.failureClass, 'authz_error');

    const privateHostSession = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/session', {
      target: { url: 'http://127.0.0.1/internal' }
    });
    assert.strictEqual(privateHostSession.status, 400);
    assert.strictEqual(privateHostSession.data.failureClass, 'validation_error');

    const capSession = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/session', {
      target: { url: 'https://example.com' }
    });
    assert.strictEqual(capSession.status, 200);
    const capSessionId = capSession.data.session.sessionId;

    for (let index = 0; index < 5; index += 1) {
      const capAction = await request(baseUrl, 'POST', `/orchestration/browser-perception-engine/sessions/${capSessionId}/action`, {
        idempotency_key: `cap-action-${index}`,
        expected_state_version: 4,
        action: {
          type: 'click',
          target: { element_id: 'el_more' }
        }
      });
      assert.strictEqual(capAction.status, 200, `Expected action ${index} to remain under cap`);
    }

    const capExceededAction = await request(baseUrl, 'POST', `/orchestration/browser-perception-engine/sessions/${capSessionId}/action`, {
      idempotency_key: 'cap-action-overflow',
      expected_state_version: 4,
      action: {
        type: 'click',
        target: { element_id: 'el_more' }
      }
    });
    assert.strictEqual(capExceededAction.status, 409);
    assert.strictEqual(capExceededAction.data.failureClass, 'action_rejection');

    const successScenario = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      interaction: { type: 'click', target: { name: 'More information...' } }
    });
    assert.strictEqual(successScenario.status, 200);
    assert.strictEqual(successScenario.data.ok, true);
    assert.ok(/^sess_det_/.test(successScenario.data.session.sessionId));
    assert.strictEqual(successScenario.data.action.actionId, 'act_1');
    assert.strictEqual(successScenario.data.evidence.terminal_failure_reason, null);
    assert.strictEqual(fakeBpe.state.lastActionBody.expected_state_version, 4);

    const explicitDangerousElement = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      interaction: { type: 'click', target: { element_id: 'danger_delete_btn' } }
    });
    assert.strictEqual(explicitDangerousElement.status, 409);
    assert.strictEqual(explicitDangerousElement.data.failureClass, 'action_rejection');
    assert.strictEqual(
      explicitDangerousElement.data.details?.reason,
      'resolved_target_blocked_by_policy',
      'Expected explicit element_id target to be denied by resolved target policy'
    );

    fakeBpe.state.elements = [
      { id: 'el_more', role: 'link', name: 'More information...' },
      { id: 'danger_delete_btn', role: 'button' }
    ];
    const explicitDangerousMissingMetadata = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      interaction: { type: 'click', target: { element_id: 'danger_delete_btn' } }
    });
    assert.strictEqual(explicitDangerousMissingMetadata.status, 409);
    assert.strictEqual(explicitDangerousMissingMetadata.data.failureClass, 'action_rejection');
    assert.strictEqual(
      explicitDangerousMissingMetadata.data.details?.reason,
      'target_metadata_missing',
      'Expected fail-closed behavior when resolved target metadata is missing'
    );
    fakeBpe.state.elements = [
      { id: 'el_more', role: 'link', name: 'More information...' },
      { id: 'danger_delete_btn', role: 'button', name: 'Delete Account' }
    ];

    const explicitDangerousElementWithOverride = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      interaction: {
        type: 'click',
        target: { element_id: 'danger_delete_btn' },
        policyOverride: {
          allowRiskyTarget: true,
          reason: 'manual-approval-kd83'
        }
      }
    });
    assert.strictEqual(explicitDangerousElementWithOverride.status, 200);
    assert.strictEqual(
      fakeBpe.state.lastActionBody.policy_override?.reason,
      'manual-approval-kd83',
      'Expected risky-target override to be audited in action payload'
    );

    const explicitDangerousElementWithTopLevelOverride = await request(
      baseUrl,
      'POST',
      '/orchestration/browser-perception-engine/scenario',
      {
        targetUrl: 'https://example.com',
        interaction: {
          type: 'click',
          target: { element_id: 'danger_delete_btn' }
        },
        interactionPolicy: {
          allowRiskyTarget: true,
          justification: 'manual-approval-kd83-top-level'
        }
      }
    );
    assert.strictEqual(explicitDangerousElementWithTopLevelOverride.status, 200);
    assert.strictEqual(
      fakeBpe.state.lastActionBody.policy_override?.reason,
      'manual-approval-kd83-top-level',
      'Expected top-level interactionPolicy override to be forwarded and audited'
    );

    const blockedActionType = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      interaction: { type: 'type_text', target: { name: 'More information...' } }
    });
    assert.strictEqual(blockedActionType.status, 409);
    assert.strictEqual(blockedActionType.data.failureClass, 'action_rejection');

    const blockedTargetName = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      interaction: { type: 'click', target: { name: 'Delete Account' } }
    });
    assert.strictEqual(blockedTargetName.status, 409);
    assert.strictEqual(blockedTargetName.data.failureClass, 'action_rejection');

    fakeBpe.state.mode = 'invalid_state_payload';
    const invalidStateScenario = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com'
    });
    assert.strictEqual(invalidStateScenario.status, 502);
    assert.strictEqual(invalidStateScenario.data.failureClass, 'invalid_state_payload');
    assert.strictEqual(invalidStateScenario.data.terminalFailureReason, 'invalid_state_payload');

    fakeBpe.state.mode = 'action_rejection';
    const rejectionScenario = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com'
    });
    assert.strictEqual(rejectionScenario.status, 409);
    assert.strictEqual(rejectionScenario.data.failureClass, 'action_rejection');

    fakeBpe.state.mode = 'timeout';
    const timeoutScenario = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com',
      timeoutMs: 25
    });
    assert.strictEqual(timeoutScenario.status, 504);
    assert.strictEqual(timeoutScenario.data.failureClass, 'timeout');

    fakeBpe.state.mode = 'transport_error';
    const transportScenario = await request(baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com'
    });
    assert.strictEqual(transportScenario.status, 502);
    assert.strictEqual(transportScenario.data.failureClass, 'transport_error');

    await stopTestServer(testServer);

    delete process.env.CLIAGENTS_BPE_API_KEY;
    process.env.CLIAGENTS_BPE_REQUIRE_AUTH = '1';
    noAuthServer = await startTestServer({
      orchestration: {
        enabled: true
      }
    });
    const noAuthScenario = await request(noAuthServer.baseUrl, 'POST', '/orchestration/browser-perception-engine/scenario', {
      targetUrl: 'https://example.com'
    });
    assert.strictEqual(noAuthScenario.status, 503);
    assert.strictEqual(noAuthScenario.data.failureClass, 'not_configured');
    await stopTestServer(noAuthServer);
    noAuthServer = null;

    console.log('✅ BPE orchestration route handles success + required failure classes');
  } finally {
    await stopTestServer(testServer).catch(() => {});
    if (noAuthServer) {
      await stopTestServer(noAuthServer).catch(() => {});
    }
    await fakeBpe.close();
    restoreEnv(envSnapshot);
  }
}

run().catch((error) => {
  console.error('BPE orchestration route test failed:', error);
  process.exit(1);
});
