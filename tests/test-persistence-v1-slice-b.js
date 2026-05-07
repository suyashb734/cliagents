#!/usr/bin/env node

const assert = require('assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDB, closeDB } = require('../src/database/db');
const { createMemoryRouter } = require('../src/routes/memory');
const { resetMemoryMaintenanceService } = require('../src/orchestration/memory-maintenance-service');
const { RunLedgerService } = require('../src/orchestration/run-ledger');
const { MemorySnapshotService } = require('../src/orchestration/memory-snapshot-service');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function request(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000)
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}

  return { status: response.status, data };
}

function loadMcpModule(envOverrides = {}) {
  const modulePath = require.resolve('../src/mcp/cliagents-mcp-server');
  delete require.cache[modulePath];

  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const mod = require('../src/mcp/cliagents-mcp-server');

  return {
    mod,
    restore() {
      delete require.cache[modulePath];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

async function withEnv(envOverrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function seedPersistenceFixture(db) {
  const runLedger = new RunLedgerService(db);
  const snapshotService = new MemorySnapshotService(db, console);

  const rootSessionId = 'root-123';
  const taskId = 'task-456';
  const repairRootSessionId = 'root-repair';
  const repairTaskId = 'task-repair';
  const linkedRootSessionId = 'root-linked';
  const attachedOnlyRootSessionId = 'root-attached-only';

  db.registerTerminal('term-1', 'session-1', 'window-1', 'codex-cli', null, 'worker', process.cwd(), null, {
    rootSessionId
  });
  db.registerTerminal('term-2', 'session-2', 'window-2', 'gemini-cli', null, 'worker', process.cwd(), null, {
    rootSessionId
  });
  db.registerTerminal('term-linked', 'session-linked', 'window-linked', 'codex-cli', null, 'worker', process.cwd(), null, {
    rootSessionId: linkedRootSessionId,
    externalSessionRef: 'codex:linked-root'
  });

  db.addMessage('term-1', 'system', 'System initialized', {
    traceId: 'trace-1',
    metadata: { stage: 'bootstrap' }
  });
  db.addMessage('term-1', 'user', 'Hello agent', { traceId: 'trace-1' });
  db.addMessage('term-1', 'assistant', 'Hello user', {
    traceId: 'trace-1',
    metadata: { model: 'codex' }
  });
  db.addMessage('term-2', 'user', 'Another task', { traceId: 'trace-2' });

  db.storeArtifact(taskId, 'artifact-1', 'console.log("bundle");', {
    type: 'code',
    agentId: 'agent-1'
  });
  db.storeFinding(taskId, 'agent-1', 'Important finding', {
    type: 'bug',
    severity: 'high'
  });
  db.storeContext(taskId, 'agent-1', {
    summary: 'Fallback context summary',
    keyDecisions: ['Use durable bundles'],
    pendingItems: ['Wire MCP routes']
  });

  const runId = runLedger.createRun({
    id: 'run-789',
    kind: 'discussion',
    status: 'completed',
    inputSummary: 'Persistence bundle smoke',
    traceId: 'trace-1',
    discussionId: 'discussion-1',
    rootSessionId,
    taskId,
    decisionSummary: 'Use persisted bundles and root rollups.',
    startedAt: Date.now() - 5000,
    completedAt: Date.now() - 1000,
    durationMs: 4000
  });
  runLedger.appendOutput({
    runId,
    outputKind: 'judge_final',
    content: 'Use persisted bundles and root rollups.'
  });
  snapshotService.writeRunSnapshot(runId, { rootSessionId, taskId });
  await snapshotService.refreshRootSnapshot(rootSessionId);

  const repairRunId = runLedger.createRun({
    id: 'run-repair',
    kind: 'consensus',
    status: 'completed',
    inputSummary: 'Repair me',
    rootSessionId: repairRootSessionId,
    taskId: repairTaskId,
    decisionSummary: 'Repair snapshot coverage.',
    startedAt: Date.now() - 4000,
    completedAt: Date.now() - 500,
    durationMs: 3500
  });
  runLedger.appendOutput({
    runId: repairRunId,
    outputKind: 'judge_final',
    content: 'Repair snapshot coverage.'
  });

  const orphanRunId = runLedger.createRun({
    id: 'run-orphan',
    kind: 'pr-review',
    status: 'completed',
    inputSummary: 'No recoverable root',
    decisionSummary: 'This run has no root session id.',
    startedAt: Date.now() - 3000,
    completedAt: Date.now() - 250,
    durationMs: 2750
  });

  const linkedRunId = runLedger.createRun({
    id: 'run-linked',
    kind: 'discussion',
    status: 'completed',
    inputSummary: 'Link me',
    traceId: 'trace-linked',
    decisionSummary: 'Repair linkage coverage.',
    startedAt: Date.now() - 2500,
    completedAt: Date.now() - 1500,
    durationMs: 1000
  });
  db.addSessionEvent({
    rootSessionId: linkedRootSessionId,
    sessionId: linkedRootSessionId,
    runId: linkedRunId,
    eventType: 'session_started',
    originClient: 'codex',
    idempotencyKey: 'linked-run-root-event',
    payloadJson: {
      sessionKind: 'main',
      adapter: 'codex-cli',
      externalSessionRef: 'codex:linked-root'
    }
  });
  db.db.prepare(`
    INSERT INTO messages (terminal_id, trace_id, root_session_id, role, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'term-linked',
    'trace-linked',
    null,
    'assistant',
    'Linked root message',
    '{}',
    Date.now() - 1200
  );
  db.addSessionEvent({
    rootSessionId: attachedOnlyRootSessionId,
    sessionId: attachedOnlyRootSessionId,
    eventType: 'session_started',
    originClient: 'codex',
    idempotencyKey: 'attached-only-root-event',
    payloadJson: {
      attachMode: 'explicit-http-attach',
      sessionKind: 'attach',
      adapter: 'codex-cli',
      clientName: 'codex',
      externalSessionRef: 'codex:attached-only'
    }
  });

  return {
    rootSessionId,
    taskId,
    runId,
    repairRootSessionId,
    repairTaskId,
    repairRunId,
    orphanRunId,
    linkedRootSessionId,
    linkedRunId,
    attachedOnlyRootSessionId
  };
}

async function runRouteTests() {
  console.log('🧪 Route tests');
  const testServer = await startTestServer({
    orchestration: {
      enabled: true
    }
  });

  try {
    const db = testServer.server.orchestration.db;
    const fixture = await seedPersistenceFixture(db);
    const memoryMaintenance = testServer.server.orchestration.memoryMaintenance;
    const linkedRunEvent = db.listSessionEvents({ rootSessionId: fixture.linkedRootSessionId, limit: 5 })
      .find((event) => event.run_id === fixture.linkedRunId);

    assert(memoryMaintenance, 'memory maintenance service should be initialized');
    assert.strictEqual(memoryMaintenance.isRunning, true, 'memory maintenance sweep should be running by default');
    assert(linkedRunEvent, 'linked run fixture should persist run_id on session events');

    const runSnapshot = db.getMemorySnapshot('run', fixture.runId);
    assert(runSnapshot, 'fixture should create a run snapshot');
    const runSnapshotEdges = db.queryMemoryEdges({
      sourceTable: 'memory_snapshots',
      sourceId: runSnapshot.id,
      edgeTypes: ['summarizes'],
      targetScopeType: 'run',
      targetId: fixture.runId,
      limit: 10
    });
    assert(runSnapshotEdges.length >= 1, 'run snapshots should write provenance edges to their source run');

    const rootSnapshot = db.getMemorySnapshot('root', fixture.rootSessionId);
    assert(rootSnapshot, 'fixture should create a root snapshot');
    const rootSnapshotEdges = db.queryMemoryEdges({
      sourceTable: 'memory_snapshots',
      sourceId: rootSnapshot.id,
      edgeTypes: ['summarizes'],
      targetScopeType: 'run',
      targetId: fixture.runId,
      limit: 10
    });
    assert(rootSnapshotEdges.length >= 1, 'root snapshots should write provenance edges to summarized runs');
    const rootLineageCount = db.listMemorySummaryEdges({
      parentScopeType: 'memory_snapshot',
      parentScopeId: rootSnapshot.id,
      childScopeType: 'run',
      childScopeId: fixture.runId,
      edgeKind: 'summarizes'
    }).length;
    await new MemorySnapshotService(db, console).refreshRootSnapshot(fixture.rootSessionId);
    assert.strictEqual(
      db.listMemorySummaryEdges({
        parentScopeType: 'memory_snapshot',
        parentScopeId: rootSnapshot.id,
        childScopeType: 'run',
        childScopeId: fixture.runId,
        edgeKind: 'summarizes'
      }).length,
      rootLineageCount,
      'summary lineage should be idempotent across repeated root refreshes'
    );

    const runBundleRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/bundle/${fixture.runId}?scope_type=run`
    );
    assert.strictEqual(runBundleRes.status, 200);
    assert.strictEqual(runBundleRes.data.scopeType, 'run');
    assert.strictEqual(runBundleRes.data.scopeId, fixture.runId);
    assert.strictEqual(runBundleRes.data.rawPointers.runId, fixture.runId);
    assert(runBundleRes.data.brief, 'run bundle should include a brief');

    const rootBundleRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/bundle/${fixture.rootSessionId}?scope_type=root&recent_runs_limit=2`
    );
    assert.strictEqual(rootBundleRes.status, 200);
    assert.strictEqual(rootBundleRes.data.scopeType, 'root');
    assert.strictEqual(rootBundleRes.data.scopeId, fixture.rootSessionId);
    assert(rootBundleRes.data.brief, 'root bundle should include a brief');
    assert(rootBundleRes.data.recentRuns.length >= 1, 'root bundle should include recent runs');

    const missingRootBundleRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/bundle/root-missing?scope_type=root'
    );
    assert.strictEqual(missingRootBundleRes.status, 404);
    assert.strictEqual(missingRootBundleRes.data.error.code, 'not_found');

    const taskBundleRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/bundle/${fixture.taskId}?scope_type=task`
    );
    assert.strictEqual(taskBundleRes.status, 200);
    assert.strictEqual(taskBundleRes.data.scopeType, 'task');
    assert.strictEqual(taskBundleRes.data.scopeId, fixture.taskId);
    assert(taskBundleRes.data.brief, 'task bundle should include a brief');
    assert.strictEqual(taskBundleRes.data.findings.length, 1);
    assert.strictEqual(taskBundleRes.data.rawPointers.artifactKeys.length, 1);
    assert(taskBundleRes.data.recentRuns.some((run) => run.runId === fixture.runId));

    const invalidBundleRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/bundle/${fixture.taskId}?scope_type=invalid`
    );
    assert.strictEqual(invalidBundleRes.status, 400);
    assert.strictEqual(invalidBundleRes.data.error.code, 'invalid_request');

    const terminalMessagesRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?terminal_id=term-1&limit=2'
    );
    assert.strictEqual(terminalMessagesRes.status, 200);
    assert.strictEqual(terminalMessagesRes.data.messages.length, 2);
    assert.strictEqual(terminalMessagesRes.data.pagination.total, 3);
    assert.strictEqual(terminalMessagesRes.data.pagination.remaining, 3);
    assert.strictEqual(terminalMessagesRes.data.pagination.hasMore, true);
    assert.strictEqual(terminalMessagesRes.data.messages[0].content, 'System initialized');
    assert.strictEqual(terminalMessagesRes.data.messages[1].content, 'Hello agent');

    const afterId = terminalMessagesRes.data.pagination.nextAfterId;
    const nextMessagesRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/messages?terminal_id=term-1&after_id=${afterId}`
    );
    assert.strictEqual(nextMessagesRes.status, 200);
    assert.strictEqual(nextMessagesRes.data.messages.length, 1);
    assert.strictEqual(nextMessagesRes.data.messages[0].content, 'Hello user');
    assert.strictEqual(nextMessagesRes.data.pagination.total, 3);
    assert.strictEqual(nextMessagesRes.data.pagination.remaining, 1);
    assert.strictEqual(nextMessagesRes.data.pagination.hasMore, false);

    const rootMessagesRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/messages?root_session_id=${fixture.rootSessionId}`
    );
    assert.strictEqual(rootMessagesRes.status, 200);
    assert.strictEqual(rootMessagesRes.data.messages.length, 4);

    const traceMessagesRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?trace_id=trace-1'
    );
    assert.strictEqual(traceMessagesRes.status, 200);
    assert.strictEqual(traceMessagesRes.data.messages.length, 3);

    db.registerTerminal('term-bulk', 'session-bulk', 'window-bulk', 'codex-cli', null, 'worker', process.cwd(), null, {
      rootSessionId: fixture.rootSessionId
    });
    for (let index = 1; index <= 501; index += 1) {
      db.addMessage('term-bulk', 'assistant', `bulk-${index}`);
    }

    const bulkMessagesRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?terminal_id=term-bulk&limit=500'
    );
    assert.strictEqual(bulkMessagesRes.status, 200);
    assert.strictEqual(bulkMessagesRes.data.messages.length, 500);
    assert.strictEqual(bulkMessagesRes.data.pagination.total, 501);
    assert.strictEqual(bulkMessagesRes.data.pagination.remaining, 501);
    assert.strictEqual(bulkMessagesRes.data.pagination.hasMore, true);
    assert(bulkMessagesRes.data.pagination.nextAfterId, 'expected a cursor for the remaining bulk message');

    const bulkNextRes = await request(
      testServer.baseUrl,
      'GET',
      `/orchestration/memory/messages?terminal_id=term-bulk&after_id=${bulkMessagesRes.data.pagination.nextAfterId}&limit=500`
    );
    assert.strictEqual(bulkNextRes.status, 200);
    assert.strictEqual(bulkNextRes.data.messages.length, 1);
    assert.strictEqual(bulkNextRes.data.messages[0].content, 'bulk-501');
    assert.strictEqual(bulkNextRes.data.pagination.total, 501);
    assert.strictEqual(bulkNextRes.data.pagination.remaining, 1);
    assert.strictEqual(bulkNextRes.data.pagination.hasMore, false);

    const roleMessagesRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?terminal_id=term-1&role=user'
    );
    assert.strictEqual(roleMessagesRes.status, 200);
    assert.strictEqual(roleMessagesRes.data.messages.length, 1);
    assert.strictEqual(roleMessagesRes.data.messages[0].role, 'user');

    const invalidSelectorRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?terminal_id=term-1&trace_id=trace-1'
    );
    assert.strictEqual(invalidSelectorRes.status, 400);
    assert.strictEqual(invalidSelectorRes.data.error.code, 'invalid_request');

    const invalidRoleRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?terminal_id=term-1&role=invalid'
    );
    assert.strictEqual(invalidRoleRes.status, 400);
    assert.strictEqual(invalidRoleRes.data.error.param, 'role');

    const invalidAfterRes = await request(
      testServer.baseUrl,
      'GET',
      '/orchestration/memory/messages?terminal_id=term-1&after_id=0'
    );
    assert.strictEqual(invalidAfterRes.status, 400);
    assert.strictEqual(invalidAfterRes.data.error.param, 'after_id');

    const repairRes = await request(
      testServer.baseUrl,
      'POST',
      '/orchestration/memory/snapshots/repair'
    );
    assert.strictEqual(repairRes.status, 200);
    assert(repairRes.data.attachedRootsLinked >= 1, 'repair should materialize attached roots into terminal rows');
    assert(repairRes.data.runsLinked >= 1, 'repair should backfill missing run root links');
    assert(repairRes.data.messagesLinked >= 1, 'repair should backfill missing message root links');
    assert(repairRes.data.terminalsRefreshed >= 1, 'repair should recompute terminal message recency');
    assert(repairRes.data.repairedRuns >= 1, 'repair should backfill at least one run snapshot');
    assert(repairRes.data.repairedRoots >= 1, 'repair should refresh at least one root snapshot');
    assert(repairRes.data.skippedRunsWithoutRootSessionId >= 1, 'repair should report orphan completed runs');
    assert(db.getMemorySnapshot('run', fixture.repairRunId), 'repair should create missing run snapshot');
    assert(db.getMemorySnapshot('root', fixture.repairRootSessionId), 'repair should create missing root snapshot');
    const repairRunSnapshot = db.getMemorySnapshot('run', fixture.repairRunId);
    assert(
      db.queryMemoryEdges({
        sourceTable: 'memory_snapshots',
        sourceId: repairRunSnapshot.id,
        edgeTypes: ['summarizes'],
        targetScopeType: 'run',
        targetId: fixture.repairRunId,
        limit: 10
      }).length >= 1,
      'repair-created run snapshots should write provenance edges'
    );
    assert.strictEqual(db.getRunById(fixture.linkedRunId).rootSessionId, fixture.linkedRootSessionId, 'repair should populate linked run root_session_id');
    const linkedMessage = db.queryMessages({ terminalId: 'term-linked', limit: 5 }).find((row) => row.content === 'Linked root message');
    assert.strictEqual(linkedMessage.root_session_id || linkedMessage.rootSessionId, fixture.linkedRootSessionId, 'repair should populate linked message root_session_id');
    assert(db.getTerminal(fixture.attachedOnlyRootSessionId), 'repair should synthesize a terminal row for attached-only roots');
    assert(db.getTerminal('term-linked').last_message_at, 'repair should backfill last_message_at on linked terminals');

    console.log('  ✅ routes and repair endpoint');
  } finally {
    const memoryMaintenance = testServer.server?.orchestration?.memoryMaintenance;
    await stopTestServer(testServer);
    assert(memoryMaintenance, 'memory maintenance handle should remain inspectable after stop');
    assert.strictEqual(memoryMaintenance.isRunning, false, 'memory maintenance should stop with server shutdown');
  }
}

async function runEnvDisablementTest() {
  console.log('🧪 maintenance disablement');

  await withEnv({ CLIAGENTS_MEMORY_REPAIR_SWEEP_MS: '0' }, async () => {
    const testServer = await startTestServer({
      orchestration: {
        enabled: true
      }
    });

    try {
      const memoryMaintenance = testServer.server.orchestration.memoryMaintenance;
      assert(memoryMaintenance, 'memory maintenance service should exist');
      assert.strictEqual(memoryMaintenance.intervalMs, 0);
      assert.strictEqual(memoryMaintenance.isRunning, false, 'sweep should stay disabled when env override is 0');
      console.log('  ✅ CLIAGENTS_MEMORY_REPAIR_SWEEP_MS=0 disables the sweep');
    } finally {
      await stopTestServer(testServer);
    }
  });
}

async function runRepairRouteInitializationGuardTest() {
  console.log('🧪 repair route initialization guard');

  resetMemoryMaintenanceService();
  closeDB();

  const dataDir = makeTempDir('cliagents-memory-route-guard-');
  const db = getDB({ dataDir });
  const app = express();
  app.use(express.json());
  app.use('/orchestration/memory', createMemoryRouter({ db }));

  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const response = await request(baseUrl, 'POST', '/orchestration/memory/snapshots/repair');
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.data.error.code, 'service_unavailable');
    console.log('  ✅ repair endpoint rejects uninitialized maintenance service explicitly');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeDB();
  }
}

async function runMcpTests() {
  console.log('🧪 MCP tools');
  const testServer = await startTestServer({
    orchestration: {
      enabled: true
    }
  });

  let loader = null;
  try {
    const fixture = await seedPersistenceFixture(testServer.server.orchestration.db);
    loader = loadMcpModule({
      CLIAGENTS_URL: testServer.baseUrl,
      CLIAGENTS_REQUIRE_ROOT_ATTACH: '',
      CLIAGENTS_MCP_POLL_MS: '10',
      CLIAGENTS_MCP_SYNC_WAIT_MS: '50'
    });

    const { mod } = loader;
    const memoryTool = mod.TOOLS.find((tool) => tool.name === 'get_memory_bundle');
    assert(memoryTool, 'get_memory_bundle should be exposed');
    assert.strictEqual(memoryTool.inputSchema.required[0], 'scopeId');
    assert.deepStrictEqual(memoryTool.inputSchema.properties.scopeType.enum, ['run', 'root', 'task']);

    const messageTool = mod.TOOLS.find((tool) => tool.name === 'get_message_window');
    assert(messageTool, 'get_message_window should be exposed');
    assert.deepStrictEqual(messageTool.inputSchema.properties.role.enum, ['user', 'assistant', 'system', 'tool']);

    const bundleResult = await mod.handleGetMemoryBundle({
      scopeId: fixture.taskId,
      scopeType: 'task',
      recentRunsLimit: 3,
      includeRawPointers: true
    });
    const bundleText = bundleResult.content[0].text;
    assert(bundleText.includes(`Memory Bundle: task ${fixture.taskId}`));
    assert(bundleText.includes('Recent Runs'));
    assert(bundleText.includes('Raw Pointers'));

    const messageResult = await mod.handleGetMessageWindow({
      terminalId: 'term-1',
      limit: 2
    });
    const messageText = messageResult.content[0].text;
    assert(messageText.includes('Message History'));
    assert(messageText.includes('SYSTEM @'));
    assert(messageText.includes('System initialized'));
    assert(messageText.includes('Use afterId='));

    await assert.rejects(
      () => mod.handleGetMessageWindow({ terminalId: 'term-1', traceId: 'trace-1' }),
      /Exactly one of terminalId, rootSessionId, or traceId is required/
    );

    console.log('  ✅ MCP memory tools');
  } finally {
    if (loader) {
      loader.restore();
    }
    await stopTestServer(testServer);
  }
}

async function run() {
  try {
    await runRouteTests();
    await runEnvDisablementTest();
    await runRepairRouteInitializationGuardTest();
    await runMcpTests();
    console.log('\n✅ Persistence V1 Slice B tests passed');
  } catch (error) {
    console.error('\n❌ Persistence V1 Slice B tests failed');
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
}

run();
