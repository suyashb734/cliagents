/**
 * MCP Server Tests
 *
 * Tests the MCP server endpoints that Claude Code uses to delegate tasks.
 * These tests call the same HTTP endpoints the MCP server calls.
 */

const assert = require('assert');
const http = require('http');

const BASE_URL = process.env.CLIAGENTS_TEST_URL || 'http://localhost:4001';

// HTTP helper
async function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Check server availability
async function checkServer() {
  try {
    const res = await request('GET', '/health');
    return res.status === 200;
  } catch {
    return false;
  }
}

async function attachRootSession(label) {
  const externalSessionRef = `${label}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const res = await request('POST', '/orchestration/root-sessions/attach', {
    originClient: 'test',
    externalSessionRef,
    clientName: 'test-mcp-server',
    sessionMetadata: {
      clientName: 'test-mcp-server',
      externalSessionRef,
      purpose: label
    }
  });

  assert.strictEqual(res.status, 200, `Expected root attach 200, got ${res.status}`);
  assert(res.data.rootSessionId, 'Root attach should return rootSessionId');

  return {
    rootSessionId: res.data.rootSessionId,
    parentSessionId: res.data.rootSessionId,
    sessionKind: 'subagent',
    originClient: 'test',
    externalSessionRef,
    lineageDepth: 1,
    sessionMetadata: {
      clientName: 'test-mcp-server',
      externalSessionRef,
      purpose: label
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
// Test Functions
// ═══════════════════════════════════════════════════════════════════

async function testListProfiles() {
  console.log('\n📝 Test: List agent profiles (MCP list_agents)');

  const res = await request('GET', '/orchestration/profiles');

  assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  assert(res.data.profiles, 'Should have profiles property');
  assert(typeof res.data.profiles === 'object', 'Profiles should be object');
  assert(res.data.count >= 10, `Should have at least 10 profiles, got ${res.data.count}`);

  // Check profile structure (profiles is an object with profile names as keys)
  const profile = res.data.profiles.researcher;
  assert(profile, 'Should have researcher profile');
  assert.strictEqual(profile.adapter, 'gemini-cli', 'Researcher should use gemini-cli');
  assert(profile.description, 'Profile should have description');
  assert(profile.systemPrompt, 'Profile should have systemPrompt');

  console.log(`  ✅ Found ${res.data.count} profiles`);
}

async function testRouteValidation() {
  console.log('\n📝 Test: Route validation (MCP delegate_task)');

  // Missing message
  let res = await request('POST', '/orchestration/route', {});
  assert(res.status >= 400, 'Missing message should return error');

  // Missing message with forceProfile
  res = await request('POST', '/orchestration/route', { forceProfile: 'researcher' });
  assert(res.status >= 400, 'Missing message should return error');

  // Invalid profile (use forceProfile parameter)
  res = await request('POST', '/orchestration/route', {
    forceProfile: 'nonexistent-profile',
    message: 'test'
  });
  assert(res.status >= 400 || res.data.error, 'Invalid profile should return error');

  console.log('  ✅ Validation errors returned correctly');
}

async function testRouteExecution() {
  console.log('\n📝 Test: Route execution (task routing)');
  const rootContext = await attachRootSession('route-execution');

  // The /route endpoint routes a task to an appropriate profile and creates a terminal
  // It does NOT execute and wait for output - that's done via /handoff
  const res = await request('POST', '/orchestration/route', {
    ...rootContext,
    message: 'What is 5+3? Answer with just the number.'
    // Not specifying profile - let the router choose
  });

  assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  assert(res.data.terminalId, 'Should return terminalId');
  assert(res.data.profile, 'Should return selected profile');
  assert(res.data.adapter, 'Should return adapter');
  assert(res.data.taskType, 'Should return taskType');
  assert(typeof res.data.confidence === 'number', 'Should return confidence score');

  console.log(`  ✅ Task routed to ${res.data.profile} (${res.data.adapter})`);
}

async function testWorkflowValidation() {
  console.log('\n📝 Test: Workflow validation (MCP run_workflow)');

  // Invalid workflow
  const res = await request('POST', '/orchestration/workflows/nonexistent', {
    message: 'test'
  });
  assert(res.status >= 400, 'Invalid workflow should return error');

  console.log('  ✅ Invalid workflow rejected');
}

async function testGetTerminalOutput() {
  console.log('\n📝 Test: Get terminal output (MCP get_terminal_output)');

  // Invalid terminal ID
  const res = await request('GET', '/orchestration/terminals/invalid123/output');
  assert(res.status >= 400, 'Invalid terminal should return error');

  console.log('  ✅ Invalid terminal ID rejected');
}

async function testTerminalStatus() {
  console.log('\n📝 Test: Get terminal status');

  // Invalid terminal ID
  const res = await request('GET', '/orchestration/terminals/invalid123');
  assert(res.status >= 400, 'Invalid terminal should return error');

  console.log('  ✅ Invalid terminal status rejected');
}

async function testHandoffEndpoint() {
  console.log('\n📝 Test: Handoff endpoint (used by MCP)');
  console.log('  ⏳ This test takes ~30s (delegates to Gemini)...');

  const res = await request('POST', '/orchestration/handoff', {
    agentProfile: 'researcher',
    message: 'What is the capital of France? Answer in one word.',
    timeout: 60
  });

  assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  assert(res.data.success, 'Should return success');
  assert(res.data.output, 'Should return output');
  assert(res.data.output.toLowerCase().includes('paris'),
    `Output should contain "Paris", got: ${res.data.output.slice(0, 100)}`);

  console.log('  ✅ Handoff returned correct answer');
}

// ═══════════════════════════════════════════════════════════════════
// Test Runner
// ═══════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('       MCP Server Tests');
  console.log('═══════════════════════════════════════════');

  // Check server
  const serverRunning = await checkServer();
  if (!serverRunning) {
    console.log('\n❌ Server not running at', BASE_URL);
    console.log('   Start with: npm start');
    process.exit(1);
  }
  console.log('✅ Server is running');

  let passed = 0, failed = 0;

  // Quick tests first
  const quickTests = [
    testListProfiles,
    testRouteValidation,
    testWorkflowValidation,
    testGetTerminalOutput,
    testTerminalStatus
  ];

  // Slower execution tests
  const slowTests = [
    testRouteExecution,
    testHandoffEndpoint
  ];

  // Run quick tests
  for (const test of quickTests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.log(`  ❌ FAILED: ${error.message}`);
      failed++;
    }
  }

  // Run slow tests
  console.log('\n--- Execution Tests (slower) ---');
  for (const test of slowTests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.log(`  ❌ FAILED: ${error.message}`);
      failed++;
    }
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
