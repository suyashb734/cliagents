#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startApp(context) {
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

async function stopApp(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(baseUrl, method, route, body) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

async function run() {
  const rootDir = makeTempDir('cliagents-input-queue-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const sentInputs = [];
  const specialKeys = [];

  try {
    db.registerTerminal(
      'term-input-1',
      'cliagents-input-queue',
      '0',
      'codex-cli',
      null,
      'worker',
      rootDir,
      null,
      {
        rootSessionId: 'root-input-1',
        sessionKind: 'worker',
        originClient: 'mcp',
        sessionMetadata: {
          taskId: 'task-input-1',
          taskAssignmentId: 'assignment-input-1'
        }
      }
    );

    const terminalColumns = db.db.prepare('PRAGMA table_info(terminals)').all().map((column) => column.name);
    assert(terminalColumns.includes('session_control_mode'), 'terminals should include session_control_mode');
    const queueTable = db.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'terminal_input_queue'
    `).get();
    assert(queueTable, 'terminal_input_queue table should exist');
    const terminal = db.getTerminal('term-input-1');
    assert.strictEqual(terminal.session_control_mode, 'operator');
    assert(JSON.parse(terminal.runtime_capabilities).includes('approve_permission'));

    const held = db.enqueueTerminalInput({
      terminalId: 'term-input-1',
      message: 'Review this before delivering.',
      approvalRequired: true,
      requestedBy: 'test'
    });
    assert.strictEqual(held.status, 'held_for_approval');
    assert.strictEqual(held.taskId, 'task-input-1');
    assert.strictEqual(held.taskAssignmentId, 'assignment-input-1');
    const approved = db.updateTerminalInputQueueItem(held.id, {
      status: 'pending',
      decision: 'approved',
      approvedBy: 'operator',
      approvedAt: Date.now(),
      holdReason: null
    });
    assert.strictEqual(approved.status, 'pending');
    assert.strictEqual(approved.decision, 'approved');

    const expired = db.enqueueTerminalInput({
      terminalId: 'term-input-1',
      message: 'Too late.',
      expiresAt: Date.now() - 1000
    });
    assert.strictEqual(db.expireTerminalInputQueueItems() >= 1, true);
    assert.strictEqual(db.getTerminalInputQueueItem(expired.id).status, 'expired');

    const { server, baseUrl } = await startApp({
      sessionManager: {
        getTerminal() {
          return null;
        },
        async sendInput(terminalId, message) {
          sentInputs.push({ terminalId, message });
        },
        sendSpecialKey(terminalId, key) {
          specialKeys.push({ terminalId, key });
        },
        getStatus() {
          return 'idle';
        },
        getOutput() {
          return '';
        }
      },
      apiSessionManager: {
        getAdapterNames() {
          return [];
        },
        getAdapter() {
          return null;
        }
      },
      db
    });

    try {
      const enqueueRes = await request(baseUrl, 'POST', '/orchestration/terminals/term-input-1/input-queue', {
        message: 'Deliver through queue.',
        approvalRequired: true,
        requestedBy: 'remote-test',
        metadata: { diffRef: 'diff://test' }
      });
      assert.strictEqual(enqueueRes.status, 200);
      assert.strictEqual(enqueueRes.data.input.status, 'held_for_approval');

      const deliverHeld = await request(baseUrl, 'POST', `/orchestration/input-queue/${enqueueRes.data.input.id}/deliver`, {});
      assert.strictEqual(deliverHeld.status, 409);
      assert.strictEqual(deliverHeld.data.error.code, 'invalid_input_queue_state');

      const approveRes = await request(baseUrl, 'POST', `/orchestration/input-queue/${enqueueRes.data.input.id}/approve`, {
        approvedBy: 'operator'
      });
      assert.strictEqual(approveRes.status, 200);
      assert.strictEqual(approveRes.data.input.status, 'pending');

      const deliverRes = await request(baseUrl, 'POST', `/orchestration/input-queue/${enqueueRes.data.input.id}/deliver`, {});
      assert.strictEqual(deliverRes.status, 200);
      assert.strictEqual(deliverRes.data.input.status, 'delivered');
      assert.deepStrictEqual(sentInputs.at(-1), {
        terminalId: 'term-input-1',
        message: 'Deliver through queue.'
      });

      const denyEnqueue = await request(baseUrl, 'POST', '/orchestration/terminals/term-input-1/input-queue', {
        inputKind: 'denial'
      });
      assert.strictEqual(denyEnqueue.status, 200);
      const denyDeliver = await request(baseUrl, 'POST', `/orchestration/input-queue/${denyEnqueue.data.input.id}/deliver`, {});
      assert.strictEqual(denyDeliver.status, 200);
      assert.deepStrictEqual(specialKeys.slice(-2), [
        { terminalId: 'term-input-1', key: 'n' },
        { terminalId: 'term-input-1', key: 'Enter' }
      ]);

      db.updateTerminalBinding('term-input-1', { sessionControlMode: 'observer' });
      const observerInput = await request(baseUrl, 'POST', '/orchestration/terminals/term-input-1/input', {
        message: 'Should not deliver.'
      });
      assert.strictEqual(observerInput.status, 403);
      assert.strictEqual(observerInput.data.error.code, 'session_control_observer');

      const observerQueued = await request(baseUrl, 'POST', '/orchestration/terminals/term-input-1/input-queue', {
        message: 'Still should not deliver.',
        controlMode: 'observer'
      });
      assert.strictEqual(observerQueued.status, 200);
      const observerDeliver = await request(baseUrl, 'POST', `/orchestration/input-queue/${observerQueued.data.input.id}/deliver`, {});
      assert.strictEqual(observerDeliver.status, 403);
      assert.strictEqual(observerDeliver.data.error.code, 'session_control_observer');

      const listRes = await request(baseUrl, 'GET', '/orchestration/input-queue?status=delivered,cancelled,expired');
      assert.strictEqual(listRes.status, 200);
      assert(Array.isArray(listRes.data.inputs));
      assert(listRes.data.inputs.some((entry) => entry.status === 'delivered'));
      assert(listRes.data.inputs.some((entry) => entry.status === 'expired'));
    } finally {
      await stopApp(server);
    }

    console.log('✅ Terminal input queue migration, DB methods, HTTP routes, approval, delivery, and observer gating work');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Terminal input queue tests failed:', error);
  process.exit(1);
});
