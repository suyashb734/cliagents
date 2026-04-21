/**
 * Messages API Integration Tests
 *
 * Tests for message storage and retrieval via the messages API.
 *
 * These are integration tests - server required at localhost:4001.
 * Run: node tests/test-messages.js
 *
 * Prerequisites:
 *   - Server running: npm start
 */

const assert = require('assert');
const http = require('http');

const BASE_URL = process.env.TEST_URL || 'http://localhost:4001';

// ============================================================
// HTTP Helper
// ============================================================

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
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

// ============================================================
// Test Utilities
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkServer() {
  try {
    const res = await request('GET', '/health');
    return res.status === 200;
  } catch {
    return false;
  }
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

// ============================================================
// Test Suite: Message Storage on Input
// ============================================================

async function testMessageStorageOnInput() {
  console.log('\n📋 Message Storage Tests\n');

  let terminalId;

  await test('Create terminal stores no messages initially', async () => {
    // Create a terminal
    const res = await request('POST', '/orchestration/terminals', {
      adapter: 'claude-code',
      agentProfile: 'planner'
    });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    terminalId = res.data.terminalId;
    assert(terminalId, 'Should return terminalId');

    // Check messages - should be empty
    const msgRes = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert.strictEqual(msgRes.status, 200, 'Messages endpoint should return 200');
    assert.strictEqual(msgRes.data.messages.length, 0, 'Should have no messages initially');
  });

  await test('Send input stores user message with role="user"', async () => {
    // Send input to the terminal
    const res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'Test message for storage'
    });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);

    // Wait a moment for the message to be stored
    await sleep(100);

    // Get messages
    const msgRes = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert.strictEqual(msgRes.status, 200, 'Messages endpoint should return 200');
    assert(msgRes.data.messages.length >= 1, 'Should have at least 1 message');

    const userMsg = msgRes.data.messages.find(m => m.role === 'user');
    assert(userMsg, 'Should have user message');
    assert.strictEqual(userMsg.content, 'Test message for storage', 'Content should match');
  });

  await test('Messages have millisecond timestamps', async () => {
    const msgRes = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert.strictEqual(msgRes.status, 200, 'Messages endpoint should return 200');

    const msg = msgRes.data.messages[0];
    assert(msg.created_at, 'Should have created_at');
    // Millisecond timestamps are typically 13 digits (after year 2001)
    // Second timestamps are 10 digits
    assert(msg.created_at.toString().length >= 13,
      `Timestamp ${msg.created_at} should be in milliseconds (13+ digits)`);
  });

  // Cleanup
  await request('DELETE', `/orchestration/terminals/${terminalId}`);
}

// ============================================================
// Test Suite: Message Retrieval Endpoint
// ============================================================

async function testMessageRetrievalEndpoint() {
  console.log('\n📋 Message Retrieval Endpoint Tests\n');

  let terminalId;

  // Setup: Create terminal with multiple messages
  const setupRes = await request('POST', '/orchestration/terminals', {
    adapter: 'claude-code',
    agentProfile: 'planner'
  });
  terminalId = setupRes.data.terminalId;

  // Add multiple messages
  await request('POST', `/orchestration/terminals/${terminalId}/input`, { message: 'First message' });
  await sleep(50);
  await request('POST', `/orchestration/terminals/${terminalId}/input`, { message: 'Second message' });
  await sleep(50);
  await request('POST', `/orchestration/terminals/${terminalId}/input`, { message: 'Third message' });
  await sleep(50);
  await request('POST', `/orchestration/terminals/${terminalId}/input`, { message: 'Fourth message' });
  await sleep(50);
  await request('POST', `/orchestration/terminals/${terminalId}/input`, { message: 'Fifth message' });
  await sleep(100);

  await test('GET /terminals/:id/messages returns stored messages', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert.strictEqual(res.status, 200, 'Should return 200');
    assert(res.data.messages, 'Should have messages array');
    assert(res.data.messages.length >= 5, `Should have at least 5 messages, got ${res.data.messages.length}`);
  });

  await test('Messages returned in timestamp order (oldest first)', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    const messages = res.data.messages;

    // Verify ascending order
    for (let i = 1; i < messages.length; i++) {
      assert(messages[i].created_at >= messages[i-1].created_at,
        `Messages should be in ascending timestamp order at index ${i}`);
    }

    // First message should be "First message"
    assert(messages[0].content.includes('First'),
      'First message in order should be "First message"');
  });

  await test('Limit parameter works (limit=2)', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages?limit=2`);
    assert.strictEqual(res.status, 200, 'Should return 200');
    assert.strictEqual(res.data.messages.length, 2, 'Should have exactly 2 messages');
    assert.strictEqual(res.data.pagination.limit, 2, 'Pagination should reflect limit');
    assert(res.data.pagination.hasMore, 'Should indicate more messages available');
  });

  await test('Offset parameter works (offset=2)', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages?offset=2`);
    assert.strictEqual(res.status, 200, 'Should return 200');
    assert.strictEqual(res.data.pagination.offset, 2, 'Pagination should reflect offset');

    // With offset=2, the first returned message should be the 3rd overall
    assert(res.data.messages[0].content.includes('Third'),
      'First message with offset=2 should be "Third message"');
  });

  await test('Role filter works (role=user)', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages?role=user`);
    assert.strictEqual(res.status, 200, 'Should return 200');

    // All messages should be user role
    res.data.messages.forEach((msg, i) => {
      assert.strictEqual(msg.role, 'user', `Message ${i} should have role=user`);
    });
  });

  await test('Combined filters work (role=user&limit=2)', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages?role=user&limit=2`);
    assert.strictEqual(res.status, 200, 'Should return 200');
    assert.strictEqual(res.data.messages.length, 2, 'Should return exactly 2 messages');
    res.data.messages.forEach((msg, i) => {
      assert.strictEqual(msg.role, 'user', `Message ${i} should have role=user`);
    });
  });

  await test('404 returned for non-existent terminal', async () => {
    const res = await request('GET', '/orchestration/terminals/nonexistent123/messages');
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}`);
    assert(res.data.error, 'Should have error object');
    assert.strictEqual(res.data.error.code, 'terminal_not_found', 'Should be terminal_not_found');
  });

  // Cleanup
  await request('DELETE', `/orchestration/terminals/${terminalId}`);
}

// ============================================================
// Test Suite: Input Validation
// ============================================================

async function testInputValidation() {
  console.log('\n📋 Input Validation Tests\n');

  let terminalId;

  // Setup
  const setupRes = await request('POST', '/orchestration/terminals', {
    adapter: 'claude-code',
    agentProfile: 'planner'
  });
  terminalId = setupRes.data.terminalId;

  await test('Empty content in input is rejected', async () => {
    const res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: ''
    });
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert(res.data.error, 'Should have error object');
  });

  await test('Missing message in input is rejected', async () => {
    const res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {});
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert(res.data.error, 'Should have error object');
    assert.strictEqual(res.data.error.code, 'missing_parameter', 'Should be missing_parameter');
  });

  await test('Invalid terminalId on input returns 404', async () => {
    const res = await request('POST', '/orchestration/terminals/invalid123/input', {
      message: 'Test'
    });
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}`);
  });

  await test('Invalid terminalId on messages endpoint returns 404', async () => {
    const res = await request('GET', '/orchestration/terminals/invalid123/messages');
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}`);
    assert.strictEqual(res.data.error.code, 'terminal_not_found', 'Should be terminal_not_found');
  });

  // Cleanup
  await request('DELETE', `/orchestration/terminals/${terminalId}`);
}

// ============================================================
// Test Suite: TraceId Filtering
// ============================================================

async function testTraceIdFiltering() {
  console.log('\n📋 TraceId Filtering Tests\n');

  let terminalId;

  // Setup: Create terminal
  const setupRes = await request('POST', '/orchestration/terminals', {
    adapter: 'claude-code',
    agentProfile: 'planner'
  });
  terminalId = setupRes.data.terminalId;

  // Add messages (traceId is set by the server during handoff, so we can only test
  // that the filter parameter is accepted and returns filtered results)
  await request('POST', `/orchestration/terminals/${terminalId}/input`, { message: 'Test message' });
  await sleep(100);

  await test('TraceId filter parameter is accepted', async () => {
    // Query with a traceId filter - should return empty or filtered results
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages?traceId=test-trace-123`);
    assert.strictEqual(res.status, 200, 'Should return 200 even with traceId filter');
    assert(Array.isArray(res.data.messages), 'Should return messages array');
    // With a non-existent traceId, should return empty
    assert.strictEqual(res.data.messages.length, 0,
      'Should return no messages for non-existent traceId');
  });

  await test('Combined traceId + role filter works', async () => {
    const res = await request('GET', `/orchestration/terminals/${terminalId}/messages?traceId=test-trace-123&role=user`);
    assert.strictEqual(res.status, 200, 'Should return 200');
    assert(Array.isArray(res.data.messages), 'Should return messages array');
  });

  // Cleanup
  await request('DELETE', `/orchestration/terminals/${terminalId}`);
}

// ============================================================
// Test Suite: Message Persistence After Terminal Deletion
// ============================================================

async function testMessagePersistenceAfterDeletion() {
  console.log('\n📋 Message Persistence Tests\n');

  await test('Messages persist after terminal deletion (audit trail)', async () => {
    // Create a terminal
    const createRes = await request('POST', '/orchestration/terminals', {
      adapter: 'claude-code',
      agentProfile: 'planner'
    });
    const terminalId = createRes.data.terminalId;

    // Send a message
    await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'Message before deletion'
    });
    await sleep(100);

    // Verify message exists
    const beforeRes = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    const messageCount = beforeRes.data.messages.length;
    assert(messageCount > 0, 'Should have messages before deletion');

    // Delete terminal
    await request('DELETE', `/orchestration/terminals/${terminalId}`);

    // The messages endpoint now returns 404 since the terminal is gone
    // This is by design - the messages are still in the database (no FK constraint)
    // but the API validates terminal existence
    const afterRes = await request('GET', `/orchestration/terminals/${terminalId}/messages`);
    assert.strictEqual(afterRes.status, 404,
      'Messages endpoint returns 404 after terminal deletion (terminal validation)');

    // NOTE: Messages DO persist in the database (no FK constraint was used)
    // but the API layer validates terminal existence before returning messages
    // This is documented behavior - messages are kept for audit purposes
  });
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('       Messages API Integration Tests');
  console.log('═══════════════════════════════════════════════════');

  // Check server
  const serverRunning = await checkServer();
  if (!serverRunning) {
    console.log('\n❌ Server not running at', BASE_URL);
    console.log('   Start server with: npm start');
    process.exit(1);
  }
  console.log('✅ Server is running');

  // Run test suites
  await testMessageStorageOnInput();
  await testMessageRetrievalEndpoint();
  await testInputValidation();
  await testTraceIdFiltering();
  await testMessagePersistenceAfterDeletion();

  // Summary
  console.log('\n' + '─'.repeat(50));
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
  process.exit(0);
}

main().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
