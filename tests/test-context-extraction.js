/**
 * Context Extraction Unit Tests
 *
 * Tests for extractKeyDecisions and extractPendingItems functions
 * from the context-summarizer module.
 *
 * These are pure unit tests - no server required.
 * Run: node tests/test-context-extraction.js
 */

const assert = require('assert');
const { extractKeyDecisions, extractPendingItems } = require('../src/utils/context-summarizer');

// ============================================================
// Test Data
// ============================================================

const SAMPLE_NUMBERED_DECISIONS = `
# Analysis Results

Key Decisions
1. Use Express.js for routing
2. Store data in SQLite for simplicity
3. Implement JWT authentication for API security

The analysis is complete.
`;

const SAMPLE_BULLETED_DECISIONS = `
## Summary

Decisions
- Use React for frontend framework
- Implement Redux for state management
- Deploy on AWS Lambda

---
Next steps outlined below.
`;

const SAMPLE_KEY_DECISIONS_HEADER = `
Some preliminary work was done.

## Key Decisions

1. Adopt TypeScript for type safety
2. Use PostgreSQL instead of SQLite
3. Implement role-based access control (RBAC)
4. Add rate limiting to prevent abuse

## TODO

- Write tests
`;

const SAMPLE_NO_DECISIONS = `
This is a regular output with no decisions.
Just some general information about the task.
The work was completed successfully.
`;

const SAMPLE_MANY_DECISIONS = `
Decisions
1. First decision about architecture
2. Second decision about database
3. Third decision about API design
4. Fourth decision about authentication
5. Fifth decision about caching
6. Sixth decision should be ignored
7. Seventh decision should also be ignored
`;

const SAMPLE_TODO_TABLE = `
Work completed. Here are the remaining items:

TODO Items
#: 1
Task: Install dependencies

#: 2
Task: Create database schema

#: 3
Task: Add API routes

---
End of report.
`;

const SAMPLE_PENDING_NUMBERED = `
Some work was done.

Pending Items
1. Review the authentication flow
2. Add error handling to API endpoints
3. Write unit tests for services

All other items are complete.
`;

const SAMPLE_PENDING_BULLETED = `
## Summary

Next Steps:
- Deploy to staging environment
- Run integration tests
- Get team review approval

---
`;

const SAMPLE_NO_PENDING = `
All tasks finished successfully!
Everything has been deployed.
The project is complete.
`;

const SAMPLE_MANY_PENDING = `
TODO Items
Task: First pending task
Task: Second pending task
Task: Third pending task
Task: Fourth pending task
Task: Fifth pending task
Task: Sixth pending task
Task: Seventh pending task
Task: Eighth task that should be ignored
`;

const SAMPLE_INLINE_DECISIONS = `
After reviewing the codebase, I decided to use Express for the server framework.
We chose JWT tokens for authentication due to their stateless nature.
The approach is to use a microservices architecture for scalability.
`;

const SAMPLE_INLINE_PENDING = `
There is some remaining work to be done:
- TODO: Add input validation
- FIXME: Memory leak in user service
Future work: Implement caching layer
`;

// ============================================================
// Test Runner
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ❌ ${name}: ${error.message}`);
  }
}

// ============================================================
// Tests: extractKeyDecisions
// ============================================================

function testKeyDecisions() {
  console.log('\n📋 extractKeyDecisions Tests\n');

  test('Extracts numbered decisions from numbered list format', () => {
    const decisions = extractKeyDecisions(SAMPLE_NUMBERED_DECISIONS);
    assert(decisions.length >= 3, `Expected at least 3 decisions, got ${decisions.length}`);
    assert(decisions.some(d => d.toLowerCase().includes('express')),
      'Should extract Express.js decision');
    assert(decisions.some(d => d.toLowerCase().includes('sqlite')),
      'Should extract SQLite decision');
    assert(decisions.some(d => d.toLowerCase().includes('jwt')),
      'Should extract JWT decision');
  });

  test('Extracts decisions from bulleted list format', () => {
    const decisions = extractKeyDecisions(SAMPLE_BULLETED_DECISIONS);
    assert(decisions.length >= 3, `Expected at least 3 decisions, got ${decisions.length}`);
    assert(decisions.some(d => d.toLowerCase().includes('react')),
      'Should extract React decision');
    assert(decisions.some(d => d.toLowerCase().includes('redux')),
      'Should extract Redux decision');
  });

  test('Extracts from "Key Decisions" section header', () => {
    const decisions = extractKeyDecisions(SAMPLE_KEY_DECISIONS_HEADER);
    assert(decisions.length >= 3, `Expected at least 3 decisions, got ${decisions.length}`);
    assert(decisions.some(d => d.toLowerCase().includes('typescript')),
      'Should extract TypeScript decision');
    assert(decisions.some(d => d.toLowerCase().includes('postgresql')),
      'Should extract PostgreSQL decision');
  });

  test('Returns empty array when no decisions found', () => {
    const decisions = extractKeyDecisions(SAMPLE_NO_DECISIONS);
    assert(Array.isArray(decisions), 'Should return array');
    assert(decisions.length === 0, `Expected 0 decisions, got ${decisions.length}`);
  });

  test('Limits to 5 decisions maximum', () => {
    const decisions = extractKeyDecisions(SAMPLE_MANY_DECISIONS);
    assert(decisions.length <= 5, `Expected max 5 decisions, got ${decisions.length}`);
    assert(decisions.some(d => d.toLowerCase().includes('first')),
      'Should include first decision');
    assert(!decisions.some(d => d.toLowerCase().includes('sixth')),
      'Should NOT include 6th decision');
  });
}

// ============================================================
// Tests: extractPendingItems
// ============================================================

function testPendingItems() {
  console.log('\n📋 extractPendingItems Tests\n');

  test('Extracts from "TODO Items" / "Task:" table format', () => {
    const items = extractPendingItems(SAMPLE_TODO_TABLE);
    assert(items.length >= 3, `Expected at least 3 items, got ${items.length}`);
    assert(items.some(i => i.toLowerCase().includes('install')),
      'Should extract install task');
    assert(items.some(i => i.toLowerCase().includes('database')),
      'Should extract database task');
    assert(items.some(i => i.toLowerCase().includes('api')),
      'Should extract API routes task');
  });

  test('Extracts from numbered list format', () => {
    const items = extractPendingItems(SAMPLE_PENDING_NUMBERED);
    assert(items.length >= 3, `Expected at least 3 items, got ${items.length}`);
    assert(items.some(i => i.toLowerCase().includes('authentication')),
      'Should extract auth review task');
    assert(items.some(i => i.toLowerCase().includes('error')),
      'Should extract error handling task');
  });

  test('Extracts from bulleted list format', () => {
    const items = extractPendingItems(SAMPLE_PENDING_BULLETED);
    assert(items.length >= 3, `Expected at least 3 items, got ${items.length}`);
    assert(items.some(i => i.toLowerCase().includes('staging') || i.toLowerCase().includes('deploy')),
      'Should extract deploy task');
    assert(items.some(i => i.toLowerCase().includes('integration') || i.toLowerCase().includes('test')),
      'Should extract integration test task');
  });

  test('Returns empty array when no pending items found', () => {
    const items = extractPendingItems(SAMPLE_NO_PENDING);
    assert(Array.isArray(items), 'Should return array');
    assert(items.length === 0, `Expected 0 items, got ${items.length}`);
  });

  test('Limits to 7 pending items maximum', () => {
    const items = extractPendingItems(SAMPLE_MANY_PENDING);
    assert(items.length <= 7, `Expected max 7 items, got ${items.length}`);
    assert(items.some(i => i.toLowerCase().includes('first')),
      'Should include first task');
    assert(!items.some(i => i.toLowerCase().includes('eighth')),
      'Should NOT include 8th task');
  });
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('       Context Extraction Unit Tests');
  console.log('═══════════════════════════════════════════════════');

  testKeyDecisions();
  testPendingItems();

  console.log('\n' + '─'.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n❌ Some tests failed\n');
    process.exit(1);
  }

  console.log('\n✅ All tests passed!\n');
  process.exit(0);
}

main().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
