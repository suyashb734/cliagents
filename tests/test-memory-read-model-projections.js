#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');

const PHASE1_PROJECTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_root ON projects(workspace_root);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

ALTER TABLE tasks ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC);

ALTER TABLE runs ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_id, started_at DESC);

ALTER TABLE rooms ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_rooms_project_updated ON rooms(project_id, updated_at DESC);

ALTER TABLE usage_records ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_records_project_created ON usage_records(project_id, created_at);

ALTER TABLE memory_snapshots ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project_updated ON memory_snapshots(project_id, updated_at);

ALTER TABLE terminals ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_terminals_project_created ON terminals(project_id, created_at);
`;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyRepoMigrations(targetDir, options = {}) {
  const sourceDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const omit = new Set(options.omit || []);
  const files = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (omit.has(file)) {
      continue;
    }
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
  }
}

function writePhase1Fixture(targetDir) {
  fs.writeFileSync(
    path.join(targetDir, '0013_memory_read_model_projects.sql'),
    `${PHASE1_PROJECTS_MIGRATION.trim()}\n`,
    'utf8'
  );
}

function seedProjectionFixture(db) {
  const now = Date.now();
  const workspaceRoot = fs.realpathSync(makeTempDir('cliagents-memory-read-model-workspace-'));
  const projectId = 'project_projection';
  const taskId = 'task_projection';
  const runId = 'run_projection';
  const weakRunId = 'run_weak_projection';
  const roomId = 'room_projection';
  const discussionId = 'discussion_projection';
  const terminalId = 'terminal_projection';
  const rootSessionId = 'root_projection';
  const taskAssignmentId = 'assignment_projection';

  fs.mkdirSync(workspaceRoot, { recursive: true });

  db.db.prepare(`
    INSERT INTO projects (id, workspace_root, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, workspaceRoot, JSON.stringify({ source: 'test-fixture' }), now, now);

  db.createTask({
    id: taskId,
    title: 'Projection Task',
    kind: 'research',
    brief: 'Verify memory projections',
    workspaceRoot,
    rootSessionId,
    createdAt: now,
    metadata: { suite: 'projection' }
  });
  db.db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(projectId, taskId);

  db.registerTerminal(
    terminalId,
    'projection-session',
    'main',
    'codex-cli',
    null,
    'worker',
    workspaceRoot,
    null,
    {
      rootSessionId,
      sessionKind: 'managed',
      originClient: 'codex',
      lineageDepth: 0,
      sessionMetadata: {
        workspaceRoot,
        taskId,
        taskAssignmentId,
        discussionId,
        runId
      },
      model: 'gpt-5.4'
    }
  );
  db.db.prepare('UPDATE terminals SET project_id = ? WHERE terminal_id = ?').run(projectId, terminalId);

  db.createTaskAssignment({
    id: taskAssignmentId,
    taskId,
    terminalId,
    role: 'implement',
    instructions: 'Implement the projection helper',
    adapter: 'codex-cli',
    model: 'gpt-5.4',
    status: 'running',
    acceptanceCriteria: 'Preserve source provenance',
    createdAt: now
  });

  db.createRoom({
    id: roomId,
    rootSessionId,
    taskId,
    title: 'Projection Room',
    createdAt: now
  });
  db.db.prepare('UPDATE rooms SET project_id = ? WHERE id = ?').run(projectId, roomId);

  const roomParticipant = db.addRoomParticipant({
    id: 'room_participant_projection',
    roomId,
    adapter: 'codex-cli',
    displayName: 'Projection Worker',
    model: 'gpt-5.4',
    workDir: workspaceRoot,
    status: 'active',
    createdAt: now
  });

  const roomTurn = db.createRoomTurn({
    id: 'room_turn_projection',
    roomId,
    initiatorRole: 'user',
    initiatorName: 'Supervisor',
    content: 'Keep source provenance explicit.',
    status: 'completed',
    createdAt: now
  });

  db.addRoomMessage({
    roomId,
    turnId: roomTurn.id,
    participantId: roomParticipant.id,
    role: 'assistant',
    content: 'Projection helper in progress.',
    metadata: { phase: 2 },
    createdAt: now
  });

  db.createDiscussion(discussionId, terminalId, {
    taskId,
    topic: 'Projection debate',
    metadata: { phase: 2 }
  });
  db.addDiscussionMessage(discussionId, terminalId, 'Need exact provenance on every edge.', {
    messageType: 'info'
  });

  const ledger = new RunLedgerService(db);
  ledger.createRun({
    id: runId,
    kind: 'discussion',
    status: 'completed',
    inputSummary: 'Projection review run',
    workingDirectory: workspaceRoot,
    traceId: 'trace_projection',
    discussionId,
    decisionSummary: 'Preserve direct scope lineage.',
    decisionSource: 'judge',
    startedAt: now - 4000,
    completedAt: now - 1000,
    durationMs: 3000,
    rootSessionId,
    taskId,
    metadata: { phase: 2 }
  });
  db.db.prepare('UPDATE runs SET project_id = ? WHERE id = ?').run(projectId, runId);

  ledger.createRun({
    id: weakRunId,
    kind: 'discussion',
    status: 'completed',
    inputSummary: 'Unlinked run',
    startedAt: now - 2500,
    completedAt: now - 500,
    durationMs: 2000,
    rootSessionId: 'root_weak_projection'
  });

  const participantId = ledger.addParticipant({
    id: 'run_participant_projection',
    runId,
    participantRole: 'review',
    participantName: 'Projection Reviewer',
    adapter: 'codex-cli',
    status: 'completed',
    startedAt: now - 3500,
    endedAt: now - 1200,
    metadata: { focus: 'provenance' }
  });

  const stepId = ledger.appendStep({
    id: 'run_step_projection',
    runId,
    participantId,
    stepKey: 'review-provenance',
    stepName: 'Review Provenance',
    status: 'completed',
    startedAt: now - 3400,
    completedAt: now - 1300,
    metadata: { strict: true }
  });

  ledger.appendInput({
    id: 'run_input_projection',
    runId,
    participantId,
    inputKind: 'participant_prompt',
    content: 'Synthesize provenance guarantees.',
    metadata: { phase: 2 },
    createdAt: now - 3300
  });

  ledger.appendOutput({
    id: 'run_output_projection',
    runId,
    participantId,
    outputKind: 'participant_final',
    content: 'All projected records keep their source table and id.',
    createdAt: now - 1200
  });

  ledger.appendToolEvent({
    id: 'run_tool_projection',
    runId,
    participantId,
    stepId,
    toolClass: 'database',
    toolName: 'queryMemoryRecords',
    content: 'Executed projection verification query.',
    status: 'completed',
    startedAt: now - 3100,
    completedAt: now - 3000,
    metadata: { kind: 'verification' }
  });

  db.addSessionEvent({
    id: 'session_event_projection',
    idempotencyKey: 'projection-root-started',
    rootSessionId,
    sessionId: terminalId,
    runId,
    discussionId,
    traceId: 'trace_projection',
    eventType: 'session_started',
    originClient: 'codex',
    payloadSummary: 'Projection session started',
    payloadJson: { phase: 2, provenance: true },
    occurredAt: now - 3900
  });

  db.addMessage(terminalId, 'assistant', 'Projection helper landed with provenance intact.', {
    traceId: 'trace_projection',
    metadata: { runId, taskId, taskAssignmentId, model: 'gpt-5.4' },
    rootSessionId
  });

  const usageRecordId = db.addUsageRecord({
    terminalId,
    rootSessionId,
    runId,
    taskId,
    taskAssignmentId,
    inputTokens: 13,
    outputTokens: 8,
    totalTokens: 21,
    adapter: 'codex-cli',
    model: 'gpt-5.4',
    sourceConfidence: 'provider_reported',
    metadata: { phase: 2 },
    createdAt: now - 900
  });
  db.db.prepare('UPDATE usage_records SET project_id = ? WHERE id = ?').run(projectId, usageRecordId);

  const artifactId = db.storeArtifact(taskId, 'projection-helper', 'function queryMemoryRecords() {}', {
    type: 'code',
    metadata: { file: 'src/database/db.js' }
  });
  const findingId = db.storeFinding(taskId, terminalId, 'Provenance coverage preserved for projected edges.', {
    type: 'suggestion',
    severity: 'medium',
    metadata: { source: 'test-fixture' }
  });
  const contextId = db.storeContext(taskId, terminalId, {
    summary: 'Projection status summary',
    keyDecisions: ['Keep source_table/source_id on every row'],
    pendingItems: ['Wire HTTP query routes in Phase 3']
  });

  db.upsertMemorySnapshot({
    id: 'snapshot_projection',
    scope: 'run',
    scopeId: runId,
    runId,
    rootSessionId,
    taskId,
    brief: 'Run projection snapshot',
    keyDecisions: ['Keep source provenance explicit'],
    pendingItems: ['Add HTTP query routes'],
    generationTrigger: 'manual',
    createdAt: now - 800,
    updatedAt: now - 700
  });
  db.db.prepare('UPDATE memory_snapshots SET project_id = ? WHERE id = ?').run(projectId, 'snapshot_projection');

  db.appendOperatorAction({
    actionId: 'operator_action_projection',
    runId,
    terminalId,
    actionKind: 'operator_reply',
    payload: { message: 'Proceed with provenance checks.' },
    createdAt: now - 600
  });

  db.appendRunBlockedState({
    id: 'run_blocked_projection',
    runId,
    blockedReason: 'waiting_for_input',
    blockingDetail: 'Awaiting scope confirmation',
    metadata: { source: 'test-fixture' },
    createdAt: now - 500
  });

  return {
    projectId,
    workspaceRoot,
    taskId,
    runId,
    weakRunId,
    roomId,
    discussionId,
    terminalId,
    taskAssignmentId,
    artifactId,
    findingId,
    contextId,
    usageRecordId,
    participantId
  };
}

function runPrerequisiteGuardTest() {
  const rootDir = makeTempDir('cliagents-memory-projection-guard-');
  const migrationsDir = path.join(rootDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  copyRepoMigrations(migrationsDir, {
    omit: [
      '0013_memory_read_model_projects.sql',
      '0014_memory_read_model_projections.sql'
    ]
  });
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir,
    migrationsDir
  });

  try {
    assert.throws(
      () => db.queryMemoryRecords({ limit: 1 }),
      /Phase 1/i,
      'queryMemoryRecords should fail clearly until Phase 1 schema lands'
    );
    assert.throws(
      () => db.queryMemoryEdges({ limit: 1 }),
      /Phase 1/i,
      'queryMemoryEdges should fail clearly until Phase 1 schema lands'
    );
    console.log('✅ Phase 2 helpers guard on missing Phase 1 schema');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function runProjectionQueryTest() {
  const rootDir = makeTempDir('cliagents-memory-projection-happy-');
  const migrationsDir = path.join(rootDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  copyRepoMigrations(migrationsDir);
  writePhase1Fixture(migrationsDir);

  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir,
    migrationsDir
  });

  try {
    const migrationVersions = db.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
    assert(migrationVersions.includes('0014_memory_read_model_projections.sql'), 'projection migration should be applied');

    const fixture = seedProjectionFixture(db);

    const recordTypes = new Set(db.queryMemoryRecords({
      projectId: fixture.projectId,
      limit: 200
    }).map((row) => row.recordType));

    for (const expectedType of [
      'project',
      'task',
      'task_assignment',
      'terminal',
      'session_event',
      'message',
      'run',
      'run_participant',
      'run_step',
      'run_input',
      'run_output',
      'run_tool_event',
      'room',
      'room_participant',
      'room_turn',
      'room_message',
      'discussion',
      'discussion_message',
      'usage_record',
      'artifact',
      'finding',
      'context',
      'memory_snapshot',
      'operator_action',
      'run_blocked_state'
    ]) {
      assert(recordTypes.has(expectedType), `expected projected record type: ${expectedType}`);
    }

    const runRecord = db.getMemoryRecord('runs', fixture.runId);
    assert(runRecord, 'run record should be queryable from the projection view');
    assert.strictEqual(runRecord.sourceTable, 'runs');
    assert.strictEqual(runRecord.sourceId, fixture.runId);
    assert.strictEqual(runRecord.recordType, 'run');
    assert.strictEqual(runRecord.projectId, fixture.projectId);
    assert.strictEqual(runRecord.workspaceRoot, fixture.workspaceRoot);
    assert.strictEqual(runRecord.taskId, fixture.taskId);
    assert.strictEqual(runRecord.rootSessionId, 'root_projection');
    assert.strictEqual(runRecord.runId, fixture.runId);
    assert(runRecord.searchText.includes('Projection review run'));

    const searched = db.queryMemoryRecords({ q: 'source provenance explicit', limit: 20 });
    assert(
      searched.some((row) => row.sourceTable === 'memory_snapshots' && row.sourceId === 'snapshot_projection'),
      'text search should find snapshot brief content'
    );

    const sourceRun = db.getMemoryRecordSource('runs', fixture.runId);
    assert(sourceRun, 'source run row should be available for drill-back');
    assert.strictEqual(sourceRun.id, fixture.runId);
    assert.strictEqual(sourceRun.project_id, fixture.projectId);

    const artifactRecord = db.getMemoryRecord('artifacts', fixture.artifactId);
    assert.strictEqual(artifactRecord.taskId, fixture.taskId);
    assert.strictEqual(artifactRecord.projectId, fixture.projectId);

    const contextRecord = db.getMemoryRecord('context', fixture.contextId);
    assert.strictEqual(contextRecord.taskId, fixture.taskId);
    assert.strictEqual(contextRecord.rootSessionId, 'root_projection');

    const runEdges = db.queryMemoryEdges({
      sourceTable: 'runs',
      sourceId: fixture.runId,
      limit: 20
    });
    const runEdgeMap = new Map(runEdges.map((edge) => [`${edge.edgeType}:${edge.targetScopeType}:${edge.targetId}`, edge]));
    assert(runEdgeMap.has(`belongs_to_project:project:${fixture.projectId}`), 'run should link to project scope');
    assert(runEdgeMap.has(`belongs_to_task:task:${fixture.taskId}`), 'run should link to task scope');
    assert(runEdgeMap.has('belongs_to_root_session:root_session:root_projection'), 'run should link to root session scope');
    assert(runEdgeMap.has(`belongs_to_discussion:discussion:${fixture.discussionId}`), 'run should link to discussion scope');
    assert(runEdgeMap.has('belongs_to_trace:trace:trace_projection'), 'run should link to trace scope');
    assert.strictEqual(runEdges[0].sourceTable, 'runs');
    assert.strictEqual(runEdges[0].sourceId, fixture.runId);

    const taskEdges = db.queryMemoryEdges({
      targetScopeType: 'task',
      targetId: fixture.taskId,
      limit: 100
    });
    assert(
      taskEdges.some((edge) => edge.sourceTable === 'artifacts' && edge.sourceId === fixture.artifactId),
      'artifact records should emit task lineage edges'
    );
    assert(
      taskEdges.some((edge) => edge.sourceTable === 'usage_records' && edge.sourceId === String(fixture.usageRecordId)),
      'usage records should emit task lineage edges'
    );

    const weakRunEdges = db.queryMemoryEdges({
      sourceTable: 'runs',
      sourceId: fixture.weakRunId,
      limit: 20
    });
    assert(
      !weakRunEdges.some((edge) => edge.targetScopeType === 'task' || edge.targetScopeType === 'project'),
      'unlinked runs must not invent task/project edges'
    );

    console.log('✅ Phase 2 projections expose source provenance, scopes, and lineage edges');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

try {
  runPrerequisiteGuardTest();
  runProjectionQueryTest();
  console.log('\nMemory read-model projection tests passed');
} catch (error) {
  console.error('\nMemory read-model projection tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
