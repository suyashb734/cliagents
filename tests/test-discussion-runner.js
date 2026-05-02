#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDiscussion } = require('../src/orchestration/discussion-runner');
const { getDB, closeDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class FakeSessionManager {
  constructor() {
    this.sessions = new Map();
    this.nextId = 0;
    this.terminated = [];
  }

  async createSession(options = {}) {
    const sessionId = `fake-session-${++this.nextId}`;
    this.sessions.set(sessionId, {
      sessionId,
      options,
      sendCount: 0
    });
    return { sessionId };
  }

  async send(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown session: ${sessionId}`);
    }

    session.sendCount += 1;
    const adapter = session.options.adapter;
    const roundMatch = String(message).match(/Current round:\s*([^\n]+)/i);
    const roundName = roundMatch ? roundMatch[1].trim() : 'judge';

    if (adapter === 'broken-cli' && session.sendCount === 1) {
      throw new Error('request timed out during discussion round');
    }
    if (adapter === 'judge-broken-cli' && String(message).includes('You are the final judge')) {
      throw new Error('judge synthesis timed out');
    }

    if (String(message).includes('You are the final judge')) {
      return {
        result: [
          'CONSENSUS_DECISIONS',
          '- move to async-first MCP delegation',
          'OPEN_DISAGREEMENTS',
          '- whether tmux should stay exposed to end users',
          'NEXT_IMPLEMENTATION_BACKLOG',
          '- P0: discussion route',
          'PRODUCTION_READINESS',
          '- not yet'
        ].join('\n'),
        metadata: {
          judged: true,
          provider: 'openai',
          model: 'judge-o4-mini',
          inputTokens: 30,
          outputTokens: 10,
          totalTokens: 40,
          costUsd: 0.25,
          sourceConfidence: 'provider_reported'
        }
      };
    }

    return {
      result: `${adapter} ${roundName} response #${session.sendCount}`,
      metadata: {
        roundName,
        sendCount: session.sendCount,
        provider: 'test-provider',
        model: `${adapter}-model`,
        inputTokens: 10 * session.sendCount,
        outputTokens: 5 * session.sendCount,
        totalTokens: 15 * session.sendCount,
        sourceConfidence: 'estimated'
      }
    };
  }

  async terminateSession(sessionId) {
    this.terminated.push(sessionId);
    this.sessions.delete(sessionId);
    return true;
  }
}

async function run() {
  closeDB();
  const dataDir = makeTempDir('cliagents-discussion-runner-data-');
  const db = getDB({ dataDir });
  const ledger = new RunLedgerService(db);

  try {
    const okManager = new FakeSessionManager();
    const result = await runDiscussion(okManager, 'Decide how cliagents should handle multi-agent debate.', {
      context: 'Focus on orchestration, persistence, and inspection.',
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      rounds: [
        { name: 'position', instructions: 'State one strength and one risk.', transcriptMode: 'none' },
        { name: 'rebuttal', instructions: 'React to the prior round and propose a compromise.', transcriptMode: 'previous' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      runLedger: ledger
    });

    assert.strictEqual(result.success, true);
    assert(result.runId, 'discussion run should expose a runId');
    assert.strictEqual(result.rounds.length, 2);
    assert(result.judge && result.judge.success, 'judge should succeed');

    const detail = ledger.getRunDetail(result.runId);
    assert(detail, 'discussion run should be persisted');
    assert.strictEqual(detail.run.kind, 'discussion');
    assert.strictEqual(detail.run.status, 'completed');
    assert(detail.inputs.some((input) => input.inputKind === 'run_message'));
    assert(detail.inputs.some((input) => input.inputKind === 'participant_prompt'));
    assert(detail.inputs.some((input) => input.inputKind === 'judge_prompt'));
    assert(detail.outputs.some((output) => output.outputKind === 'participant_final' && output.metadata?.roundName === 'position'));
    assert(detail.outputs.some((output) => output.outputKind === 'participant_final' && output.metadata?.responseCount >= 1));
    assert(detail.outputs.some((output) => output.outputKind === 'judge_final'));
    assert.strictEqual(detail.participants.filter((participant) => participant.participantRole === 'participant').length, 2);
    assert.strictEqual(detail.participants.filter((participant) => participant.participantRole === 'judge').length, 1);
    const discussion = db.getDiscussion(result.discussionId);
    assert(discussion, 'legacy discussions table should mirror the discussion');
    assert.strictEqual(discussion.status, 'completed');
    const discussionMessages = db.getDiscussionMessages(result.discussionId);
    assert(discussionMessages.length >= 7, 'discussion history should include system, participant, and judge messages');
    assert(discussionMessages.some((message) => message.content.includes('Round 1: position')));
    assert(discussionMessages.some((message) => message.content.includes('Judge synthesis')));
    const usageSummary = db.summarizeUsage({ runId: result.runId });
    assert.strictEqual(usageSummary.recordCount, 5);
    assert.strictEqual(usageSummary.inputTokens, 90);
    assert.strictEqual(usageSummary.outputTokens, 40);
    assert.strictEqual(usageSummary.totalTokens, 130);
    assert.strictEqual(usageSummary.costUsd, 0.25);
    const usageRecords = db.listUsageRecords({ runId: result.runId });
    assert.strictEqual(usageRecords.length, 5);
    assert(usageRecords.every((record) => record.run_id === result.runId));
    assert(usageRecords.every((record) => record.root_session_id === result.discussionId));
    const rootUsageSummary = db.summarizeUsage({ rootSessionId: result.discussionId });
    assert.strictEqual(rootUsageSummary.recordCount, 5);
    assert.strictEqual(rootUsageSummary.totalTokens, 130);
    const usageBreakdown = db.listUsageBreakdown({ runId: result.runId, groupBy: 'sourceConfidence' });
    assert(usageBreakdown.some((entry) => entry.key === 'estimated' && entry.totalTokens === 90));
    assert(usageBreakdown.some((entry) => entry.key === 'provider_reported' && entry.totalTokens === 40));

    const partialManager = new FakeSessionManager();
    const partial = await runDiscussion(partialManager, 'Stress the degraded-run path.', {
      participants: [
        { name: 'broken', adapter: 'broken-cli' },
        { name: 'codex', adapter: 'codex-cli' }
      ],
      rounds: [
        { name: 'position', instructions: 'State your initial position.', transcriptMode: 'none' },
        { name: 'converge', instructions: 'Converge on next steps.', transcriptMode: 'previous' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      runLedger: ledger
    });

    assert.strictEqual(partial.success, true, 'partial discussion should still return success when at least one participant succeeds');
    const partialDetail = ledger.getRunDetail(partial.runId);
    assert.strictEqual(partialDetail.run.status, 'partial');
    assert.strictEqual(partialDetail.run.metadata.failedParticipantCount, 1);
    assert(partialDetail.outputs.some((output) => output.outputKind === 'participant_error'));
    assert.strictEqual(db.getDiscussion(partial.discussionId).status, 'partial');

    const judgeFailureManager = new FakeSessionManager();
    const judgeFailure = await runDiscussion(judgeFailureManager, 'Exercise the judge failure path.', {
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      rounds: [
        { name: 'position', instructions: 'State your position.', transcriptMode: 'none' }
      ],
      judge: { name: 'judge', adapter: 'judge-broken-cli' },
      runLedger: ledger
    });

    assert.strictEqual(judgeFailure.success, true, 'discussion should still return success when the judge fails after successful rounds');
    const judgeFailureDetail = ledger.getRunDetail(judgeFailure.runId);
    assert.strictEqual(judgeFailureDetail.run.status, 'partial');
    assert(
      judgeFailureDetail.outputs.some((output) =>
        output.participantId &&
        output.outputKind === 'participant_error' &&
        output.metadata?.failureClass === 'timeout'
      ),
      'judge failure should be persisted using an allowed output kind'
    );
    assert.strictEqual(db.getDiscussion(judgeFailure.discussionId).status, 'partial');

    console.log('✅ Discussion runner persists multi-round discussions and degraded runs');
  } finally {
    closeDB();
  }
}

run().then(() => {
  console.log('\nDiscussion runner tests passed');
}).catch((error) => {
  console.error('\nDiscussion runner tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
