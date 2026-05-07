#!/usr/bin/env node

'use strict';

const assert = require('assert');
const http = require('http');

const {
  runBpeIntegrationScenario
} = require('../src/services/bpe-integration-scenario');

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

function createMockBpeGateway(options = {}) {
  const state = {
    requests: [],
    sessionId: 'session-bpe-1',
    stateVersion: 7
  };

  const server = http.createServer(async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      state.requests.push({
        method: req.method,
        url: req.url,
        body
      });

      if (req.method === 'POST' && req.url === '/v1/sessions') {
        return writeJson(res, 200, {
          sessionId: state.sessionId,
          browserWorkerId: 'worker-1',
          stateVersion: state.stateVersion
        });
      }

      if (req.method === 'POST' && req.url === `/v1/sessions/${state.sessionId}/navigate`) {
        return writeJson(res, 200, {
          sessionId: state.sessionId,
          url: body.url,
          stateVersion: state.stateVersion,
          navigatedAt: new Date().toISOString()
        });
      }

      if (req.method === 'GET' && req.url === `/v1/sessions/${state.sessionId}/state`) {
        return writeJson(res, 200, {
          sessionId: state.sessionId,
          stateVersion: state.stateVersion,
          elements: [
            {
              id: 'search-input',
              role: 'textbox',
              controlType: 'input',
              visible: true,
              enabled: true,
              typeable: true,
              clickable: false,
              name: 'Search',
              label: 'Search query',
              importance: 0.95
            },
            {
              id: 'search-submit',
              role: 'button',
              controlType: 'button',
              visible: true,
              enabled: true,
              typeable: false,
              clickable: true,
              name: 'Search',
              label: 'Search button',
              importance: 0.91
            }
          ]
        });
      }

      if (req.method === 'POST' && req.url === `/v1/sessions/${state.sessionId}/resolve-action`) {
        return writeJson(res, 200, {
          type: 'element_action',
          selectedElementId: 'search-submit',
          confidence: 0.92,
          reason: 'search controls available'
        });
      }

      if (req.method === 'POST' && req.url === `/v1/sessions/${state.sessionId}/actions`) {
        if (options.stateVersionConflict) {
          return writeJson(res, 409, {
            error: 'state_version_conflict',
            message: 'Expected state version 7 but current version is 8.'
          });
        }

        return writeJson(res, 200, {
          executionId: 'exec-1',
          status: 'completed',
          newStateVersion: state.stateVersion + 1
        });
      }

      if (req.method === 'POST' && req.url === `/v1/sessions/${state.sessionId}/extract`) {
        return writeJson(res, 200, {
          sessionId: state.sessionId,
          capturedAt: new Date().toISOString(),
          schemaName: body.schemaName,
          collections: [
            {
              name: 'search_controls',
              entity: 'elements',
              count: 1,
              records: [{ id: 'search-submit', role: 'button', name: 'Search' }],
              warnings: []
            }
          ],
          warnings: []
        });
      }

      if (req.method === 'DELETE' && req.url === `/v1/sessions/${state.sessionId}`) {
        return writeJson(res, 200, {
          closed: true,
          sessionId: state.sessionId,
          artifacts: {
            videoPath: null
          }
        });
      }

      return writeJson(res, 404, {
        error: 'route_not_found',
        message: `No mock route for ${req.method} ${req.url}`
      });
    } catch (error) {
      return writeJson(res, 500, {
        error: 'mock_server_failure',
        message: error.message
      });
    }
  });

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function testHappyPath() {
  const gateway = createMockBpeGateway();
  const gatewayUrl = await gateway.start();
  try {
    const result = await runBpeIntegrationScenario({
      gatewayUrl,
      targetUrl: 'http://example.test/search',
      searchQuery: 'Alan Turing',
      timeoutMs: 3_000
    });

    assert.strictEqual(result.ok, true, 'scenario should succeed');
    assert(Array.isArray(result.timeline), 'timeline should be array');

    const steps = result.timeline.map((entry) => entry.step);
    assert.deepStrictEqual(
      steps,
      ['create_session', 'navigate', 'state', 'resolve_action', 'execute_actions', 'extract', 'close_session'],
      'scenario should execute required sequence'
    );

    const executeRequest = gateway.state.requests.find(
      (entry) => entry.method === 'POST' && entry.url === '/v1/sessions/session-bpe-1/actions'
    );
    assert(executeRequest, 'execute actions request should be sent');
    assert(Array.isArray(executeRequest.body.actions), 'actions payload must be array');
    assert.strictEqual(executeRequest.body.expectedStateVersion, 7, 'expectedStateVersion should match fetched state');
  } finally {
    await gateway.stop();
  }
}

async function testStateConflictFailureClassification() {
  const gateway = createMockBpeGateway({ stateVersionConflict: true });
  const gatewayUrl = await gateway.start();
  try {
    const result = await runBpeIntegrationScenario({
      gatewayUrl,
      targetUrl: 'http://example.test/search',
      searchQuery: 'Grace Hopper',
      timeoutMs: 3_000
    });

    assert.strictEqual(result.ok, false, 'scenario should fail');
    assert(result.error, 'error payload should be present');
    assert.strictEqual(result.error.code, 'state_version_conflict');
    assert.strictEqual(result.error.retryable, true);
    assert.strictEqual(result.error.recommendedAction, 'refresh_state_and_retry');
    assert.strictEqual(result.error.classification, 'retryable');
  } finally {
    await gateway.stop();
  }
}

async function main() {
  await testHappyPath();
  await testStateConflictFailureClassification();
  console.log('✅ BPE integration scenario tests passed');
}

main().catch((error) => {
  console.error('❌ BPE integration scenario tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
