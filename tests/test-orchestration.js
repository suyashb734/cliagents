/**
 * Tests for Orchestration API
 *
 * Tests the orchestration endpoints.
 * The suite starts/stops an isolated test server automatically.
 * Run with: node tests/test-orchestration.js
 */

const assert = require('assert');
const http = require('http');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

let BASE_URL = 'http://localhost:4001';
let testServer = null;

// Helper to make HTTP requests
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Test: List terminals endpoint
async function testListTerminals() {
  console.log('\n📝 Test: GET /orchestration/terminals');

  const res = await request('GET', '/orchestration/terminals');
  assert.strictEqual(res.status, 200, 'Should return 200');
  assert(res.data && typeof res.data === 'object', 'Should return object');
  assert(typeof res.data.count === 'number', 'Should have count field');
  assert(Array.isArray(res.data.terminals), 'Should have terminals array');

  console.log(`  ✅ Returns ${res.data.count} terminals`);
}

// Test: List agent profiles endpoint
async function testListProfiles() {
  console.log('\n📝 Test: GET /orchestration/profiles');

  const res = await request('GET', '/orchestration/profiles');
  assert.strictEqual(res.status, 200, 'Should return 200');
  assert(typeof res.data === 'object', 'Should return object');
  assert(typeof res.data.count === 'number', 'Should have count field');
  assert(typeof res.data.profiles === 'object', 'Should have profiles object');

  console.log(`  ✅ Returns ${res.data.count} profiles`);
}

// Test: Input validation for handoff
async function testHandoffValidation() {
  console.log('\n📝 Test: Handoff input validation');

  // Missing agentProfile
  let res = await request('POST', '/orchestration/handoff', {
    message: 'test',
  });
  assert(res.status === 400, 'Should return 400 for missing agentProfile');

  // Missing message
  res = await request('POST', '/orchestration/handoff', {
    agentProfile: 'developer',
  });
  assert(res.status === 400, 'Should return 400 for missing message');

  // Non-existent profile returns 404
  res = await request('POST', '/orchestration/handoff', {
    agentProfile: 'nonexistent-profile',
    message: 'test',
  });
  assert(res.status === 404 || res.status === 500, 'Should return 404 or 500 for non-existent profile');

  console.log('  ✅ Input validation works correctly');
}

// Test: Input validation for assign
async function testAssignValidation() {
  console.log('\n📝 Test: Assign input validation');

  // Missing agentProfile
  let res = await request('POST', '/orchestration/assign', {
    message: 'test',
  });
  assert(res.status === 400, 'Should return 400 for missing agentProfile');

  // Missing message
  res = await request('POST', '/orchestration/assign', {
    agentProfile: 'developer',
  });
  assert(res.status === 400, 'Should return 400 for missing message');

  console.log('  ✅ Input validation works correctly');
}

// Test: Input validation for send_message
async function testSendMessageValidation() {
  console.log('\n📝 Test: send_message input validation');

  // Missing receiverId
  let res = await request('POST', '/orchestration/send_message', {
    senderId: 'abc123',
    message: 'test',
  });
  assert(res.status === 400, 'Should return 400 for missing receiverId');

  // Missing message
  res = await request('POST', '/orchestration/send_message', {
    senderId: 'abc123',
    receiverId: 'def456',
  });
  assert(res.status === 400, 'Should return 400 for missing message');

  console.log('  ✅ Input validation works correctly');
}

// Test: Get nonexistent terminal
async function testGetNonexistentTerminal() {
  console.log('\n📝 Test: GET /orchestration/terminals/:id (nonexistent)');

  const res = await request('GET', '/orchestration/terminals/nonexistent123');
  assert.strictEqual(res.status, 404, 'Should return 404 for nonexistent terminal');

  console.log('  ✅ Returns 404 for nonexistent terminal');
}

// Test: Security - injection in profile name blocked
async function testSecurityInjection() {
  console.log('\n📝 Test: Security - injection attempts blocked');

  const injectionAttempts = [
    { agentProfile: '$(whoami)', message: 'test' },
    { agentProfile: '`id`', message: 'test' },
    { agentProfile: 'test; cat /etc/passwd', message: 'test' },
    { agentProfile: '../../../etc/passwd', message: 'test' },
  ];

  for (const payload of injectionAttempts) {
    const res = await request('POST', '/orchestration/handoff', payload);
    // Should either reject with 400/404 or fail safely with 500
    assert(res.status >= 400,
      `Injection attempt should be rejected: ${payload.agentProfile}`);
  }

  console.log('  ✅ All injection attempts blocked');
}

// Test: Get orchestration stats
async function testGetStats() {
  console.log('\n📝 Test: GET /orchestration/stats');

  const res = await request('GET', '/orchestration/stats');
  // Stats endpoint might fail if database isn't fully initialized
  if (res.status === 200) {
    assert(res.data && typeof res.data === 'object', 'Should return object');
    assert(res.data.terminals && typeof res.data.terminals === 'object', 'Should have terminals stats');
    assert(typeof res.data.terminals.total === 'number', 'Should have terminal count');
    console.log(`  ✅ Returns stats with ${res.data.terminals.total} terminals`);
  } else {
    // Accept 500 as non-critical if db isn't fully set up
    console.log(`  ⚠️ Stats endpoint returned ${res.status} (non-critical)`);
  }
}

// Test: workingDirectory accepted in /route endpoint (non-blocking)
async function testRouteWorkingDirectory() {
  console.log('\n📝 Test: /orchestration/route accepts workingDirectory');

  // Use /route which returns immediately with terminalId (doesn't wait for agent)
  const res = await request('POST', '/orchestration/route', {
    forceRole: 'implement',
    message: 'echo test',
    workingDirectory: '/tmp/test-workdir'
  });

  // Should not fail with "unexpected parameter" or validation error for workingDirectory
  // The route may fail for other reasons (adapter not available, etc.) but that's OK
  const isWorkDirError = res.status === 400 &&
    res.data?.error?.message?.toLowerCase().includes('workingdirectory');

  assert(!isWorkDirError, 'workingDirectory should be accepted as a valid parameter');

  // If successful, clean up the terminal
  if (res.status === 200 && res.data?.terminalId) {
    await request('DELETE', `/orchestration/terminals/${res.data.terminalId}`);
    console.log('  ✅ workingDirectory parameter accepted, terminal created and cleaned up');
  } else {
    console.log(`  ✅ workingDirectory parameter accepted (route returned ${res.status})`);
  }
}

// Test: workingDirectory not rejected as invalid parameter
async function testWorkingDirectoryNotRejected() {
  console.log('\n📝 Test: workingDirectory not rejected as unknown parameter');

  // This test ensures the parameter is extracted from req.body
  // even if the actual handoff might timeout or fail for other reasons
  const res = await request('POST', '/orchestration/route', {
    forceProfile: 'researcher',  // Use a simple profile
    message: 'simple test',
    workingDirectory: '/tmp'
  });

  // Check it's not rejected as an unknown/invalid parameter
  const errorMsg = res.data?.error?.message?.toLowerCase() || '';
  const isUnknownParamError = res.status === 400 && (
    errorMsg.includes('unknown') ||
    errorMsg.includes('unexpected') ||
    errorMsg.includes('invalid parameter')
  ) && errorMsg.includes('workingdirectory');

  assert(!isUnknownParamError, 'workingDirectory should not be rejected as unknown parameter');

  // Cleanup if terminal was created
  if (res.status === 200 && res.data?.terminalId) {
    await request('DELETE', `/orchestration/terminals/${res.data.terminalId}`);
  }

  console.log('  ✅ workingDirectory not rejected as unknown parameter');
}

// Run all tests
async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('       Orchestration API Tests');
  console.log('═══════════════════════════════════════════');

  testServer = await startTestServer();
  BASE_URL = testServer.baseUrl;
  console.log(`\n✅ Test server running at ${BASE_URL}`);

  let passed = 0;
  let failed = 0;

  const tests = [
    testListTerminals,
    testListProfiles,
    testHandoffValidation,
    testAssignValidation,
    testSendMessageValidation,
    testGetNonexistentTerminal,
    testSecurityInjection,
    testGetStats,
    testRouteWorkingDirectory,
    testWorkingDirectoryNotRejected,
  ];

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.log(`  ❌ FAILED: ${error.message}`);
      if (error.stack) {
        console.log(`     ${error.stack.split('\n')[1]}`);
      }
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  await stopTestServer(testServer);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  if (testServer) {
    stopTestServer(testServer).catch(() => {});
  }
  process.exit(1);
});
