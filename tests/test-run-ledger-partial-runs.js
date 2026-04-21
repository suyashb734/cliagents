#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');
const { runConsensus } = require('../src/orchestration/consensus');
const { runPlanReview, runPrReview } = require('../src/orchestration/review-protocols');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeSessionManager(handler) {
  const sessions = new Map();
  let nextId = 1;

  return {
    async createSession(options) {
      const sessionId = `fake-${nextId++}`;
      sessions.set(sessionId, options);
      return { sessionId };
    },

    async send(sessionId, message, options = {}) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown fake session: ${sessionId}`);
      }
      return handler(session, message, options);
    },

    async terminateSession(sessionId) {
      sessions.delete(sessionId);
    }
  };
}

async function testConsensusPartialRun() {
  const rootDir = makeTempDir('cliagents-run-ledger-consensus-partial-');
  const db = new OrchestrationDB({ dbPath: path.join(rootDir, 'cliagents.db'), dataDir: rootDir });
  const ledger = new RunLedgerService(db);

  try {
    const sessionManager = createFakeSessionManager((session, message) => {
      if (session.adapter === 'gemini-cli') {
        throw new Error('quota exceeded for gemini-cli');
      }

      if (session.adapter === 'codex-cli') {
        return { result: '6', metadata: { adapter: 'codex-cli', promptLength: message.length } };
      }

      if (session.adapter === 'qwen-cli') {
        return { result: '6', metadata: { adapter: 'qwen-cli', promptLength: message.length } };
      }

      throw new Error(`Unhandled adapter ${session.adapter}`);
    });

    const result = await runConsensus(sessionManager, 'What is 3 + 3? Reply with just the number.', {
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'gemini', adapter: 'gemini-cli' }
      ],
      judge: { name: 'judge', adapter: 'qwen-cli' },
      timeout: 30000,
      workDir: '/tmp/project',
      runLedger: ledger
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.successCount, 1);
    assert.strictEqual(result.consensus.success, true);

    const detail = ledger.getRunDetail(result.runId);
    assert(detail, 'Consensus partial run should be persisted');
    assert.strictEqual(detail.run.status, 'partial');
    assert.strictEqual(detail.run.failureClass, 'rate_limit');
    assert.strictEqual(detail.run.metadata.failedParticipantCount, 1);
    assert(detail.run.metadata.participantFailures.some((failure) => failure.adapter === 'gemini-cli'));
    assert.strictEqual(detail.inputs.length, 4, 'Should persist run message, two participant prompts, and judge prompt');
    assert(detail.inputs.some((input) => input.inputKind === 'judge_prompt'));
    assert(detail.outputs.some((output) => output.outputKind === 'participant_error'));
  } finally {
    db.close();
  }
}

async function testPlanReviewPartialReviewerFailure() {
  const rootDir = makeTempDir('cliagents-run-ledger-review-partial-reviewer-');
  const db = new OrchestrationDB({ dbPath: path.join(rootDir, 'cliagents.db'), dataDir: rootDir });
  const ledger = new RunLedgerService(db);

  try {
    const sessionManager = createFakeSessionManager((session) => {
      if (session.adapter === 'qwen-cli') {
        throw new Error('request timed out while reviewing');
      }

      if (session.systemPrompt && session.systemPrompt.includes('Synthesize reviewer findings')) {
        return {
          result: JSON.stringify({
            verdict: 'revise',
            summary: 'Judge synthesized the surviving reviewer output.',
            blockers: [],
            risks: ['reviewer timeout reduced coverage'],
            testGaps: ['need rerun after reviewer timeout']
          }),
          metadata: { adapter: session.adapter }
        };
      }

      return {
        result: JSON.stringify({
          verdict: 'revise',
          summary: 'Need clearer validation steps.',
          blockers: [],
          risks: ['validation is underspecified'],
          testGaps: ['missing regression execution step']
        }),
        metadata: { adapter: session.adapter }
      };
    });

    const result = await runPlanReview(sessionManager, {
      plan: '1. Reproduce the bug.\n2. Fix the bug.\n3. Add tests.',
      context: 'Focus on correctness and validation.',
      reviewers: [
        { name: 'codex-reviewer', adapter: 'codex-cli' },
        { name: 'qwen-reviewer', adapter: 'qwen-cli' }
      ],
      judge: { name: 'codex-judge', adapter: 'codex-cli' }
    }, {
      timeout: 30000,
      workDir: '/tmp/project',
      runLedger: ledger
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.successCount, 1);
    assert.strictEqual(result.decision.verdict, 'revise');

    const detail = ledger.getRunDetail(result.runId);
    assert(detail, 'Plan-review partial run should be persisted');
    assert.strictEqual(detail.run.status, 'partial');
    assert.strictEqual(detail.run.failureClass, 'timeout');
    assert.strictEqual(detail.run.metadata.failedReviewerCount, 1);
    assert(detail.run.metadata.reviewerFailures.some((failure) => failure.adapter === 'qwen-cli'));
    assert(detail.inputs.some((input) => input.inputKind === 'judge_prompt'));
  } finally {
    db.close();
  }
}

async function testPlanReviewPartialJudgeFailure() {
  const rootDir = makeTempDir('cliagents-run-ledger-review-partial-judge-');
  const db = new OrchestrationDB({ dbPath: path.join(rootDir, 'cliagents.db'), dataDir: rootDir });
  const ledger = new RunLedgerService(db);

  try {
    const sessionManager = createFakeSessionManager((session) => {
      if (session.systemPrompt && session.systemPrompt.includes('Synthesize reviewer findings')) {
        throw new Error('authentication failed for judge');
      }

      return {
        result: JSON.stringify({
          verdict: 'approve',
          summary: 'Looks acceptable with minimal risk.',
          blockers: [],
          risks: [],
          testGaps: []
        }),
        metadata: { adapter: session.adapter }
      };
    });

    const result = await runPlanReview(sessionManager, {
      plan: '1. Reproduce the bug.\n2. Fix it.\n3. Run tests.',
      context: 'Use a minimal fix.',
      reviewers: [
        { name: 'codex-reviewer', adapter: 'codex-cli' },
        { name: 'gemini-reviewer', adapter: 'gemini-cli' }
      ],
      judge: { name: 'codex-judge', adapter: 'codex-cli' }
    }, {
      timeout: 30000,
      workDir: '/tmp/project',
      runLedger: ledger
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.decision.source, 'aggregated-reviewers');

    const detail = ledger.getRunDetail(result.runId);
    assert(detail, 'Judge-failed run should be persisted');
    assert.strictEqual(detail.run.status, 'partial');
    assert.strictEqual(detail.run.failureClass, 'auth');
    assert.strictEqual(detail.run.metadata.judgeSuccess, false);
    assert(detail.inputs.some((input) => input.inputKind === 'judge_prompt'));
    assert(detail.outputs.some((output) => output.outputKind === 'participant_error'));
  } finally {
    db.close();
  }
}

async function testPrReviewPartialReviewerFailure() {
  const rootDir = makeTempDir('cliagents-run-ledger-pr-review-partial-reviewer-');
  const db = new OrchestrationDB({ dbPath: path.join(rootDir, 'cliagents.db'), dataDir: rootDir });
  const ledger = new RunLedgerService(db);

  try {
    const sessionManager = createFakeSessionManager((session) => {
      if (session.adapter === 'gemini-cli') {
        throw new Error('quota exceeded while reviewing diff');
      }

      if (session.systemPrompt && session.systemPrompt.includes('Synthesize reviewer findings')) {
        return {
          result: JSON.stringify({
            verdict: 'revise',
            summary: 'Judge kept the surviving correctness review and flagged missing security coverage.',
            blockers: [],
            risks: ['security reviewer quota failure reduced confidence'],
            testGaps: ['rerun security review after quota recovery']
          }),
          metadata: { adapter: session.adapter }
        };
      }

      return {
        result: JSON.stringify({
          verdict: 'revise',
          summary: 'Diff looks plausible but needs more explicit null handling tests.',
          blockers: [],
          risks: ['null-path behavior is still implicit'],
          testGaps: ['missing regression test for null branch']
        }),
        metadata: { adapter: session.adapter }
      };
    });

    const result = await runPrReview(sessionManager, {
      summary: 'Guard null parser state before property access.',
      diff: 'diff --git a/src/parser.js b/src/parser.js\n+ if (!state) return null;',
      context: 'Focus on correctness and security.',
      reviewers: [
        { name: 'codex-reviewer', adapter: 'codex-cli' },
        { name: 'gemini-reviewer', adapter: 'gemini-cli' }
      ],
      judge: { name: 'codex-judge', adapter: 'codex-cli' }
    }, {
      timeout: 30000,
      workDir: '/tmp/project',
      runLedger: ledger
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.protocol, 'pr-review');
    assert.strictEqual(result.successCount, 1);

    const detail = ledger.getRunDetail(result.runId);
    assert(detail, 'PR-review partial run should be persisted');
    assert.strictEqual(detail.run.kind, 'pr-review');
    assert.strictEqual(detail.run.status, 'partial');
    assert.strictEqual(detail.run.failureClass, 'rate_limit');
    assert.strictEqual(detail.run.metadata.failedReviewerCount, 1);
    assert(detail.run.metadata.reviewerFailures.some((failure) => failure.adapter === 'gemini-cli'));
    assert(detail.inputs.some((input) => input.inputKind === 'judge_prompt'));
    assert(detail.outputs.some((output) => output.outputKind === 'participant_error'));
  } finally {
    db.close();
  }
}

(async () => {
  try {
    await testConsensusPartialRun();
    await testPlanReviewPartialReviewerFailure();
    await testPlanReviewPartialJudgeFailure();
    await testPrReviewPartialReviewerFailure();
    console.log('✅ Partial and degraded runs are persisted with accurate status and prompt coverage');
    console.log('\nRun-ledger partial-run tests passed');
  } catch (error) {
    console.error('\nRun-ledger partial-run tests failed');
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
})();
