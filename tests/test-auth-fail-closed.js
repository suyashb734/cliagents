#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const AgentServer = require('../src/server');
const { callCliagentsJson } = require('../src/index');
const { configureAuth, getLocalApiKeyFilePaths, readLocalApiKey } = require('../src/server/auth');

const AUTH_ENV_KEYS = [
  'CLIAGENTS_API_KEY',
  'CLI_AGENTS_API_KEY',
  'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST',
  'CLIAGENTS_DATA_DIR',
  'CLIAGENTS_LOCAL_API_KEY_FILE',
  'CLIAGENTS_URL'
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

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(host = '127.0.0.1', options = {}) {
  const dataDir = options.dataDir || makeTempDir('cliagents-auth-test-');
  const server = new AgentServer({
    host,
    port: 0,
    cleanupOrphans: false,
    orchestration: {
      enabled: false,
      dataDir
    }
  });
  try {
    await server.start();
  } catch (error) {
    await server.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const address = server.server?.address();
  const port = address && typeof address === 'object' ? address.port : null;
  if (!port) {
    throw new Error('Unable to resolve ephemeral port');
  }
  return {
    server,
    dataDir,
    address,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`
  };
}

async function stopServerHandle(serverHandle) {
  if (serverHandle?.server) {
    await serverHandle.server.stop();
  }
  if (serverHandle?.dataDir) {
    fs.rmSync(serverHandle.dataDir, { recursive: true, force: true });
  }
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
    assert.strictEqual(serverHandle.address.address, '127.0.0.1', 'Expected broker default bind host to be loopback');
    const result = await request(serverHandle.baseUrl, '/adapters');
    assert.strictEqual(result.status, 401, `Expected 401 from protected route, got ${result.status}`);
    assert.strictEqual(result.body?.error?.code, 'authentication_required');
  } finally {
    await stopServerHandle(serverHandle);
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
    await stopServerHandle(serverHandle);
    restoreAuthEnv(envSnapshot);
  }
}

async function testLocalBrokerTokenAuthenticatesSameMachineCli() {
  const envSnapshot = snapshotAuthEnv();
  let serverHandle = null;

  try {
    applyAuthEnv({});
    serverHandle = await startServer();
    const unauthenticated = await request(serverHandle.baseUrl, '/adapters');
    assert.strictEqual(unauthenticated.status, 401, `Expected unauthenticated route to fail closed, got ${unauthenticated.status}`);

    const localApiKey = readLocalApiKey({ dataDir: serverHandle.dataDir });
    assert(localApiKey, 'Expected server to create a local broker token when no env API key is configured');
    const authenticated = await request(serverHandle.baseUrl, '/adapters', {
      authorization: `Bearer ${localApiKey}`
    });
    assert.strictEqual(authenticated.status, 200, `Expected local broker token auth success, got ${authenticated.status}`);

    process.env.CLIAGENTS_DATA_DIR = serverHandle.dataDir;
    process.env.CLIAGENTS_URL = serverHandle.baseUrl;
    const cliResult = await callCliagentsJson('/adapters');
    assert(Array.isArray(cliResult.adapters), 'Expected local CLI JSON client to authenticate with the local broker token');
  } finally {
    await stopServerHandle(serverHandle);
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
    await stopServerHandle(serverHandle);
    serverHandle = null;

    applyAuthEnv({ CLI_AGENTS_API_KEY: key });
    serverHandle = await startServer();
    const legacyResult = await request(serverHandle.baseUrl, '/adapters', {
      'x-api-key': key
    });
    assert.strictEqual(legacyResult.status, 200, `Expected legacy alias auth success, got ${legacyResult.status}`);
  } finally {
    await stopServerHandle(serverHandle);
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

async function testCliAuthFailureExplainsLocalTokenMigration() {
  const envSnapshot = snapshotAuthEnv();
  const dataDir = makeTempDir('cliagents-auth-hint-');
  let server = null;

  try {
    applyAuthEnv({ CLIAGENTS_DATA_DIR: dataDir });
    server = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'authentication_required',
          message: 'Authentication required. Configure CLIAGENTS_API_KEY (or CLI_AGENTS_API_KEY).'
        }
      }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    process.env.CLIAGENTS_URL = `http://127.0.0.1:${address.port}`;

    await assert.rejects(
      callCliagentsJson('/orchestration/root-sessions'),
      (error) => (
        /Authentication required/.test(error.message)
        && /local broker token/.test(error.message)
        && /restart it so it creates/.test(error.message)
        && error.message.includes(path.join(dataDir, 'local-api-key'))
      ),
      'Expected CLI auth failure to explain local-token migration and broker restart'
    );
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    restoreAuthEnv(envSnapshot);
  }
}

async function testLocalTokenLookupFallsBackToPackageDataDir() {
  const envSnapshot = snapshotAuthEnv();
  const originalCwd = process.cwd();
  const cwdDir = makeTempDir('cliagents-auth-cwd-');
  const packageDataDir = makeTempDir('cliagents-auth-package-data-');

  try {
    applyAuthEnv({});
    process.chdir(cwdDir);
    configureAuth({ localApiKeyFilePath: null });
    const tokenPath = path.join(packageDataDir, 'local-api-key');
    fs.writeFileSync(tokenPath, 'package-token\n', 'utf8');

    const searchedPaths = getLocalApiKeyFilePaths({ packageDataDir });
    assert.deepStrictEqual(searchedPaths, [
      path.resolve(process.cwd(), 'data', 'local-api-key'),
      tokenPath
    ]);
    assert.strictEqual(readLocalApiKey({ packageDataDir }), 'package-token');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.rmSync(packageDataDir, { recursive: true, force: true });
    restoreAuthEnv(envSnapshot);
  }
}

async function run() {
  const tests = [
    { name: 'HTTP auth is fail-closed by default', fn: testHttpFailClosedByDefault },
    { name: 'WebSocket auth is fail-closed by default', fn: testWebSocketFailClosedByDefault },
    { name: 'local broker token authenticates same-machine CLI calls', fn: testLocalBrokerTokenAuthenticatesSameMachineCli },
    { name: 'API key env aliases are parity-compatible', fn: testEnvAliasParity },
    { name: 'localhost unauthenticated override rejects non-loopback bind host', fn: testLocalhostOverrideRejectsNonLoopbackHost },
    { name: 'CLI auth failure explains local-token migration', fn: testCliAuthFailureExplainsLocalTokenMigration },
    { name: 'local token lookup falls back to package data dir', fn: testLocalTokenLookupFallsBackToPackageDataDir }
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
