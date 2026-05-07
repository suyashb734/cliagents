#!/usr/bin/env node

'use strict';

const assert = require('assert');
const WebSocket = require('ws');
const AgentServer = require('../src/server');

const AUTH_ENV_KEYS = [
  'CLIAGENTS_API_KEY',
  'CLI_AGENTS_API_KEY',
  'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST'
];

function snapshotAuthEnv() {
  const snapshot = {};
  for (const key of AUTH_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreAuthEnv(snapshot) {
  for (const key of AUTH_ENV_KEYS) {
    if (typeof snapshot[key] === 'string') {
      process.env[key] = snapshot[key];
    } else {
      delete process.env[key];
    }
  }
}

function applyAuthEnv(overrides) {
  for (const key of AUTH_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key];
      if (value === undefined || value === null) {
        delete process.env[key];
      } else {
        process.env[key] = String(value);
      }
    } else {
      delete process.env[key];
    }
  }
}

async function startServer(host = '127.0.0.1') {
  const server = new AgentServer({
    host,
    port: 0,
    cleanupOrphans: false,
    orchestration: {
      enabled: false
    }
  });
  try {
    await server.start();
  } catch (error) {
    await server.stop().catch(() => {});
    throw error;
  }
  const address = server.server?.address();
  const port = address && typeof address === 'object' ? address.port : null;
  if (!port) {
    throw new Error('Unable to resolve ephemeral port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`
  };
}

async function request(baseUrl, path, headers = {}) {
  const response = await fetch(baseUrl + path, { headers });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}

async function expectWebSocketUnauthorized(wsUrl) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket auth rejection'));
    }, 5000);
    let settled = false;

    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    }

    ws.once('open', () => finish(new Error('WebSocket connection unexpectedly opened without auth')));
    ws.once('unexpected-response', (_req, response) => {
      if (response.statusCode === 401) {
        finish();
      } else {
        finish(new Error(`Expected WebSocket 401 rejection, received ${response.statusCode}`));
      }
    });
    ws.once('error', (error) => {
      if (/401/.test(String(error.message || ''))) {
        finish();
      } else {
        finish(error);
      }
    });
  });
}

async function testHttpFailClosedByDefault() {
  const envSnapshot = snapshotAuthEnv();
  let serverHandle = null;

  try {
    applyAuthEnv({});
    serverHandle = await startServer();
    const result = await request(serverHandle.baseUrl, '/adapters');
    assert.strictEqual(result.status, 401, `Expected 401 from protected route, got ${result.status}`);
    assert.strictEqual(result.body?.error?.code, 'authentication_required');
  } finally {
    if (serverHandle?.server) {
      await serverHandle.server.stop();
    }
    restoreAuthEnv(envSnapshot);
  }
}

async function testWebSocketFailClosedByDefault() {
  const envSnapshot = snapshotAuthEnv();
  let serverHandle = null;

  try {
    applyAuthEnv({});
    serverHandle = await startServer();
    await expectWebSocketUnauthorized(serverHandle.wsUrl);
  } finally {
    if (serverHandle?.server) {
      await serverHandle.server.stop();
    }
    restoreAuthEnv(envSnapshot);
  }
}

async function testEnvAliasParity() {
  const envSnapshot = snapshotAuthEnv();
  const key = 'kd-alias-test-key';
  let serverHandle = null;

  try {
    applyAuthEnv({ CLIAGENTS_API_KEY: key });
    serverHandle = await startServer();
    const canonicalResult = await request(serverHandle.baseUrl, '/adapters', {
      authorization: `Bearer ${key}`
    });
    assert.strictEqual(canonicalResult.status, 200, `Expected canonical alias auth success, got ${canonicalResult.status}`);
    await serverHandle.server.stop();
    serverHandle = null;

    applyAuthEnv({ CLI_AGENTS_API_KEY: key });
    serverHandle = await startServer();
    const legacyResult = await request(serverHandle.baseUrl, '/adapters', {
      'x-api-key': key
    });
    assert.strictEqual(legacyResult.status, 200, `Expected legacy alias auth success, got ${legacyResult.status}`);
  } finally {
    if (serverHandle?.server) {
      await serverHandle.server.stop();
    }
    restoreAuthEnv(envSnapshot);
  }
}

async function testLocalhostOverrideRejectsNonLoopbackHost() {
  const envSnapshot = snapshotAuthEnv();
  try {
    applyAuthEnv({ CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST: '1' });
    await assert.rejects(
      startServer('0.0.0.0'),
      /loopback bind host/i,
      'Expected non-loopback host to be rejected when localhost override is enabled'
    );
  } finally {
    restoreAuthEnv(envSnapshot);
  }
}

async function run() {
  const tests = [
    { name: 'HTTP auth is fail-closed by default', fn: testHttpFailClosedByDefault },
    { name: 'WebSocket auth is fail-closed by default', fn: testWebSocketFailClosedByDefault },
    { name: 'API key env aliases are parity-compatible', fn: testEnvAliasParity },
    { name: 'localhost unauthenticated override rejects non-loopback bind host', fn: testLocalhostOverrideRejectsNonLoopbackHost }
  ];

  console.log('Running auth fail-closed regression tests...');
  for (const test of tests) {
    await test.fn();
    console.log(`  ✓ ${test.name}`);
  }
  console.log('Auth fail-closed regression tests passed.');
}

run().catch((error) => {
  console.error('Auth fail-closed regression tests failed:', error);
  process.exit(1);
});
