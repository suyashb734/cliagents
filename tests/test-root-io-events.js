#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { REDACTION_PLACEHOLDER } = require('../src/security/secret-redaction');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashRootIoPayload(event) {
  return crypto.createHash('sha256').update(JSON.stringify({
    eventKind: event.eventKind,
    source: event.source,
    contentPreview: event.contentPreview || null,
    contentFull: event.contentFull || null,
    metadata: event.metadata || {}
  }), 'utf8').digest('hex');
}

function seedNativeRootFixture(db, rootDir) {
  const now = Date.now();
  const workspacePath = path.join(rootDir, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const workspaceRoot = fs.realpathSync(workspacePath);

  const task = db.createTask({
    id: 'task-native-root-io',
    title: 'Native root IO capture',
    workspaceRoot,
    brief: 'Capture native interactive root IO as redacted memory records',
    createdAt: now - 5000
  });

  db.createTaskAssignment({
    id: 'assignment-native-root-io',
    taskId: task.id,
    role: 'implement',
    instructions: 'Implement root IO persistence',
    adapter: 'codex-cli',
    model: 'gpt-5.5',
    status: 'running',
    createdAt: now - 4500
  });

  db.registerTerminal(
    'terminal-native-root-io',
    'native-root-session',
    'main',
    'codex-cli',
    null,
    'main',
    workspaceRoot,
    path.join(rootDir, 'native-root.log'),
    {
      rootSessionId: 'root-native-root-io',
      model: 'gpt-5.5',
      sessionMetadata: {
        workspaceRoot,
        taskId: task.id,
        taskAssignmentId: 'assignment-native-root-io'
      }
    }
  );

  return { taskId: task.id, projectId: task.projectId, workspaceRoot };
}

function runRootIoPersistenceTest() {
  const rootDir = makeTempDir('cliagents-root-io-events-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    const fixture = seedNativeRootFixture(db, rootDir);
    const rootColumns = db.db.prepare('PRAGMA table_info(root_io_events)').all().map((column) => column.name);
    const edgeColumns = db.db.prepare('PRAGMA table_info(memory_summary_edges)').all().map((column) => column.name);
    assert(rootColumns.includes('content_sha256'), 'root_io_events should include content hash column');
    assert(edgeColumns.includes('edge_namespace'), 'memory_summary_edges should include edge namespace');

    const event = db.appendRootIoEvent({
      idempotencyKey: 'native-root-log-span-1',
      rootSessionId: 'root-native-root-io',
      terminalId: 'terminal-native-root-io',
      taskId: fixture.taskId,
      taskAssignmentId: 'assignment-native-root-io',
      eventKind: 'output',
      source: 'terminal_log',
      contentFull: 'Using api_key=sk-1234567890abcdef1234567890 before continuing.',
      logPath: path.join(rootDir, 'native-root.log'),
      logOffsetStart: 10,
      logOffsetEnd: 78,
      metadata: {
        source: 'native-log-parser',
        nested: {
          accessToken: 'secret-token-value'
        }
      },
      occurredAt: Date.now() - 1000,
      recordedAt: Date.now() - 900
    });

    assert.strictEqual(event.eventKind, 'output');
    assert.strictEqual(event.source, 'terminal_log');
    assert.strictEqual(event.rootSessionId, 'root-native-root-io');
    assert.strictEqual(event.projectId, fixture.projectId);
    assert(event.contentFull.includes(REDACTION_PLACEHOLDER), 'content_full should be redacted on write');
    assert(!event.contentFull.includes('sk-1234567890abcdef1234567890'), 'raw OpenAI-like key must not persist');
    assert.strictEqual(event.metadata.nested.accessToken, REDACTION_PLACEHOLDER, 'secret-like metadata fields should be redacted');
    assert.strictEqual(event.contentSha256, hashRootIoPayload(event), 'hash should be over the redacted persisted payload');

    const duplicate = db.appendRootIoEvent({
      idempotencyKey: 'native-root-log-span-1',
      rootSessionId: 'root-native-root-io',
      eventKind: 'output',
      source: 'terminal_log',
      contentFull: 'different content should not overwrite idempotent event'
    });
    assert.strictEqual(duplicate.rootIoEventId, event.rootIoEventId);
    assert.strictEqual(duplicate.contentFull, event.contentFull);

    const messageId = db.addMessage('terminal-native-root-io', 'assistant', 'Parsed visible assistant message.', {
      rootSessionId: 'root-native-root-io',
      traceId: 'trace-native-root-io',
      metadata: {
        taskId: fixture.taskId,
        taskAssignmentId: 'assignment-native-root-io',
        model: 'gpt-5.5'
      }
    });
    const parsedMessages = db.listRootIoEvents({
      rootSessionId: 'root-native-root-io',
      eventKind: 'parsed_message',
      limit: 10
    });
    assert(
      parsedMessages.some((entry) => entry.metadata.sourceTable === 'messages' && entry.metadata.messageId === messageId),
      'addMessage should seed a broker parsed-message root IO event'
    );

    const records = db.queryMemoryRecords({
      rootSessionId: 'root-native-root-io',
      types: ['root_io_event'],
      q: 'native-log-parser',
      limit: 20
    });
    assert(records.some((record) => record.sourceTable === 'root_io_events' && record.sourceId === event.rootIoEventId));
    const source = db.getMemoryRecordSource('root_io_events', event.rootIoEventId);
    assert.strictEqual(source.root_io_event_id, event.rootIoEventId);
    assert.strictEqual(source.metadata.nested.accessToken, REDACTION_PLACEHOLDER);

    const edges = db.queryMemoryEdges({
      sourceTable: 'root_io_events',
      sourceId: event.rootIoEventId,
      limit: 20
    });
    assert(edges.some((edge) => edge.edgeType === 'belongs_to_root_session' && edge.targetId === 'root-native-root-io'));
    assert(edges.some((edge) => edge.edgeType === 'belongs_to_terminal' && edge.targetId === 'terminal-native-root-io'));
    assert(edges.some((edge) => edge.edgeType === 'belongs_to_task' && edge.targetId === fixture.taskId));

    db.upsertMemorySnapshot({
      id: 'snapshot-native-root-io',
      scope: 'root',
      scopeId: 'root-native-root-io',
      rootSessionId: 'root-native-root-io',
      taskId: fixture.taskId,
      brief: 'Native root IO summary',
      generationTrigger: 'manual'
    });
    const summaryEdge = db.appendMemorySummaryEdge({
      parentScopeType: 'memory_snapshot',
      parentScopeId: 'snapshot-native-root-io',
      childScopeType: 'root_io_event',
      childScopeId: event.rootIoEventId,
      edgeKind: 'summarizes',
      metadata: {
        reason: 'summary provenance',
        apiKey: 'sk-1234567890abcdef1234567890'
      }
    });
    assert.strictEqual(summaryEdge.metadata.apiKey, REDACTION_PLACEHOLDER);
    const duplicateSummaryEdge = db.appendMemorySummaryEdge({
      parentScopeType: 'memory_snapshot',
      parentScopeId: 'snapshot-native-root-io',
      childScopeType: 'root_io_event',
      childScopeId: event.rootIoEventId,
      edgeKind: 'summarizes'
    });
    assert.strictEqual(duplicateSummaryEdge.edgeId, summaryEdge.edgeId);

    assert.throws(
      () => db.appendMemorySummaryEdge({
        parentScopeType: 'root_io_event',
        parentScopeId: event.rootIoEventId,
        childScopeType: 'memory_snapshot',
        childScopeId: 'snapshot-native-root-io',
        edgeKind: 'summarizes'
      }),
      /direct cycle/i,
      'summary lineage should reject direct cycles'
    );

    const summaryEdges = db.queryMemoryEdges({
      sourceTable: 'memory_snapshots',
      sourceId: 'snapshot-native-root-io',
      targetScopeType: 'root_io_event',
      targetId: event.rootIoEventId,
      limit: 20
    });
    assert(summaryEdges.some((edge) => edge.edgeType === 'summarizes'));

    console.log('✅ Root IO events are redacted, idempotent, projected, and lineage-linked');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

try {
  runRootIoPersistenceTest();
  console.log('\nRoot IO event tests passed');
} catch (error) {
  console.error('\nRoot IO event tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
