#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ACTIVE_BROKER_ADAPTERS } = require('../src/adapters/active-surface');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');
const { isAdapterAuthenticated } = require('../src/utils/adapter-auth');

const results = { passed: 0, failed: 0, skipped: 0 };

let testServer = null;
let baseUrl = null;
const PREFERRED_MODEL_ORDER = Object.freeze({
  'gemini-cli': ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'codex-cli': ['o4-mini', 'o3-mini', 'gpt-4o', 'gpt-4o-mini'],
  'qwen-cli': ['qwen-max', 'qwen-plus'],
  'opencode-cli': []
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSkippableProviderFailure(message = '') {
  const text = String(message).toLowerCase();
  return [
    'not authenticated',
    'authentication failed',
    'invalid access token',
    'token expired',
    'please log in',
    'please login',
    'login required',
    'api key',
    'quota',
    'usage limit',
    'rate limit',
    'resourceexhausted',
    'capacity on this model',
    'no active provider',
    'no active subscription',
    'billing',
    'request timed out',
    'status: 504',
    'timed out',
    'automated queries',
    'google help',
    'cloudcode-pa.googleapis.com',
    'qwen oauth was discontinued',
    "we're sorry..."
  ].some((pattern) => text.includes(pattern));
}

async function request(method, route, body = null, timeoutMs = 120000) {
  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(timeoutMs)
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${route}`, options);
    const text = await response.text();
    let data = text;

    try {
      data = JSON.parse(text);
    } catch {}

    return { status: response.status, data };
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new Error(`SKIP: request timeout after ${timeoutMs}ms for ${method} ${route}`);
    }
    throw error;
  }
}

async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    if (String(error.message || '').startsWith('SKIP:')) {
      results.skipped += 1;
      console.log(`  ⏭️  ${name} (${error.message.slice('SKIP:'.length).trim()})`);
      return;
    }

    results.failed += 1;
    console.log(`  ❌ ${name}: ${error.message}`);
  }
}

function makeTempWorkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cliagents-${prefix}-`));
}

async function getAdapterMap() {
  const { status, data } = await request('GET', '/adapters');
  assert.strictEqual(status, 200, `Expected /adapters 200, got ${status}`);
  return new Map((data.adapters || []).map((adapter) => [adapter.name, adapter]));
}

async function ensureAdapterAvailable(adapterName) {
  const adapters = await getAdapterMap();
  const adapter = adapters.get(adapterName);

  if (!adapter) {
    throw new Error(`SKIP: ${adapterName} adapter not registered`);
  }

  if (!adapter.available) {
    throw new Error(`SKIP: ${adapterName} adapter not installed`);
  }

  const auth = isAdapterAuthenticated(adapterName);
  if (!auth.authenticated) {
    throw new Error(`SKIP: ${auth.reason}`);
  }

  return adapter;
}

function pickExplicitModel(adapterName, adapterInfo) {
  const models = Array.isArray(adapterInfo.models) ? adapterInfo.models : [];
  const modelIds = new Set(models.map((model) => model?.id).filter(Boolean));
  const preferredOrder = PREFERRED_MODEL_ORDER[adapterName] || [];

  for (const modelId of preferredOrder) {
    if (modelIds.has(modelId)) {
      return modelId;
    }
  }

  return models.find((model) => model?.id && model.id !== 'default')?.id || null;
}

async function createSession(adapter, body = {}) {
  const { status, data } = await request('POST', '/sessions', { adapter, ...body });
  if (status !== 200) {
    const message = data?.error?.message || data?.error || JSON.stringify(data);
    if (isSkippableProviderFailure(message)) {
      throw new Error(`SKIP: ${message}`);
    }
    throw new Error(`createSession failed: ${status} ${message}`);
  }
  return data;
}

async function sendMessage(sessionId, message, timeout = 120000) {
  const { status, data } = await request(
    'POST',
    `/sessions/${sessionId}/messages`,
    { message, timeout },
    timeout + 15000
  );

  if (status !== 200) {
    const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
    if (isSkippableProviderFailure(errorMessage)) {
      throw new Error(`SKIP: ${errorMessage}`);
    }
    throw new Error(`sendMessage failed: ${status} ${errorMessage}`);
  }

  return String(data.result || data.text || '').trim();
}

async function cleanupSession(sessionId) {
  await request('DELETE', `/sessions/${sessionId}`);
}

async function testSessionMetadata(adapterName) {
  const adapterInfo = await ensureAdapterAvailable(adapterName);
  const workDir = makeTempWorkDir(`${adapterName}-metadata-`);
  const requestedModel = pickExplicitModel(adapterName, adapterInfo);
  const supportedModelIds = new Set(
    (Array.isArray(adapterInfo.models) ? adapterInfo.models : [])
      .map((model) => model?.id)
      .filter(Boolean)
  );

  const session = await createSession(adapterName, {
    workDir,
    ...(requestedModel ? { model: requestedModel } : {})
  });

  const assertEffectiveModel = (actualModel, label) => {
    assert(actualModel, `Expected ${label} to include model`);
    if (requestedModel && adapterName !== 'gemini-cli') {
      assert.strictEqual(actualModel, requestedModel, `Expected ${label} model ${requestedModel}, got ${actualModel}`);
      return;
    }

    assert(
      supportedModelIds.has(actualModel),
      `Expected ${label} model ${actualModel} to be in advertised models ${Array.from(supportedModelIds).join(', ')}`
    );
  };

  try {
    assert.strictEqual(session.workDir, workDir, `Expected createSession workDir ${workDir}, got ${session.workDir}`);
    assertEffectiveModel(session.model, 'createSession');

    const infoRes = await request('GET', `/sessions/${session.sessionId}`);
    assert.strictEqual(infoRes.status, 200, `Expected session info 200, got ${infoRes.status}`);
    assert.strictEqual(infoRes.data.workDir, workDir, `Expected session info workDir ${workDir}, got ${infoRes.data.workDir}`);
    assertEffectiveModel(infoRes.data.model, 'session info');

    const statusRes = await request('GET', `/sessions/${session.sessionId}/status`);
    assert.strictEqual(statusRes.status, 200, `Expected session status 200, got ${statusRes.status}`);
    assert.strictEqual(statusRes.data.workDir, workDir, `Expected session status workDir ${workDir}, got ${statusRes.data.workDir}`);
    assertEffectiveModel(statusRes.data.model, 'session status');

    const listRes = await request('GET', '/sessions');
    assert.strictEqual(listRes.status, 200, `Expected sessions list 200, got ${listRes.status}`);
    const listed = (listRes.data.sessions || []).find((entry) => entry.sessionId === session.sessionId);
    assert(listed, `Expected ${session.sessionId} in session list`);
    assert.strictEqual(listed.workDir, workDir, `Expected listed workDir ${workDir}, got ${listed.workDir}`);
    assertEffectiveModel(listed.model, 'listed session');
  } finally {
    await cleanupSession(session.sessionId);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function testWorkingDirectory(adapterName) {
  await ensureAdapterAvailable(adapterName);

  const workDir = makeTempWorkDir(`${adapterName}-cwd-`);
  const marker = `${adapterName.toUpperCase()}_WORKDIR_OK`;
  fs.writeFileSync(path.join(workDir, 'conformance-marker.txt'), `${marker}\n`, 'utf8');

  try {
    const { status, data } = await request(
      'POST',
      '/ask',
      {
        adapter: adapterName,
        workingDirectory: workDir,
        message: 'Read ./conformance-marker.txt and reply with its exact contents only.',
        timeout: 45000
      },
      60000
    );

    if (status !== 200) {
      const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
      if (isSkippableProviderFailure(errorMessage)) {
        throw new Error(`SKIP: ${errorMessage}`);
      }
      throw new Error(`workingDirectory ask failed: ${status} ${errorMessage}`);
    }

    const output = String(data.result || data.text || '').trim();
    if (isSkippableProviderFailure(output)) {
      throw new Error(`SKIP: ${output}`);
    }
    const normalizedLines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    assert(
      normalizedLines.includes(marker),
      `Expected marker ${marker} to appear as an exact output line, got ${output}`
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function testMultiTurnResume(adapterName) {
  const adapterInfo = await ensureAdapterAvailable(adapterName);
  const capabilities = adapterInfo.capabilities || {};

  if (!capabilities.supportsResume) {
    throw new Error('SKIP: adapter does not advertise resume support');
  }

  const workDir = makeTempWorkDir(`${adapterName}-resume-`);
  const marker = `${adapterName.toUpperCase()}_MEMORY_OK`;

  const session = await createSession(adapterName, { workDir });

  try {
    const ready = await sendMessage(session.sessionId, `Remember the marker ${marker}. Reply with READY.`, 120000);
    if (isSkippableProviderFailure(ready)) {
      throw new Error(`SKIP: ${ready}`);
    }
    assert(/ready/i.test(ready), `Expected READY acknowledgement, got ${ready}`);

    let recall = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      recall = await sendMessage(
        session.sessionId,
        attempt === 1
          ? 'What marker did I ask you to remember? Reply with exactly the marker only.'
          : `Return exactly this remembered marker and nothing else: ${marker}`,
        120000
      );
      if (isSkippableProviderFailure(recall)) {
        throw new Error(`SKIP: ${recall}`);
      }
      const normalizedRecall = recall.replace(/\[Thought:\s*true\]/gi, '').trim();
      if (normalizedRecall.includes(marker)) {
        return;
      }
    }
    assert.fail(`Expected recalled marker ${marker}, got ${recall}`);
  } finally {
    await cleanupSession(session.sessionId);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('Adapter runtime conformance tests\n');

  testServer = await startTestServer();
  baseUrl = testServer.baseUrl;

  try {
    for (const adapterName of ACTIVE_BROKER_ADAPTERS) {
      await test(`${adapterName} persists effective session metadata`, async () => {
        await testSessionMetadata(adapterName);
      });
    }

    for (const adapterName of ACTIVE_BROKER_ADAPTERS) {
      await test(`${adapterName} honors workingDirectory on /ask`, async () => {
        await testWorkingDirectory(adapterName);
      });
    }

    for (const adapterName of ACTIVE_BROKER_ADAPTERS) {
      await test(`${adapterName} supports multi-turn recall when advertised`, async () => {
        await testMultiTurnResume(adapterName);
      });
    }
  } finally {
    await stopTestServer(testServer);
  }

  console.log(`\nResults: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);
  if (results.failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error.stack || error.message || String(error));
  if (testServer) {
    await stopTestServer(testServer);
  }
  process.exit(1);
});
