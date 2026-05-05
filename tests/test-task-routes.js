#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyMigration(sourceDir, targetDir, fileName) {
  fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
}

function loadCreateOrchestrationRouter() {
  const routerPath = require.resolve('../src/server/orchestration-router');
  delete require.cache[routerPath];
  return require('../src/server/orchestration-router').createOrchestrationRouter;
}

function createFakeSessionManager() {
  const state = {
    createCalls: [],
    sendCalls: [],
    terminals: new Map()
  };
  let counter = 0;

  return {
    state,
    async createTerminal(options = {}) {
      counter += 1;
      const terminalId = `term-${counter}`;
      const terminal = {
        terminalId,
        adapter: options.adapter || 'codex-cli',
        model: options.model || null,
        role: options.agentProfile || null,
        status: 'processing',
        taskState: 'processing',
        rootSessionId: options.rootSessionId || null,
        parentSessionId: options.parentSessionId || null,
        sessionKind: options.sessionKind || null
      };
      state.createCalls.push({
        ...options,
        terminalId
      });
      state.terminals.set(terminalId, terminal);
      return {
        terminalId,
        reused: false,
        reuseReason: null
      };
    },
    async sendInput(terminalId, message) {
      state.sendCalls.push({ terminalId, message });
      return { terminalId, message };
    },
    getTerminal(terminalId) {
      return state.terminals.get(terminalId) || null;
    }
  };
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', loadCreateOrchestrationRouter()(context));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function stopApp(serverHandle) {
  await new Promise((resolve, reject) => {
    serverHandle.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function request(baseUrl, method, route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

function getColumnNames(db, tableName) {
  return db.db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

async function runMigrationAssertions() {
  const rootDir = makeTempDir('cliagents-tasks-v1-migrate-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const limitedMigrationsDir = path.join(rootDir, 'migrations-pre-0009');
  const fullMigrationsDir = path.join(__dirname, '../src/database/migrations');
  fs.mkdirSync(limitedMigrationsDir, { recursive: true });

  try {
    for (const fileName of [
      '0001_run_ledger_core.sql',
      '0002_run_ledger_inputs.sql',
      '0003_session_control_plane_scaffold.sql',
      '0004_terminal_identity_and_adoption.sql',
      '0005_usage_records.sql',
      '0006_memory_snapshots.sql',
      '0007_resume_linkage_and_recency.sql',
      '0008_provider_sessions_and_rooms.sql'
    ]) {
      copyMigration(fullMigrationsDir, limitedMigrationsDir, fileName);
    }

    const legacyDb = new OrchestrationDB({
      dbPath,
      dataDir: rootDir,
      migrationsDir: limitedMigrationsDir
    });

    const ledger = new RunLedgerService(legacyDb);
    ledger.createRun({
      id: 'run-legacy-task',
      kind: 'discussion',
      status: 'completed',
      inputSummary: 'Legacy run title',
      workingDirectory: '/tmp/legacy-workspace',
      rootSessionId: 'root-legacy',
      taskId: 'task-legacy-run'
    });
    legacyDb.createDiscussion('discussion-legacy-task', 'terminal-1', {
      taskId: 'task-legacy-discussion',
      topic: 'Legacy discussion title'
    });
    legacyDb.storeArtifact('task-legacy-artifact', 'artifact-key', 'artifact payload');
    legacyDb.storeFinding('room:legacy-room', 'agent-1', 'synthetic room id should stay legacy');
    legacyDb.close();

    const migratedDb = new OrchestrationDB({
      dbPath,
      dataDir: rootDir,
      migrationsDir: fullMigrationsDir
    });

    try {
      assert(getColumnNames(migratedDb, 'rooms').includes('task_id'), 'rooms.task_id should exist after migration');
      assert(getColumnNames(migratedDb, 'tasks').includes('workspace_root'), 'tasks table should exist after migration');
      assert(getColumnNames(migratedDb, 'task_assignments').includes('instructions'), 'task_assignments table should exist after migration');

      const runBackfilled = migratedDb.getTask('task-legacy-run');
      assert(runBackfilled, 'run-backed task should be materialized');
      assert.strictEqual(runBackfilled.title, 'Legacy run title');
      assert.strictEqual(runBackfilled.workspaceRoot, '/tmp/legacy-workspace');
      assert.strictEqual(runBackfilled.rootSessionId, 'root-legacy');
      assert.strictEqual(runBackfilled.kind, 'general');
      assert.strictEqual(runBackfilled.metadata.backfilled, true);

      const discussionBackfilled = migratedDb.getTask('task-legacy-discussion');
      assert(discussionBackfilled, 'discussion-backed task should be materialized');
      assert.strictEqual(discussionBackfilled.title, 'Legacy discussion title');
      assert.strictEqual(discussionBackfilled.workspaceRoot, null);

      const artifactBackfilled = migratedDb.getTask('task-legacy-artifact');
      assert(artifactBackfilled, 'artifact-backed task should be materialized');
      assert.strictEqual(artifactBackfilled.title, 'Task task-legacy-artifact');
      assert.strictEqual(artifactBackfilled.workspaceRoot, null);

      assert.strictEqual(migratedDb.getTask('room:legacy-room'), null, 'synthetic room task ids should be skipped during backfill');
    } finally {
      migratedDb.close();
    }

    console.log('✅ Tasks V1 migration backfills historical task ids and skips synthetic room ids');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runRouteAssertions() {
  const rootDir = makeTempDir('cliagents-task-routes-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const ledger = new RunLedgerService(db);
  const sessionManager = createFakeSessionManager();
  const discussionCalls = [];
  let serverHandle = null;

  try {
    serverHandle = await startApp({
      db,
      sessionManager,
      adapterAuthInspector: () => ({ authenticated: true, reason: null }),
      roomDiscussionRunner: async (_manager, _message, options = {}) => {
        discussionCalls.push(options);
        return {
          runId: `run-${discussionCalls.length}`,
          discussionId: `discussion-${discussionCalls.length}`,
          participants: (options.participants || []).map((participant) => ({
            participantRef: participant.participantRef,
            name: participant.name,
            adapter: participant.adapter,
            success: true
          })),
          rounds: [
            {
              name: 'position',
              responses: (options.participants || []).map((participant) => ({
                participantRef: participant.participantRef,
                adapter: participant.adapter,
                success: true,
                output: 'OK'
              }))
            }
          ],
          judge: null
        };
      }
    });

    const missingWorkspace = await request(serverHandle.baseUrl, 'POST', '/orchestration/tasks', {
      title: 'Task without workspace'
    });
    assert.strictEqual(missingWorkspace.status, 400);
    assert.strictEqual(missingWorkspace.data.error.param, 'workspaceRoot');

    const createTaskRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/tasks', {
      title: 'Implement Tasks V1',
      workspaceRoot: rootDir,
      brief: 'Create the first task object.'
    });
    assert.strictEqual(createTaskRes.status, 200);
    assert.strictEqual(createTaskRes.data.status, 'pending');
    const taskId = createTaskRes.data.task.id;
    const worktreePath = path.join(rootDir, 'task-worktree');

    const missingRole = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      instructions: 'Implement the feature.'
    });
    assert.strictEqual(missingRole.status, 400);
    assert.strictEqual(missingRole.data.error.param, 'role');

    const createAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Implement the feature and add tests.',
      worktreePath,
      worktreeBranch: 'task/tasks-v1'
    });
    assert.strictEqual(createAssignmentRes.status, 200);
    assert.strictEqual(createAssignmentRes.data.assignment.status, 'queued');
    assert.strictEqual(createAssignmentRes.data.assignment.worktreePath, worktreePath);
    const assignmentId = createAssignmentRes.data.assignment.id;

    const patchAssignmentRes = await request(serverHandle.baseUrl, 'PATCH', `/orchestration/tasks/${taskId}/assignments/${assignmentId}`, {
      instructions: 'Implement the feature, add tests, and report status.',
      worktreeBranch: 'task/tasks-v1-updated'
    });
    assert.strictEqual(patchAssignmentRes.status, 200);
    assert.strictEqual(patchAssignmentRes.data.assignment.instructions, 'Implement the feature, add tests, and report status.');
    assert.strictEqual(patchAssignmentRes.data.assignment.worktreeBranch, 'task/tasks-v1-updated');

    fs.mkdirSync(worktreePath, { recursive: true });

    const startAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments/${assignmentId}/start`, {
      rootSessionId: 'root-task-routes',
      parentSessionId: 'root-task-routes',
      originClient: 'test',
      externalSessionRef: 'test:task-routes'
    });
    assert.strictEqual(startAssignmentRes.status, 200);
    assert.strictEqual(startAssignmentRes.data.assignment.status, 'running');
    assert(startAssignmentRes.data.assignment.terminalId, 'started assignment should be linked to a terminal');
    assert.strictEqual(sessionManager.state.createCalls.length, 1);
    assert.strictEqual(sessionManager.state.sendCalls.length, 1);
    assert.strictEqual(sessionManager.state.createCalls[0].workDir, worktreePath);
    assert.strictEqual(sessionManager.state.createCalls[0].sessionMetadata.taskId, taskId);
    assert.strictEqual(sessionManager.state.createCalls[0].sessionMetadata.taskAssignmentId, assignmentId);
    assert.strictEqual(sessionManager.state.sendCalls[0].message, 'Implement the feature, add tests, and report status.');
    assert.strictEqual(sessionManager.state.createCalls[0].rootSessionId, 'root-task-routes');

    db.addUsageRecord({
      rootSessionId: 'root-task-routes',
      terminalId: startAssignmentRes.data.assignment.terminalId,
      taskId,
      taskAssignmentId: assignmentId,
      adapter: 'codex-cli',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      sourceConfidence: 'estimated',
      metadata: {
        taskId,
        taskAssignmentId: assignmentId,
        role: 'worker'
      }
    });
    ledger.createRun({
      id: 'run-task-route-1',
      kind: 'discussion',
      status: 'completed',
      inputSummary: 'Task-linked run',
      rootSessionId: 'root-task-routes',
      taskId,
      startedAt: Date.now(),
      completedAt: Date.now()
    });

    const getTaskRes = await request(serverHandle.baseUrl, 'GET', `/orchestration/tasks/${taskId}`);
    assert.strictEqual(getTaskRes.status, 200);
    assert.strictEqual(getTaskRes.data.status, 'running');
    assert.strictEqual(getTaskRes.data.assignmentCounts.running, 1);
    assert.strictEqual(getTaskRes.data.linkedCounts.rooms, 0);
    assert.strictEqual(getTaskRes.data.usageSummary.totalTokens, 15);
    assert.strictEqual(getTaskRes.data.usageAttribution.executionTokens, 15);
    assert.strictEqual(getTaskRes.data.recentRuns[0].id, 'run-task-route-1');

    const listAssignmentsRes = await request(serverHandle.baseUrl, 'GET', `/orchestration/tasks/${taskId}/assignments`);
    assert.strictEqual(listAssignmentsRes.status, 200);
    assert.strictEqual(listAssignmentsRes.data.assignments.length, 1);
    assert.strictEqual(listAssignmentsRes.data.assignments[0].status, 'running');
    assert.strictEqual(listAssignmentsRes.data.assignments[0].terminalStatus, 'processing');
    assert.strictEqual(listAssignmentsRes.data.assignments[0].usageSummary.totalTokens, 15);

    const liveTerminal = sessionManager.state.terminals.get(startAssignmentRes.data.assignment.terminalId);
    liveTerminal.status = 'error';
    liveTerminal.taskState = 'error';
    const failedTaskRes = await request(serverHandle.baseUrl, 'GET', `/orchestration/tasks/${taskId}`);
    assert.strictEqual(failedTaskRes.status, 200);
    assert.strictEqual(failedTaskRes.data.status, 'failed');

    const supersedeRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${assignmentId}/supersede`,
      {
        reason: 'provider model mismatch',
        replacement: {
          id: 'assignment-retry-gpt54',
          model: 'gpt-5.4',
          metadata: {
            startPolicy: 'after-phase0-contract'
          }
        }
      }
    );
    assert.strictEqual(supersedeRes.status, 200);
    assert.strictEqual(supersedeRes.data.assignment.status, 'superseded');
    assert.strictEqual(supersedeRes.data.assignment.terminalStatus, 'error');
    assert.strictEqual(supersedeRes.data.replacement.id, 'assignment-retry-gpt54');
    assert.strictEqual(supersedeRes.data.replacement.model, 'gpt-5.4');
    assert.strictEqual(supersedeRes.data.replacement.metadata.supersedes, assignmentId);
    assert.strictEqual(supersedeRes.data.replacement.metadata.startPolicy, 'after-phase0-contract');
    assert.strictEqual(supersedeRes.data.task.status, 'pending');
    assert.strictEqual(supersedeRes.data.task.assignmentCounts.superseded, 1);
    assert.strictEqual(supersedeRes.data.task.assignmentCounts.queued, 1);

    const createRoomWithTaskRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/rooms', {
      title: 'Task-linked room',
      taskId,
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex' }
      ]
    });
    assert.strictEqual(createRoomWithTaskRes.status, 200);
    assert.strictEqual(createRoomWithTaskRes.data.room.taskId, taskId);
    const roomWithTaskId = createRoomWithTaskRes.data.room.id;

    const createRoomWithoutTaskRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/rooms', {
      title: 'Unlinked room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex' }
      ]
    });
    assert.strictEqual(createRoomWithoutTaskRes.status, 200);
    assert.strictEqual(createRoomWithoutTaskRes.data.room.taskId, null);
    const roomWithoutTaskId = createRoomWithoutTaskRes.data.room.id;

    const discussLinkedRoomRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/rooms/${roomWithTaskId}/discuss`, {
      message: 'Debate the current task plan.'
    });
    assert.strictEqual(discussLinkedRoomRes.status, 200);
    assert.strictEqual(discussionCalls[0].taskId, taskId);

    const discussUnlinkedRoomRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/rooms/${roomWithoutTaskId}/discuss`, {
      message: 'Debate without a task.'
    });
    assert.strictEqual(discussUnlinkedRoomRes.status, 200);
    assert.strictEqual(discussionCalls[1].taskId, null);

    console.log('✅ Task routes create, patch, start, and link rooms to canonical task ids');
  } finally {
    if (serverHandle) {
      await stopApp(serverHandle.server);
    }
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function run() {
  await runMigrationAssertions();
  await runRouteAssertions();
}

run().then(() => {
  console.log('\nTask route tests passed');
}).catch((error) => {
  console.error('\nTask route tests failed:', error);
  process.exit(1);
});
