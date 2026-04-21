/**
 * Tests for Shared Memory System
 *
 * Tests both the SharedMemoryService directly and the API endpoints.
 *
 * Run with: node tests/test-shared-memory.js
 *
 * Modes:
 *   - Unit tests (no server needed): Tests SharedMemoryService directly
 *   - API tests (server required): Tests /orchestration/memory/* endpoints
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BASE_URL = 'http://localhost:4001';

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

// ============================================================
// Unit Tests - SharedMemoryService
// ============================================================

async function runUnitTests() {
  console.log('\n📦 Unit Tests: Database Shared Memory Methods\n');

  // Use a temporary database for tests
  const testDbPath = path.join(__dirname, 'fixtures', 'test-shared-memory.db');

  // Clean up any existing test database
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  // Ensure fixtures directory exists
  const fixturesDir = path.dirname(testDbPath);
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  // Use OrchestrationDB class directly - shared memory methods are built-in
  const { OrchestrationDB } = require('../src/database/db');
  const memory = new OrchestrationDB({ dbPath: testDbPath });

  const taskId = 'test-task-' + Date.now();

  try {
    // Test 1: Store and retrieve artifact
    console.log('📝 Test: Store and retrieve artifact');
    {
      const artifactId = memory.storeArtifact(taskId, 'test-file', 'console.log("hello");', {
        type: 'code',
        agentId: 'test-agent',
        metadata: { language: 'javascript' }
      });

      assert(artifactId, 'Should return artifact ID');

      const artifact = memory.getArtifact(taskId, 'test-file');
      assert(artifact, 'Should find artifact');
      assert.strictEqual(artifact.content, 'console.log("hello");');
      assert.strictEqual(artifact.type, 'code');
      assert.deepStrictEqual(artifact.metadata, { language: 'javascript' });

      console.log('  ✅ Artifact stored and retrieved');
    }

    // Test 2: Update existing artifact
    console.log('📝 Test: Update existing artifact');
    {
      memory.storeArtifact(taskId, 'test-file', 'console.log("updated");', {
        type: 'code',
        agentId: 'test-agent-2'
      });

      const artifact = memory.getArtifact(taskId, 'test-file');
      assert.strictEqual(artifact.content, 'console.log("updated");');
      assert.strictEqual(artifact.agent_id, 'test-agent-2');

      console.log('  ✅ Artifact updated correctly');
    }

    // Test 3: Get all artifacts for task
    console.log('📝 Test: Get all artifacts for task');
    {
      memory.storeArtifact(taskId, 'plan', 'Step 1: Do something', { type: 'plan' });

      const artifacts = memory.getArtifacts(taskId);
      assert(artifacts.length >= 2, 'Should have at least 2 artifacts');

      const codeArtifacts = memory.getArtifacts(taskId, { type: 'code' });
      assert(codeArtifacts.every(a => a.type === 'code'), 'Filter should work');

      console.log(`  ✅ Retrieved ${artifacts.length} artifacts`);
    }

    // Test 4: Store and retrieve findings
    console.log('📝 Test: Store and retrieve findings');
    {
      const findingId = memory.storeFinding(taskId, 'test-agent', 'Found SQL injection in login.js', {
        type: 'security',
        severity: 'critical',
        agentProfile: 'reviewer-security',
        metadata: { file: 'login.js', line: 45 }
      });

      assert(findingId, 'Should return finding ID');

      const finding = memory.getFinding(findingId);
      assert(finding, 'Should find finding');
      assert.strictEqual(finding.type, 'security');
      assert.strictEqual(finding.severity, 'critical');
      assert.deepStrictEqual(finding.metadata, { file: 'login.js', line: 45 });

      console.log('  ✅ Finding stored and retrieved');
    }

    // Test 5: Get findings with filters
    console.log('📝 Test: Get findings with filters');
    {
      memory.storeFinding(taskId, 'test-agent', 'Consider using async/await', {
        type: 'suggestion',
        severity: 'low'
      });

      memory.storeFinding(taskId, 'test-agent', 'Memory leak detected', {
        type: 'bug',
        severity: 'high'
      });

      const allFindings = memory.getFindings(taskId);
      assert(allFindings.length >= 3, 'Should have at least 3 findings');

      const securityFindings = memory.getFindings(taskId, { type: 'security' });
      assert(securityFindings.length >= 1, 'Should have security findings');
      assert(securityFindings.every(f => f.type === 'security'));

      const criticalFindings = memory.getFindings(taskId, { severity: 'critical' });
      assert(criticalFindings.length >= 1, 'Should have critical findings');

      console.log(`  ✅ Retrieved ${allFindings.length} findings with filters`);
    }

    // Test 6: Store and retrieve context
    console.log('📝 Test: Store and retrieve context');
    {
      const contextId = memory.storeContext(taskId, 'test-agent', {
        summary: 'Analyzed the authentication flow. Found issues in login.js.',
        keyDecisions: ['Use bcrypt for password hashing', 'Add rate limiting'],
        pendingItems: ['Review logout flow', 'Check token expiry']
      });

      assert(contextId, 'Should return context ID');

      const contexts = memory.getContext(taskId);
      assert(contexts.length >= 1, 'Should have context entries');

      const latest = memory.getLatestContext(taskId);
      assert(latest, 'Should get latest context');
      assert.strictEqual(latest.summary, 'Analyzed the authentication flow. Found issues in login.js.');
      assert.deepStrictEqual(latest.keyDecisions, ['Use bcrypt for password hashing', 'Add rate limiting']);
      assert.deepStrictEqual(latest.pendingItems, ['Review logout flow', 'Check token expiry']);

      console.log('  ✅ Context stored and retrieved');
    }

    // Test 7: Get complete task memory
    console.log('📝 Test: Get complete task memory');
    {
      const taskMemory = memory.getTaskMemory(taskId);

      assert.strictEqual(taskMemory.taskId, taskId);
      assert(taskMemory.artifacts.length >= 2, 'Should have artifacts');
      assert(taskMemory.findings.length >= 3, 'Should have findings');
      assert(taskMemory.context.length >= 1, 'Should have context');

      console.log('  ✅ Complete task memory retrieved');
    }

    // Test 8: Get statistics
    console.log('📝 Test: Get statistics');
    {
      const stats = memory.getStats();

      assert(stats.artifacts >= 2, 'Should have artifacts');
      assert(stats.findings >= 3, 'Should have findings');
      assert(stats.context >= 1, 'Should have context');
      // Note: getStats returns 'terminals' not 'tasks'

      console.log(`  ✅ Stats: ${stats.artifacts} artifacts, ${stats.findings} findings, ${stats.context} context`);
    }

    // Test 9: Delete artifact
    console.log('📝 Test: Delete artifact');
    {
      const deleted = memory.deleteArtifact(taskId, 'plan');
      assert(deleted, 'Should delete artifact');

      const artifact = memory.getArtifact(taskId, 'plan');
      assert(!artifact, 'Artifact should be gone');

      console.log('  ✅ Artifact deleted');
    }

    // Test 10: Clear task memory
    console.log('📝 Test: Clear task memory');
    {
      const deleted = memory.clearTaskMemory(taskId);

      assert(deleted.artifacts >= 1, 'Should have deleted artifacts');
      assert(deleted.findings >= 3, 'Should have deleted findings');
      assert(deleted.context >= 1, 'Should have deleted context');

      const taskMemory = memory.getTaskMemory(taskId);
      assert.strictEqual(taskMemory.artifacts.length, 0, 'No artifacts left');
      assert.strictEqual(taskMemory.findings.length, 0, 'No findings left');
      assert.strictEqual(taskMemory.context.length, 0, 'No context left');

      console.log(`  ✅ Task memory cleared: ${deleted.artifacts} artifacts, ${deleted.findings} findings, ${deleted.context} context`);
    }

    // Test 11: Cleanup old entries
    console.log('📝 Test: Cleanup old entries');
    {
      // Store some entries
      memory.storeArtifact('old-task', 'old-file', 'old content');

      // Cleanup (with 0 seconds to delete everything)
      const deleted = memory.cleanupMemory(0);

      assert(deleted.artifacts >= 0, 'Should report deleted artifacts');

      console.log('  ✅ Cleanup works');
    }

    // Cleanup
    memory.close();
    fs.unlinkSync(testDbPath);

    console.log('\n✅ All unit tests passed!\n');
    return true;

  } catch (error) {
    console.error('\n❌ Unit test failed:', error.message);
    console.error(error.stack);
    memory.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    return false;
  }
}

// ============================================================
// API Tests - REST Endpoints
// ============================================================

async function checkServer() {
  try {
    const res = await request('GET', '/health');
    return res.status === 200;
  } catch (e) {
    return false;
  }
}

async function runApiTests() {
  console.log('\n🌐 API Tests: /orchestration/memory/*\n');

  const taskId = 'api-test-' + Date.now();

  try {
    // Test 1: Store artifact via API
    console.log('📝 Test: POST /orchestration/memory/artifacts');
    {
      const res = await request('POST', '/orchestration/memory/artifacts', {
        taskId,
        key: 'api-test-file',
        content: 'function test() { return true; }',
        type: 'code',
        agentId: 'api-test-agent',
        metadata: { language: 'javascript' }
      });

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(res.data.id, 'Should return artifact ID');
      assert.strictEqual(res.data.taskId, taskId);

      console.log('  ✅ Artifact stored via API');
    }

    // Test 2: Get artifacts via API
    console.log('📝 Test: GET /orchestration/memory/artifacts/:taskId');
    {
      const res = await request('GET', `/orchestration/memory/artifacts/${taskId}`);

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(Array.isArray(res.data.artifacts), 'Should return artifacts array');
      assert(res.data.artifacts.length >= 1, 'Should have at least 1 artifact');

      console.log(`  ✅ Retrieved ${res.data.artifacts.length} artifact(s)`);
    }

    // Test 3: Store finding via API
    console.log('📝 Test: POST /orchestration/memory/findings');
    {
      const res = await request('POST', '/orchestration/memory/findings', {
        taskId,
        agentId: 'api-test-agent',
        content: 'Found potential XSS vulnerability in input handling',
        type: 'security',
        severity: 'high',
        agentProfile: 'reviewer-security',
        metadata: { file: 'input.js', line: 23 }
      });

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(res.data.id, 'Should return finding ID');

      console.log('  ✅ Finding stored via API');
    }

    // Test 4: Get findings via API
    console.log('📝 Test: GET /orchestration/memory/findings/:taskId');
    {
      const res = await request('GET', `/orchestration/memory/findings/${taskId}`);

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(Array.isArray(res.data.findings), 'Should return findings array');
      assert(res.data.findings.length >= 1, 'Should have at least 1 finding');

      console.log(`  ✅ Retrieved ${res.data.findings.length} finding(s)`);
    }

    // Test 5: Store context via API
    console.log('📝 Test: POST /orchestration/memory/context');
    {
      const res = await request('POST', '/orchestration/memory/context', {
        taskId,
        agentId: 'api-test-agent',
        summary: 'Completed security review of the authentication module.',
        keyDecisions: ['Implement CSRF protection', 'Add input sanitization'],
        pendingItems: ['Review session management', 'Check cookie settings']
      });

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(res.data.id, 'Should return context ID');

      console.log('  ✅ Context stored via API');
    }

    // Test 6: Get context via API
    console.log('📝 Test: GET /orchestration/memory/context/:taskId');
    {
      const res = await request('GET', `/orchestration/memory/context/${taskId}`);

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(Array.isArray(res.data.context), 'Should return context array');
      assert(res.data.context.length >= 1, 'Should have at least 1 context entry');

      console.log(`  ✅ Retrieved ${res.data.context.length} context entry(s)`);
    }

    // Test 7: Get complete task memory via API
    console.log('📝 Test: GET /orchestration/memory/tasks/:taskId');
    {
      const res = await request('GET', `/orchestration/memory/tasks/${taskId}`);

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert.strictEqual(res.data.taskId, taskId);
      assert(res.data.artifacts.length >= 1, 'Should have artifacts');
      assert(res.data.findings.length >= 1, 'Should have findings');
      assert(res.data.context.length >= 1, 'Should have context');

      console.log('  ✅ Complete task memory retrieved via API');
    }

    // Test 8: Get statistics via API
    console.log('📝 Test: GET /orchestration/memory/stats');
    {
      const res = await request('GET', '/orchestration/memory/stats');

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(typeof res.data.artifacts === 'number', 'Should have artifacts count');
      assert(typeof res.data.findings === 'number', 'Should have findings count');
      assert(typeof res.data.context === 'number', 'Should have context count');
      assert(typeof res.data.tasks === 'number', 'Should have tasks count');

      console.log(`  ✅ Stats: ${res.data.artifacts} artifacts, ${res.data.findings} findings`);
    }

    // Test 9: Delete task memory via API
    console.log('📝 Test: DELETE /orchestration/memory/tasks/:taskId');
    {
      const res = await request('DELETE', `/orchestration/memory/tasks/${taskId}`);

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert(res.data.success, 'Should return success');
      assert(res.data.deleted.artifacts >= 1, 'Should have deleted artifacts');
      assert(res.data.deleted.findings >= 1, 'Should have deleted findings');
      assert(res.data.deleted.context >= 1, 'Should have deleted context');

      console.log(`  ✅ Task memory deleted: ${res.data.deleted.artifacts} artifacts, ${res.data.deleted.findings} findings, ${res.data.deleted.context} context`);
    }

    // Test 10: Verify deletion
    console.log('📝 Test: Verify task memory deleted');
    {
      const res = await request('GET', `/orchestration/memory/tasks/${taskId}`);

      assert.strictEqual(res.status, 200, 'Should return 200');
      assert.strictEqual(res.data.artifacts.length, 0, 'Should have no artifacts');
      assert.strictEqual(res.data.findings.length, 0, 'Should have no findings');
      assert.strictEqual(res.data.context.length, 0, 'Should have no context');

      console.log('  ✅ Task memory confirmed deleted');
    }

    // Test 11: Validation - missing required fields
    console.log('📝 Test: Validation - missing required fields');
    {
      const res = await request('POST', '/orchestration/memory/artifacts', {
        taskId: 'test'
        // Missing key and content
      });

      assert.strictEqual(res.status, 400, 'Should return 400');
      assert(res.data.error, 'Should return error');

      console.log('  ✅ Validation works correctly');
    }

    console.log('\n✅ All API tests passed!\n');
    return true;

  } catch (error) {
    console.error('\n❌ API test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

// ============================================================
// Test for buildEnhancedMessage
// ============================================================

async function runEnhancedMessageTests() {
  console.log('\n🔧 Unit Tests: buildEnhancedMessage\n');

  const { buildEnhancedMessage } = require('../src/orchestration/handoff');

  try {
    // Test 1: Empty context and findings
    console.log('📝 Test: Empty context and findings');
    {
      const message = buildEnhancedMessage('Do something', [], []);
      assert.strictEqual(message, '## Your Task\nDo something');
      console.log('  ✅ Handles empty arrays');
    }

    // Test 2: With findings only
    console.log('📝 Test: With findings only');
    {
      const findings = [
        { agent_profile: 'reviewer-security', type: 'security', severity: 'high', content: 'Found XSS vulnerability' },
        { agent_profile: 'reviewer-bugs', type: 'bug', severity: 'medium', content: 'Null check missing' }
      ];
      const message = buildEnhancedMessage('Fix the issues', findings, []);

      assert(message.includes('## Findings from Other Agents'), 'Should have findings section');
      assert(message.includes('Found XSS vulnerability'), 'Should include finding content');
      assert(message.includes('## Your Task'), 'Should have task section');
      assert(message.includes('Fix the issues'), 'Should include original message');

      console.log('  ✅ Builds message with findings');
    }

    // Test 3: With context only
    console.log('📝 Test: With context only');
    {
      const context = [{
        summary: 'Analyzed the auth module. Found issues.',
        keyDecisions: ['Use JWT', 'Add rate limiting'],
        pendingItems: ['Review logout']
      }];
      const message = buildEnhancedMessage('Continue the work', [], context);

      assert(message.includes('## Prior Context'), 'Should have context section');
      assert(message.includes('Analyzed the auth module'), 'Should include summary');
      assert(message.includes('Use JWT'), 'Should include key decisions');
      assert(message.includes('Review logout'), 'Should include pending items');

      console.log('  ✅ Builds message with context');
    }

    // Test 4: With both findings and context
    console.log('📝 Test: With both findings and context');
    {
      const findings = [{ agent_profile: 'reviewer', type: 'bug', content: 'Issue found' }];
      const context = [{ summary: 'Prior work done', keyDecisions: [], pendingItems: [] }];
      const message = buildEnhancedMessage('Complete the task', findings, context);

      assert(message.includes('## Prior Context'), 'Should have context section');
      assert(message.includes('## Findings from Other Agents'), 'Should have findings section');
      assert(message.includes('## Your Task'), 'Should have task section');

      // Verify order: context, findings, task
      const contextIndex = message.indexOf('## Prior Context');
      const findingsIndex = message.indexOf('## Findings from Other Agents');
      const taskIndex = message.indexOf('## Your Task');

      assert(contextIndex < findingsIndex, 'Context should come before findings');
      assert(findingsIndex < taskIndex, 'Findings should come before task');

      console.log('  ✅ Builds complete enhanced message');
    }

    console.log('\n✅ All enhanced message tests passed!\n');
    return true;

  } catch (error) {
    console.error('\n❌ Enhanced message test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('🧪 Shared Memory System Tests\n');
  console.log('='.repeat(50));

  let allPassed = true;

  // Run unit tests (no server needed)
  const unitTestsPassed = await runUnitTests();
  allPassed = allPassed && unitTestsPassed;

  // Run enhanced message tests
  const enhancedMessageTestsPassed = await runEnhancedMessageTests();
  allPassed = allPassed && enhancedMessageTestsPassed;

  // Run API tests (server required)
  const serverRunning = await checkServer();
  if (serverRunning) {
    const apiTestsPassed = await runApiTests();
    allPassed = allPassed && apiTestsPassed;
  } else {
    console.log('\n⚠️  Skipping API tests - server not running');
    console.log('   Start server with: npm start');
    console.log('   Then run tests again to include API tests');
  }

  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('✅ All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
