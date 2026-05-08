#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');
const { createMemoryRouter } = require('../src/routes/memory');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration/memory', createMemoryRouter({ db }));

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
    serverHandle.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function request(baseUrl, route) {
  const response = await fetch(baseUrl + route);
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

function seedMemoryReadModelFixture(db, rootDir) {
  const now = Date.now();
  const workspacePath = path.join(rootDir, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const workspaceRoot = fs.realpathSync(workspacePath);

  const task = db.createTask({
    id: 'task-memory-query',
    title: 'Memory query implementation',
    workspaceRoot,
    brief: 'Build query and insights APIs',
    createdAt: now - 5000
  });

  db.createTaskAssignment({
    id: 'assignment-memory-query',
    taskId: task.id,
    role: 'implement',
    instructions: 'Implement memory query endpoints',
    adapter: 'codex-cli',
    model: 'gpt-5.4',
    status: 'completed',
    completedAt: now - 1000,
    createdAt: now - 4000
  });

  db.registerTerminal(
    'terminal-memory-query',
    'memory-query-session',
    'main',
    'codex-cli',
    null,
    'worker',
    workspaceRoot,
    null,
    {
      rootSessionId: 'root-memory-query',
      model: 'gpt-5.4',
      sessionMetadata: {
        workspaceRoot,
        taskId: task.id,
        taskAssignmentId: 'assignment-memory-query'
      }
    }
  );
  const dispatch = db.createDispatchRequest({
    id: 'dispatch-memory-query',
    taskId: task.id,
    taskAssignmentId: 'assignment-memory-query',
    rootSessionId: 'root-memory-query',
    requestKind: 'assignment_start',
    status: 'spawned',
    terminalId: 'terminal-memory-query',
    metadata: { note: 'memory dispatch projection' },
    createdAt: now - 3500,
    updatedAt: now - 3200,
    dispatchedAt: now - 3200
  });
  db.createRunContextSnapshot({
    id: 'context-memory-query',
    dispatchRequestId: dispatch.id,
    workspacePath: workspaceRoot,
    contextMode: 'task_assignment',
    promptSummary: 'Implement memory query endpoints',
    promptBody: 'Implement memory query endpoints',
    linkedContext: { taskId: task.id, taskAssignmentId: 'assignment-memory-query' },
    adapter: 'codex-cli',
    model: 'gpt-5.4',
    createdAt: now - 3400
  });
  db.createTaskSessionBinding({
    id: 'binding-memory-query',
    rootSessionId: 'root-memory-query',
    taskId: task.id,
    taskAssignmentId: 'assignment-memory-query',
    adapter: 'codex-cli',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    terminalId: 'terminal-memory-query',
    providerSessionId: 'provider-memory-query',
    runtimeHost: 'tmux',
    runtimeFidelity: 'managed',
    reusePolicy: 'prefer_compatible_reuse',
    reuseDecision: { reused: false },
    createdAt: now - 3300
  });

  const ledger = new RunLedgerService(db);
  ledger.createRun({
    id: 'run-memory-query',
    kind: 'discussion',
    status: 'completed',
    inputSummary: 'Memory query implementation run',
    workingDirectory: workspaceRoot,
    rootSessionId: 'root-memory-query',
    taskId: task.id,
    startedAt: now - 3000,
    completedAt: now - 500,
    durationMs: 2500
  });

  db.addMessage('terminal-memory-query', 'assistant', 'Memory query implementation complete.', {
    model: 'gpt-5.4',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      sourceConfidence: 'estimated'
    }
  });
  db.addUsageRecord({
    rootSessionId: 'root-memory-query',
    terminalId: 'terminal-memory-query',
    runId: 'run-memory-query',
    taskId: task.id,
    taskAssignmentId: 'assignment-memory-query',
    adapter: 'codex-cli',
    model: 'gpt-5.4',
    inputTokens: 20,
    outputTokens: 8,
    totalTokens: 28,
    sourceConfidence: 'estimated',
    metadata: { role: 'worker' },
    createdAt: now - 400
  });
  db.storeFinding(task.id, 'agent-memory-query', 'Memory query should preserve source provenance.', {
    type: 'suggestion',
    severity: 'high'
  });
  db.storeContext(task.id, 'agent-memory-query', {
    summary: 'Memory query route is wired to projection helpers.',
    keyDecisions: ['Use memory_records_v1 as read model'],
    pendingItems: ['Add browser-facing explorer later']
  });

  return { taskId: task.id, workspaceRoot, projectId: task.projectId };
}

async function run() {
  const rootDir = makeTempDir('cliagents-memory-query-insights-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  let serverHandle = null;

  try {
    const fixture = seedMemoryReadModelFixture(db, rootDir);
    serverHandle = await startApp(db);

    const invalidTypeRes = await request(serverHandle.baseUrl, '/orchestration/memory/query?types=not-a-type');
    assert.strictEqual(invalidTypeRes.status, 400);
    assert.strictEqual(invalidTypeRes.data.error.param, 'types');

    const queryRes = await request(
      serverHandle.baseUrl,
      `/orchestration/memory/query?task_id=${fixture.taskId}&types=task,task_assignment,run,terminal,usage,finding,context,dispatch_request,run_context_snapshot,task_session_binding&q=memory&limit=30`
    );
    assert.strictEqual(queryRes.status, 200);
    assert.strictEqual(queryRes.data.filters.taskId, fixture.taskId);
    assert.deepStrictEqual(
      queryRes.data.filters.types,
      ['task', 'task_assignment', 'run', 'terminal', 'usage', 'finding', 'context', 'dispatch_request', 'run_context_snapshot', 'task_session_binding']
    );
    assert(queryRes.data.records.length >= 5, 'query should return seeded memory records');
    assert(queryRes.data.records.every((record) => record.sourceTable && record.sourceId), 'records should keep source provenance');
    assert(queryRes.data.records.some((record) => record.recordType === 'finding' && record.record?.content?.includes('source provenance')));
    assert(queryRes.data.records.some((record) => record.recordType === 'dispatch_request' && record.sourceId === 'dispatch-memory-query'));
    assert(queryRes.data.records.some((record) => record.recordType === 'run_context_snapshot' && record.sourceId === 'context-memory-query'));
    assert(queryRes.data.records.some((record) => record.recordType === 'task_session_binding' && record.sourceId === 'binding-memory-query'));

    const limitedRes = await request(serverHandle.baseUrl, `/orchestration/memory/query?task_id=${fixture.taskId}&limit=1`);
    assert.strictEqual(limitedRes.status, 200);
    assert.strictEqual(limitedRes.data.pagination.returned, 1);
    assert.strictEqual(limitedRes.data.pagination.hasMore, true);

    const edgeRes = await request(serverHandle.baseUrl, `/orchestration/memory/edges?task_id=${fixture.taskId}&limit=100`);
    assert.strictEqual(edgeRes.status, 200);
    assert(edgeRes.data.edges.some((edge) => edge.targetScopeType === 'task' && edge.targetId === fixture.taskId));
    assert(edgeRes.data.edges.some((edge) => edge.sourceRecordType === 'dispatch_request' && edge.targetScopeType === 'task_assignment'));

    const insightsRes = await request(serverHandle.baseUrl, `/orchestration/memory/insights?task_id=${fixture.taskId}&limit=5`);
    assert.strictEqual(insightsRes.status, 200);
    assert(insightsRes.data.statusCounts.task_assignment_completed >= 1);
    assert.strictEqual(insightsRes.data.tokenTotals.totalTokens, 28);
    assert(insightsRes.data.adapterUsage.some((entry) => entry.key === 'codex-cli'));
    assert(insightsRes.data.modelUsage.some((entry) => entry.key === 'gpt-5.4'));
    assert(insightsRes.data.topFindings.some((finding) => finding.severity === 'high'));
    assert(insightsRes.data.pendingItems.includes('Add browser-facing explorer later'));
    assert(insightsRes.data.missingLinkDiagnostics.projectId);

    console.log('✅ Memory query and insights routes use projection helpers with source provenance');
  } finally {
    if (serverHandle) {
      await stopApp(serverHandle);
    }
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Memory query/insights tests failed');
  console.error(error);
  process.exit(1);
});
