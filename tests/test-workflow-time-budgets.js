#!/usr/bin/env node

const assert = require('assert');

const { runConsensus } = require('../src/orchestration/consensus');
const { runPlanReview } = require('../src/orchestration/review-protocols');
const { runDiscussion } = require('../src/orchestration/discussion-runner');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTestTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`test-level timeout after ${ms}ms`);
    })
  ]);
}

function createMockSessionManager(sendImpl) {
  const createCalls = [];
  const sendCalls = [];
  const terminateCalls = [];
  const interruptCalls = [];
  let nextId = 1;

  return {
    createCalls,
    sendCalls,
    terminateCalls,
    interruptCalls,
    async createSession(options) {
      const sessionId = options.sessionId || `mock-session-${nextId++}`;
      createCalls.push({ sessionId, options });
      return { sessionId };
    },
    async send(sessionId, message, options = {}) {
      const createRecord = createCalls.find((entry) => entry.sessionId === sessionId);
      const record = {
        sessionId,
        message,
        options,
        createOptions: createRecord?.options || null
      };
      sendCalls.push(record);
      return sendImpl(record);
    },
    async terminateSession(sessionId) {
      terminateCalls.push(sessionId);
      return true;
    },
    async interruptSession(sessionId) {
      interruptCalls.push(sessionId);
      return { interrupted: true };
    }
  };
}

async function testConsensusJudgeUsesRemainingBudget() {
  const overallTimeoutMs = 600;
  const manager = createMockSessionManager(async ({ message, options, createOptions }) => {
    if (message.includes('You are judging')) {
      assert(options.timeout < overallTimeoutMs, `expected judge timeout < ${overallTimeoutMs}, got ${options.timeout}`);
      return { result: 'judge result' };
    }

    if (createOptions?.adapter === 'gemini-cli') {
      await sleep(150);
      throw new Error('participant timed out after 150ms');
    }

    return { result: 'participant result' };
  });

  const startedAt = Date.now();
  const result = await runConsensus(manager, 'Decide what to ship next.', {
    participants: [
      { name: 'fast', adapter: 'codex-cli' },
      { name: 'slow', adapter: 'gemini-cli' }
    ],
    judge: { name: 'judge', adapter: 'qwen-cli' },
    timeout: overallTimeoutMs
  });
  const elapsedMs = Date.now() - startedAt;

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.consensus.success, true);
  assert(elapsedMs < 900, `expected consensus flow to finish promptly, took ${elapsedMs}ms`);
}

async function testPlanReviewJudgeUsesRemainingBudget() {
  const overallTimeoutMs = 600;
  const manager = createMockSessionManager(async ({ message, options, createOptions }) => {
    const isJudge = message.includes('You are the final judge for a plan-review workflow.');
    if (isJudge) {
      assert(options.timeout < overallTimeoutMs, `expected judge timeout < ${overallTimeoutMs}, got ${options.timeout}`);
      throw new Error('judge budget exhausted');
    }

    if (createOptions?.adapter === 'gemini-cli') {
      return new Promise(() => {});
    }

    return {
      result: JSON.stringify({
        verdict: 'revise',
        summary: 'Fast reviewer completed.',
        blockers: [],
        risks: [],
        testGaps: []
      })
    };
  });

  const startedAt = Date.now();
  const result = await withTestTimeout(runPlanReview(manager, {
    plan: '1. Reproduce.\n2. Fix.\n3. Test.'
  }, {
    timeout: overallTimeoutMs
  }));
  const elapsedMs = Date.now() - startedAt;

  assert.strictEqual(result.success, true);
  assert(result.judge, 'expected judge result to be present');
  assert.strictEqual(result.judge.success, false);
  assert.strictEqual(result.judge.failureClass, 'timeout');
  assert(elapsedMs < 900, `expected plan-review flow to finish promptly, took ${elapsedMs}ms`);
  assert(manager.interruptCalls.length >= 1, 'expected timed out reviewer to be interrupted');
}

async function testConsensusOuterTimeoutEnforcement() {
  const overallTimeoutMs = 600;
  const slowParticipantTimeoutMs = 150;
  const manager = createMockSessionManager(async ({ message, options, createOptions }) => {
    const isJudge = message.includes('You are judging');
    if (isJudge) {
      assert(options.timeout < overallTimeoutMs, `expected judge timeout < ${overallTimeoutMs}, got ${options.timeout}`);
      assert(options.timeout > 200, `expected judge to have meaningful budget remaining, got ${options.timeout}ms`);
      return { result: 'judge result' };
    }

    if (createOptions?.adapter === 'gemini-cli') {
      return new Promise(() => {});
    }

    await sleep(15);
    return { result: 'participant result' };
  });

  const startedAt = Date.now();
  const result = await withTestTimeout(runConsensus(manager, 'Decide what to ship next.', {
    participants: [
      { name: 'fast', adapter: 'codex-cli' },
      { name: 'slow', adapter: 'gemini-cli', timeout: slowParticipantTimeoutMs }
    ],
    judge: { name: 'judge', adapter: 'qwen-cli' },
    timeout: overallTimeoutMs
  }));
  const elapsedMs = Date.now() - startedAt;

  assert.strictEqual(result.success, true, 'expected overall consensus success');
  assert(result.consensus && result.consensus.success, 'expected judge to complete with remaining budget, got: ' + JSON.stringify(result.consensus));
  assert(elapsedMs < 900, `expected consensus flow to finish promptly, took ${elapsedMs}ms`);
  assert(manager.interruptCalls.length >= 1, 'expected hung participant to be interrupted');
}

async function testDiscussionJudgeUsesRemainingBudget() {
  const overallTimeoutMs = 600;
  const manager = createMockSessionManager(async ({ message, options, createOptions }) => {
    if (message.includes('You are the final judge for a multi-agent technical discussion.')) {
      assert(options.timeout < overallTimeoutMs, `expected judge timeout < ${overallTimeoutMs}, got ${options.timeout}`);
      return { result: 'Judge summary' };
    }

    if (createOptions?.adapter === 'gemini-cli') {
      await sleep(150);
      throw new Error('discussion participant timed out after 150ms');
    }

    return { result: 'Participant round output' };
  });

  const result = await runDiscussion(manager, 'Debate async orchestration defaults.', {
    participants: [
      { name: 'steady', adapter: 'codex-cli' },
      { name: 'slow', adapter: 'gemini-cli' }
    ],
    rounds: [
      { name: 'position', instructions: 'State one recommendation.', transcriptMode: 'none' }
    ],
    judge: { name: 'judge', adapter: 'qwen-cli' },
    timeout: overallTimeoutMs
  });

  assert.strictEqual(result.success, true);
  assert(result.judge && result.judge.success, 'expected judge to still complete with remaining budget');
}

async function testDiscussionParticipantOuterTimeoutEnforcement() {
  const overallTimeoutMs = 600;
  const slowParticipantTimeoutMs = 150;
  const manager = createMockSessionManager(async ({ message, options, createOptions }) => {
    if (message.includes('You are the final judge for a multi-agent technical discussion.')) {
      assert(options.timeout < overallTimeoutMs, `expected judge timeout < ${overallTimeoutMs}, got ${options.timeout}`);
      return { result: 'Judge summary' };
    }

    if (createOptions?.adapter === 'gemini-cli') {
      return new Promise(() => {});
    }

    return { result: 'Participant round output' };
  });

  const startedAt = Date.now();
  const result = await withTestTimeout(runDiscussion(manager, 'Debate async orchestration defaults.', {
    participants: [
      { name: 'steady', adapter: 'codex-cli' },
      { name: 'slow', adapter: 'gemini-cli', timeout: slowParticipantTimeoutMs }
    ],
    rounds: [
      { name: 'position', instructions: 'State one recommendation.', transcriptMode: 'none' }
    ],
    judge: { name: 'judge', adapter: 'qwen-cli' },
    timeout: overallTimeoutMs
  }));
  const elapsedMs = Date.now() - startedAt;

  assert.strictEqual(result.success, true);
  assert(result.judge && result.judge.success, 'expected judge to complete after timed out participant');
  assert(elapsedMs < 900, `expected discussion flow to finish promptly, took ${elapsedMs}ms`);
  assert(manager.interruptCalls.length >= 1, 'expected hung discussion participant to be interrupted');
}

async function run() {
  console.log('Running workflow time-budget tests...');

  await testConsensusJudgeUsesRemainingBudget();
  console.log('  ✓ consensus judge uses remaining budget');

  await testConsensusOuterTimeoutEnforcement();
  console.log('  ✓ consensus outer timeout enforcement');

  await testPlanReviewJudgeUsesRemainingBudget();
  console.log('  ✓ plan-review judge uses remaining budget');

  await testDiscussionJudgeUsesRemainingBudget();
  console.log('  ✓ discussion judge uses remaining budget');

  await testDiscussionParticipantOuterTimeoutEnforcement();
  console.log('  ✓ discussion participant outer timeout enforcement');

  console.log('Workflow time-budget tests passed.');
}

run().catch((error) => {
  console.error('Workflow time-budget tests failed:', error);
  process.exit(1);
});
