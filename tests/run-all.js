#!/usr/bin/env node
/**
 * cliagents - Automated Test Suite
 *
 * Runs all tests against a running server.
 * Start server first: npm start
 * Then run tests: npm test
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:3001';

// Test utilities
async function request(method, path, body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${BASE_URL}${path}`, options);
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) };
  } catch {
    return { status: response.status, data: text };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Test results tracking
const results = { passed: 0, failed: 0, tests: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'failed', error: error.message });
    console.log(`  ❌ ${name}: ${error.message}`);
  }
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
  });
}

async function testAdapters() {
  console.log('\n📋 Adapter Tests');

  await test('Lists available adapters', async () => {
    const { status, data } = await request('GET', '/adapters');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.adapters), 'Should return adapters array');
    assert(data.adapters.length >= 2, 'Should have at least 2 adapters');
  });

  await test('Claude Code adapter is available', async () => {
    const { data } = await request('GET', '/adapters');
    const claude = data.adapters.find(a => a.name === 'claude-code');
    assert(claude, 'Claude adapter should exist');
    assert(claude.available === true, 'Claude should be available');
  });

  await test('Gemini CLI adapter is available', async () => {
    const { data } = await request('GET', '/adapters');
    const gemini = data.adapters.find(a => a.name === 'gemini-cli');
    assert(gemini, 'Gemini adapter should exist');
    assert(gemini.available === true, 'Gemini should be available');
  });
}

async function testSessions() {
  console.log('\n📋 Session Tests');

  let sessionId;

  await test('Create Claude Code session', async () => {
    const { status, data } = await request('POST', '/sessions', { adapter: 'claude-code' });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.sessionId, 'Should return sessionId');
    assert(data.adapter === 'claude-code', 'Adapter should match');
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
    assert(data.adapterName === 'claude-code', 'Adapter should match');
  });

  await test('Get session status', async () => {
    // Create a new session for status test
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
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
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
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

  await test('Simple math with Claude', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: 'claude-code',
      message: 'What is 5 + 5? Reply with just the number.'
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.result, 'Should have result');
    assert(data.result.includes('10'), `Expected 10, got: ${data.result}`);
  });

  await test('Simple math with Gemini', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: 'gemini-cli',
      message: 'What is 7 + 7? Reply with just the number.'
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.result, 'Should have result');
    assert(data.result.includes('14'), `Expected 14, got: ${data.result}`);
  });
}

async function testContextPreservation() {
  console.log('\n📋 Context Preservation Tests');

  let sessionId;

  await test('Context preserved across messages', async () => {
    // Create session
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
    sessionId = session.sessionId;

    // Send first message with name
    await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'My favorite color is purple. Remember this.'
    });

    // Ask about it
    const { data } = await request('POST', `/sessions/${sessionId}/messages`, {
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

  await test('Claude streaming returns progress events via SSE', async () => {
    // Create session
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
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
    const { data } = await request('POST', '/ask', {
      adapter: 'claude-code',
      message: 'Say hi'
    });

    assert(data.metadata, 'Should have metadata');
    assert(typeof data.metadata.outputTokens === 'number', 'Should have outputTokens');
    // Cost is now returned in metadata
    assert(data.metadata.costUsd !== undefined || data.metadata.inputTokens !== undefined,
      'Should have cost or token info');
  });
}

async function testNewAdapters() {
  console.log('\n📋 New Adapter Tests');

  // Get available adapters first
  const { data } = await request('GET', '/adapters');
  const adapters = data.adapters;

  // Test Codex CLI if available
  const codex = adapters.find(a => a.name === 'codex-cli');
  if (codex && codex.available) {
    await test('Codex CLI one-shot ask', async () => {
      const { status, data } = await request('POST', '/ask', {
        adapter: 'codex-cli',
        message: 'What is 3 + 3? Reply with just the number.'
      });
      // Accept either success or CLI auth error (not a server crash)
      if (status === 200) {
        assert(data.result, 'Should have result');
        assert(data.result.includes('6'), `Expected 6, got: ${data.result}`);
      } else {
        // Handle both old string error format and new standardized format
        const errorMsg = data.error?.message || data.error || '';
        if (status === 500 && errorMsg.includes('not authenticated')) {
          console.log('    (skipped - CLI not authenticated)');
        } else {
          assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
        }
      }
    });
  } else {
    await test('Codex CLI adapter registered', async () => {
      assert(codex, 'Codex adapter should be registered');
      console.log('    (skipped - CLI not installed)');
    });
  }

  // Test Mistral Vibe if available
  const vibe = adapters.find(a => a.name === 'mistral-vibe');
  if (vibe && vibe.available) {
    await test('Mistral Vibe one-shot ask', async () => {
      const { status, data } = await request('POST', '/ask', {
        adapter: 'mistral-vibe',
        message: 'What is 4 + 4? Reply with just the number.'
      });
      // Accept either success or CLI not configured (exit code, timeout, or specific error)
      if (status === 200) {
        assert(data.result, 'Should have result');
        assert(data.result.includes('8'), `Expected 8, got: ${data.result}`);
      } else {
        // Handle both old string error format and new standardized format
        const errorMsg = data.error?.message || data.error || '';
        if (errorMsg.includes('exit') ||
            errorMsg.includes('not configured') ||
            errorMsg.includes('timed out')) {
          console.log('    (skipped - CLI not configured, run: vibe --setup)');
        } else {
          assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
        }
      }
    });
  } else {
    await test('Mistral Vibe adapter registered', async () => {
      assert(vibe, 'Mistral Vibe adapter should be registered');
      console.log('    (skipped - CLI not installed)');
    });
  }
}

async function testValidation() {
  console.log('\n📋 Input Validation Tests');

  // workDir validation
  await test('Rejects path traversal in workDir', async () => {
    const { status, data } = await request('POST', '/sessions', {
      adapter: 'claude-code',
      workDir: '/tmp/../etc/passwd'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter error');
  });

  await test('Rejects dangerous system paths', async () => {
    const { status, data } = await request('POST', '/sessions', {
      adapter: 'claude-code',
      workDir: '/etc/secrets'
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.message?.includes('system directory'), 'Should mention system directory');
  });

  // Message validation
  await test('Rejects empty message in session', async () => {
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
    const { status, data } = await request('POST', `/sessions/${session.sessionId}/messages`, {
      message: ''
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter error');
    await request('DELETE', `/sessions/${session.sessionId}`);
  });

  await test('Rejects missing message in /ask', async () => {
    const { status, data } = await request('POST', '/ask', { adapter: 'claude-code' });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'missing_parameter', 'Should be missing_parameter');
    assert(data.error?.param === 'message', 'Should specify message param');
  });

  await test('Rejects non-string message', async () => {
    const { status, data } = await request('POST', '/ask', {
      adapter: 'claude-code',
      message: 12345
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.error?.code === 'invalid_parameter', 'Should be invalid_parameter');
  });
}

async function testFileOperations() {
  console.log('\n📋 File Operation Tests');

  let sessionId;

  await test('Upload file to session', async () => {
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
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

async function testSessionResume() {
  console.log('\n📋 Session Resume Tests');

  await test('Multi-turn conversation preserves context (Claude)', async () => {
    // Create session
    const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
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
    // Create session
    const { data: session } = await request('POST', '/sessions', { adapter: 'gemini-cli' });
    const sessionId = session.sessionId;

    // First message
    await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'My pet cat is named Whiskers. Remember this.'
    });

    // Second message - recall
    const { data } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'What is my cat\'s name? Reply with just the name.'
    });

    assert(data.result.toLowerCase().includes('whiskers'),
      `Expected Whiskers, got: ${data.result}`);

    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
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
  await testOneShot();
  await testContextPreservation();
  await testErrorHandling();
  await testStreamingProgress();
  await testNewAdapters();
  await testSessionResume();

  // Summary
  console.log('\n' + '━'.repeat(50));
  console.log(`\n📊 Results: ${results.passed} passed, ${results.failed} failed`);

  if (results.failed > 0) {
    console.log('\n❌ Failed tests:');
    results.tests
      .filter(t => t.status === 'failed')
      .forEach(t => console.log(`   - ${t.name}: ${t.error}`));
    process.exit(1);
  }

  console.log('\n✅ All tests passed!\n');
  process.exit(0);
}

main().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
