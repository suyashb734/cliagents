#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const {
  buildRootSessionSnapshot,
  listRootSessionSummaries
} = require('../src/orchestration/root-session-monitor');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function run() {
  const rootDir = makeTempDir('cliagents-root-monitor-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    db.registerTerminal(
      'child-review-1',
      'cliagents-root',
      '0',
      'qwen-cli',
      'review_qwen-cli',
      'worker',
      '/tmp/project',
      '/tmp/root.log',
      {
        rootSessionId: 'root-123',
        parentSessionId: 'root-123',
        sessionKind: 'reviewer',
        originClient: 'mcp',
        externalSessionRef: 'opencode:thread-1',
        lineageDepth: 1
      }
    );
    db.updateStatus('child-review-1', 'waiting_user_answer');

    db.addSessionEvent({
      rootSessionId: 'root-123',
      sessionId: 'root-123',
      eventType: 'session_started',
      originClient: 'mcp',
      idempotencyKey: 'root-start',
      payloadJson: {
        sessionKind: 'attach',
        externalSessionRef: 'opencode:thread-1'
      }
    });
    db.addSessionEvent({
      rootSessionId: 'root-123',
      sessionId: 'discussion-1',
      parentSessionId: 'root-123',
      eventType: 'session_started',
      originClient: 'mcp',
      idempotencyKey: 'discussion-start',
      payloadJson: {
        sessionKind: 'discussion'
      }
    });
    db.addSessionEvent({
      rootSessionId: 'root-123',
      sessionId: 'child-review-1',
      parentSessionId: 'root-123',
      eventType: 'session_resumed',
      originClient: 'mcp',
      idempotencyKey: 'child-resumed',
      payloadJson: {
        adapter: 'qwen-cli',
        sessionKind: 'reviewer',
        reuseReason: 'matching-root-session-shape'
      }
    });
    db.addSessionEvent({
      rootSessionId: 'root-123',
      sessionId: 'child-review-1',
      parentSessionId: 'root-123',
      eventType: 'user_input_requested',
      originClient: 'mcp',
      idempotencyKey: 'child-input',
      payloadJson: {
        question: 'Need approval'
      }
    });
    db.addSessionEvent({
      rootSessionId: 'root-123',
      sessionId: 'discussion-1',
      parentSessionId: 'root-123',
      eventType: 'consensus_recorded',
      originClient: 'mcp',
      idempotencyKey: 'discussion-final',
      payloadSummary: 'Discussion completed',
      payloadJson: {
        status: 'completed',
        decisionSummary: 'Proceed with async-first delegation.'
      }
    });

    const oldOccurredAt = Date.now() - (2 * 60 * 60 * 1000);
    db.addSessionEvent({
      rootSessionId: 'legacy-stale-root',
      sessionId: 'legacy-stale-root',
      eventType: 'session_started',
      originClient: 'legacy',
      idempotencyKey: 'legacy-stale-start',
      occurredAt: oldOccurredAt,
      payloadJson: {
        sessionKind: 'legacy'
      }
    });
    db.addSessionEvent({
      rootSessionId: 'legacy-stale-root',
      sessionId: 'legacy-stale-root',
      eventType: 'session_stale',
      originClient: 'legacy',
      idempotencyKey: 'legacy-stale-flag',
      occurredAt: oldOccurredAt + 1,
      payloadJson: {}
    });

    db.registerTerminal(
      'system-review-1',
      'cliagents-system',
      '0',
      'codex-cli',
      'review_codex-cli',
      'worker',
      '/tmp/project',
      '/tmp/system.log',
      {
        rootSessionId: 'system-detached-root',
        parentSessionId: null,
        sessionKind: 'reviewer',
        originClient: 'system',
        lineageDepth: 0
      }
    );
    db.updateStatus('system-review-1', 'processing');
    db.addSessionEvent({
      rootSessionId: 'system-detached-root',
      sessionId: 'system-detached-root',
      eventType: 'session_started',
      originClient: 'system',
      idempotencyKey: 'system-detached-start',
      payloadJson: {
        sessionKind: 'reviewer',
        adapter: 'codex-cli'
      },
      metadata: {
        clientName: 'opencode',
        attachMode: 'implicit-first-use'
      }
    });

    db.registerTerminal(
      'managed-main-root',
      'cliagents-managed-main',
      '0',
      'claude-code',
      'main_claude-code',
      'main',
      '/tmp/project',
      '/tmp/managed-main.log',
      {
        rootSessionId: 'managed-main-root',
        parentSessionId: null,
        sessionKind: 'main',
        originClient: 'claude',
        externalSessionRef: 'claude:thread-1',
        lineageDepth: 0,
        sessionMetadata: {
          attachMode: 'managed-root-launch',
          clientName: 'claude'
        }
      }
    );
    db.updateStatus('managed-main-root', 'idle');
    db.addSessionEvent({
      rootSessionId: 'managed-main-root',
      sessionId: 'managed-main-root',
      eventType: 'session_started',
      originClient: 'claude',
      idempotencyKey: 'managed-main-start',
      payloadJson: {
        sessionKind: 'main',
        adapter: 'claude-code',
        externalSessionRef: 'claude:thread-1'
      },
      metadata: {
        clientName: 'claude',
        attachMode: 'managed-root-launch'
      }
    });

    db.registerTerminal(
      'recovered-main-root',
      'cliagents-recovered-main',
      '0',
      'codex-cli',
      'main_codex-cli',
      'main',
      '/tmp/project',
      '/tmp/recovered-main.log',
      {
        rootSessionId: 'recovered-main-root',
        parentSessionId: null,
        sessionKind: 'main',
        originClient: 'codex',
        externalSessionRef: 'codex:thread-recovered',
        lineageDepth: 0,
        sessionMetadata: {
          attachMode: 'managed-root-launch',
          clientName: 'codex',
          managedLaunch: true
        }
      }
    );
    db.updateStatus('recovered-main-root', 'idle');

    const snapshot = buildRootSessionSnapshot({
      db,
      rootSessionId: 'root-123',
      eventLimit: 50,
      terminalLimit: 20
    });

    assert(snapshot, 'snapshot should exist');
    assert.strictEqual(snapshot.rootSessionId, 'root-123');
    assert.strictEqual(snapshot.status, 'blocked');
    assert.strictEqual(snapshot.counts.blocked, 1);
    assert(snapshot.attention.requiresAttention);
    assert(snapshot.attention.reasons.some((reason) => reason.code === 'user_input_required'));
    assert.strictEqual(snapshot.latestConclusion.summary, 'Proceed with async-first delegation.');
    const reusedSession = snapshot.sessions.find((session) => session.sessionId === 'child-review-1');
    assert(reusedSession && reusedSession.status === 'blocked');
    assert.strictEqual(reusedSession.wasReused, true);
    assert.strictEqual(reusedSession.resumeCount, 1);
    assert.strictEqual(reusedSession.lastReuseReason, 'matching-root-session-shape');
    assert.strictEqual(snapshot.counts.reuseEvents, 1);
    assert.strictEqual(snapshot.counts.reusedSessions, 1);
    assert.strictEqual(snapshot.rootType, 'attached_client_root');
    assert.strictEqual(snapshot.userFacing, true);

    const managedMainSnapshot = buildRootSessionSnapshot({
      db,
      rootSessionId: 'managed-main-root',
      eventLimit: 50,
      terminalLimit: 20
    });
    assert(managedMainSnapshot, 'managed main snapshot should exist');
    assert.strictEqual(managedMainSnapshot.status, 'idle');
    assert.strictEqual(managedMainSnapshot.counts.running, 0);
    assert.strictEqual(managedMainSnapshot.counts.idle, 1);
    assert.strictEqual(managedMainSnapshot.rootType, 'attached_client_root');
    assert.strictEqual(managedMainSnapshot.userFacing, true);

    const recoveredMainSnapshot = buildRootSessionSnapshot({
      db,
      rootSessionId: 'recovered-main-root',
      eventLimit: 50,
      terminalLimit: 20
    });
    assert(recoveredMainSnapshot, 'recovered main snapshot should exist');
    assert.strictEqual(recoveredMainSnapshot.status, 'idle');
    assert.strictEqual(recoveredMainSnapshot.counts.running, 0);
    assert.strictEqual(recoveredMainSnapshot.counts.idle, 1);
    assert.strictEqual(recoveredMainSnapshot.rootType, 'attached_client_root');
    assert.strictEqual(recoveredMainSnapshot.userFacing, true);

    db.registerTerminal(
      'live-refresh-root',
      'cliagents-live-refresh',
      '0',
      'claude-code',
      'main_claude-code',
      'main',
      '/tmp/project',
      '/tmp/live-refresh.log',
      {
        rootSessionId: 'live-refresh-root',
        parentSessionId: null,
        sessionKind: 'main',
        originClient: 'claude',
        externalSessionRef: 'claude:thread-live-refresh',
        lineageDepth: 0,
        sessionMetadata: {
          attachMode: 'managed-root-launch',
          clientName: 'claude'
        }
      }
    );
    db.updateStatus('live-refresh-root', 'processing');
    db.addSessionEvent({
      rootSessionId: 'live-refresh-root',
      sessionId: 'live-refresh-root',
      eventType: 'session_started',
      originClient: 'claude',
      idempotencyKey: 'live-refresh-start',
      payloadJson: {
        sessionKind: 'main',
        adapter: 'claude-code',
        externalSessionRef: 'claude:thread-live-refresh'
      },
      metadata: {
        clientName: 'claude',
        attachMode: 'managed-root-launch'
      }
    });

    const liveRefreshSnapshot = buildRootSessionSnapshot({
      db,
      rootSessionId: 'live-refresh-root',
      eventLimit: 50,
      terminalLimit: 20,
      liveTerminalResolver: () => ({
        terminalId: 'live-refresh-root',
        taskState: 'idle',
        processState: 'alive',
        sessionKind: 'main',
        originClient: 'claude',
        externalSessionRef: 'claude:thread-live-refresh',
        sessionMetadata: {
          attachMode: 'managed-root-launch',
          clientName: 'claude'
        }
      })
    });
    assert(liveRefreshSnapshot, 'live refresh snapshot should exist');
    assert.strictEqual(liveRefreshSnapshot.status, 'idle');
    assert.strictEqual(liveRefreshSnapshot.counts.running, 0);
    assert.strictEqual(liveRefreshSnapshot.counts.idle, 1);

    db.addSessionEvent({
      rootSessionId: 'interrupted-root',
      sessionId: 'interrupted-root',
      eventType: 'session_started',
      originClient: 'codex',
      idempotencyKey: 'interrupted-start',
      payloadJson: {
        sessionKind: 'main',
        adapter: 'codex-cli',
        externalSessionRef: 'codex:thread-interrupted'
      },
      metadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch'
      }
    });
    db.addSessionEvent({
      rootSessionId: 'interrupted-root',
      sessionId: 'interrupted-root',
      eventType: 'session_terminated',
      originClient: 'codex',
      idempotencyKey: 'interrupted-error',
      payloadJson: {
        status: 'error',
        attentionCode: 'conversation_interrupted',
        attentionMessage: 'Conversation interrupted - tell the model what to do differently.',
        resumeCommand: 'codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'
      },
      metadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch'
      }
    });

    const interruptedSnapshot = buildRootSessionSnapshot({
      db,
      rootSessionId: 'interrupted-root',
      eventLimit: 50,
      terminalLimit: 20
    });
    assert(interruptedSnapshot, 'interrupted snapshot should exist');
    assert.strictEqual(interruptedSnapshot.status, 'needs_attention');
    assert(interruptedSnapshot.attention.requiresAttention, 'interrupted root should require attention');
    assert(interruptedSnapshot.attention.reasons.some((reason) => (
      reason.code === 'failed_session'
      && reason.resumeCommand === 'codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'
    )));

    const summaries = listRootSessionSummaries({
      db,
      limit: 10,
      eventLimit: 50,
      terminalLimit: 20
    });

    assert.strictEqual(summaries.archivedCount, 1);
    assert.strictEqual(summaries.roots.length, 5);
    const blockedRootSummary = summaries.roots.find((root) => root.rootSessionId === 'root-123');
    assert(blockedRootSummary, 'Expected blocked attached root summary');
    assert.strictEqual(blockedRootSummary.status, 'blocked');
    assert.strictEqual(blockedRootSummary.rootType, 'attached_client_root');
    assert.strictEqual(blockedRootSummary.attention.requiresAttention, true);
    assert.strictEqual(blockedRootSummary.counts.reuseEvents, 1);
    assert.strictEqual(blockedRootSummary.counts.reusedSessions, 1);
    const managedMainSummary = summaries.roots.find((root) => root.rootSessionId === 'managed-main-root');
    assert(managedMainSummary, 'Expected managed main root summary');
    assert.strictEqual(managedMainSummary.status, 'idle');
    assert.strictEqual(managedMainSummary.rootType, 'attached_client_root');
    assert.strictEqual(managedMainSummary.attention.requiresAttention, false);
    assert.strictEqual(managedMainSummary.counts.running, 0);
    assert.strictEqual(managedMainSummary.counts.idle, 1);
    const recoveredMainSummary = summaries.roots.find((root) => root.rootSessionId === 'recovered-main-root');
    assert(recoveredMainSummary, 'Expected recovered main root summary');
    assert.strictEqual(recoveredMainSummary.status, 'idle');
    assert.strictEqual(recoveredMainSummary.rootType, 'attached_client_root');
    assert.strictEqual(recoveredMainSummary.counts.running, 0);
    assert.strictEqual(recoveredMainSummary.counts.idle, 1);
    const liveRefreshSummary = summaries.roots.find((root) => root.rootSessionId === 'live-refresh-root');
    assert(liveRefreshSummary, 'Expected live-refresh root summary');
    assert.strictEqual(liveRefreshSummary.status, 'running');
    const interruptedSummary = summaries.roots.find((root) => root.rootSessionId === 'interrupted-root');
    assert(interruptedSummary, 'Expected interrupted root summary');
    assert.strictEqual(interruptedSummary.status, 'needs_attention');
    assert(interruptedSummary.attention.reasons.some((reason) => reason.resumeCommand), 'Expected interrupted summary to preserve resume command');
    assert.strictEqual(summaries.hiddenDetachedCount, 1);
    assert.strictEqual(summaries.hiddenNonUserCount, 0);

    const withArchived = listRootSessionSummaries({
      db,
      limit: 10,
      eventLimit: 50,
      terminalLimit: 20,
      includeArchived: true,
      scope: 'all'
    });
    assert.strictEqual(withArchived.archivedCount, 1);
    assert.strictEqual(withArchived.roots.length, 7);
    const archivedRoot = withArchived.roots.find((root) => root.rootSessionId === 'legacy-stale-root');
    assert(archivedRoot, 'Expected archived legacy root to be returned when requested');
    assert.strictEqual(archivedRoot.archived, true);

    const detachedOnly = listRootSessionSummaries({
      db,
      limit: 10,
      eventLimit: 50,
      terminalLimit: 20,
      scope: 'detached'
    });
    assert.strictEqual(detachedOnly.roots.length, 1);
    assert.strictEqual(detachedOnly.roots[0].rootSessionId, 'system-detached-root');
    assert.strictEqual(detachedOnly.roots[0].rootType, 'detached_worker_root');
    assert.strictEqual(detachedOnly.roots[0].userFacing, false);

    console.log('✅ Root session monitor builds blocked/attention/reuse summaries from session events and terminals');
    console.log('\nRoot session monitor tests passed');
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error('\nRoot session monitor tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
