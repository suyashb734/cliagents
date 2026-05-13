#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');
const { deriveSessionState } = require('../src/services/session-peek');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function request(baseUrl, method, route, body) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

async function startRouterApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', createOrchestrationRouter({
    adapterAuthInspector() {
      return { authenticated: true, reason: 'test' };
    },
    ...context
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopRouterApp(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function registerRootTerminal(db, rootDir) {
  db.registerTerminal(
    'term-control-1',
    'cliagents-control',
    '0',
    'codex-cli',
    null,
    'worker',
    rootDir,
    null,
    {
      rootSessionId: 'root-control-1',
      parentSessionId: 'root-control-1',
      sessionKind: 'worker',
      originClient: 'codex',
      externalSessionRef: 'ext-control-1',
      sessionMetadata: {
        taskId: 'task-control-1',
        taskAssignmentId: 'assignment-control-1'
      }
    }
  );

  db.addSessionEvent({
    rootSessionId: 'root-control-1',
    sessionId: 'root-control-1',
    eventType: 'session_started',
    originClient: 'codex',
    idempotencyKey: 'root-control-1:session_started:ext-control-1',
    payloadSummary: 'control root attached',
    payloadJson: {
      attachMode: 'explicit-http-attach',
      externalSessionRef: 'ext-control-1',
      clientName: 'codex'
    },
    metadata: {
      clientName: 'codex',
      externalSessionRef: 'ext-control-1'
    }
  });
}

function runPureStateTests() {
  assert.strictEqual(deriveSessionState({ status: 'processing', processState: 'alive' }).task, 'working');
  assert.strictEqual(deriveSessionState({ status: 'waiting_user_answer', processState: 'alive' }).task, 'needs_input');
  assert.strictEqual(deriveSessionState({ status: 'orphaned' }).liveness, 'orphaned');
}

function runDbTests() {
  const rootDir = makeTempDir('cliagents-agent-control-db-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    const dispatchColumns = db.db.prepare('PRAGMA table_info(dispatch_requests)').all().map((column) => column.name);
    assert(dispatchColumns.includes('claim_owner'), 'dispatch_requests should include claim_owner');
    assert(dispatchColumns.includes('claim_expires_at'), 'dispatch_requests should include claim_expires_at');
    assert(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_input_leases'").get(), 'terminal_input_leases table should exist');

    const dispatch = db.createDispatchRequest({
      id: 'dispatch-control-1',
      rootSessionId: 'root-control-1',
      taskId: 'task-control-1',
      taskAssignmentId: 'assignment-control-1',
      requestKind: 'assignment_start',
      status: 'queued',
      createdAt: 100
    });
    assert.strictEqual(dispatch.status, 'queued');

    const firstClaim = db.claimDispatchRequest(dispatch.id, {
      claimOwner: 'supervisor-a',
      now: 200,
      ttlMs: 1000
    });
    assert.strictEqual(firstClaim.claimed, true);
    assert.strictEqual(firstClaim.dispatch.status, 'claimed');
    assert.strictEqual(firstClaim.dispatch.claimOwner, 'supervisor-a');
    assert.strictEqual(firstClaim.dispatch.claimExpiresAt, 1200);

    const blockedClaim = db.claimDispatchRequest(dispatch.id, {
      claimOwner: 'supervisor-b',
      now: 300,
      ttlMs: 1000
    });
    assert.strictEqual(blockedClaim.claimed, false);
    assert.strictEqual(blockedClaim.reason, 'already_claimed');

    const recoveredClaim = db.claimDispatchRequest(dispatch.id, {
      claimOwner: 'supervisor-b',
      now: 1300,
      ttlMs: 1000
    });
    assert.strictEqual(recoveredClaim.claimed, true);
    assert.strictEqual(recoveredClaim.dispatch.claimOwner, 'supervisor-b');

    registerRootTerminal(db, rootDir);
    const lease = db.acquireTerminalInputLease({
      terminalId: 'term-control-1',
      holder: 'operator-a',
      rootSessionId: 'root-control-1',
      now: 1000,
      ttlMs: 500
    });
    assert.strictEqual(lease.acquired, true);
    assert.strictEqual(lease.lease.status, 'active');

    const blockedLease = db.acquireTerminalInputLease({
      terminalId: 'term-control-1',
      holder: 'operator-b',
      now: 1200,
      ttlMs: 500
    });
    assert.strictEqual(blockedLease.acquired, false);
    assert.strictEqual(blockedLease.reason, 'lease_held');

    assert.strictEqual(db.expireTerminalInputLeases(2100), 1);
    assert.strictEqual(db.getTerminalInputLease(lease.lease.id).status, 'expired');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runLeaseRouteTests() {
  const rootDir = makeTempDir('cliagents-agent-control-route-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  registerRootTerminal(db, rootDir);

  const sentInputs = [];
  const { server, baseUrl } = await startRouterApp({
    db,
    sessionManager: {
      getTerminal(terminalId) {
        const row = db.getTerminal(terminalId);
        if (!row) return null;
        return {
          terminalId,
          adapter: row.adapter,
          rootSessionId: row.root_session_id,
          parentSessionId: row.parent_session_id,
          originClient: row.origin_client || 'codex',
          sessionKind: row.session_kind,
          sessionControlMode: row.session_control_mode,
          runtimeCapabilities: JSON.parse(row.runtime_capabilities || '[]'),
          runtimeHost: row.runtime_host || 'tmux',
          processState: 'alive',
          status: row.status || 'idle'
        };
      },
      async sendInput(terminalId, message) {
        sentInputs.push({ terminalId, message });
      },
      getStatus() {
        return 'idle';
      },
      getOutput() {
        return '';
      },
      listTerminals() {
        return [];
      }
    },
    apiSessionManager: {
      getAdapterNames() {
        return [];
      },
      getAdapter() {
        return null;
      }
    }
  });

  try {
    const rootBody = {
      rootSessionId: 'root-control-1',
      originClient: 'codex',
      externalSessionRef: 'ext-control-1'
    };
    const acquire = await request(baseUrl, 'POST', '/orchestration/terminals/term-control-1/input-lease', {
      ...rootBody,
      holder: 'operator-a',
      ttlMs: 60000
    });
    assert.strictEqual(acquire.status, 200);
    assert.strictEqual(acquire.data.acquired, true);

    const blockedInput = await request(baseUrl, 'POST', '/orchestration/terminals/term-control-1/input', {
      ...rootBody,
      requestedBy: 'operator-b',
      message: 'pwd'
    });
    assert.strictEqual(blockedInput.status, 423);
    assert.strictEqual(blockedInput.data.error.code, 'terminal_input_lease_held');

    const acceptedInput = await request(baseUrl, 'POST', '/orchestration/terminals/term-control-1/input', {
      ...rootBody,
      requestedBy: 'operator-a',
      leaseId: acquire.data.lease.id,
      message: 'pwd'
    });
    assert.strictEqual(acceptedInput.status, 200, JSON.stringify(acceptedInput.data));
    assert.deepStrictEqual(sentInputs, [{ terminalId: 'term-control-1', message: 'pwd' }]);

    const heartbeat = await request(baseUrl, 'POST', `/orchestration/input-leases/${acquire.data.lease.id}/heartbeat`, {
      ttlMs: 60000
    });
    assert.strictEqual(heartbeat.status, 200);
    assert.strictEqual(heartbeat.data.heartbeated, true);

    const released = await request(baseUrl, 'POST', `/orchestration/input-leases/${acquire.data.lease.id}/release`, {});
    assert.strictEqual(released.status, 200);
    assert.strictEqual(released.data.lease.status, 'released');
  } finally {
    await stopRouterApp(server);
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runPeekRouteTests() {
  const testServer = await startTestServer();
  try {
    const apiSessionId = 'api-session-control-1';
    testServer.server.sessionManager.sessions.set(apiSessionId, {
      sessionId: apiSessionId,
      adapterName: 'codex-cli',
      workDir: testServer.tempDataDir,
      model: 'gpt-5.5',
      providerSessionId: 'provider-api-1',
      createdAt: 1000,
      lastActivity: 2000,
      status: 'stable',
      messageCount: 0
    });

    const apiPeek = await request(testServer.baseUrl, 'GET', `/sessions/${apiSessionId}/peek?tail=0`);
    assert.strictEqual(apiPeek.status, 200);
    assert.strictEqual(apiPeek.data.sessionId, apiSessionId);
    assert.strictEqual(apiPeek.data.source, 'api-session-manager');
    assert.strictEqual(apiPeek.data.sessionState.task, 'idle');

    if (testServer.server.orchestration?.db) {
      registerRootTerminal(testServer.server.orchestration.db, testServer.tempDataDir);
      const terminalPeek = await request(testServer.baseUrl, 'GET', '/sessions/term-control-1/peek?tail=0');
      assert.strictEqual(terminalPeek.status, 200);
      assert.strictEqual(terminalPeek.data.sessionId, 'term-control-1');
      assert.strictEqual(terminalPeek.data.source, 'orchestration-terminal');
      assert.strictEqual(terminalPeek.data.taskId, 'task-control-1');
    }
  } finally {
    await stopTestServer(testServer);
  }
}

async function run() {
  runPureStateTests();
  runDbTests();
  await runLeaseRouteTests();
  await runPeekRouteTests();
  console.log('✅ Agent control foundation state, claims, leases, and peek routes work');
}

run().catch((error) => {
  console.error('Agent control foundation tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
