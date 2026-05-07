#!/usr/bin/env node

'use strict';

const assert = require('assert');
const http = require('http');

function loadMcpModule(envOverrides = {}) {
  const modulePath = require.resolve('../src/mcp/cliagents-mcp-server');
  delete require.cache[modulePath];

  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const mod = require('../src/mcp/cliagents-mcp-server');

  return {
    mod,
    restore() {
      delete require.cache[modulePath];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

async function startFakeCliagentsServer() {
  const state = {
    mode: 'success',
    lastScenarioBody: null
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

    if (req.method === 'POST' && req.url === '/orchestration/browser-perception-engine/scenario') {
      state.lastScenarioBody = await readBody();
      if (state.mode === 'failure') {
        return writeJson(409, {
          ok: false,
          provider: 'browser_perception_engine',
          failureClass: 'action_rejection',
          terminalFailureReason: 'action_rejection',
          sessionId: 'sess_det_1',
          actionId: 'act_1',
          message: 'BPE action rejected with status blocked',
          details: { status: 'blocked' }
        });
      }
      return writeJson(200, {
        ok: true,
        provider: 'browser_perception_engine',
        scenario: {
          kind: 'deterministic_single_interaction',
          targetUrl: 'https://example.com'
        },
        session: {
          sessionId: 'sess_det_1',
          resumed: false
        },
        state: {
          stateVersion: 4,
          url: 'https://example.com',
          title: 'Example Domain',
          elementCount: 1
        },
        action: {
          actionId: 'act_1',
          status: 'succeeded',
          stateVersion: 5,
          events: ['navigation_completed']
        },
        evidence: {
          session_id: 'sess_det_1',
          action_id: 'act_1',
          terminal_failure_reason: null
        }
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
  const fakeServer = await startFakeCliagentsServer();
  const { mod, restore } = loadMcpModule({
    CLIAGENTS_URL: fakeServer.baseUrl
  });

  try {
    const success = await mod.handleRunBpeScenario({
      targetUrl: 'https://example.com',
      interactionPolicy: {
        allowRiskyTarget: true,
        justification: 'kd-83-safe-override-test'
      }
    });
    const successText = success.content[0].text;
    assert(successText.includes('BPE Scenario Completed'));
    assert(successText.includes('session_id: sess_det_1'));
    assert(successText.includes('action_id: act_1'));
    assert.strictEqual(fakeServer.state.lastScenarioBody.targetUrl, 'https://example.com');
    assert.strictEqual(
      fakeServer.state.lastScenarioBody.interactionPolicy?.justification,
      'kd-83-safe-override-test',
      'Expected run_bpe_scenario interactionPolicy to be forwarded'
    );

    const jsonSuccess = await mod.handleRunBpeScenario({
      targetUrl: 'https://example.com',
      format: 'json'
    });
    const parsed = JSON.parse(jsonSuccess.content[0].text);
    assert.strictEqual(parsed.status, 200);
    assert.strictEqual(parsed.session.sessionId, 'sess_det_1');

    fakeServer.state.mode = 'failure';
    const failed = await mod.handleRunBpeScenario({
      targetUrl: 'https://example.com'
    });
    const failedText = failed.content[0].text;
    assert(failedText.includes('BPE Scenario Failed'));
    assert(failedText.includes('failure_class: action_rejection'));
    assert(failedText.includes('status_code: 409'));

    console.log('✅ MCP BPE scenario tool surfaces normalized success and failure payloads');
  } finally {
    restore();
    await fakeServer.close();
  }
}

run().catch((error) => {
  console.error('MCP BPE scenario tool test failed:', error);
  process.exit(1);
});
