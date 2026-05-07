#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

const TRACKED_ENV_KEYS = [
  'CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION',
  'CLIAGENTS_DASHBOARD_ENV_MUTATION_EXTRA_KEYS',
  'CLIAGENTS_API_CORS_ALLOWED_ORIGINS',
  'CLIAGENTS_API_CORS_ALLOW_LOOPBACK',
  'OPENAI_API_KEY'
];

function snapshotEnv() {
  const snapshot = {};
  for (const key of TRACKED_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const key of TRACKED_ENV_KEYS) {
    if (typeof snapshot[key] === 'string') {
      process.env[key] = snapshot[key];
    } else {
      delete process.env[key];
    }
  }
}

function setEnvVars(overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
}

async function request(baseUrl, method, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(baseUrl + route, {
    method,
    headers,
    body
  });
  const text = await response.text();

  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}

  return {
    status: response.status,
    body: parsed,
    headers: response.headers
  };
}

async function testDashboardEnvAllowlist() {
  const envSnapshot = snapshotEnv();
  let serverHandle = null;

  try {
    setEnvVars({
      CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION: undefined,
      CLIAGENTS_DASHBOARD_ENV_MUTATION_EXTRA_KEYS: undefined,
      OPENAI_API_KEY: 'original-openai-key'
    });

    serverHandle = await startTestServer({
      orchestration: { enabled: false }
    });

    const rejectRes = await request(serverHandle.baseUrl, 'POST', '/dashboard/adapters/codex-cli/env', {
      body: {
        envVars: {
          OPENAI_API_KEY: 'rotated-openai-key',
          NODE_OPTIONS: '--require /tmp/evil.js'
        }
      }
    });

    assert.strictEqual(rejectRes.status, 400, `Expected 400 for disallowed env key, received ${rejectRes.status}`);
    assert.strictEqual(rejectRes.body?.success, false);
    assert.deepStrictEqual(rejectRes.body?.rejectedKeys, ['NODE_OPTIONS']);
    assert.strictEqual(
      process.env.OPENAI_API_KEY,
      'original-openai-key',
      'Allowlisted values must not be applied when request contains rejected keys'
    );

    const acceptRes = await request(serverHandle.baseUrl, 'POST', '/dashboard/adapters/codex-cli/env', {
      body: {
        envVars: {
          OPENAI_API_KEY: 'rotated-openai-key'
        }
      }
    });

    assert.strictEqual(acceptRes.status, 200, `Expected 200 for allowlisted env key, received ${acceptRes.status}`);
    assert.strictEqual(acceptRes.body?.success, true);
    assert.deepStrictEqual(acceptRes.body?.acceptedKeys, ['OPENAI_API_KEY']);
    assert.strictEqual(process.env.OPENAI_API_KEY, 'rotated-openai-key');
  } finally {
    if (serverHandle) {
      await stopTestServer(serverHandle);
    }
    restoreEnv(envSnapshot);
  }
}

async function testDashboardEnvMutationDisabledFlag() {
  const envSnapshot = snapshotEnv();
  let serverHandle = null;

  try {
    setEnvVars({
      CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION: '1',
      OPENAI_API_KEY: 'disable-flag-baseline'
    });

    serverHandle = await startTestServer({
      orchestration: { enabled: false }
    });

    const response = await request(serverHandle.baseUrl, 'POST', '/dashboard/adapters/codex-cli/env', {
      body: {
        envVars: {
          OPENAI_API_KEY: 'should-not-apply'
        }
      }
    });

    assert.strictEqual(response.status, 403, `Expected 403 when mutation endpoint is disabled, received ${response.status}`);
    assert.strictEqual(response.body?.success, false);
    assert.match(String(response.body?.error || ''), /CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION/);
    assert.strictEqual(process.env.OPENAI_API_KEY, 'disable-flag-baseline');
  } finally {
    if (serverHandle) {
      await stopTestServer(serverHandle);
    }
    restoreEnv(envSnapshot);
  }
}

async function testApiCorsOriginPolicy() {
  const envSnapshot = snapshotEnv();
  let serverHandle = null;

  try {
    setEnvVars({
      CLIAGENTS_API_CORS_ALLOWED_ORIGINS: undefined,
      CLIAGENTS_API_CORS_ALLOW_LOOPBACK: '1'
    });

    serverHandle = await startTestServer({
      orchestration: { enabled: false }
    });

    const denied = await request(serverHandle.baseUrl, 'GET', '/adapters', {
      headers: {
        origin: 'https://evil.example'
      }
    });

    assert.strictEqual(denied.status, 403, `Expected 403 for disallowed origin, received ${denied.status}`);
    assert.strictEqual(denied.body?.success, false);

    const allowed = await request(serverHandle.baseUrl, 'GET', '/adapters', {
      headers: {
        origin: 'http://localhost:5173'
      }
    });

    assert.strictEqual(allowed.status, 200, `Expected 200 for loopback origin, received ${allowed.status}`);
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  } finally {
    if (serverHandle) {
      await stopTestServer(serverHandle);
    }
    restoreEnv(envSnapshot);
  }
}

async function run() {
  const tests = [
    { name: 'dashboard env endpoint rejects non-allowlisted env keys', fn: testDashboardEnvAllowlist },
    { name: 'dashboard env endpoint obeys disable flag', fn: testDashboardEnvMutationDisabledFlag },
    { name: 'API CORS policy rejects non-loopback origins by default', fn: testApiCorsOriginPolicy }
  ];

  console.log('Running dashboard env security regression tests...');
  for (const test of tests) {
    await test.fn();
    console.log(`  ✓ ${test.name}`);
  }
  console.log('Dashboard env security regression tests passed.');
}

run().catch((error) => {
  console.error('Dashboard env security regression tests failed:', error);
  process.exit(1);
});
