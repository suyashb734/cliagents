/**
 * Unit tests for direct-session review protocols.
 *
 * Run:
 *   node tests/test-review-protocols.js
 */

const assert = require('assert');
const { runPlanReview, runPrReview } = require('../src/orchestration/review-protocols');

function createMockSessionManager(sendImpl) {
  const createCalls = [];
  const sendCalls = [];
  const terminateCalls = [];
  const interruptCalls = [];

  return {
    createCalls,
    sendCalls,
    terminateCalls,
    interruptCalls,
    async createSession(options) {
      createCalls.push(options);
      return { sessionId: options.sessionId };
    },
    async send(sessionId, message, options) {
      const createOptions = createCalls.find((entry) => entry.sessionId === sessionId);
      sendCalls.push({ sessionId, message, options, createOptions });
      return sendImpl({ sessionId, message, options, createOptions, sendCalls });
    },
    async terminateSession(sessionId) {
      terminateCalls.push(sessionId);
    },
    async interruptSession(sessionId) {
      interruptCalls.push(sessionId);
      return { interrupted: true };
    }
  };
}

async function testPlanReviewWithJudge() {
  const manager = createMockSessionManager(({ message, createOptions }) => {
    const isJudge = message.includes('You are the final judge for a plan-review workflow.');

    if (isJudge) {
      return {
        result: JSON.stringify({
          verdict: 'approve',
          summary: 'Judge says plan is good.',
          blockers: [],
          risks: [],
          testGaps: []
        })
      };
    }

    if (createOptions.adapter === 'codex-cli') {
      return {
        result: JSON.stringify({
          verdict: 'revise',
          summary: 'Need one integration test.',
          blockers: [{ id: 'B1', severity: 'high', issue: 'No rollback step', evidence: 'Missing in phase 2', fix: 'Add rollback checklist' }],
          risks: ['Deployment sequencing risk'],
          testGaps: ['No migration rollback test']
        })
      };
    }

    return {
      result: JSON.stringify({
        verdict: 'approve',
        summary: 'Risk review clean.',
        blockers: [],
        risks: [],
        testGaps: []
      })
    };
  });

  const result = await runPlanReview(manager, {
    plan: 'Add /orchestration/plan-review and /orchestration/pr-review routes.',
    context: 'Node + Express service'
  }, {
    timeout: 30,
    workDir: '/tmp/demo'
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.protocol, 'plan-review');
  assert.strictEqual(result.reviewerCount, 2);
  assert.strictEqual(result.successCount, 2);
  assert.strictEqual(result.judge.success, true);
  assert.strictEqual(result.decision.source, 'judge');
  assert.strictEqual(result.decision.verdict, 'approve');
  assert.strictEqual(result.reviewers[0].structured.parser, 'json');
  assert.strictEqual(manager.createCalls.length, 3);
  assert.strictEqual(manager.terminateCalls.length, 3);
}

async function testPlanReviewAggregatesWithoutJudge() {
  const manager = createMockSessionManager(({ createOptions }) => {
    if (createOptions.adapter === 'codex-cli') {
      return {
        result: JSON.stringify({
          verdict: 'reject',
          summary: 'Critical blocker found.',
          blockers: [{ id: 'B1', severity: 'critical', issue: 'Data loss risk', evidence: 'No backup plan', fix: 'Add backup+restore' }],
          risks: [],
          testGaps: []
        })
      };
    }

    return {
      result: JSON.stringify({
        verdict: 'approve',
        summary: 'No additional issues.',
        blockers: [],
        risks: [],
        testGaps: []
      })
    };
  });

  const result = await runPlanReview(manager, {
    plan: 'Ship data migration workflow.',
    judge: false
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.judge, null);
  assert.strictEqual(result.decision.source, 'aggregated-reviewers');
  assert.strictEqual(result.decision.verdict, 'reject');
  assert.strictEqual(manager.createCalls.length, 2);
}

async function testPrReviewValidation() {
  let didThrow = false;

  try {
    await runPrReview(createMockSessionManager(() => ({ result: '{}' })), {});
  } catch (error) {
    didThrow = true;
    assert.strictEqual(error.message, 'summary or diff is required');
  }

  assert.strictEqual(didThrow, true);
}

async function testFallbackParserMode() {
  const manager = createMockSessionManager(() => ({
    result: 'This plan has major concerns. Missing test coverage and rollback strategy.'
  }));

  const result = await runPlanReview(manager, {
    plan: 'Refactor routing layer.',
    reviewers: [{ name: 'text-reviewer', adapter: 'codex-cli' }],
    judge: false
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.reviewerCount, 1);
  assert.strictEqual(result.reviewers[0].structured.parser, 'fallback-text');
  assert.strictEqual(result.reviewers[0].structured.verdict, 'revise');
  assert(result.reviewers[0].structured.summary.includes('Missing test coverage'));
}

async function testAllReviewersFail() {
  const manager = createMockSessionManager(() => {
    throw new Error('adapter timeout');
  });

  const result = await runPlanReview(manager, {
    plan: 'Optimize search indexing.',
    judge: false
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.successCount, 0);
  assert.strictEqual(result.decision, null);
}

async function testReviewerTimeoutIsForcedAtProtocolLayer() {
  const manager = createMockSessionManager(({ createOptions }) => {
    if (createOptions.adapter === 'codex-cli') {
      return {
        result: JSON.stringify({
          verdict: 'approve',
          summary: 'Fast review completed.',
          blockers: [],
          risks: [],
          testGaps: []
        })
      };
    }

    return new Promise(() => {});
  });

  const result = await runPlanReview(manager, {
    plan: 'Ship a small routing change.',
    judge: false
  }, {
    timeout: 25
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.successCount, 1);
  assert.strictEqual(result.reviewers.length, 2);
  const failedReviewer = result.reviewers.find((reviewer) => !reviewer.success);
  assert(failedReviewer, 'Expected qwen reviewer entry');
  assert.strictEqual(failedReviewer.success, false);
  assert.strictEqual(failedReviewer.failureClass, 'timeout');
  assert(manager.interruptCalls.length >= 1, 'Timed out reviewer should be interrupted');
  assert(manager.terminateCalls.length >= 2, 'All created sessions should be terminated');
}

async function run() {
  console.log('Running review protocol tests...');

  await testPlanReviewWithJudge();
  console.log('  ✓ plan review with judge');

  await testPlanReviewAggregatesWithoutJudge();
  console.log('  ✓ plan review aggregates without judge');

  await testPrReviewValidation();
  console.log('  ✓ PR validation');

  await testFallbackParserMode();
  console.log('  ✓ fallback parser mode');

  await testAllReviewersFail();
  console.log('  ✓ all-reviewers-fail path');

  await testReviewerTimeoutIsForcedAtProtocolLayer();
  console.log('  ✓ participant timeout is enforced at protocol layer');

  console.log('All review protocol tests passed.');
}

run().catch((error) => {
  console.error('Review protocol tests failed:', error);
  process.exit(1);
});
