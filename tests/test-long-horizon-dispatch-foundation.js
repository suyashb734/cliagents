#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tableExists(db, tableName) {
  const row = db.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return Boolean(row);
}

function run() {
  const rootDir = makeTempDir('cliagents-long-horizon-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    assert(tableExists(db, 'dispatch_requests'), 'dispatch_requests table should exist');
    assert(tableExists(db, 'run_context_snapshots'), 'run_context_snapshots table should exist');
    assert(tableExists(db, 'task_session_bindings'), 'task_session_bindings table should exist');

    const dispatch = db.createDispatchRequest({
      id: 'dispatch-1',
      idempotencyKey: 'dispatch-key-1',
      rootSessionId: 'root-1',
      taskId: 'task-1',
      taskAssignmentId: 'assignment-1',
      requestKind: 'assignment_start',
      coalesceKey: 'task-1:assignment-1',
      requestedBy: 'supervisor',
      metadata: {
        note: 'queued before spawn'
      },
      createdAt: 1000
    });
    assert.strictEqual(dispatch.id, 'dispatch-1');
    assert.strictEqual(dispatch.status, 'queued');
    assert.strictEqual(dispatch.taskAssignmentId, 'assignment-1');

    const duplicate = db.createDispatchRequest({
      id: 'dispatch-duplicate',
      idempotencyKey: 'dispatch-key-1',
      rootSessionId: 'root-1',
      requestKind: 'assignment_start'
    });
    assert.strictEqual(duplicate.id, 'dispatch-1', 'idempotency should return the original request');

    const snapshot = db.createRunContextSnapshot({
      id: 'context-1',
      dispatchRequestId: 'dispatch-1',
      workspacePath: rootDir,
      contextMode: 'task_assignment',
      promptBody: 'Run the task with OPENAI_API_KEY=sk-12345678901234567890 and report back.',
      linkedContext: {
        taskId: 'task-1',
        accessToken: 'secret-token-value'
      },
      toolPolicy: {
        allowedTools: ['read', 'test']
      },
      adapter: 'codex-cli',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      createdAt: 1200
    });
    assert.strictEqual(snapshot.contextSnapshotId, 'context-1');
    assert.strictEqual(snapshot.dispatchRequestId, 'dispatch-1');
    assert(snapshot.contentSha256, 'context snapshot should have a content hash');
    assert(!snapshot.promptBody.includes('sk-12345678901234567890'), 'prompt body should be redacted before persistence');
    assert.strictEqual(snapshot.linkedContext.accessToken, '[REDACTED_SECRET]');
    assert.strictEqual(snapshot.metadata.security.redactedSecretLikeContent, true);
    assert.strictEqual(db.getDispatchRequest('dispatch-1').contextSnapshotId, 'context-1');

    assert.throws(
      () => db.db.prepare('UPDATE run_context_snapshots SET prompt_body = ? WHERE context_snapshot_id = ?').run('changed', 'context-1'),
      /immutable/,
      'run context snapshots should be immutable'
    );

    const spawned = db.updateDispatchRequest('dispatch-1', {
      status: 'spawned',
      terminalId: 'term-1',
      runId: 'run-1',
      boundSessionId: 'session-1',
      dispatchedAt: 1300,
      updatedAt: 1300
    });
    assert.strictEqual(spawned.status, 'spawned');
    assert.strictEqual(spawned.terminalId, 'term-1');
    assert.strictEqual(spawned.runId, 'run-1');
    assert.strictEqual(db.listDispatchRequests({ taskAssignmentId: 'assignment-1' }).length, 1);

    const binding = db.createTaskSessionBinding({
      id: 'binding-1',
      taskId: 'task-1',
      taskAssignmentId: 'assignment-1',
      adapter: 'codex-cli',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      terminalId: 'term-1',
      providerSessionId: 'provider-1',
      runtimeHost: 'tmux',
      runtimeFidelity: 'managed-tmux',
      reusePolicy: 'compatible-default',
      reuseDecision: {
        reused: false,
        reason: 'first binding'
      },
      createdAt: 1400
    });
    assert.strictEqual(binding.bindingId, 'binding-1');
    assert.strictEqual(binding.reuseDecision.reused, false);
    assert.strictEqual(db.listTaskSessionBindings({ taskId: 'task-1' }).length, 1);

    assert.throws(
      () => db.db.prepare('UPDATE task_session_bindings SET status = ? WHERE binding_id = ?').run('superseded', 'binding-1'),
      /append-only/,
      'task session bindings should be append-only'
    );

    console.log('✅ Long-horizon dispatch foundation persists requests, immutable context, and append-only bindings');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error('\nLong-horizon dispatch foundation tests failed:', error);
  process.exit(1);
}
