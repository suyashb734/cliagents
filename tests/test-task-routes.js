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
        requestedModel: options.model || null,
        effectiveModel: options.model || null,
        requestedEffort: options.reasoningEffort || null,
        effectiveEffort: options.reasoningEffort || null,
        role: options.agentProfile || null,
        status: 'processing',
        taskState: 'processing',
        rootSessionId: options.rootSessionId || null,
        parentSessionId: options.parentSessionId || null,
        sessionKind: options.sessionKind || null,
        providerThreadRef: `provider-${terminalId}`,
        runtimeHost: 'tmux',
        runtimeFidelity: 'managed',
        activeRun: null
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
      const terminal = state.terminals.get(terminalId);
      if (terminal) {
        terminal.activeRun = { runId: `run-${terminalId}` };
        terminal.status = 'processing';
        terminal.taskState = 'processing';
      }
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
      assert(getColumnNames(migratedDb, 'task_assignments').includes('branch_name'), 'task_assignments should include branch orchestration columns');
      assert(
        migratedDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_assignment_path_leases'").get(),
        'task_assignment_path_leases table should exist after migration'
      );

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

    const invalidEffort = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Implement the feature.',
      reasoningEffort: 'maximum'
    });
    assert.strictEqual(invalidEffort.status, 400);
    assert.strictEqual(invalidEffort.data.error.param, 'reasoningEffort');

    const createAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Implement the feature and add tests.',
      reasoningEffort: 'high',
      worktreePath,
      worktreeBranch: 'task/tasks-v1',
      branchName: 'task/tasks-v1',
      baseBranch: 'main',
      mergeTarget: 'main',
      writePaths: ['src/tasks.js']
    });
    assert.strictEqual(createAssignmentRes.status, 200);
    assert.strictEqual(createAssignmentRes.data.assignment.status, 'queued');
    assert.strictEqual(createAssignmentRes.data.assignment.reasoningEffort, 'high');
    assert.strictEqual(createAssignmentRes.data.assignment.worktreePath, worktreePath);
    assert.strictEqual(createAssignmentRes.data.assignment.branch.branchName, 'task/tasks-v1');
    assert.strictEqual(createAssignmentRes.data.assignment.branch.status, 'planned');
    assert.deepStrictEqual(createAssignmentRes.data.assignment.branch.writePaths, ['src/tasks.js']);
    assert(createAssignmentRes.data.assignment.branch.pathLeaseId, 'assignment with write paths should acquire a path lease');
    const assignmentId = createAssignmentRes.data.assignment.id;

    const conflictingAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Try to edit the same file.',
      worktreePath: path.join(rootDir, 'conflicting-task-worktree'),
      worktreeBranch: 'task/tasks-v1-conflict',
      branchName: 'task/tasks-v1-conflict',
      writePaths: ['src/tasks.js']
    });
    assert.strictEqual(conflictingAssignmentRes.status, 409);
    assert.strictEqual(conflictingAssignmentRes.data.error.code, 'path_lease_conflict');

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
      externalSessionRef: 'test:task-routes',
      reasoningEffort: 'xhigh'
    });
    assert.strictEqual(startAssignmentRes.status, 200);
    assert.strictEqual(startAssignmentRes.data.assignment.status, 'running');
    assert.strictEqual(startAssignmentRes.data.assignment.reasoningEffort, 'xhigh');
    assert.strictEqual(startAssignmentRes.data.assignment.branch.status, 'running');
    assert.strictEqual(startAssignmentRes.data.assignment.branch.pathLease.status, 'active');
    assert(startAssignmentRes.data.assignment.terminalId, 'started assignment should be linked to a terminal');
    assert.strictEqual(startAssignmentRes.data.assignment.dispatch.status, 'spawned');
    assert.strictEqual(startAssignmentRes.data.assignment.dispatchRequests.length, 1);
    assert.strictEqual(startAssignmentRes.data.assignment.taskSessionBindings.length, 1);
    assert.strictEqual(sessionManager.state.createCalls.length, 1);
    assert.strictEqual(sessionManager.state.sendCalls.length, 1);
    assert.strictEqual(sessionManager.state.createCalls[0].workDir, worktreePath);
    assert.strictEqual(sessionManager.state.createCalls[0].sessionMetadata.taskId, taskId);
    assert.strictEqual(sessionManager.state.createCalls[0].sessionMetadata.taskAssignmentId, assignmentId);
    assert.strictEqual(sessionManager.state.createCalls[0].reasoningEffort, 'xhigh');
    assert.strictEqual(sessionManager.state.sendCalls[0].message, 'Implement the feature, add tests, and report status.');
    assert.strictEqual(sessionManager.state.createCalls[0].rootSessionId, 'root-task-routes');
    assert(startAssignmentRes.data.dispatch.dispatchRequestId, 'start response should expose dispatch request linkage');
    assert(startAssignmentRes.data.dispatch.contextSnapshotId, 'start response should expose context snapshot linkage');
    assert(startAssignmentRes.data.dispatch.taskSessionBindingId, 'start response should expose task session binding linkage');

    const dispatches = db.listDispatchRequests({ taskAssignmentId: assignmentId });
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].status, 'spawned');
    assert.strictEqual(dispatches[0].taskId, taskId);
    assert.strictEqual(dispatches[0].rootSessionId, 'root-task-routes');
    assert.strictEqual(dispatches[0].terminalId, startAssignmentRes.data.assignment.terminalId);
    assert.strictEqual(dispatches[0].runId, `run-${startAssignmentRes.data.assignment.terminalId}`);
    assert.strictEqual(dispatches[0].contextSnapshotId, startAssignmentRes.data.dispatch.contextSnapshotId);
    assert.strictEqual(dispatches[0].boundSessionId, startAssignmentRes.data.dispatch.taskSessionBindingId);

    const contextSnapshot = db.getRunContextSnapshot(startAssignmentRes.data.dispatch.contextSnapshotId);
    assert.strictEqual(contextSnapshot.dispatchRequestId, startAssignmentRes.data.dispatch.dispatchRequestId);
    assert.strictEqual(contextSnapshot.workspacePath, worktreePath);
    assert.strictEqual(contextSnapshot.contextMode, 'task_assignment');
    assert(contextSnapshot.promptBody.includes('Implement the feature'), 'context snapshot should persist the assignment prompt');
    assert.strictEqual(contextSnapshot.linkedContext.task.id, taskId);
    assert.strictEqual(contextSnapshot.linkedContext.assignment.id, assignmentId);
    assert.strictEqual(contextSnapshot.linkedContext.assignment.reasoningEffort, 'xhigh');
    assert.strictEqual(contextSnapshot.linkedContext.assignment.branchName, 'task/tasks-v1');
    assert.deepStrictEqual(contextSnapshot.linkedContext.assignment.writePaths, ['src/tasks.js']);

    const sessionBindings = db.listTaskSessionBindings({ taskAssignmentId: assignmentId });
    assert.strictEqual(sessionBindings.length, 1);
    assert.strictEqual(sessionBindings[0].rootSessionId, 'root-task-routes');
    assert.strictEqual(sessionBindings[0].taskId, taskId);
    assert.strictEqual(sessionBindings[0].terminalId, startAssignmentRes.data.assignment.terminalId);
    assert.strictEqual(sessionBindings[0].providerSessionId, `provider-${startAssignmentRes.data.assignment.terminalId}`);
    assert.strictEqual(sessionBindings[0].runtimeHost, 'tmux');
    assert.strictEqual(sessionBindings[0].runtimeFidelity, 'managed');
    assert.strictEqual(sessionBindings[0].reuseDecision.reused, false);

    const dispatchPolicyTaskRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/tasks', {
      title: 'Dispatch policy task',
      workspaceRoot: rootDir
    });
    assert.strictEqual(dispatchPolicyTaskRes.status, 200);
    const dispatchPolicyTaskId = dispatchPolicyTaskRes.data.task.id;

    const deferredAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${dispatchPolicyTaskId}/assignments`, {
      role: 'executor',
      instructions: 'Run this later.'
    });
    assert.strictEqual(deferredAssignmentRes.status, 200);
    const deferUntil = Date.now() + 60_000;
    const createCallsBeforeDeferred = sessionManager.state.createCalls.length;
    const deferredStartRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${dispatchPolicyTaskId}/assignments/${deferredAssignmentRes.data.assignment.id}/start`, {
      rootSessionId: 'root-task-routes',
      parentSessionId: 'root-task-routes',
      originClient: 'test',
      externalSessionRef: 'test:task-routes',
      deferUntil
    });
    assert.strictEqual(deferredStartRes.status, 202);
    assert.strictEqual(deferredStartRes.data.assignment.status, 'queued');
    assert.strictEqual(deferredStartRes.data.dispatch.status, 'deferred');
    assert.strictEqual(deferredStartRes.data.dispatch.deferUntil, deferUntil);
    assert.strictEqual(deferredStartRes.data.dispatch.liveness.state, 'deferred');
    assert.strictEqual(deferredStartRes.data.dispatch.liveness.nextAction, 'wait_until_defer_time');
    assert.strictEqual(sessionManager.state.createCalls.length, createCallsBeforeDeferred, 'deferred dispatch should not spawn a terminal');

    const coalescedAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${dispatchPolicyTaskId}/assignments`, {
      role: 'executor',
      instructions: 'Coalesce duplicate starts.'
    });
    assert.strictEqual(coalescedAssignmentRes.status, 200);
    const coalescedAssignmentId = coalescedAssignmentRes.data.assignment.id;
    db.createDispatchRequest({
      id: 'dispatch-preclaimed-route',
      taskId: dispatchPolicyTaskId,
      taskAssignmentId: coalescedAssignmentId,
      rootSessionId: 'root-task-routes',
      requestKind: 'assignment_start',
      status: 'claimed',
      coalesceKey: `task:${dispatchPolicyTaskId}:assignment:${coalescedAssignmentId}:start`,
      requestedBy: 'first-supervisor',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000
    });
    const createCallsBeforeCoalesced = sessionManager.state.createCalls.length;
    const coalescedStartRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${dispatchPolicyTaskId}/assignments/${coalescedAssignmentId}/start`, {
      rootSessionId: 'root-task-routes',
      parentSessionId: 'root-task-routes',
      originClient: 'test',
      externalSessionRef: 'test:task-routes'
    });
    assert.strictEqual(coalescedStartRes.status, 202);
    assert.strictEqual(coalescedStartRes.data.assignment.status, 'queued');
    assert.strictEqual(coalescedStartRes.data.dispatch.status, 'claimed');
    assert.strictEqual(coalescedStartRes.data.dispatch.action, 'coalesced');
    assert.strictEqual(coalescedStartRes.data.dispatch.coalesced, true);
    assert.strictEqual(coalescedStartRes.data.dispatch.coalescedCount, 1);
    assert.strictEqual(coalescedStartRes.data.dispatch.liveness.state, 'claimed');
    assert.strictEqual(sessionManager.state.createCalls.length, createCallsBeforeCoalesced, 'coalesced dispatch should not spawn a duplicate terminal');

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
    assert.strictEqual(listAssignmentsRes.data.assignments[0].dispatch.status, 'spawned');
    assert.strictEqual(listAssignmentsRes.data.assignments[0].taskSessionBindings[0].rootSessionId, 'root-task-routes');

    const liveTerminal = sessionManager.state.terminals.get(startAssignmentRes.data.assignment.terminalId);
    sessionManager.state.terminals.delete(startAssignmentRes.data.assignment.terminalId);
    const missingTerminalTaskRes = await request(serverHandle.baseUrl, 'GET', `/orchestration/tasks/${taskId}`);
    assert.strictEqual(missingTerminalTaskRes.status, 200);
    assert.strictEqual(missingTerminalTaskRes.data.status, 'failed');
    assert.strictEqual(missingTerminalTaskRes.data.assignmentCounts.failed, 1);
    assert(missingTerminalTaskRes.data.task.projectId, 'new workspace-backed tasks should be linked to a project');
    const missingTerminalAssignmentsRes = await request(serverHandle.baseUrl, 'GET', `/orchestration/tasks/${taskId}/assignments`);
    assert.strictEqual(missingTerminalAssignmentsRes.status, 200);
    assert.strictEqual(missingTerminalAssignmentsRes.data.assignments[0].status, 'failed');
    assert.strictEqual(missingTerminalAssignmentsRes.data.assignments[0].terminalStatus, 'terminal_missing');
    assert.strictEqual(missingTerminalAssignmentsRes.data.assignments[0].terminalMissing, true);

    db.updateTaskAssignment(assignmentId, { status: 'completed', completedAt: Date.now() });
    const reconciledAssignmentRes = await request(serverHandle.baseUrl, 'GET', `/orchestration/tasks/${taskId}/assignments`);
    assert.strictEqual(reconciledAssignmentRes.status, 200);
    assert.strictEqual(reconciledAssignmentRes.data.assignments[0].status, 'completed');
    db.updateTaskAssignment(assignmentId, { status: 'running', completedAt: null });
    sessionManager.state.terminals.set(startAssignmentRes.data.assignment.terminalId, liveTerminal);

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
