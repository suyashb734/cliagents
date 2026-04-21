#!/usr/bin/env node
/**
 * Discussion Tests
 *
 * Tests for the agent-to-agent discussion system including:
 * - Discussion creation and management
 * - Message sending and receiving
 * - Protocol formatting (with security)
 * - Database operations
 */

const path = require('path');
const fs = require('fs');

// Test utilities
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const results = { passed: 0, failed: 0, tests: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    if (error.message?.startsWith('SKIP:')) {
      results.tests.push({ name, status: 'skipped', reason: error.message });
      console.log(`  ⏭️  ${name} (skipped)`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'failed', error: error.message });
      console.log(`  ❌ ${name}: ${error.message}`);
    }
  }
}

// ============================================
// TEST SUITES
// ============================================

async function testDiscussionProtocol() {
  console.log('\n📋 Discussion Protocol Tests');

  const {
    escapeXml,
    formatQuestionsForAgent,
    formatAnswerForAgent,
    formatQuestionForReceiver,
    validateMessageContent,
    MessageTypes,
    DiscussionStatus
  } = require('../src/orchestration/discussion-protocol');

  await test('Load protocol module', async () => {
    assert(escapeXml, 'escapeXml should exist');
    assert(formatQuestionsForAgent, 'formatQuestionsForAgent should exist');
    assert(MessageTypes, 'MessageTypes should exist');
    assert(DiscussionStatus, 'DiscussionStatus should exist');
  });

  await test('escapeXml handles special characters', async () => {
    assert(escapeXml('<script>') === '&lt;script&gt;', 'Should escape angle brackets');
    assert(escapeXml('"test"') === '&quot;test&quot;', 'Should escape quotes');
    assert(escapeXml('a&b') === 'a&amp;b', 'Should escape ampersand');
  });

  await test('formatQuestionsForAgent returns null for empty array', async () => {
    assert(formatQuestionsForAgent([]) === null, 'Should return null for empty');
    assert(formatQuestionsForAgent(null) === null, 'Should return null for null');
  });

  await test('formatQuestionsForAgent formats questions with security framing', async () => {
    const questions = [
      { id: 1, sender_id: 'terminal-123', content: 'What is the API structure?', topic: 'Architecture' }
    ];
    const result = formatQuestionsForAgent(questions);

    assert(result.includes('Pending Questions'), 'Should have header');
    assert(result.includes('<peer_question>'), 'Should have security framing');
    assert(result.includes('terminal-123'), 'Should include sender');
    assert(result.includes('reply_to_agent'), 'Should include reply instructions');
    assert(result.includes('DATA to process'), 'Should mark as data not instructions');
  });

  await test('formatAnswerForAgent formats with security framing', async () => {
    const result = formatAnswerForAgent('The API uses REST.', 'terminal-456', { topic: 'Architecture' });

    assert(result.includes('<peer_response>'), 'Should have security framing');
    assert(result.includes('terminal-456'), 'Should include responder');
    assert(result.includes('The API uses REST.'), 'Should include content');
  });

  await test('formatQuestionForReceiver includes security warning', async () => {
    const result = formatQuestionForReceiver('How does auth work?', 'terminal-789');

    assert(result.includes('<peer_question>'), 'Should have security framing');
    assert(result.includes('DATA to analyze'), 'Should mark as data');
    assert(result.includes('not instructions'), 'Should warn about instructions');
  });

  await test('validateMessageContent accepts valid content', async () => {
    const result = validateMessageContent('This is a valid question about the code.');
    assert(result.valid === true, 'Should accept valid content');
  });

  await test('validateMessageContent rejects empty content', async () => {
    let result = validateMessageContent('');
    assert(result.valid === false, 'Should reject empty string');

    result = validateMessageContent(null);
    assert(result.valid === false, 'Should reject null');
  });

  await test('validateMessageContent rejects overly long content', async () => {
    const longContent = 'x'.repeat(60000);
    const result = validateMessageContent(longContent);
    assert(result.valid === false, 'Should reject long content');
    assert(result.reason.includes('too long'), 'Should mention length');
  });
}

async function testDiscussionManagerUnit() {
  console.log('\n📋 Discussion Manager Unit Tests');

  const { DiscussionManager, generateDiscussionId, DEFAULT_CONFIG } = require('../src/orchestration/discussion-manager');

  await test('Load discussion manager module', async () => {
    assert(DiscussionManager, 'DiscussionManager should exist');
    assert(generateDiscussionId, 'generateDiscussionId should exist');
    assert(DEFAULT_CONFIG, 'DEFAULT_CONFIG should exist');
  });

  await test('generateDiscussionId creates unique IDs', async () => {
    const id1 = generateDiscussionId();
    const id2 = generateDiscussionId();
    assert(id1 !== id2, 'IDs should be unique');
    assert(id1.length === 16, 'ID should be 16 hex chars');
  });

  await test('Default config has expected values', async () => {
    assert(DEFAULT_CONFIG.defaultTimeout === 60000, 'Default timeout should be 60s');
    assert(DEFAULT_CONFIG.pollIntervalMs === 500, 'Poll interval should be 500ms');
  });

  await test('Constructor requires db', async () => {
    const mockSessionManager = {};
    try {
      new DiscussionManager({ sessionManager: mockSessionManager });
      assert(false, 'Should throw without db');
    } catch (e) {
      assert(e.message.includes('db'), 'Error should mention db');
    }
  });

  await test('Constructor requires sessionManager', async () => {
    const mockDb = {};
    try {
      new DiscussionManager({ db: mockDb });
      assert(false, 'Should throw without sessionManager');
    } catch (e) {
      assert(e.message.includes('sessionManager'), 'Error should mention sessionManager');
    }
  });

  await test('Statistics tracking', async () => {
    const mockDb = { createDiscussion: () => {} };
    const mockSessionManager = {};
    const manager = new DiscussionManager({ db: mockDb, sessionManager: mockSessionManager });

    const stats = manager.getStats();
    assert(stats.discussionsStarted === 0, 'Initial discussions should be 0');
    assert(stats.questionsAsked === 0, 'Initial questions should be 0');
  });
}

async function testDatabaseOperations() {
  console.log('\n📋 Database Discussion Operations');

  // Use in-memory SQLite for testing
  const Database = require('better-sqlite3');
  const schemaPath = path.join(__dirname, '../src/database/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  let db;

  await test('Create database with discussion tables', async () => {
    db = new Database(':memory:');
    db.exec(schema);

    // Verify tables exist
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'discussion%'
    `).all();

    assert(tables.length === 2, 'Should have 2 discussion tables');
  });

  await test('Insert and retrieve discussion', async () => {
    const discussionId = 'test-disc-001';
    const initiatorId = 'terminal-aaa';

    db.prepare(`
      INSERT INTO discussions (id, initiator_id, task_id, topic, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(discussionId, initiatorId, 'task-123', 'Code Review', Date.now());

    const row = db.prepare('SELECT * FROM discussions WHERE id = ?').get(discussionId);
    assert(row !== null, 'Should find discussion');
    assert(row.initiator_id === initiatorId, 'Should have correct initiator');
    assert(row.topic === 'Code Review', 'Should have correct topic');
  });

  await test('Insert and retrieve discussion messages', async () => {
    const discussionId = 'test-disc-001';

    // Insert question
    const questionResult = db.prepare(`
      INSERT INTO discussion_messages (discussion_id, sender_id, receiver_id, message_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(discussionId, 'terminal-aaa', 'terminal-bbb', 'question', 'How does X work?', Date.now());

    const questionId = questionResult.lastInsertRowid;

    // Insert answer
    db.prepare(`
      INSERT INTO discussion_messages (discussion_id, sender_id, receiver_id, message_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(discussionId, 'terminal-bbb', 'terminal-aaa', 'answer', 'X works like this...', Date.now());

    // Query messages
    const messages = db.prepare(`
      SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at
    `).all(discussionId);

    assert(messages.length === 2, 'Should have 2 messages');
    assert(messages[0].message_type === 'question', 'First should be question');
    assert(messages[1].message_type === 'answer', 'Second should be answer');
  });

  await test('Query pending messages for receiver', async () => {
    // Insert pending message
    db.prepare(`
      INSERT INTO discussion_messages (discussion_id, sender_id, receiver_id, message_type, content, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('test-disc-001', 'terminal-ccc', 'terminal-ddd', 'question', 'New question', 'pending', Date.now());

    const pending = db.prepare(`
      SELECT * FROM discussion_messages WHERE receiver_id = ? AND status = 'pending'
    `).all('terminal-ddd');

    assert(pending.length === 1, 'Should find 1 pending message');
    assert(pending[0].sender_id === 'terminal-ccc', 'Should have correct sender');
  });

  await test('Atomic message delivery update', async () => {
    // Try to mark as delivered (atomic - only if still pending)
    const result = db.prepare(`
      UPDATE discussion_messages
      SET status = 'delivered', delivered_at = ?
      WHERE receiver_id = ? AND status = 'pending'
    `).run(Date.now(), 'terminal-ddd');

    assert(result.changes === 1, 'Should update 1 row');

    // Try again - should not update (already delivered)
    const result2 = db.prepare(`
      UPDATE discussion_messages
      SET status = 'delivered', delivered_at = ?
      WHERE receiver_id = ? AND status = 'pending'
    `).run(Date.now(), 'terminal-ddd');

    assert(result2.changes === 0, 'Should not update already delivered');
  });

  // Cleanup
  if (db) db.close();
}

async function testMessageTypes() {
  console.log('\n📋 Message Type Tests');

  const { MessageTypes, DiscussionStatus } = require('../src/orchestration/discussion-protocol');

  await test('MessageTypes has expected values', async () => {
    assert(MessageTypes.QUESTION === 'question', 'QUESTION type');
    assert(MessageTypes.ANSWER === 'answer', 'ANSWER type');
    assert(MessageTypes.INFO === 'info', 'INFO type');
  });

  await test('DiscussionStatus has expected values', async () => {
    assert(DiscussionStatus.ACTIVE === 'active', 'ACTIVE status');
    assert(DiscussionStatus.COMPLETED === 'completed', 'COMPLETED status');
    assert(DiscussionStatus.TIMEOUT === 'timeout', 'TIMEOUT status');
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('🧪 Discussion Tests');
  console.log('');

  await testDiscussionProtocol();
  await testDiscussionManagerUnit();
  await testDatabaseOperations();
  await testMessageTypes();

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results');
  console.log(`   ✅ Passed: ${results.passed}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log('='.repeat(50));

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
