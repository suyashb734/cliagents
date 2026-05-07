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

function loadMcpModule(envOverrides = {}) {
  const modulePath = require.resolve('../src/mcp/cliagents-mcp-server');
  delete require.cache[modulePath];

  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
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

function parseOutputField(text, key) {
  const match = String(text || '').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function parseToolErrorPayload(error) {
  const message = error?.message || String(error);
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) {
    return null;
  }
  try {
    return JSON.parse(message.slice(jsonStart));
  } catch {
    return null;
  }
}

async function expectForbidden(action, label) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  assert(caught, `${label} should be rejected`);
  const payload = parseToolErrorPayload(caught);
  assert(payload, `${label} should return a JSON error payload`);
  assert.strictEqual(payload.error?.code, 'terminal_input_forbidden', `${label} should fail with terminal_input_forbidden`);
  assert(!String(caught.message).includes('terminal_not_found'), `${label} should not leak terminal existence`);
  return payload;
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

async function run() {
  const rootDir = makeTempDir('cliagents-kd71-root-');
  const mcpStateDir = makeTempDir('cliagents-kd71-mcp-state-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const sentInputs = [];

  let ownerSession = null;
  let attackerSession = null;
  let ownerReloaded = null;
  let server = null;

  try {
    const appRuntime = await startApp({
      sessionManager: {
        getTerminal(terminalId) {
          const row = db.getTerminal(terminalId);
          if (!row) {
            return null;
          }
          return {
            terminalId,
            rootSessionId: row.root_session_id || row.rootSessionId || null,
            parentSessionId: row.parent_session_id || row.parentSessionId || null,
            originClient: row.origin_client || row.originClient || null,
            sessionKind: row.session_kind || row.sessionKind || null,
            agentProfile: row.agent_profile || row.agentProfile || null,
            sessionControlMode: row.session_control_mode || row.sessionControlMode || null
          };
        },
        async sendInput(terminalId, message) {
          sentInputs.push({ terminalId, message });
        },
        sendSpecialKey() {},
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

    server = appRuntime.server;

    const commonEnv = {
      CLIAGENTS_URL: appRuntime.baseUrl,
      CLIAGENTS_CLIENT_NAME: 'codex',
      CLIAGENTS_WORKSPACE_ROOT: rootDir,
      CLIAGENTS_MCP_STATE_DIR: mcpStateDir,
      CLIAGENTS_REQUIRE_ROOT_ATTACH: '',
      CLIAGENTS_ROOT_SESSION_ID: '',
      CLIAGENTS_CLIENT_SESSION_REF: ''
    };
    const ownerEnv = {
      ...commonEnv,
      CLIAGENTS_MCP_SESSION_SCOPE: 'kd71-owner-scope',
      CODEX_THREAD_ID: 'kd71-owner-thread'
    };
    const attackerEnv = {
      ...commonEnv,
      CLIAGENTS_MCP_SESSION_SCOPE: 'kd71-attacker-scope',
      CODEX_THREAD_ID: 'kd71-attacker-thread'
    };

    ownerSession = loadMcpModule(ownerEnv);
    const ownerEnsure = await ownerSession.mod.handleEnsureRootSession({
      externalSessionRef: 'kd71-root-owner'
    });
    const ownerRootSessionId = parseOutputField(ownerEnsure.content?.[0]?.text, 'root_session_id');
    assert(ownerRootSessionId, 'owner root session should be created');

    db.registerTerminal(
      'term-kd71-owner',
      'cliagents-kd71',
      '0',
      'codex-cli',
      null,
      'worker',
      rootDir,
      null,
      {
        rootSessionId: ownerRootSessionId,
        parentSessionId: ownerRootSessionId,
        sessionKind: 'worker',
        originClient: 'codex',
        externalSessionRef: 'kd71-root-owner',
        sessionMetadata: {
          clientName: 'codex',
          externalSessionRef: 'kd71-root-owner'
        }
      }
    );

    const heldInput = await ownerSession.mod.handleEnqueueTerminalInput({
      terminalId: 'term-kd71-owner',
      message: 'READY',
      approvalRequired: true,
      requestedBy: 'owner'
    });
    const heldInputId = parseOutputField(heldInput.content?.[0]?.text, 'input_id');
    assert(heldInputId && heldInputId !== 'n/a', 'held input id should be returned');

    const pendingDeliverInput = await ownerSession.mod.handleEnqueueTerminalInput({
      terminalId: 'term-kd71-owner',
      message: 'pwd'
    });
    const pendingDeliverInputId = parseOutputField(pendingDeliverInput.content?.[0]?.text, 'input_id');
    assert(pendingDeliverInputId && pendingDeliverInputId !== 'n/a', 'pending deliver input id should be returned');

    const pendingDenyInput = await ownerSession.mod.handleEnqueueTerminalInput({
      terminalId: 'term-kd71-owner',
      message: 'whoami'
    });
    const pendingDenyInputId = parseOutputField(pendingDenyInput.content?.[0]?.text, 'input_id');
    assert(pendingDenyInputId && pendingDenyInputId !== 'n/a', 'pending deny input id should be returned');

    const pendingCancelInput = await ownerSession.mod.handleEnqueueTerminalInput({
      terminalId: 'term-kd71-owner',
      message: 'id'
    });
    const pendingCancelInputId = parseOutputField(pendingCancelInput.content?.[0]?.text, 'input_id');
    assert(pendingCancelInputId && pendingCancelInputId !== 'n/a', 'pending cancel input id should be returned');

    ownerSession.restore();
    ownerSession = null;

    attackerSession = loadMcpModule(attackerEnv);
    const attackerEnsure = await attackerSession.mod.handleEnsureRootSession({
      externalSessionRef: 'kd71-root-attacker'
    });
    const attackerRootSessionId = parseOutputField(attackerEnsure.content?.[0]?.text, 'root_session_id');
    assert(attackerRootSessionId, 'attacker root session should be created');
    assert.notStrictEqual(attackerRootSessionId, ownerRootSessionId, 'attacker root must be distinct');

    const crossRootReplyPayload = await expectForbidden(
      () => attackerSession.mod.handleReplyToTerminal({
        terminalId: 'term-kd71-owner',
        message: 'ATTACKER_B_REPLY_TO_OWNER_TERMINAL'
      }),
      'cross-root reply_to_terminal'
    );
    const unknownTerminalPayload = await expectForbidden(
      () => attackerSession.mod.handleReplyToTerminal({
        terminalId: 'deadbeefdeadbeef',
        message: 'ATTACKER_UNKNOWN_TERMINAL_PROBE'
      }),
      'unknown-terminal reply_to_terminal probe'
    );
    assert.deepStrictEqual(
      unknownTerminalPayload,
      crossRootReplyPayload,
      'unknown-terminal probe should return the same generic denial payload as known terminals'
    );

    await expectForbidden(
      () => attackerSession.mod.handleEnqueueTerminalInput({
        terminalId: 'term-kd71-owner',
        message: 'ATTACKER_B_ENQUEUE_TO_OWNER_TERMINAL',
        approvalRequired: true
      }),
      'cross-root enqueue_terminal_input'
    );

    await expectForbidden(
      () => attackerSession.mod.handleApproveTerminalInput({
        inputId: heldInputId,
        approvedBy: 'attacker'
      }),
      'cross-root approve_terminal_input'
    );

    await expectForbidden(
      () => attackerSession.mod.handleDenyTerminalInput({
        inputId: pendingDenyInputId,
        deniedBy: 'attacker',
        reason: 'cross-root deny attempt'
      }),
      'cross-root deny_terminal_input'
    );

    await expectForbidden(
      () => attackerSession.mod.handleCancelTerminalInput({
        inputId: pendingCancelInputId,
        reason: 'cross-root cancel attempt'
      }),
      'cross-root cancel_terminal_input'
    );

    await expectForbidden(
      () => attackerSession.mod.handleDeliverTerminalInput({
        inputId: pendingDeliverInputId
      }),
      'cross-root deliver_terminal_input'
    );

    assert.strictEqual(db.getTerminalInputQueueItem(heldInputId).status, 'held_for_approval');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingDeliverInputId).status, 'pending');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingDenyInputId).status, 'pending');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingCancelInputId).status, 'pending');
    assert.strictEqual(sentInputs.length, 0, 'cross-root failures must not inject terminal input');

    const resetResult = await attackerSession.mod.handleResetRootSession();
    assert(
      resetResult.content?.[0]?.text?.includes(`previous_root_session_id: ${attackerRootSessionId}`),
      'reset_root_session should clear the attacker root context'
    );

    await expectForbidden(
      () => attackerSession.mod.handleApproveTerminalInput({
        inputId: heldInputId,
        approvedBy: 'missing-root-test'
      }),
      'no-root approve_terminal_input after reset'
    );
    await expectForbidden(
      () => attackerSession.mod.handleEnqueueTerminalInput({
        terminalId: 'term-kd71-owner',
        message: 'NO_ROOT_ENQUEUE_AFTER_RESET',
        approvalRequired: true
      }),
      'no-root enqueue_terminal_input after reset'
    );

    assert.strictEqual(db.getTerminalInputQueueItem(heldInputId).status, 'held_for_approval');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingDeliverInputId).status, 'pending');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingDenyInputId).status, 'pending');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingCancelInputId).status, 'pending');
    assert.strictEqual(sentInputs.length, 0, 'no-root failures must not inject terminal input');

    attackerSession.restore();
    attackerSession = null;

    ownerReloaded = loadMcpModule(ownerEnv);
    const approveHeld = await ownerReloaded.mod.handleApproveTerminalInput({
      inputId: heldInputId,
      approvedBy: 'owner-operator'
    });
    assert(approveHeld.content?.[0]?.text?.includes('Terminal Input Approved'));

    const deliverHeld = await ownerReloaded.mod.handleDeliverTerminalInput({
      inputId: heldInputId
    });
    assert(deliverHeld.content?.[0]?.text?.includes('Terminal Input Delivered'));

    const pingAfterReady = await ownerReloaded.mod.handleReplyToTerminal({
      terminalId: 'term-kd71-owner',
      message: 'whoami'
    });
    assert(pingAfterReady.content?.[0]?.text?.includes('Terminal Updated'));

    const deliverPending = await ownerReloaded.mod.handleDeliverTerminalInput({
      inputId: pendingDeliverInputId
    });
    assert(deliverPending.content?.[0]?.text?.includes('Terminal Input Delivered'));

    const denyPending = await ownerReloaded.mod.handleDenyTerminalInput({
      inputId: pendingDenyInputId,
      deniedBy: 'owner-operator',
      reason: 'owner denial control'
    });
    assert(denyPending.content?.[0]?.text?.includes('Terminal Input Denied'));

    const cancelPending = await ownerReloaded.mod.handleCancelTerminalInput({
      inputId: pendingCancelInputId,
      reason: 'owner cancellation control'
    });
    assert(cancelPending.content?.[0]?.text?.includes('Terminal Input Cancelled'));

    assert.strictEqual(db.getTerminalInputQueueItem(heldInputId).status, 'delivered');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingDeliverInputId).status, 'delivered');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingDenyInputId).status, 'cancelled');
    assert.strictEqual(db.getTerminalInputQueueItem(pendingCancelInputId).status, 'cancelled');
    assert.deepStrictEqual(
      sentInputs,
      [
        { terminalId: 'term-kd71-owner', message: 'READY' },
        { terminalId: 'term-kd71-owner', message: 'whoami' },
        { terminalId: 'term-kd71-owner', message: 'pwd' }
      ],
      'owner-root positive controls should remain functional'
    );

    console.log('✅ MCP terminal input isolation blocks cross-root and no-root writes while preserving owner ping-after-READY and queue controls');
  } finally {
    if (ownerSession) {
      ownerSession.restore();
    }
    if (attackerSession) {
      attackerSession.restore();
    }
    if (ownerReloaded) {
      ownerReloaded.restore();
    }
    if (server) {
      await stopApp(server);
    }
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(mcpStateDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('MCP terminal input isolation tests failed:', error);
  process.exit(1);
});
