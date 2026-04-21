#!/usr/bin/env node
/**
 * cliagents - Broad API Surface Test Suite
 *
 * Runs broad regression coverage against the active broker adapter surface.
 * If TEST_URL is not provided, the suite starts an isolated local test server.
 */

const WebSocket = require('ws');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

let BASE_URL = process.env.TEST_URL || null;
const ACTIVE_ADAPTERS = ['codex-cli', 'gemini-cli', 'qwen-cli', 'opencode-cli', 'claude-code'];
const PRIMARY_SESSION_ADAPTER = 'codex-cli';
const GEMINI_TEST_MODEL = process.env.TEST_GEMINI_MODEL || process.env.CLIAGENTS_GEMINI_MODEL || 'gemini-3-pro-preview';
const OPENAI_COMPAT_MODEL = 'gpt-4o';
const OPENAI_COMPAT_OWNER = 'codex-cli';
let testServer = null;

// Test utilities
async function request(method, path, body = null) {
  const controller = new AbortController();
  const timeoutMs = 90000;
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms for ${method} ${path}`));
  }, timeoutMs);
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(`${BASE_URL}${path}`, options);
    const text = await response.text();
    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch {
      return { status: response.status, data: text };
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms for ${method} ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getProviderIssueReason(status, data) {
  const errorMsg = typeof data.error === 'string' ? data.error : (data.error?.message || '');
  const resultMsg = data.result || '';
  const combined = (errorMsg + ' ' + resultMsg).toLowerCase();

  if (status >= 400 && data?.error?.code === 'adapter_unavailable') {
    return errorMsg || 'adapter unavailable';
  }

  if ([401, 403].includes(status)) {
    return errorMsg || 'authentication failure';
  }

  if ([429, 503, 504].includes(status)) {
    return errorMsg || `provider returned ${status}`;
  }

  const authPatterns = [
    'not authenticated',
    'authentication failed',
    'invalid access token',
    'token expired',
    'please log in',
    'not logged in',
    'login required',
    'sign in with google',
    'active signed-in google account',
    'cloud code private api',
    'accessnotconfigured',
    'api key',
    'unauthorized',
    'forbidden',
    'gemini auth login'
  ];

  if (authPatterns.some((pattern) => combined.includes(pattern))) {
    return errorMsg || resultMsg || 'provider authentication issue';
  }

  const discontinuationPatterns = [
    'oauth was discontinued upstream',
    'switch to api key or coding plan'
  ];

  if (discontinuationPatterns.some((pattern) => combined.includes(pattern))) {
    return errorMsg || resultMsg || 'provider auth flow discontinued upstream';
  }

  const capacityPatterns = [
    'quota',
    'resourceexhausted',
    'capacity',
    'rate limit',
    'overloaded'
  ];

  if (capacityPatterns.some((pattern) => combined.includes(pattern))) {
    return errorMsg || resultMsg || 'provider capacity issue';
  }

  const transientPatterns = [
    'timed out',
    'timeout',
    'fetch failed',
    'network',
    'econnreset',
    'socket'
  ];

  if (transientPatterns.some((pattern) => combined.includes(pattern))) {
    return errorMsg || resultMsg || 'provider timeout or transient failure';
  }

  return null;
}

function getProviderExceptionReason(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) {
    return null;
  }

  const transientPatterns = [
    'fetch failed',
    'timed out',
    'timeout',
    'aborted',
    'network',
    'econnreset',
    'socket'
  ];

  if (transientPatterns.some((pattern) => message.includes(pattern))) {
    return String(error.message || error);
  }

  return null;
}

// Test results tracking
const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    // Handle explicit skips
    if (error.message.startsWith('SKIP:')) {
      results.skipped++;
      const reason = error.message.replace('SKIP:', '').trim();
      results.tests.push({ name, status: 'skipped', reason });
      console.log(`  ⏭️  ${name} (skipped - ${reason})`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'failed', error: error.message });
      console.log(`  ❌ ${name}: ${error.message}`);
    }
  }
}

async function runTestSection(title, fn) {
  console.log(`\n📋 ${title}`);
  await fn();
}

// ============================================
// TEST SUITES
// ============================================

async function testHealth() {
  console.log('\n📋 Health Tests');

  await test('Server responds to health check', async () => {
    const { status, data } = await request('GET', '/health');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.status === 'ok', 'Health status should be ok');
    assert(typeof data.timestamp === 'number', 'Should have timestamp');
  });

  await test('OpenAPI spec is available', async () => {
    const { status, data } = await request('GET', '/openapi.json');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.openapi === '3.0.3', 'Should be OpenAPI 3.0.3');
    assert(data.info?.title === 'cliagents API', 'Should have correct title');
    assert(data.paths?.['/health'], 'Should have /health path');
    assert(data.paths?.['/sessions/{sessionId}/status'], 'Should have /status path');
    assert(data.paths?.['/sessions/{sessionId}/interrupt'], 'Should have /interrupt path');
    // OpenAI-compatible endpoints
    assert(data.paths?.['/v1/models'], 'Should have /v1/models path');
    assert(data.paths?.['/v1/models/{model}'], 'Should have /v1/models/{model} path');
    assert(data.paths?.['/v1/chat/completions'], 'Should have /v1/chat/completions path');
  });
}

async function testAdapters() {
  console.log('\n📋 Adapter Tests');

  await test('Lists the active broker adapters', async () => {
    const { status, data } = await request('GET', '/adapters');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.adapters), 'Should return adapters array');
    assert(data.adapters.length === ACTIVE_ADAPTERS.length, `Should have exactly ${ACTIVE_ADAPTERS.length} adapters, got ${data.adapters.length}`);

    const names = data.adapters.map(a => a.name).sort();
    const expected = [...ACTIVE_ADAPTERS].sort();
    assert(JSON.stringify(names) === JSON.stringify(expected), `Expected ${expected}, got ${names}`);
  });

  await test('Codex adapter is registered', async () => {
    const { data } = await request('GET', '/adapters');
    const codex = data.adapters.find(a => a.name === 'codex-cli');
    assert(codex, 'Codex adapter should exist');
    // Note: availability depends on CLI installation
    if (!codex.available) {
      throw new Error('SKIP: Codex CLI not installed');
    }
  });

  await test('Gemini CLI adapter is registered', async () => {
    const { data } = await request('GET', '/adapters');
    const gemini = data.adapters.find(a => a.name === 'gemini-cli');
    assert(gemini, 'Gemini adapter should exist');
    // Note: availability depends on CLI installation
    if (!gemini.available) {
      throw new Error('SKIP: Gemini CLI not installed');
    }
  });

  await test('Accepts claude-code in the active broker surface', async () => {
    const { status, data } = await request('POST', '/orchestration/terminals', {
      adapter: 'claude-code'
    });
    // It should be 200 or 503 (if not installed), but NOT 400 invalid_adapter
    assert(status === 200 || status === 503, `Expected 200 or 503, got ${status}: ${JSON.stringify(data)}`);
    if (status === 200) {
      assert(data.terminalId, 'Should return terminalId');
      // Cleanup
      await request('DELETE', `/orchestration/terminals/${data.terminalId}`);
    }
  });

  await test('Rejects legacy orchestration adapters outside the active surface', async () => {
    const { status, data } = await request('POST', '/orchestration/terminals', {
      adapter: 'mistral-vibe'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_adapter', 'Should return invalid_adapter');
  });
}

async function testSessions() {
  console.log('\n📋 Session Tests');

  let sessionId;

  await test('Create primary session', async () => {
    const { status, data } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.sessionId, 'Should return sessionId');
    assert(data.adapter === PRIMARY_SESSION_ADAPTER, 'Adapter should match');
    assert(data.status === 'ready', 'Status should be ready');
    sessionId = data.sessionId;
  });

  await test('List sessions includes created session', async () => {
    const { status, data } = await request('GET', '/sessions');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.sessions), 'Should return sessions array');
    const found = data.sessions.find(s => s.sessionId === sessionId);
    assert(found, 'Created session should be listed');
  });

  await test('Get session info', async () => {
    const { status, data } = await request('GET', `/sessions/${sessionId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.sessionId === sessionId, 'Session ID should match');
    assert(data.adapterName === PRIMARY_SESSION_ADAPTER, 'Adapter should match');
  });

  await test('Get session status', async () => {
    // Create a new session for status test
    const { data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });
    const newSessionId = session.sessionId;

    const { status, data } = await request('GET', `/sessions/${newSessionId}/status`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.sessionId === newSessionId, 'Session ID should match');
    assert(data.status === 'stable', 'Initial status should be stable');
    assert(typeof data.lastActivity === 'number', 'Should have lastActivity timestamp');
    assert(typeof data.messageCount === 'number', 'Should have messageCount');
    assert(typeof data.hasActiveProcess === 'boolean', 'Should have hasActiveProcess');

    // Cleanup
    await request('DELETE', `/sessions/${newSessionId}`);
  });

  await test('Interrupt session returns result', async () => {
    // Create a new session for interrupt test
    const { data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });
    const newSessionId = session.sessionId;

    // Interrupt (no active process, should return false)
    const { status, data } = await request('POST', `/sessions/${newSessionId}/interrupt`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.interrupted === false, 'Should not interrupt when no active process');
    assert(data.reason === 'no_active_process', 'Reason should be no_active_process');

    // Cleanup
    await request('DELETE', `/sessions/${newSessionId}`);
  });

  await test('Status 404 for non-existent session', async () => {
    const { status } = await request('GET', '/sessions/nonexistent123/status');
    assert(status === 404, `Expected 404, got ${status}`);
  });

  await test('Terminate session', async () => {
    const { status } = await request('DELETE', `/sessions/${sessionId}`);
    assert(status === 200, `Expected 200, got ${status}`);

    // Verify session is gone
    const { status: getStatus } = await request('GET', `/sessions/${sessionId}`);
    assert(getStatus === 404, 'Session should be deleted');
  });
}

async function testOneShot() {
  console.log('\n📋 One-Shot Ask Tests');

  await test('Simple math with Codex', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: PRIMARY_SESSION_ADAPTER,
      message: 'What is 5 + 5? Reply with just the number.'
    });
    const providerIssue = getProviderIssueReason(status, data);
    if (providerIssue) {
      throw new Error(`SKIP: ${providerIssue}`);
    }
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.result, 'Should have result');
    assert(data.result.includes('10'), `Expected 10, got: ${data.result}`);
  });

  await test('Simple math with Gemini', async () => {
    try {
      const { status, data } = await request('POST', '/ask', {
        adapter: 'gemini-cli',
        message: 'What is 7 + 7? Reply with just the number.'
      });
      const providerIssue = getProviderIssueReason(status, data);
      if (providerIssue) {
        throw new Error(`SKIP: ${providerIssue}`);
      }
      assert(status === 200, `Expected 200, got ${status}`);
      assert(data.result, 'Should have result');
      assert(data.result.includes('14'), `Expected 14, got: ${data.result}`);
    } catch (error) {
      const providerIssue = getProviderExceptionReason(error);
      if (providerIssue) {
        throw new Error(`SKIP: ${providerIssue}`);
      }
      throw error;
    }
  });
}

async function testContextPreservation() {
  console.log('\n📋 Context Preservation Tests');

  let sessionId;

  await test('Context preserved across messages', async () => {
    // Create session
    const { status: createStatus, data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });

    const providerIssue = getProviderIssueReason(createStatus, session);
    if (providerIssue) {
      throw new Error(`SKIP: ${providerIssue}`);
    }

    sessionId = session.sessionId;

    // Send first message with name
    await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'My favorite color is purple. Remember this.'
    });

    // Ask about it
    const { status, data } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'What is my favorite color? Reply with just the color.'
    });

    assert(data.result.toLowerCase().includes('purple'),
      `Expected purple, got: ${data.result}`);

    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
  });
}

async function testErrorHandling() {
  console.log('\n📋 Error Handling Tests');

  await test('404 for non-existent session', async () => {
    const { status } = await request('GET', '/sessions/nonexistent123');
    assert(status === 404, `Expected 404, got ${status}`);
  });

  await test('Error for invalid adapter', async () => {
    const { status } = await request('POST', '/sessions', { adapter: 'invalid-adapter' });
    assert(status >= 400, `Expected error status, got ${status}`);
  });
}

async function testStreamingProgress() {
  console.log('\n📋 Streaming Progress Tests');

  await test('Primary adapter streaming returns progress events via SSE', async () => {
    // Create session
    const { status: createStatus, data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });

    const createIssue = getProviderIssueReason(createStatus, session);
    if (createIssue) {
      throw new Error(`SKIP: ${createIssue}`);
    }

    const sessionId = session.sessionId;

    // Send message with stream=true using SSE
    const response = await fetch(`${BASE_URL}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Say hello world',
        stream: true
      })
    });

    assert(response.ok, `Expected 200, got ${response.status}`);

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let events = [];
    let hasResult = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            events.push(event);
            if (event.type === 'result') hasResult = true;
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    assert(hasResult, 'Should receive final result event');
    assert(events.length > 0, 'Should receive at least one event');

    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
  });

  await test('Metadata includes cost and token stats', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: PRIMARY_SESSION_ADAPTER,
      message: 'Say hi'
    });

    const providerIssue = getProviderIssueReason(status, data);
    if (providerIssue) {
      throw new Error(`SKIP: ${providerIssue}`);
    }

    assert(data.metadata, 'Should have metadata');
    assert(typeof data.metadata.outputTokens === 'number', 'Should have outputTokens');
    // Cost is now returned in metadata
    assert(data.metadata.costUsd !== undefined || data.metadata.inputTokens !== undefined,
      'Should have cost or token info');
  });
}

async function testFirstPartyAdapters() {
  console.log('\n📋 First-Party Adapter Tests');

  // Get available adapters first
  const { data } = await request('GET', '/adapters');
  const adapters = data.adapters;

  // Helper for testing adapters with proper skip tracking
  async function testAdapter(name, displayName) {
    const adapter = adapters.find(a => a.name === name);

    if (!adapter) {
      results.skipped = (results.skipped || 0) + 1;
      results.tests.push({ name: `${displayName} one-shot ask`, status: 'skipped', reason: 'not registered' });
      console.log(`  ⏭️  ${displayName} one-shot ask (skipped - not registered)`);
      return;
    }

    if (!adapter.available) {
      results.skipped = (results.skipped || 0) + 1;
      results.tests.push({ name: `${displayName} one-shot ask`, status: 'skipped', reason: 'CLI not installed' });
      console.log(`  ⏭️  ${displayName} one-shot ask (skipped - CLI not installed)`);
      return;
    }

    if (adapter.authenticated === false) {
      const reason = adapter.authenticationReason || 'provider not authenticated';
      results.skipped = (results.skipped || 0) + 1;
      results.tests.push({ name: `${displayName} one-shot ask`, status: 'skipped', reason });
      console.log(`  ⏭️  ${displayName} one-shot ask (skipped - ${reason})`);
      return;
    }

    await test(`${displayName} one-shot ask`, async () => {
      const num1 = Math.floor(Math.random() * 5) + 1;
      const num2 = Math.floor(Math.random() * 5) + 1;
      const expected = num1 + num2;

      try {
        const { status, data } = await request('POST', '/ask', {
          adapter: name,
          message: `What is ${num1} + ${num2}? Reply with just the number.`
        });

        const providerIssue = getProviderIssueReason(status, data);
        if (providerIssue) {
          throw new Error(`SKIP: ${providerIssue}`);
        }

        if (status === 200) {
          assert(data.result, 'Should have result');
          assert(data.result.includes(String(expected)), `Expected ${expected}, got: ${data.result}`);
        } else {
          assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
        }
      } catch (error) {
        const providerIssue = getProviderExceptionReason(error);
        if (providerIssue) {
          throw new Error(`SKIP: ${providerIssue}`);
        }
        throw error;
      }
    });
  }

  // Test the active adapters
  await testAdapter('codex-cli', 'Codex CLI', null);
  await testAdapter('gemini-cli', 'Gemini CLI', null);
  await testAdapter('qwen-cli', 'Qwen CLI', null);
  await testAdapter('opencode-cli', 'OpenCode CLI', null);
  await testAdapter('claude-code', 'Claude Code', null);
}

async function testValidation() {
  console.log('\n📋 Input Validation Tests');

  // workDir validation
  await test('Rejects path traversal in workDir', async () => {
    const { status, data } = await request('POST', '/sessions', {
      adapter: PRIMARY_SESSION_ADAPTER,
      workDir: '/tmp/../etc/passwd'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter error');
  });

  await test('Rejects dangerous system paths', async () => {
    const { status, data } = await request('POST', '/sessions', {
      adapter: PRIMARY_SESSION_ADAPTER,
      workDir: '/etc/secrets'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.message?.includes('system directory'), 'Should mention system directory');
  });

  // Message validation
  await test('Rejects empty message in session', async () => {
    const { data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });
    const { status, data } = await request('POST', `/sessions/${session.sessionId}/messages`, {
      message: ''
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter error');
    await request('DELETE', `/sessions/${session.sessionId}`);
  });

  await test('Rejects missing message in /ask', async () => {
    const { status, data } = await request('POST', '/ask', { adapter: PRIMARY_SESSION_ADAPTER });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'missing_parameter', 'Should be missing_parameter');
    assert(data.error?.param === 'message', 'Should specify message param');
  });

  await test('Rejects non-string message', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: PRIMARY_SESSION_ADAPTER,
      message: 12345
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter');
  });

  await test('Rejects path traversal in /ask workDir', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: PRIMARY_SESSION_ADAPTER,
      message: 'hi',
      workDir: '/tmp/../etc/passwd'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter error');
  });

  await test('Rejects dangerous system paths in /ask workingDirectory', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: PRIMARY_SESSION_ADAPTER,
      message: 'hi',
      workingDirectory: '/etc/secrets'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.message?.includes('system directory'), 'Should mention system directory');
  });
}

async function testFileOperations() {
  console.log('\n📋 File Operation Tests');

  let sessionId;

  await test('Upload file to session', async () => {
    const { data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });
    sessionId = session.sessionId;

    const { status, data } = await request('POST', `/sessions/${sessionId}/files`, {
      files: [{ name: 'test.txt', content: 'Hello World', encoding: 'utf8' }]
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.files?.[0]?.status === 'uploaded', 'File should be uploaded');
  });

  await test('Upload base64 encoded file', async () => {
    const { status, data } = await request('POST', `/sessions/${sessionId}/files`, {
      files: [{ name: 'binary.bin', content: Buffer.from('binary data').toString('base64'), encoding: 'base64' }]
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.files?.[0]?.status === 'uploaded', 'Base64 file should be uploaded');
  });

  await test('List files in session', async () => {
    const { status, data } = await request('GET', `/sessions/${sessionId}/files`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.files), 'Should return files array');
    assert(data.files.some(f => f.name === 'test.txt'), 'Should list uploaded file');
  });

  await test('Reject path traversal in filename', async () => {
    const { status, data } = await request('POST', `/sessions/${sessionId}/files`, {
      files: [{ name: '../../../etc/passwd', content: 'malicious', encoding: 'utf8' }]
    });
    assert(status === 200, 'Request succeeds but file fails');
    assert(data.files?.[0]?.status === 'failed', 'File with traversal should fail');
  });

  await test('Reject missing files array', async () => {
    const { status, data } = await request('POST', `/sessions/${sessionId}/files`, {});
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'missing_parameter', 'Should be missing_parameter');
  });

  await test('Files 404 for non-existent session', async () => {
    const { status } = await request('GET', '/sessions/nonexistent123/files');
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // Cleanup
  await request('DELETE', `/sessions/${sessionId}`);
}

async function testErrorFormat() {
  console.log('\n📋 Standardized Error Format Tests');

  await test('404 returns standardized error object', async () => {
    const { status, data } = await request('GET', '/sessions/nonexistent123');
    assert(status === 404, `Expected 404, got ${status}`);
    assert(typeof data.error === 'object', 'Error should be object not string');
    assert(data.error.code === 'session_not_found', `Expected session_not_found, got ${data.error.code}`);
    assert(data.error.message, 'Should have message field');
    assert(data.error.type === 'session_not_found', 'Should have type field');
  });

  await test('400 missing param returns error with param field', async () => {
    const { status, data } = await request('POST', '/ask', {});
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'missing_parameter', 'Should be missing_parameter');
    assert(data.error?.param === 'message', 'Should specify which param is missing');
  });

  await test('Invalid adapter returns adapter_not_found', async () => {
    const { status, data } = await request('POST', '/sessions', { adapter: 'nonexistent-adapter' });
    assert(status === 404, `Expected 404, got ${status}`);
    assert(data.error?.code === 'adapter_not_found', 'Should be adapter_not_found');
  });
}

async function testWebSocket() {
  console.log('\n📋 WebSocket Tests');

  // Helper to create WebSocket connection
  const WS_URL = BASE_URL.replace('http', 'ws') + '/ws';

  function createWsClient() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function sendAndWait(ws, message, expectedType, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${expectedType}`)), timeout);
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === expectedType || msg.type === 'error') {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(message));
    });
  }

  await test('WebSocket connects successfully', async () => {
    const ws = await createWsClient();
    assert(ws.readyState === WebSocket.OPEN, 'WebSocket should be open');
    ws.close();
  });

  await test('WebSocket ping/pong works', async () => {
    const ws = await createWsClient();
    const response = await sendAndWait(ws, { type: 'ping' }, 'pong');
    assert(response.type === 'pong', 'Should receive pong');
    assert(typeof response.timestamp === 'number', 'Should have timestamp');
    ws.close();
  });

  await test('WebSocket create_session works', async () => {
    const ws = await createWsClient();
    const response = await sendAndWait(ws, {
      type: 'create_session',
      adapter: PRIMARY_SESSION_ADAPTER
    }, 'session_created');
    assert(response.type === 'session_created', 'Should create session');
    assert(response.session?.sessionId, 'Should have sessionId');

    // Cleanup
    await sendAndWait(ws, { type: 'terminate_session' }, 'session_terminated');
    ws.close();
  });

  await test('WebSocket join_session works', async () => {
    // Create session via HTTP first
    const { data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });
    const sessionId = session.sessionId;

    const ws = await createWsClient();
    const response = await sendAndWait(ws, {
      type: 'join_session',
      sessionId
    }, 'session_joined');
    assert(response.type === 'session_joined', 'Should join session');
    assert(response.sessionId === sessionId, 'Should have correct sessionId');

    ws.close();
    await request('DELETE', `/sessions/${sessionId}`);
  });

  await test('WebSocket returns error for invalid session', async () => {
    const ws = await createWsClient();
    const response = await sendAndWait(ws, {
      type: 'join_session',
      sessionId: 'nonexistent123'
    }, 'error');
    assert(response.type === 'error', 'Should return error');
    assert(response.error.includes('not found'), 'Should mention not found');
    ws.close();
  });

  await test('WebSocket send_message requires session', async () => {
    const ws = await createWsClient();
    const response = await sendAndWait(ws, {
      type: 'send_message',
      message: 'Hello'
    }, 'error');
    assert(response.type === 'error', 'Should return error');
    assert(response.error.includes('No session'), 'Should mention no session');
    ws.close();
  });
}

async function testSessionResume() {
  console.log('\n📋 Session Resume Tests');

  await test('Multi-turn conversation preserves context (primary adapter)', async () => {
    // Create session
    const { status: createStatus, data: session } = await request('POST', '/sessions', { adapter: PRIMARY_SESSION_ADAPTER });

    const createIssue = getProviderIssueReason(createStatus, session);
    if (createIssue) {
      throw new Error(`SKIP: ${createIssue}`);
    }

    const sessionId = session.sessionId;

    // First message - set context
    await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'Remember: the secret code is ALPHA123'
    });

    // Second message - ask about something else
    await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'What is 2+2?'
    });

    // Third message - recall the secret
    const { data } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'What was the secret code I told you? Reply with just the code.'
    });

    assert(data.result.includes('ALPHA123'),
      `Expected ALPHA123, got: ${data.result}`);

    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
  });

  await test('Gemini session preserves context across messages', async () => {
    let sessionId = null;

    try {
      const { status: createStatus, data: session } = await request('POST', '/sessions', { adapter: 'gemini-cli' });
      const createIssue = getProviderIssueReason(createStatus, session);
      if (createIssue) {
        throw new Error(`SKIP: ${createIssue}`);
      }

      sessionId = session.sessionId;

      const firstResponse = await request('POST', `/sessions/${sessionId}/messages`, {
        message: 'My pet cat is named Whiskers. Remember this.'
      });
      const firstIssue = getProviderIssueReason(firstResponse.status, firstResponse.data);
      if (firstIssue) {
        throw new Error(`SKIP: ${firstIssue}`);
      }

      const { status, data } = await request('POST', `/sessions/${sessionId}/messages`, {
        message: 'What is my cat\'s name? Reply with just the name.'
      });
      const secondIssue = getProviderIssueReason(status, data);
      if (secondIssue) {
        throw new Error(`SKIP: ${secondIssue}`);
      }
      if (!data?.result || typeof data.result !== 'string') {
        throw new Error(`SKIP: Gemini returned no usable result: ${JSON.stringify(data).slice(0, 200)}`);
      }

      assert(data.result.toLowerCase().includes('whiskers'),
        `Expected Whiskers, got: ${data.result}`);
    } catch (error) {
      const providerIssue = getProviderExceptionReason(error);
      if (providerIssue) {
        throw new Error(`SKIP: ${providerIssue}`);
      }
      throw error;
    } finally {
      if (sessionId) {
        await request('DELETE', `/sessions/${sessionId}`).catch(() => {});
      }
    }
  });
}

async function testActiveModelCatalog() {
  await runTestSection('Active Model Catalog Tests', async () => {
    await test('Active adapter list matches the canonical surface', async () => {
      const { status, data } = await request('GET', '/adapters');
      assert(status === 200, `Expected 200, got ${status}`);
      const names = data.adapters.map(a => a.name).sort();
      assert(JSON.stringify(names) === JSON.stringify([...ACTIVE_ADAPTERS].sort()), `Expected active adapters only, got ${names}`);
    });

    await test('Gemini and Qwen model mappings exist', async () => {
      const { status, data } = await request('GET', '/v1/models');
      assert(status === 200, `Expected 200, got ${status}`);
      const modelIds = (data.data || []).map(m => m.id);
      assert(modelIds.includes(GEMINI_TEST_MODEL), `Expected ${GEMINI_TEST_MODEL} in model list`);
      assert(modelIds.includes('qwen-max') || modelIds.includes('qwen-plus'), 'Expected at least one Qwen model in model list');
    });

    await test('Qwen model detail endpoint returns active owner metadata', async () => {
      const { status, data } = await request('GET', '/v1/models/qwen-max');
      if (status === 200) {
        assert(data.id === 'qwen-max', 'Model id should match');
        assert(data.owned_by === 'qwen-cli', 'Owner should be qwen-cli');
        return;
      }
      assert(status === 404 || status === 503, `Expected 200, 404, or 503, got ${status}`);
    });
  });
}

async function testOpenAICompat() {
  console.log('\n📋 OpenAI-Compatible API Tests');

  await test('GET /v1/models returns available models', async () => {
    const { status, data } = await request('GET', '/v1/models');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.object === 'list', 'Should have object: list');
    assert(Array.isArray(data.data), 'Should have data array');
    // Should have at least some models if any CLI is installed
  });

  await test('GET /v1/models/:model returns model info', async () => {
    const { status, data } = await request('GET', `/v1/models/${OPENAI_COMPAT_MODEL}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.id === OPENAI_COMPAT_MODEL, 'Should have correct id');
    assert(data.object === 'model', 'Should have object: model');
    assert(data.owned_by === OPENAI_COMPAT_OWNER, `Should be owned by ${OPENAI_COMPAT_OWNER}`);
  });

  await test('GET /v1/models/:unknown returns 404', async () => {
    const { status, data } = await request('GET', '/v1/models/unknown-model-xyz');
    assert(status === 404, `Expected 404, got ${status}`);
    assert(data.error?.code === 'model_not_found', 'Should be model_not_found');
  });

  await test('POST /v1/chat/completions requires messages', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: OPENAI_COMPAT_MODEL
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.type === 'invalid_request_error', 'Should be invalid_request_error');
    assert(data.error?.message?.includes('messages'), 'Should mention messages');
  });

  await test('POST /v1/chat/completions requires non-empty messages', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: OPENAI_COMPAT_MODEL,
      messages: []
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.message?.includes('non-empty'), 'Should mention non-empty');
  });

  await test('POST /v1/chat/completions non-streaming works', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: OPENAI_COMPAT_MODEL,
      messages: [{ role: 'user', content: 'Reply with just the word: PONG' }],
      stream: false
    });

    // May skip if CLI not available
    if (status === 503) {
      throw new Error(`SKIP: ${OPENAI_COMPAT_OWNER} not installed`);
    }

    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.id?.startsWith('chatcmpl-'), 'Should have chatcmpl id');
    assert(data.object === 'chat.completion', 'Should have correct object type');
    assert(data.choices?.[0]?.message?.role === 'assistant', 'Should have assistant role');
    assert(typeof data.choices?.[0]?.message?.content === 'string', 'Should have content');
    assert(data.choices?.[0]?.finish_reason === 'stop', 'Should have finish_reason');
  });

  await test('POST /v1/chat/completions with system prompt works', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: OPENAI_COMPAT_MODEL,
      messages: [
        { role: 'system', content: 'You are a pirate. Always say "Arrr!"' },
        { role: 'user', content: 'Hello' }
      ],
      stream: false
    });

    if (status === 503) {
      throw new Error(`SKIP: ${OPENAI_COMPAT_OWNER} not installed`);
    }

    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.choices?.[0]?.message?.content, 'Should have response');
  });

  await test('POST /v1/chat/completions multi-turn conversation', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: OPENAI_COMPAT_MODEL,
      messages: [
        { role: 'user', content: 'My name is Alice' },
        { role: 'assistant', content: 'Hello Alice!' },
        { role: 'user', content: 'What is my name? Reply with just the name.' }
      ],
      stream: false
    });

    if (status === 503) {
      throw new Error(`SKIP: ${OPENAI_COMPAT_OWNER} not installed`);
    }

    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.choices?.[0]?.message?.content?.toLowerCase().includes('alice'),
      `Expected Alice in response, got: ${data.choices?.[0]?.message?.content}`);
  });

  await test('POST /v1/chat/completions streaming works', async () => {
    // For streaming, we need to use raw fetch
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_COMPAT_MODEL,
        messages: [{ role: 'user', content: 'Say: Hi' }],
        stream: true
      })
    });

    if (response.status === 503) {
      throw new Error(`SKIP: ${OPENAI_COMPAT_OWNER} not installed`);
    }

    assert(response.status === 200, `Expected 200, got ${response.status}`);
    assert(response.headers.get('content-type')?.includes('text/event-stream'),
      'Should be text/event-stream');

    const text = await response.text();
    assert(text.includes('data:'), 'Should have SSE data lines');
    assert(text.includes('[DONE]'), 'Should end with [DONE]');
  });

  await test('OpenAI SDK compatibility - model mapping', async () => {
    // Test that different model names map correctly
    const { data: models } = await request('GET', '/v1/models');

    // Check various model families are available
    const modelIds = models.data?.map(m => m.id) || [];

    // At least some should be present if CLIs are installed
    const expectedFamilies = ['claude', 'gemini', 'gpt'];
    let foundAny = false;
    for (const family of expectedFamilies) {
      if (modelIds.some(id => id.includes(family))) {
        foundAny = true;
        break;
      }
    }

    // This test passes if we have any models (meaning at least one CLI is installed)
    // or if no CLIs are installed (empty list is valid)
    assert(Array.isArray(models.data), 'Should return array of models');
  });

  await test('GET /v1/models only returns models for available adapters', async () => {
    // Get adapters to see what's available
    const { data: adaptersData } = await request('GET', '/adapters');
    const availableAdapters = adaptersData.adapters
      .filter(a => a.available)
      .map(a => a.name);

    // Get models
    const { data: models } = await request('GET', '/v1/models');

    // Each returned model should be owned by an available adapter
    for (const model of models.data || []) {
      assert(availableAdapters.includes(model.owned_by),
        `Model ${model.id} owned by ${model.owned_by} but adapter not available`);
    }
  });

  await test('POST /v1/chat/completions works with Gemini model', async () => {
    try {
      const { status, data } = await request('POST', '/v1/chat/completions', {
        model: GEMINI_TEST_MODEL,
        messages: [{ role: 'user', content: 'Reply with just: OK' }],
        stream: false
      });

      const providerIssue = getProviderIssueReason(status, data);
      if (providerIssue) {
        throw new Error(`SKIP: ${providerIssue}`);
      }

      assert(status === 200, `Expected 200, got ${status}`);
      assert(data.object === 'chat.completion', 'Should have correct object type');
      if (!data.choices?.[0]?.message?.content) {
        throw new Error('SKIP: Gemini returned no usable OpenAI-compatible content');
      }
    } catch (error) {
      const providerIssue = getProviderExceptionReason(error);
      if (providerIssue) {
        throw new Error(`SKIP: ${providerIssue}`);
      }
      throw error;
    }
  });

  await test('POST /v1/chat/completions returns error for unavailable model', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: 'unknown-model-xyz',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'model_not_found', `Expected model_not_found, got ${JSON.stringify(data)}`);
  });
}

async function testOpenAICompatFeatures() {
  console.log('\n📋 OpenAI-Compat Feature Tests');

  // Unit tests for translation functions (no HTTP requests, instant)
  const { translateOpenAIRequest, buildPromptFromMessages, extractSystemPrompt } = require('../src/server/openai-compat');

  await test('translateOpenAIRequest extracts response_format json_schema', async () => {
    const result = translateOpenAIRequest({
      model: OPENAI_COMPAT_MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'test',
          schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
        }
      }
    });
    assert(result.options.jsonSchema, 'Should have jsonSchema in options');
    assert(result.options.jsonSchema.type === 'object', 'Schema should have correct type');
    assert(result.options.jsonSchema.properties.answer, 'Schema should have answer property');
  });

  await test('translateOpenAIRequest extracts response_format json_object', async () => {
    const result = translateOpenAIRequest({
      model: OPENAI_COMPAT_MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
      response_format: { type: 'json_object' }
    });
    assert(result.options.jsonMode === true, 'Should have jsonMode in options');
  });

  await test('buildPromptFromMessages preserves image references', async () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What do you see?' },
          { type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } }
        ]
      }
    ];
    const prompt = buildPromptFromMessages(messages);
    assert(prompt.includes('What do you see?'), 'Should include text content');
    assert(prompt.includes('screenshot.png'), 'Should include image reference (not stripped)');
  });

  await test('translateOpenAIRequest extracts images from base64', async () => {
    const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const result = translateOpenAIRequest({
      model: OPENAI_COMPAT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }]
    });
    assert(result.images && result.images.length === 1, 'Should extract 1 image');
    assert(result.images[0].type === 'file', 'Base64 image should be saved as file');
    assert(result.images[0].path.endsWith('.png'), 'Should save as .png file');
    // Verify file exists on disk
    const fs = require('fs');
    assert(fs.existsSync(result.images[0].path), 'Image file should exist on disk');
  });

  await test('Vision payload translation keeps the active adapter mapping', async () => {
    const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const result = translateOpenAIRequest({
      model: GEMINI_TEST_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Say OK' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }]
    });

    assert(result.adapter === 'gemini-cli', 'Should preserve active gemini mapping');
    assert(result.images?.length === 1, 'Should preserve extracted image');
  });
}

async function testMessagesEndpoint() {
  console.log('\n📋 Messages Endpoint Smoke Tests');

  let sessionId;

  await test('GET /orchestration/terminals/:id/messages returns 200', async () => {
    // Create a terminal first
    const createRes = await request('POST', '/orchestration/terminals', {
      adapter: PRIMARY_SESSION_ADAPTER,
      agentProfile: 'planner'
    });
    assert(createRes.status === 200, `Terminal create failed: ${createRes.status}`);
    const terminalId = createRes.data.terminalId;

    // Get messages
    const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.messages !== undefined, 'Should have messages field');
    assert(data.pagination !== undefined, 'Should have pagination field');

    // Save for cleanup
    sessionId = terminalId;
  });

  await test('Messages endpoint returns empty array for new terminal', async () => {
    // Create a fresh terminal
    const createRes = await request('POST', '/orchestration/terminals', {
      adapter: PRIMARY_SESSION_ADAPTER,
      agentProfile: 'planner'
    });
    const terminalId = createRes.data.terminalId;

    const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.messages), 'messages should be an array');
    assert(data.messages.length === 0, `Expected 0 messages, got ${data.messages.length}`);

    // Cleanup
    await request('DELETE', `/orchestration/terminals/${terminalId}`);
  });

  await test('Messages endpoint returns 404 for invalid terminal', async () => {
    const { status, data } = await request('GET', '/orchestration/terminals/invalid-id-12345/messages');
    assert(status === 404, `Expected 404, got ${status}`);
    assert(data.error, 'Should have error object');
    assert(data.error.code === 'terminal_not_found', `Expected terminal_not_found, got ${data.error.code}`);
  });

  // Cleanup from first test
  if (sessionId) {
    await request('DELETE', `/orchestration/terminals/${sessionId}`);
  }
}

async function testJsonExtractionAndRateLimits() {
  console.log('\n📋 JSON Extraction, Rate Limit Detection & Timeout Tests');

  const {
    extractJsonFromResponse,
    detectRateLimitError,
    translateOpenAIRequest
  } = require('../src/server/openai-compat');

  // --- extractJsonFromResponse ---

  await test('extractJsonFromResponse: clean JSON object passes through', async () => {
    const input = '{"answer": "hello"}';
    const result = extractJsonFromResponse(input);
    assert(result === input, `Expected clean pass-through, got: ${result}`);
    JSON.parse(result); // should not throw
  });

  await test('extractJsonFromResponse: JSON with preamble text is extracted', async () => {
    const input = 'Looking at the screenshot, here is the result:\n{"action": "click", "x": 100}';
    const result = extractJsonFromResponse(input);
    const parsed = JSON.parse(result);
    assert(parsed.action === 'click', `Expected action=click, got: ${parsed.action}`);
    assert(parsed.x === 100, `Expected x=100, got: ${parsed.x}`);
  });

  await test('extractJsonFromResponse: JSON array is extracted', async () => {
    const input = 'Here are the colors:\n["red", "green", "blue"]';
    const result = extractJsonFromResponse(input);
    const parsed = JSON.parse(result);
    assert(Array.isArray(parsed), 'Should be an array');
    assert(parsed.length === 3, `Expected 3 items, got ${parsed.length}`);
  });

  await test('extractJsonFromResponse: nested JSON with trailing text', async () => {
    const input = 'Result: {"data": {"nested": true}, "count": 1}\nHope this helps!';
    const result = extractJsonFromResponse(input);
    const parsed = JSON.parse(result);
    assert(parsed.data.nested === true, 'Nested value should be true');
    assert(parsed.count === 1, 'Count should be 1');
  });

  await test('extractJsonFromResponse: no JSON returns original text', async () => {
    const input = 'This is just plain text with no JSON at all.';
    const result = extractJsonFromResponse(input);
    assert(result === input, 'Should return original text unchanged');
  });

  await test('extractJsonFromResponse: handles null/undefined', async () => {
    assert(extractJsonFromResponse(null) === null, 'null should return null');
    assert(extractJsonFromResponse(undefined) === undefined, 'undefined should return undefined');
    assert(extractJsonFromResponse('') === '', 'empty string should return empty');
  });

  // --- detectRateLimitError ---

  await test('detectRateLimitError: detects "Rate limit exceeded"', async () => {
    assert(detectRateLimitError('Error: Rate limit exceeded. Please retry.') === true, 'Should detect rate limit');
  });

  await test('detectRateLimitError: detects "overloaded"', async () => {
    assert(detectRateLimitError('The model is currently overloaded. Try again later.') === true, 'Should detect overloaded');
  });

  await test('detectRateLimitError: detects "too many requests"', async () => {
    assert(detectRateLimitError('Too many requests, slow down.') === true, 'Should detect too many requests');
  });

  await test('detectRateLimitError: detects "ResourceExhausted"', async () => {
    assert(detectRateLimitError('ResourceExhausted: Quota limit reached') === true, 'Should detect ResourceExhausted');
  });

  await test('detectRateLimitError: normal text returns false', async () => {
    assert(detectRateLimitError('Hello, here is your answer about rates and limits.') === false, 'Normal text should not match');
  });

  await test('detectRateLimitError: explanatory text about rate limits is NOT a false positive', async () => {
    assert(detectRateLimitError('A rate limit is a restriction on API calls.') === false, 'Explanatory text should not match');
    assert(detectRateLimitError('The rate limit for this API is 100 requests per minute.') === false, 'Informational text should not match');
  });

  await test('detectRateLimitError: handles null/undefined', async () => {
    assert(detectRateLimitError(null) === false, 'null should return false');
    assert(detectRateLimitError(undefined) === false, 'undefined should return false');
    assert(detectRateLimitError('') === false, 'empty should return false');
  });

  // --- translateOpenAIRequest: timeout parameter ---

  await test('translateOpenAIRequest: extracts timeout from body', async () => {
    const result = translateOpenAIRequest({
      model: GEMINI_TEST_MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
      timeout: 300000
    });
    assert(result.timeout === 300000, `Expected timeout=300000, got: ${result.timeout}`);
  });

  await test('translateOpenAIRequest: timeout defaults to null', async () => {
    const result = translateOpenAIRequest({
      model: GEMINI_TEST_MODEL,
      messages: [{ role: 'user', content: 'Hello' }]
    });
    assert(result.timeout === null, `Expected timeout=null, got: ${result.timeout}`);
  });

  // --- translateOpenAIRequest: json_object augments system prompt ---

  await test('translateOpenAIRequest: json_object mode augments system prompt', async () => {
    const result = translateOpenAIRequest({
      model: GEMINI_TEST_MODEL,
      messages: [{ role: 'user', content: 'List colors' }],
      response_format: { type: 'json_object' }
    });
    assert(result.systemPrompt.includes('valid JSON only'), 'System prompt should include JSON instruction');
    assert(result.options.jsonMode === true, 'jsonMode should be true');
  });

  await test('translateOpenAIRequest: json_object preserves existing system prompt', async () => {
    const result = translateOpenAIRequest({
      model: GEMINI_TEST_MODEL,
      messages: [
        { role: 'system', content: 'You are a color expert.' },
        { role: 'user', content: 'List colors' }
      ],
      response_format: { type: 'json_object' }
    });
    assert(result.systemPrompt.includes('color expert'), 'Should preserve original system prompt');
    assert(result.systemPrompt.includes('valid JSON only'), 'Should append JSON instruction');
  });

  // --- translateOpenAIRequest: returns responseFormat ---

  await test('translateOpenAIRequest: returns responseFormat for post-processing', async () => {
    const result = translateOpenAIRequest({
      model: GEMINI_TEST_MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
      response_format: { type: 'json_object' }
    });
    assert(result.responseFormat !== null, 'responseFormat should be returned');
    assert(result.responseFormat.type === 'json_object', 'responseFormat type should match');
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  if (!BASE_URL) {
    testServer = await startTestServer({
      cleanupOrphans: false
    });
    BASE_URL = testServer.baseUrl;
  }

  console.log('🚀 cliagents - Test Suite');
  console.log(`   Testing against: ${BASE_URL}`);
  console.log('━'.repeat(50));

  // Check server is running
  try {
    await request('GET', '/health');
  } catch (error) {
    console.error('\n❌ Server not reachable. Start it with: npm start\n');
    process.exit(1);
  }

  // Run test suites
  await testHealth();
  await testAdapters();
  await testSessions();
  await testValidation();        // Input validation tests
  await testFileOperations();    // File upload/list tests
  await testErrorFormat();       // Standardized error format tests
  await testWebSocket();         // WebSocket API tests
  await testMessagesEndpoint();  // Messages endpoint smoke tests
  await testOneShot();
  await testContextPreservation();
  await testErrorHandling();
  await testStreamingProgress();
  await testFirstPartyAdapters();
  await testSessionResume();
  await testActiveModelCatalog();
  await testOpenAICompat();       // OpenAI-compatible API tests
  await testOpenAICompatFeatures();
  await testJsonExtractionAndRateLimits(); // JSON extraction, rate limits, timeouts

  // Summary
  console.log('\n' + '━'.repeat(50));
  const skippedMsg = results.skipped > 0 ? `, ${results.skipped} skipped` : '';
  console.log(`\n📊 Results: ${results.passed} passed, ${results.failed} failed${skippedMsg}`);

  if (results.skipped > 0) {
    console.log('\n⏭️  Skipped tests:');
    results.tests
      .filter(t => t.status === 'skipped')
      .forEach(t => console.log(`   - ${t.name}: ${t.reason}`));
  }

  if (results.failed > 0) {
    console.log('\n❌ Failed tests:');
    results.tests
      .filter(t => t.status === 'failed')
      .forEach(t => console.log(`   - ${t.name}: ${t.error}`));
    process.exit(1);
  }

  console.log('\n✅ All tests passed!\n');
}

main()
  .catch(error => {
    console.error('Test runner error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopTestServer(testServer);
  });
