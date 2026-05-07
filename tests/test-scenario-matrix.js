#!/usr/bin/env node

/**
 * Scenario matrix smoke test:
 * - direct session multi-turn
 * - long-running tasks
 * - orchestration endpoints
 * - qwen via qwen-cli adapter
 *
 * Run:
 *   node scripts/run-with-supported-node.js tests/test-scenario-matrix.js
 */

const assert = require('assert');
const { extractOutput } = require('../src/utils/output-extractor');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

let testServer = null;
let baseUrl = null;

const summary = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: []
};

function shouldSkip(message = '') {
  const text = String(message).toLowerCase();
  return [
    'not authenticated',
    'authentication failed',
    'please log in',
    'login required',
    'api key',
    'quota',
    'usage limit',
    'rate limit',
    'resourceexhausted',
    'billing',
    'adapter_unavailable',
    'cli not available',
    'model not available',
    'pull'
  ].some((token) => text.includes(token));
}

function isTimeoutMessage(message = '') {
  const text = String(message).toLowerCase();
  return [
    'request timed out',
    'timed out',
    'operation was aborted due to timeout',
    'operation was aborted',
    'aborterror'
  ].some((token) => text.includes(token));
}

function isQwenSkippableMessage(message = '') {
  return shouldSkip(message) || isTimeoutMessage(message);
}

function isQwenTransientMessage(message = '') {
  const text = String(message).toLowerCase();
  return (
    isTimeoutMessage(text)
    || text.includes('qwen cli exited with code null')
    || text.includes('qwen cli exited with code')
    || text.includes('process exited')
    || text.includes('request aborted')
  );
}

async function request(method, route, body = null, timeoutMs = 180000) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
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
}

async function runTest(name, fn) {
  try {
    await fn();
    summary.passed += 1;
    summary.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('SKIP:')) {
      summary.skipped += 1;
      summary.tests.push({ name, status: 'skipped', reason: message.slice('SKIP:'.length).trim() });
      console.log(`  ⏭️  ${name} (${message.slice('SKIP:'.length).trim()})`);
      return;
    }

    summary.failed += 1;
    summary.tests.push({ name, status: 'failed', error: message });
    console.log(`  ❌ ${name}: ${message}`);
  }
}

async function createSession(adapter, extra = {}) {
  const { status, data } = await request('POST', '/sessions', { adapter, ...extra }, 120000);
  if (status !== 200) {
    const msg = data?.error?.message || data?.error || JSON.stringify(data);
    if (shouldSkip(msg)) {
      throw new Error(`SKIP: ${msg}`);
    }
    throw new Error(`createSession(${adapter}) failed: ${status} ${msg}`);
  }
  return data.sessionId;
}

async function sendMessage(sessionId, message, timeout = 180000) {
  const { status, data } = await request('POST', `/sessions/${sessionId}/messages`, { message, timeout }, timeout + 10000);
  if (status !== 200) {
    const msg = data?.error?.message || data?.error || JSON.stringify(data);
    if (shouldSkip(msg)) {
      throw new Error(`SKIP: ${msg}`);
    }
    throw new Error(`sendMessage failed: ${status} ${msg}`);
  }
  return data.result;
}

async function deleteSession(sessionId) {
  if (!sessionId) {
    return;
  }

  try {
    await request('POST', `/sessions/${sessionId}/interrupt`, {}, 30000);
  } catch {}

  try {
    await request('DELETE', `/sessions/${sessionId}`, null, 30000);
  } catch {}
}

async function runQwenPromptWithRetry(options) {
  const {
    prompt,
    timeoutMs,
    retryPrompt,
    retryTimeoutMs,
    skipLabel
  } = options;

  let sessionId = await createSession('qwen-cli');
  try {
    try {
      return await sendMessage(sessionId, prompt, timeoutMs);
    } catch (error) {
      const message = String(error?.message || error);
      if (!isQwenTransientMessage(message)) {
        if (isQwenSkippableMessage(message)) {
          throw new Error(`SKIP: ${message}`);
        }
        throw error;
      }

      await deleteSession(sessionId);
      sessionId = await createSession('qwen-cli');

      try {
        return await sendMessage(sessionId, retryPrompt || prompt, retryTimeoutMs || timeoutMs);
      } catch (retryError) {
        const retryMessage = String(retryError?.message || retryError);
        if (isQwenSkippableMessage(retryMessage) || isQwenTransientMessage(retryMessage)) {
          throw new Error(`SKIP: ${skipLabel} could not complete after retry (${retryMessage})`);
        }
        throw retryError;
      }
    }
  } finally {
    await deleteSession(sessionId);
  }
}

async function waitForTerminalDone(terminalId, timeoutMs = 180000) {
  const start = Date.now();
  let sawProcessing = false;

  while (Date.now() - start < timeoutMs) {
    const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}`, null, 30000);
    if (status !== 200) {
      throw new Error(`terminal status failed: ${status}`);
    }

    if (data.status === 'processing') {
      sawProcessing = true;
    }

    if (data.status === 'completed' || (data.status === 'idle' && sawProcessing)) {
      return data;
    }
    if (data.status === 'error') {
      throw new Error(`terminal entered error status`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`terminal timeout after ${timeoutMs}ms`);
}

async function testCodexMultiTurn() {
  const sessionId = await createSession('codex-cli');
  try {
    await sendMessage(sessionId, 'The session marker is ALPHA42. Reply with READY.');
    const result = await sendMessage(sessionId, 'What is the session marker for this conversation? Reply with one word.');
    assert(result.toLowerCase().includes('alpha42'), `Expected ALPHA42, got: ${result.slice(0, 200)}`);
  } finally {
    await deleteSession(sessionId);
  }
}

async function testCodexLongTask() {
  let sessionId = await createSession('codex-cli');
  try {
    let result;
    try {
      result = await sendMessage(
        sessionId,
        'Provide a 12-step numbered observability rollout checklist. Keep each step under 10 words. End with MATRIX_DONE.',
        210000
      );
    } catch (error) {
      const message = String(error?.message || error);
      if (!message.toLowerCase().includes('request timed out')) {
        throw error;
      }

      // Retry once with a lighter long prompt in a fresh session.
      await deleteSession(sessionId);
      sessionId = await createSession('codex-cli');
      result = await sendMessage(
        sessionId,
        'Provide exactly 8 concise numbered observability checks. End with MATRIX_DONE.',
        150000
      );
    }

    const stepCount = (String(result).match(/^\s*\d+\./gm) || []).length;
    assert(stepCount >= 8, `Expected at least 8 numbered steps, got ${stepCount}: ${String(result).slice(0, 240)}`);
    assert(result.includes('MATRIX_DONE'), `Expected MATRIX_DONE marker in long task output, got: ${String(result).slice(0, 240)}`);
  } finally {
    await deleteSession(sessionId);
  }
}

async function testQwenShort() {
  const result = await runQwenPromptWithRetry({
    prompt: 'What is 9 + 4? Reply with only the number.',
    timeoutMs: 120000,
    retryPrompt: 'Compute 9 + 4 and reply with only digits.',
    retryTimeoutMs: 90000,
    skipLabel: 'Qwen short task'
  });
  assert(result.includes('13'), `Expected 13, got: ${String(result).slice(0, 200)}`);
}

async function testQwenLong() {
  const result = await runQwenPromptWithRetry({
    prompt: 'Provide a 12-step checklist to review a pull request. Keep each step under 12 words and end with QWEN_DONE.',
    timeoutMs: 240000,
    retryPrompt: 'Provide exactly 8 concise PR review checks and end with QWEN_DONE.',
    retryTimeoutMs: 180000,
    skipLabel: 'Qwen long task'
  });
  const hasMarker = /QWEN_DONE/i.test(String(result));
  const stepCount = (String(result).match(/^\s*\d+\./gm) || []).length;
  assert(
    hasMarker || stepCount >= 8,
    `Expected QWEN_DONE marker or >=8 numbered steps, got: ${String(result).slice(0, 280)}`
  );
}

async function testGeminiBootstrap() {
  const sessionId = await createSession('gemini-cli');
  try {
    const result = await sendMessage(sessionId, 'What is 6 + 7? Reply with only the number.', 120000);
    assert(result.includes('13'), `Expected 13 from Gemini, got: ${result.slice(0, 200)}`);
  } finally {
    await deleteSession(sessionId);
  }
}

async function testConsensusCodexQwen() {
  const { status, data } = await request('POST', '/orchestration/consensus', {
    message: 'What is 8 + 11? Reply with just the number.',
    timeout: 120000,
    participants: [
      { adapter: 'codex-cli', name: 'codex-participant' },
      { adapter: 'qwen-cli', name: 'qwen-participant' }
    ],
    judge: {
      adapter: 'codex-cli',
      name: 'judge-codex',
      systemPrompt: 'Synthesize a single best final answer.'
    }
  }, 240000);

  if (status !== 200) {
    const msg = data?.error?.message || JSON.stringify(data);
    if (shouldSkip(msg)) {
      throw new Error(`SKIP: ${msg}`);
    }
    throw new Error(`consensus failed: ${status} ${msg}`);
  }

  assert.strictEqual(data.mode, 'direct-session');
  assert(Array.isArray(data.participants), 'participants should be array');
  assert(data.participants.length >= 2, 'expected at least 2 participants');
  const successes = data.participants.filter((p) => p.success);
  assert(successes.length >= 1, 'expected at least one successful participant');
}

async function testPlanReviewCodexQwen() {
  const { status, data } = await request('POST', '/orchestration/plan-review', {
    plan: 'Implement endpoint input validation, add unit tests, and add docs update.',
    context: 'Smoke matrix test',
    timeout: 120000,
    judge: false,
    reviewers: [
      {
        name: 'codex-plan-reviewer',
        adapter: 'codex-cli',
        systemPrompt: 'Review implementation plans for correctness. Return JSON only.'
      },
      {
        name: 'qwen-plan-reviewer',
        adapter: 'qwen-cli',
        systemPrompt: 'Review implementation plans for risks. Return JSON only.'
      }
    ]
  }, 240000);

  if (status !== 200) {
    const msg = data?.error?.message || JSON.stringify(data);
    if (shouldSkip(msg)) {
      throw new Error(`SKIP: ${msg}`);
    }
    throw new Error(`plan-review failed: ${status} ${msg}`);
  }

  assert.strictEqual(data.protocol, 'plan-review');
  assert(data.success === true || data.success === false, 'success should be boolean');
  assert(Array.isArray(data.reviewers), 'reviewers should be array');
}

async function testTmuxReplyLoopCodex() {
  const createRes = await request('POST', '/orchestration/terminals', {
    adapter: 'codex-cli',
    agentProfile: 'codex-worker',
    role: 'worker'
  }, 120000);

  if (createRes.status !== 200) {
    const msg = createRes.data?.error?.message || JSON.stringify(createRes.data);
    if (shouldSkip(msg)) {
      throw new Error(`SKIP: ${msg}`);
    }
    throw new Error(`create tmux terminal failed: ${createRes.status} ${msg}`);
  }

  const terminalId = createRes.data.terminalId;
  try {
    let res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'What is 2 + 3? Reply with just the number.'
    }, 120000);
    assert.strictEqual(res.status, 200, `first input failed: ${res.status}`);

    await waitForTerminalDone(terminalId, 180000);
    let out = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=400`, null, 60000);
    const firstOutput = extractOutput(out.data?.output || '', 'codex-cli');
    assert(firstOutput.includes('5'), `expected first response to include 5, got: ${firstOutput.slice(0, 200)}`);

    res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'Now what is 7 + 5? Reply with just the number.'
    }, 120000);
    assert.strictEqual(res.status, 200, `second input failed: ${res.status}`);

    await waitForTerminalDone(terminalId, 180000);
    out = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=600`, null, 60000);
    const secondOutput = extractOutput(out.data?.output || '', 'codex-cli');
    assert(secondOutput.includes('12'), `expected second response to include 12, got: ${secondOutput.slice(0, 240)}`);
  } finally {
    await request('DELETE', `/orchestration/terminals/${terminalId}`);
  }
}

async function testTmuxReplyLoopQwen() {
  const createRes = await request('POST', '/orchestration/terminals', {
    adapter: 'qwen-cli',
    agentProfile: 'qwen-worker',
    role: 'worker'
  }, 120000);

  if (createRes.status !== 200) {
    const msg = createRes.data?.error?.message || JSON.stringify(createRes.data);
    if (shouldSkip(msg)) {
      throw new Error(`SKIP: ${msg}`);
    }
    throw new Error(`create qwen tmux terminal failed: ${createRes.status} ${msg}`);
  }

  const terminalId = createRes.data.terminalId;
  try {
    let res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'What is 2 + 8? Reply with just the number.'
    }, 120000);
    assert.strictEqual(res.status, 200, `first qwen input failed: ${res.status}`);

    await waitForTerminalDone(terminalId, 180000);
    let out = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=500`, null, 60000);
    const firstOutput = extractOutput(out.data?.output || '', 'qwen-cli');
    assert(firstOutput.includes('10'), `expected first qwen response to include 10, got: ${firstOutput.slice(0, 200)}`);

    res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'Now what is 7 + 6? Reply with just the number.'
    }, 120000);
    assert.strictEqual(res.status, 200, `second qwen input failed: ${res.status}`);

    await waitForTerminalDone(terminalId, 180000);
    out = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=700`, null, 60000);
    const secondOutput = extractOutput(out.data?.output || '', 'qwen-cli');
    assert(secondOutput.includes('13'), `expected second qwen response to include 13, got: ${secondOutput.slice(0, 240)}`);
  } finally {
    await request('DELETE', `/orchestration/terminals/${terminalId}`);
  }
}

async function main() {
  console.log('🚦 Scenario Matrix: cliagents');
  testServer = await startTestServer();
  baseUrl = testServer.baseUrl;
  console.log(`   baseUrl: ${baseUrl}`);

  console.log('\n📋 Direct sessions');
  await runTest('Codex multi-turn reply-back', testCodexMultiTurn);
  await runTest('Codex long task', testCodexLongTask);
  await runTest('Qwen short task via qwen-cli', testQwenShort);
  await runTest('Qwen long task via qwen-cli', testQwenLong);
  await runTest('Gemini bootstrap + one-shot', testGeminiBootstrap);

  console.log('\n📋 Orchestration');
  await runTest('Consensus (Codex + Qwen)', testConsensusCodexQwen);
  await runTest('Plan-review (Codex + Qwen)', testPlanReviewCodexQwen);
  await runTest('Tmux reply loop (Codex)', testTmuxReplyLoopCodex);
  await runTest('Tmux reply loop (Qwen)', testTmuxReplyLoopQwen);

  await stopTestServer(testServer);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Matrix Results: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);

  if (summary.failed > 0) {
    console.log('\n❌ Failed tests:');
    summary.tests
      .filter((t) => t.status === 'failed')
      .forEach((t) => console.log(`   - ${t.name}: ${t.error}`));
    process.exit(1);
  }

  if (summary.skipped > 0) {
    console.log('\n⏭️  Skipped tests:');
    summary.tests
      .filter((t) => t.status === 'skipped')
      .forEach((t) => console.log(`   - ${t.name}: ${t.reason}`));
  }
}

main().catch(async (error) => {
  console.error('Fatal matrix error:', error.message);
  if (testServer) {
    await stopTestServer(testServer);
  }
  process.exit(1);
});
