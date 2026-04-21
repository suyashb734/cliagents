#!/usr/bin/env node

const assert = require('assert');

const { startTestServer, stopTestServer } = require('./helpers/server-harness');
const { RunLedgerService } = require('../src/orchestration/run-ledger');

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function run() {
  const previousReadFlag = process.env.RUN_LEDGER_READS_ENABLED;
  process.env.RUN_LEDGER_READS_ENABLED = '1';

  let testServer = null;

  try {
    testServer = await startTestServer();

    const db = testServer.server.orchestration.db;
    const ledger = new RunLedgerService(db);
    const now = Date.now();
    const discussionId = 'discussion_seeded_replay';

    db.createDiscussion(discussionId, 'terminal-seed', {
      taskId: 'task-seed',
      topic: 'Should replay include full discussion messages?',
      metadata: { seeded: true }
    });
    db.addDiscussionMessage(discussionId, 'discussion-system', 'Discussion opened.', { messageType: 'info' });
    db.addDiscussionMessage(discussionId, 'participant-1-codex', 'Yes, replay should include every persisted message.', { messageType: 'answer' });
    db.addDiscussionMessage(discussionId, 'judge-1-codex', 'Judge synthesis: include the complete thread.', { messageType: 'answer' });
    db.updateDiscussionStatus(discussionId, 'completed');

    const runId = ledger.createRun({
      kind: 'discussion',
      status: 'completed',
      inputSummary: 'Seeded replay route test',
      discussionId,
      messageHash: ledger.computeMessageHash('discussion', { message: 'Seeded replay route test' }),
      startedAt: now,
      completedAt: now + 2000,
      durationMs: 2000,
      decisionSummary: 'Replay should include the complete thread',
      decisionSource: 'judge'
    });

    const runDetail = await fetchJson(`${testServer.baseUrl}/orchestration/runs/${runId}`);
    assert.strictEqual(runDetail.status, 200, 'Run detail route should succeed');
    assert.strictEqual(runDetail.data.run.id, runId);
    assert.strictEqual(runDetail.data.discussion.id, discussionId, 'Run detail should include discussion metadata');
    assert.strictEqual(runDetail.data.discussionMessages.length, 3, 'Run detail should include ordered discussion messages');
    assert.strictEqual(runDetail.data.discussionMessages[1].sender_id, 'participant-1-codex');

    const discussionDetail = await fetchJson(`${testServer.baseUrl}/orchestration/discussions/${discussionId}`);
    assert.strictEqual(discussionDetail.status, 200, 'Discussion detail route should succeed');
    assert.strictEqual(discussionDetail.data.discussion.id, discussionId);
    assert.strictEqual(discussionDetail.data.messages.length, 3, 'Discussion detail route should expose all persisted messages');
    assert.strictEqual(discussionDetail.data.messages[2].content, 'Judge synthesis: include the complete thread.');

    console.log('✅ Discussion replay routes expose persisted thread data');
  } finally {
    if (testServer) {
      await stopTestServer(testServer);
    }

    if (previousReadFlag === undefined) {
      delete process.env.RUN_LEDGER_READS_ENABLED;
    } else {
      process.env.RUN_LEDGER_READS_ENABLED = previousReadFlag;
    }
  }
}

run().then(() => {
  console.log('\nDiscussion replay route tests passed');
}).catch((error) => {
  console.error('\nDiscussion replay route tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
