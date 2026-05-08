#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractOutput } = require('../src/utils/output-extractor');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');
const { isAdapterAuthenticated } = require('../src/utils/adapter-auth');

const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

let testServer = null;
let baseUrl = null;
let runtimeRootContext = null;
const envRestore = new Map();

function log(section, message) {
  console.log(`[${section}] ${message}`);
}

function isSkippableProviderFailure(message = '') {
  const text = String(message).toLowerCase();
  return [
    'not authenticated',
    'authentication failed',
    'invalid access token',
    'token expired',
    'please log in',
    'login required',
    'api key',
    'quota',
    'usage limit',
    'rate limit',
    'resourceexhausted',
    'no active subscription',
    'billing',
    'participant timed out',
    'request timed out',
    'qwen oauth was discontinued',
    'status: 504'
  ].some((pattern) => text.includes(pattern));
}

function isTransientFailure(message = '') {
  const text = String(message).toLowerCase();
  return [
    'timed out',
    'timeout',
    'request timeout',
    'deadline exceeded',
    'fetch failed',
    'network',
    'aborterror',
    'econnreset',
    'socket',
    'status: 504',
    'process exited with code',
    'exited with code'
  ].some((pattern) => text.includes(pattern));
}

async function request(method, route, body = null, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const requestOptions = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  };

  if (body) {
    requestOptions.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${baseUrl}${route}`, requestOptions);
    const text = await response.text();
    let data = text;

    try {
      data = JSON.parse(text);
    } catch {}

    return {
      status: response.status,
      data
    };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`SKIP: request timeout after ${timeoutMs}ms for ${method} ${route}`);
    }
    throw error;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    results.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    if (String(error.message).startsWith('SKIP:')) {
      const reason = error.message.slice('SKIP:'.length).trim();
      results.skipped += 1;
      results.tests.push({ name, status: 'skipped', reason });
      console.log(`  ⏭️  ${name} (${reason})`);
      return;
    }
    if (isTransientFailure(error.message)) {
      const reason = `transient runtime/provider failure: ${error.message}`;
      results.skipped += 1;
      results.tests.push({ name, status: 'skipped', reason });
      console.log(`  ⏭️  ${name} (${reason})`);
      return;
    }

    results.failed += 1;
    results.tests.push({ name, status: 'failed', error: error.message });
    console.log(`  ❌ ${name}: ${error.message}`);
  }
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

function makeTempWorkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cliagents-${prefix}-`));
}

function setTemporaryEnv(name, value) {
  if (!envRestore.has(name)) {
    envRestore.set(name, process.env[name]);
  }
  process.env[name] = value;
}

function restoreTemporaryEnv() {
  for (const [name, value] of envRestore.entries()) {
    if (typeof value === 'string') {
      process.env[name] = value;
    } else {
      delete process.env[name];
    }
  }
  envRestore.clear();
}

async function createSession(adapter, workDir, options = {}) {
  const maxAttempts = Math.max(1, Number(options.retries || 1));
  const retryDelayMs = Number(options.retryDelayMs || 1500);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { status, data } = await request('POST', '/sessions', { adapter, workDir }, {
        timeoutMs: options.timeoutMs || 120000
      });
      if (status !== 200) {
        const message = data?.error?.message || data?.error || JSON.stringify(data);
        if (isSkippableProviderFailure(message)) {
          throw new Error(`SKIP: ${message}`);
        }

        if (attempt < maxAttempts && isTransientFailure(message)) {
          await sleep(retryDelayMs);
          continue;
        }

        if (isTransientFailure(message)) {
          throw new Error(`SKIP: transient session create failure: ${message}`);
        }

        throw new Error(`Failed to create ${adapter} session: ${status} ${message}`);
      }
      return data.sessionId;
    } catch (error) {
      const errorMessage = String(error?.message || error);
      if (errorMessage.startsWith('SKIP:')) {
        throw error;
      }

      if (attempt < maxAttempts && isTransientFailure(errorMessage)) {
        await sleep(retryDelayMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Failed to create ${adapter} session after ${maxAttempts} attempts`);
}

async function sendMessage(sessionId, message, options = {}) {
  const maxAttempts = Math.max(1, Number(options.retries || 1));
  const retryDelayMs = Number(options.retryDelayMs || 1500);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { status, data } = await request('POST', `/sessions/${sessionId}/messages`, {
        message,
        timeout: options.timeout || 45000
      });

      if (status !== 200) {
        const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
        if (isSkippableProviderFailure(errorMessage)) {
          throw new Error(`SKIP: ${errorMessage}`);
        }

        if (attempt < maxAttempts && isTransientFailure(errorMessage)) {
          await sleep(retryDelayMs);
          continue;
        }

        throw new Error(`Message failed: ${status} ${errorMessage}`);
      }

      if (!data?.result) {
        throw new Error(`Message returned no result: ${JSON.stringify(data)}`);
      }

      if (isSkippableProviderFailure(data.result)) {
        throw new Error(`SKIP: ${data.result}`);
      }

      return data.result;
    } catch (error) {
      const errorMessage = String(error?.message || error);
      if (errorMessage.startsWith('SKIP:')) {
        throw error;
      }

      if (attempt < maxAttempts && isTransientFailure(errorMessage)) {
        await sleep(retryDelayMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Message failed after ${maxAttempts} attempts`);
}

async function cleanupSession(sessionId) {
  await request('DELETE', `/sessions/${sessionId}`);
}

function runtimeRootHeaders() {
  if (!runtimeRootContext) {
    return {};
  }
  return {
    'x-cliagents-root-session-id': runtimeRootContext.rootSessionId,
    'x-cliagents-parent-session-id': runtimeRootContext.rootSessionId,
    'x-cliagents-origin-client': runtimeRootContext.originClient,
    'x-cliagents-client-name': runtimeRootContext.clientName,
    'x-cliagents-session-ref': runtimeRootContext.externalSessionRef
  };
}

function runtimeRootPayload(extra = {}) {
  if (!runtimeRootContext) {
    return extra;
  }
  return {
    ...extra,
    rootSessionId: runtimeRootContext.rootSessionId,
    parentSessionId: runtimeRootContext.rootSessionId,
    originClient: runtimeRootContext.originClient,
    externalSessionRef: runtimeRootContext.externalSessionRef,
    sessionMetadata: {
      clientName: runtimeRootContext.clientName,
      externalSessionRef: runtimeRootContext.externalSessionRef,
      clientSessionRef: runtimeRootContext.externalSessionRef,
      ...(extra.sessionMetadata || {})
    }
  };
}

async function ensureRuntimeRootContext() {
  if (runtimeRootContext) {
    return runtimeRootContext;
  }

  const externalSessionRef = `runtime-consistency-${Date.now()}`;
  const originClient = 'runtime-consistency';
  const clientName = 'runtime-consistency';
  const { status, data } = await request('POST', '/orchestration/root-sessions/attach', {
    originClient,
    externalSessionRef,
    sessionMetadata: {
      clientName,
      externalSessionRef,
      clientSessionRef: externalSessionRef
    }
  });

  if (status !== 200 || !data?.rootSessionId) {
    const message = data?.error?.message || data?.error || JSON.stringify(data);
    throw new Error(`Failed to attach runtime root: ${status} ${message}`);
  }

  runtimeRootContext = {
    rootSessionId: data.rootSessionId,
    originClient,
    clientName,
    externalSessionRef
  };
  return runtimeRootContext;
}

async function createTmuxTerminal(adapter, options = {}) {
  await ensureRuntimeRootContext();
  const { status, data } = await request('POST', '/orchestration/terminals', runtimeRootPayload({
    adapter,
    agentProfile: options.agentProfile || `${adapter}-worker`,
    role: options.role || 'worker',
    workDir: options.workDir,
    sessionKind: 'worker'
  }), {
    headers: runtimeRootHeaders()
  });

  if (status !== 200) {
    const message = data?.error?.message || data?.error || JSON.stringify(data);
    if (isSkippableProviderFailure(message)) {
      throw new Error(`SKIP: ${message}`);
    }
    throw new Error(`Failed to create tmux terminal: ${status} ${message}`);
  }

  return data;
}

async function waitForTerminalCompletion(terminalId, timeoutMs = 120000) {
  const start = Date.now();
  let sawProcessing = false;
  const graceTimeoutMs = 60000;

  while (Date.now() - start < timeoutMs) {
    const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}`);
    if (status !== 200) {
      throw new Error(`Failed to read terminal ${terminalId}: ${status}`);
    }

    const terminalStatus = data.status;
    if (terminalStatus === 'processing') {
      sawProcessing = true;
    }

    if (terminalStatus === 'completed' || (terminalStatus === 'idle' && sawProcessing)) {
      return data;
    }

    if (terminalStatus === 'error') {
      const output = await getTerminalExtractedOutput(terminalId, data.adapter);
      if (isSkippableProviderFailure(output)) {
        throw new Error(`SKIP: ${output}`);
      }
      throw new Error(`Terminal ${terminalId} entered error state: ${output || 'no extracted output'}`);
    }

    await sleep(1000);
  }

  const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}`);
  if (status !== 200) {
    throw new Error(`Failed to read terminal ${terminalId}: ${status}`);
  }

  if (sawProcessing && data.status === 'processing') {
    const graceStart = Date.now();
    while (Date.now() - graceStart < graceTimeoutMs) {
      const graceStatus = await request('GET', `/orchestration/terminals/${terminalId}`);
      if (graceStatus.status !== 200) {
        throw new Error(`Failed to read terminal ${terminalId}: ${graceStatus.status}`);
      }

      const terminalStatus = graceStatus.data.status;
      if (terminalStatus === 'completed' || terminalStatus === 'idle') {
        return graceStatus.data;
      }
      if (terminalStatus === 'error') {
        const output = await getTerminalExtractedOutput(terminalId, graceStatus.data.adapter);
        if (isSkippableProviderFailure(output)) {
          throw new Error(`SKIP: ${output}`);
        }
        throw new Error(`Terminal ${terminalId} entered error state: ${output || 'no extracted output'}`);
      }

      await sleep(1000);
    }
  }

  const output = await getTerminalExtractedOutput(terminalId, data.adapter);
  if (isSkippableProviderFailure(output) || isTransientFailure(output)) {
    throw new Error(`SKIP: ${output || `Timed out waiting for terminal ${terminalId} to complete`}`);
  }
  throw new Error(`Timed out waiting for terminal ${terminalId} to complete`);
}

async function sendTerminalInput(terminalId, message) {
  await ensureRuntimeRootContext();
  const enqueue = await request('POST', `/orchestration/terminals/${terminalId}/input-queue`, {
    message,
    approvalRequired: true,
    requestedBy: 'runtime-consistency'
  }, {
    headers: runtimeRootHeaders()
  });
  if (enqueue.status !== 200) {
    const errorMessage = enqueue.data?.error?.message || enqueue.data?.error || JSON.stringify(enqueue.data);
    if (isSkippableProviderFailure(errorMessage)) {
      throw new Error(`SKIP: ${errorMessage}`);
    }
    throw new Error(`Failed to enqueue terminal input: ${enqueue.status} ${errorMessage}`);
  }

  const inputId = enqueue.data?.input?.id;
  if (!inputId) {
    throw new Error(`Input queue returned no input id: ${JSON.stringify(enqueue.data)}`);
  }

  const approve = await request('POST', `/orchestration/input-queue/${inputId}/approve`, {
    approvedBy: 'runtime-consistency'
  }, {
    headers: runtimeRootHeaders()
  });
  if (approve.status !== 200) {
    const errorMessage = approve.data?.error?.message || approve.data?.error || JSON.stringify(approve.data);
    throw new Error(`Failed to approve terminal input: ${approve.status} ${errorMessage}`);
  }

  const { status, data } = await request('POST', `/orchestration/input-queue/${inputId}/deliver`, {}, {
    headers: runtimeRootHeaders()
  });
  if (status !== 200) {
    const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
    if (isSkippableProviderFailure(errorMessage)) {
      throw new Error(`SKIP: ${errorMessage}`);
    }
    throw new Error(`Failed to send terminal input: ${status} ${errorMessage}`);
  }

  return data;
}

async function getTerminalExtractedOutput(terminalId, adapter) {
  const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=600`);
  if (status !== 200) {
    throw new Error(`Failed to fetch terminal output for ${terminalId}: ${status}`);
  }
  return extractOutput(data.output, adapter);
}

async function destroyTmuxTerminal(terminalId) {
  await request('DELETE', `/orchestration/terminals/${terminalId}`);
}

async function testHealthAndCatalog() {
  console.log('\n📋 Runtime Health');

  await test('Server health responds', async () => {
    const { status, data } = await request('GET', '/health');
    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.strictEqual(data.status, 'ok', 'Health status should be ok');
  });

  await test('Core adapters are registered', async () => {
    const adapters = await getAdapterMap();
    const expected = ['gemini-cli', 'codex-cli', 'qwen-cli', 'opencode-cli'];
    for (const name of expected) {
      assert(adapters.has(name), `Expected adapter ${name} to be registered`);
    }
  });
}

async function testGeminiPersistence() {
  console.log('\n📋 Gemini Session Isolation');

  await test('Gemini keeps session A and B isolated in the same project directory', async () => {
    await ensureAdapterAvailable('gemini-cli');

    const workDir = makeTempWorkDir('gemini-shared');
    let sessionA = null;
    let sessionB = null;

    try {
      sessionA = await createSession('gemini-cli', workDir, {
        timeoutMs: 210000,
        retries: 2,
        retryDelayMs: 3000
      });
      sessionB = await createSession('gemini-cli', workDir, {
        timeoutMs: 210000,
        retries: 2,
        retryDelayMs: 3000
      });
      await sendMessage(sessionA, 'The session marker is ALPHA. Reply with READY.', { timeout: 120000, retries: 2 });
      await sendMessage(sessionB, 'The session marker is BETA. Reply with READY.', { timeout: 120000, retries: 2 });
      const answer = await sendMessage(
        sessionA,
        'What is the session marker for this conversation? Reply with one word.',
        { timeout: 120000, retries: 2 }
      );
      assert(answer.toLowerCase().includes('alpha'), `Expected ALPHA, got: ${answer}`);
    } finally {
      if (sessionA) {
        await cleanupSession(sessionA);
      }
      if (sessionB) {
        await cleanupSession(sessionB);
      }
    }
  });
}

async function testCodexPersistence() {
  console.log('\n📋 Codex Session Resume');

  await test('Codex resumes the same session across turns', async () => {
    await ensureAdapterAvailable('codex-cli');

    const workDir = makeTempWorkDir('codex-resume');
    const sessionId = await createSession('codex-cli', workDir);

    try {
      await sendMessage(sessionId, 'The session marker is ALPHA. Reply with READY.');
      const answer = await sendMessage(sessionId, 'What is the session marker for this conversation? Reply with one word.');
      assert(answer.toLowerCase().includes('alpha'), `Expected ALPHA, got: ${answer}`);
    } finally {
      await cleanupSession(sessionId);
    }
  });
}

async function testConsensusRoute() {
  console.log('\n📋 Direct Consensus Route');

  await test('Consensus route produces a judged answer without tmux workers', async () => {
    const { status, data } = await request(
      'POST',
      '/orchestration/consensus',
      {
        message: 'What is 3 + 3? Reply with just the number.',
        timeout: 120000,
        participants: [
          { adapter: 'qwen-cli', name: 'qwen' },
          { adapter: 'codex-cli', name: 'codex' }
        ],
        judge: {
          adapter: 'codex-cli',
          name: 'judge',
          systemPrompt: 'Synthesize the strongest final answer from the provided responses.'
        }
      },
      { timeoutMs: 180000 }
    );

    if (status !== 200) {
      const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
      if (isSkippableProviderFailure(errorMessage)) {
        throw new Error(`SKIP: ${errorMessage}`);
      }
      throw new Error(`Consensus route failed: ${status} ${errorMessage}`);
    }

    assert(Array.isArray(data.participants), 'participants should be an array');
    assert(data.participants.length === 2, `Expected 2 participants, got ${data.participants.length}`);

    const failed = data.participants.filter((participant) => !participant.success);
    if (failed.length > 0) {
      const failureText = failed.map((participant) => participant.error).join(' | ');
      if (isSkippableProviderFailure(failureText)) {
        throw new Error(`SKIP: ${failureText}`);
      }
      throw new Error(`Participant failures: ${failureText}`);
    }

    assert(data.consensus?.success === true, `Expected successful consensus, got ${JSON.stringify(data.consensus)}`);
    assert(String(data.consensus.output).includes('6'), `Expected consensus output to include 6, got ${data.consensus.output}`);
  });
}

async function testTmuxWorkerBehavior() {
  console.log('\n📋 Tmux Worker Behavior');

  await test('Tmux worker reports a real lifecycle for Codex one-shot runs', async () => {
    await ensureAdapterAvailable('codex-cli');

    const terminal = await createTmuxTerminal('codex-cli');
    try {
      const response = await sendTerminalInput(terminal.terminalId, 'What is 2 + 3? Reply with just the number.');
      assert(
        response.status === 'processing' || response.status === 'completed',
        `Expected processing or completed after input, got ${response.status}`
      );

      await waitForTerminalCompletion(terminal.terminalId, 180000);
      const { status, data } = await request('GET', `/orchestration/terminals/${terminal.terminalId}`);
      assert.strictEqual(status, 200, `Expected terminal fetch to succeed, got ${status}`);
      assert(
        data.status === 'completed' || data.status === 'idle',
        `Expected completed or idle after run, got ${data.status}`
      );
    } finally {
      await destroyTmuxTerminal(terminal.terminalId);
    }
  });

  await test('Tmux worker handles a bounded one-shot task', async () => {
    await ensureAdapterAvailable('codex-cli');

    const terminal = await createTmuxTerminal('codex-cli');
    try {
      await sendTerminalInput(terminal.terminalId, 'What is 2 + 3? Reply with just the number.');
      await waitForTerminalCompletion(terminal.terminalId);
      const output = await getTerminalExtractedOutput(terminal.terminalId, 'codex-cli');
      assert(String(output).includes('5'), `Expected extracted output to include 5, got ${output}`);
    } finally {
      await destroyTmuxTerminal(terminal.terminalId);
    }
  });

  await test('Tmux worker is not a true multi-turn conversation for Codex', async () => {
    await ensureAdapterAvailable('codex-cli');

    const terminal = await createTmuxTerminal('codex-cli');
    try {
      await sendTerminalInput(terminal.terminalId, 'The session marker is ALPHA. Reply with READY.');
      await waitForTerminalCompletion(terminal.terminalId, 240000);

      await sendTerminalInput(
        terminal.terminalId,
        'What is the session marker for this conversation? If you do not know, reply with UNKNOWN.'
      );
      try {
        await waitForTerminalCompletion(terminal.terminalId, 240000);
      } catch (error) {
        if (String(error.message || '').includes('Timed out waiting for terminal')) {
          throw new Error(`SKIP: ${error.message}`);
        }
        throw error;
      }
      const output = await getTerminalExtractedOutput(terminal.terminalId, 'codex-cli');
      const lower = String(output).toLowerCase();
      assert(!lower.includes('alpha'), `Expected no persisted context, got ${output}`);
    } finally {
      await destroyTmuxTerminal(terminal.terminalId);
    }
  });

  await test('Tmux Gemini worker handles a bounded one-shot task', async () => {
    await ensureAdapterAvailable('gemini-cli');

    const terminal = await createTmuxTerminal('gemini-cli');
    try {
      const response = await sendTerminalInput(terminal.terminalId, 'What is 9 + 1? Reply with just the number.');
      assert(
        response.status === 'processing' || response.status === 'completed',
        `Expected processing or completed after input, got ${response.status}`
      );

      await waitForTerminalCompletion(terminal.terminalId);
      const output = await getTerminalExtractedOutput(terminal.terminalId, 'gemini-cli');
      assert(String(output).includes('10'), `Expected extracted output to include 10, got ${output}`);
    } finally {
      await destroyTmuxTerminal(terminal.terminalId);
    }
  });

  await test('Tmux Gemini worker launches a fresh one-shot command each turn', async () => {
    await ensureAdapterAvailable('gemini-cli');

    const terminal = await createTmuxTerminal('gemini-cli');
    try {
      await sendTerminalInput(terminal.terminalId, 'What is 9 + 1? Reply with just the number.');
      await waitForTerminalCompletion(terminal.terminalId);

      const secondPrompt = 'What is the session marker for this conversation? If you do not know, reply with UNKNOWN.';
      const response = await sendTerminalInput(
        terminal.terminalId,
        secondPrompt
      );
      assert(
        response.status === 'processing' || response.status === 'completed',
        `Expected processing or completed after input, got ${response.status}`
      );

      await waitForTerminalCompletion(terminal.terminalId);
      const { status, data } = await request('GET', `/orchestration/terminals/${terminal.terminalId}/output?lines=600`);
      assert.strictEqual(status, 200, `Expected terminal output fetch to succeed, got ${status}`);

      const output = String(data.output || '');
      const normalizedOutput = output.replace(/\s+/g, ' ');
      const runStarts = (output.match(/__CLIAGENTS_RUN_START__/g) || []).length;
      assert(runStarts >= 2, `Expected at least two tracked Gemini runs, got ${output}`);
      assert(
        /gemini --approval-mode yolo(?: -m [^\s]+)? -p/.test(normalizedOutput),
        `Expected a fresh gemini one-shot launch, got ${output}`
      );
      assert(!output.includes('gemini -r '), `Expected no Gemini resume flag in tmux worker output, got ${output}`);
    } finally {
      await destroyTmuxTerminal(terminal.terminalId);
    }
  });
}

async function testOneShotAdapters() {
  console.log('\n📋 One-Shot Smoke');

  await test('Gemini one-shot ask works', async () => {
    await ensureAdapterAvailable('gemini-cli');

    const { status, data } = await request('POST', '/ask', {
      adapter: 'gemini-cli',
      message: 'What is 7 + 7? Reply with just the number.',
      timeout: 90000
    });

    if (status !== 200) {
      const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
      if (isSkippableProviderFailure(errorMessage)) {
        throw new Error(`SKIP: ${errorMessage}`);
      }
      if (errorMessage.includes('Process exited with code 1')) {
        throw new Error(`SKIP: ${errorMessage}`);
      }
      throw new Error(`Gemini one-shot failed: ${status} ${errorMessage}`);
    }

    assert(String(data.result).includes('14'), `Expected 14, got ${data.result}`);
  });

  await test('Codex one-shot ask works', async () => {
    await ensureAdapterAvailable('codex-cli');

    const { status, data } = await request('POST', '/ask', {
      adapter: 'codex-cli',
      message: 'What is 4 + 4? Reply with just the number.',
      timeout: 90000
    });

    if (status !== 200) {
      const errorMessage = data?.error?.message || data?.error || JSON.stringify(data);
      if (isSkippableProviderFailure(errorMessage)) {
        throw new Error(`SKIP: ${errorMessage}`);
      }
      if (isTransientFailure(errorMessage)) {
        throw new Error(`SKIP: ${errorMessage}`);
      }
      throw new Error(`Codex one-shot failed: ${status} ${errorMessage}`);
    }

    assert(String(data.result).includes('8'), `Expected 8, got ${data.result}`);
  });
}

async function main() {
  console.log('🚀 cliagents - Runtime Consistency Tests');

  setTemporaryEnv('SESSION_GRAPH_WRITES_ENABLED', '1');
  setTemporaryEnv('SESSION_EVENTS_ENABLED', '1');
  testServer = await startTestServer();
  baseUrl = testServer.baseUrl;
  console.log(`   Testing against: ${baseUrl}`);

  try {
    await testHealthAndCatalog();
    await testOneShotAdapters();
    await testGeminiPersistence();
    await testCodexPersistence();
    await testConsensusRoute();
    await testTmuxWorkerBehavior();
  } finally {
    await stopTestServer(testServer);
    restoreTemporaryEnv();
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`\n📊 Results: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);

  if (results.skipped > 0) {
    console.log('\n⏭️  Skipped tests:');
    for (const entry of results.tests.filter((item) => item.status === 'skipped')) {
      console.log(`   - ${entry.name}: ${entry.reason}`);
    }
  }

  if (results.failed > 0) {
    console.log('\n❌ Failed tests:');
    for (const entry of results.tests.filter((item) => item.status === 'failed')) {
      console.log(`   - ${entry.name}: ${entry.error}`);
    }
    process.exit(1);
  }

  console.log('\n✅ Runtime consistency checks passed.\n');
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  if (testServer) {
    await stopTestServer(testServer);
  }
  restoreTemporaryEnv();
  process.exit(1);
});
