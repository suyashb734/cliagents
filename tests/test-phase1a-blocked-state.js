#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run() {
  const rootDir = makeTempDir('cliagents-phase1a-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });
  const ledger = new RunLedgerService(db);

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log('\nPhase 1A: Run-state and blocked-state durability foundation\n');

  // Verify migration applied
  test('migration 0012 is applied', () => {
    const migrations = db.db.prepare(
      "SELECT version FROM schema_migrations WHERE version = '0012_run_blocked_state_and_operator_actions.sql'"
    ).all();
    assert.strictEqual(migrations.length, 1, 'Migration 0012 should be applied');
  });

  // Verify tables exist
  test('operator_actions table exists', () => {
    const tables = db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_actions'"
    ).all();
    assert.strictEqual(tables.length, 1);
  });

  test('run_blocked_states table exists', () => {
    const tables = db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_blocked_states'"
    ).all();
    assert.strictEqual(tables.length, 1);
  });

  // Verify indexes exist
  test('operator_actions indexes exist', () => {
    const indexes = db.db.prepare('PRAGMA index_list(operator_actions)').all();
    assert.ok(indexes.length >= 3, 'Should have at least 3 indexes');
  });

  test('run_blocked_states indexes exist', () => {
    const indexes = db.db.prepare('PRAGMA index_list(run_blocked_states)').all();
    assert.ok(indexes.length >= 3, 'Should have at least 3 indexes');
  });

  // Create a run for testing
  const runId = ledger.createRun({
    kind: 'implementation-run',
    status: 'running',
    hashInput: {
      message: 'Build feature X',
      participants: [{ adapter: 'codex-cli', name: 'dev' }]
    },
    inputSummary: 'Build feature X',
    workingDirectory: '/tmp/project',
    initiator: 'phase1a-test',
    metadata: { phase: '1a' }
  });

  test('run was created', () => {
    assert.ok(runId, 'Run ID should be returned');
  });

  // Test appendOperatorAction via ledger service
  test('appendOperatorAction via ledger service', () => {
    const action = ledger.appendOperatorAction({
      runId,
      terminalId: 'term_test123',
      actionKind: 'operator_reply',
      payload: { content: 'Proceed with implementation' },
      createdAt: Date.now()
    });
    assert.ok(action, 'Action should be returned');
    assert.strictEqual(action.runId, runId);
    assert.strictEqual(action.actionKind, 'operator_reply');
    assert.strictEqual(action.payload.content, 'Proceed with implementation');
  });

  // Test listOperatorActions
  test('listOperatorActions returns actions for run', () => {
    const actions = ledger.listOperatorActions(runId);
    assert.ok(Array.isArray(actions), 'Should return an array');
    assert.strictEqual(actions.length, 1, 'Should have 1 action');
    assert.strictEqual(actions[0].actionKind, 'operator_reply');
  });

  test('listOperatorActions filters by kind and terminal', () => {
    const byKind = ledger.listOperatorActions(runId, { actionKind: 'operator_reply' });
    assert.strictEqual(byKind.length, 1);
    assert.strictEqual(byKind[0].terminalId, 'term_test123');

    const byTerminal = ledger.listOperatorActions(runId, { terminalId: 'term_test123' });
    assert.strictEqual(byTerminal.length, 1);
    assert.strictEqual(byTerminal[0].actionKind, 'operator_reply');

    assert.strictEqual(ledger.listOperatorActions(runId, { actionKind: 'operator_cancel' }).length, 0);
    assert.strictEqual(ledger.listOperatorActions(runId, { terminalId: 'missing-terminal' }).length, 0);
  });

  // Test all operator action kinds
  const actionKinds = [
    'operator_override',
    'operator_unblock',
    'operator_cancel',
    'operator_retry',
    'operator_escalate',
    'operator_resume'
  ];

  for (const kind of actionKinds) {
    test(`appendOperatorAction accepts kind: ${kind}`, () => {
      const action = ledger.appendOperatorAction({
        runId,
        actionKind: kind,
        payload: { note: `Testing ${kind}` }
      });
      assert.strictEqual(action.actionKind, kind);
    });
  }

  // Test invalid action kind
  test('appendOperatorAction rejects invalid actionKind', () => {
    let threw = false;
    try {
      ledger.appendOperatorAction({
        runId,
        actionKind: 'invalid_kind'
      });
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Invalid actionKind'));
    }
    assert.ok(threw, 'Should throw for invalid actionKind');
  });

  test('appendOperatorAction rejects unknown runs', () => {
    assert.throws(() => {
      ledger.appendOperatorAction({
        runId: 'missing-run',
        actionKind: 'operator_reply',
        payload: { content: 'orphan' }
      });
    }, /Run not found/);
  });

  test('operator action payload preserves JSON-compatible strings', () => {
    const action = ledger.appendOperatorAction({
      runId,
      actionKind: 'operator_reply',
      payload: '123'
    });
    assert.strictEqual(action.payload, '123');
    assert.strictEqual(ledger.getOperatorAction(action.actionId).payload, '123');
  });

  test('appendOperatorAction rejects duplicate action ids', () => {
    ledger.appendOperatorAction({
      runId,
      actionId: 'opact_duplicate_test',
      actionKind: 'operator_reply',
      payload: { note: 'first' }
    });
    assert.throws(() => {
      ledger.appendOperatorAction({
        runId,
        actionId: 'opact_duplicate_test',
        actionKind: 'operator_reply',
        payload: { note: 'second' }
      });
    }, /UNIQUE|constraint/i);
  });

  // Test appendRunBlockedState via ledger service
  test('appendRunBlockedState via ledger service', () => {
    const blocked = ledger.appendRunBlockedState({
      runId,
      blockedReason: 'waiting_for_approval',
      blockingDetail: 'Need design review approval',
      metadata: { approver: 'sre-lead' }
    });
    assert.ok(blocked, 'Blocked state should be returned');
    assert.strictEqual(blocked.runId, runId);
    assert.strictEqual(blocked.blockedReason, 'waiting_for_approval');
    assert.strictEqual(blocked.blockingDetail, 'Need design review approval');
    assert.strictEqual(blocked.unblockedAt, null, 'Should not be unblocked');
  });

  // Test getActiveBlockedState
  test('getActiveBlockedState returns active block', () => {
    const active = ledger.getActiveBlockedState(runId);
    assert.ok(active, 'Should return active blocked state');
    assert.strictEqual(active.blockedReason, 'waiting_for_approval');
    assert.strictEqual(active.unblockedAt, null);
  });

  // Test listRunBlockedStates
  test('listRunBlockedStates returns all states', () => {
    const states = ledger.listRunBlockedStates(runId);
    assert.ok(Array.isArray(states), 'Should return an array');
    assert.strictEqual(states.length, 1, 'Should have 1 blocked state');
  });

  test('listRunBlockedStates with activeOnly filter', () => {
    const states = ledger.listRunBlockedStates(runId, { activeOnly: true });
    assert.strictEqual(states.length, 1, 'Should have 1 active block');
    const inactive = ledger.listRunBlockedStates(runId, { activeOnly: false });
    assert.strictEqual(inactive.length, 1, 'Should have 1 total block');
  });

  test('getRunDetail exposes blocked-state overlay', () => {
    const detail = ledger.getRunDetail(runId);
    assert.strictEqual(detail.run.status, 'running', 'blocked state is an overlay, not a runs.status value');
    assert.strictEqual(detail.isBlocked, true);
    assert.strictEqual(detail.activeBlockedState.blockedReason, 'waiting_for_approval');
    assert.strictEqual(detail.blockedStates.length, 1);
  });

  test('unblockRun clears the active blocked state', () => {
    const result = ledger.unblockRun(runId, {
      unblockReason: 'Approved by sre-lead'
    });
    assert.ok(result, 'Result should be returned');
    assert.strictEqual(result.runId, runId);
    assert.strictEqual(result.unblockedCount, 1, 'Should unblock exactly 1 state');
    assert.ok(result.unblockedAt, 'Should have unblockedAt timestamp');
    assert.strictEqual(result.unblockReason, 'Approved by sre-lead');
  });

  test('unblockRun rejects missing active blocked states', () => {
    assert.throws(() => {
      ledger.unblockRun(runId, { unblockReason: 'Already clear' });
    }, /No active blocked state/);
  });

  test('getActiveBlockedState returns null after unblock', () => {
    const active = ledger.getActiveBlockedState(runId);
    assert.strictEqual(active, null, 'Should be null after unblock');
  });

  test('listRunBlockedStates shows all unblocked states', () => {
    const states = ledger.listRunBlockedStates(runId);
    assert.strictEqual(states.length, 1, 'Should have exactly 1 state record');
    for (const state of states) {
      assert.ok(state.unblockedAt, 'Each state should have unblockedAt set');
      assert.strictEqual(state.unblockReason, 'Approved by sre-lead');
    }
  });

  // Test multiple blocked states (create another run)
  const runId2 = ledger.createRun({
    kind: 'research-run',
    status: 'running',
    inputSummary: 'Research phase',
    initiator: 'phase1a-test'
  });

  // Test all blocked reasons on runId2
  const blockedReasons = [
    'waiting_for_input',
    'waiting_for_handoff',
    'waiting_for_resource',
    'waiting_for_dependency',
    'blocked_by_gate',
    'blocked_by_operator',
    'internal_block'
  ];

  for (const reason of blockedReasons) {
    test(`appendRunBlockedState accepts reason: ${reason}`, () => {
      const blocked = ledger.appendRunBlockedState({
        runId: runId2,
        blockedReason: reason,
        blockingDetail: `Testing ${reason}`
      });
      assert.strictEqual(blocked.blockedReason, reason);
      const result = ledger.unblockRun(runId2, { unblockReason: `Cleared ${reason}` });
      assert.strictEqual(result.unblockedCount, 1);
    });
  }

  // Test invalid blocked reason
  test('appendRunBlockedState rejects invalid blockedReason', () => {
    let threw = false;
    try {
      ledger.appendRunBlockedState({
        runId: runId2,
        blockedReason: 'invalid_reason'
      });
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Invalid blockedReason'));
    }
    assert.ok(threw, 'Should throw for invalid blockedReason');
  });

  test('appendRunBlockedState rejects unknown runs', () => {
    assert.throws(() => {
      ledger.appendRunBlockedState({
        runId: 'missing-run',
        blockedReason: 'waiting_for_input'
      });
    }, /Run not found/);
  });

  test('run can have multiple blocked states over time', () => {
    const first = ledger.appendRunBlockedState({
      runId: runId2,
      blockedReason: 'waiting_for_resource',
      metadata: { resource: 'gpu' }
    });
    assert.strictEqual(first.blockedReason, 'waiting_for_resource');

    ledger.unblockRun(runId2, { unblockReason: 'GPU acquired' });

    const second = ledger.appendRunBlockedState({
      runId: runId2,
      blockedReason: 'blocked_by_gate',
      metadata: { gate: 'design-review' }
    });
    assert.strictEqual(second.blockedReason, 'blocked_by_gate');

    const states = ledger.listRunBlockedStates(runId2);
    assert.strictEqual(states.length, blockedReasons.length + 2, 'Should retain historical blocked states');
    const active = ledger.getActiveBlockedState(runId2);
    assert.ok(active, 'Should have an active blocked state');
    assert.strictEqual(active.blockedReason, 'blocked_by_gate');
  });

  test('run cannot have two active blocked states at once', () => {
    assert.throws(() => {
      ledger.appendRunBlockedState({
        runId: runId2,
        blockedReason: 'waiting_for_input'
      });
    }, /active blocked state/);
  });

  test('listRunBlockedStates filters by reason', () => {
    const gateStates = ledger.listRunBlockedStates(runId2, { blockedReason: 'blocked_by_gate' });
    assert.strictEqual(gateStates.length, 2);
    assert(gateStates.every((state) => state.blockedReason === 'blocked_by_gate'));
    assert.strictEqual(ledger.listRunBlockedStates(runId2, { blockedReason: 'internal_block', activeOnly: true }).length, 0);
  });

  // Test operator action replay scenario
  test('operator actions survive DB close and reopen', () => {
    const replayRootDir = makeTempDir('cliagents-phase1a-replay-');
    const replayDbPath = path.join(replayRootDir, 'cliagents.db');
    const replayDb = new OrchestrationDB({ dbPath: replayDbPath, dataDir: replayRootDir });
    const replayLedger = new RunLedgerService(replayDb);
    const replayRunId = replayLedger.createRun({
      kind: 'consensus',
      status: 'pending',
      inputSummary: 'Consensus test',
      initiator: 'phase1a-test'
    });

    replayLedger.appendOperatorAction({
      runId: replayRunId,
      actionKind: 'operator_override',
      payload: {
        decision: 'proceed',
        rationale: 'Design is sound',
        overrideReason: 'Time constraint'
      }
    });
    replayDb.close();

    const reopenedDb = new OrchestrationDB({ dbPath: replayDbPath, dataDir: replayRootDir });
    const reopenedLedger = new RunLedgerService(reopenedDb);
    const actions = reopenedLedger.listOperatorActions(replayRunId);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].actionKind, 'operator_override');
    assert.deepStrictEqual(actions[0].payload, {
      decision: 'proceed',
      rationale: 'Design is sound',
      overrideReason: 'Time constraint'
    });
    reopenedDb.close();
    fs.rmSync(replayRootDir, { recursive: true, force: true });
  });

  // Test db.js helpers directly
  test('db.appendOperatorAction works directly', () => {
    const action = db.appendOperatorAction({
      runId,
      terminalId: 'term_direct',
      actionKind: 'operator_reply',
      payload: { note: 'direct db call' }
    });
    assert.strictEqual(action.actionKind, 'operator_reply');
  });

  test('db.appendRunBlockedState works directly', () => {
    const active = db.getActiveBlockedState(runId);
    if (active) {
      db.unblockRun(runId, { unblockReason: 'Preparing direct db test' });
    }
    const blocked = db.appendRunBlockedState({
      runId,
      blockedReason: 'waiting_for_input',
      blockingDetail: 'Awaiting user input'
    });
    assert.strictEqual(blocked.blockedReason, 'waiting_for_input');
  });

  test('db.getActiveBlockedState works directly', () => {
    const active = db.getActiveBlockedState(runId);
    assert.ok(active, 'Should return active blocked state');
    assert.strictEqual(active.blockedReason, 'waiting_for_input');
  });

  test('db.unblockRun works directly', () => {
    const result = db.unblockRun(runId, { unblockReason: 'User responded' });
    assert.strictEqual(result.unblockedCount, 1);
  });

  test('appendRunBlockedState rejects duplicate ids', () => {
    const duplicateRunId = ledger.createRun({
      kind: 'implementation-run',
      status: 'running',
      inputSummary: 'Duplicate blocked-state id test',
      initiator: 'phase1a-test'
    });
    ledger.appendRunBlockedState({
      runId: duplicateRunId,
      id: 'rbs_duplicate_test',
      blockedReason: 'waiting_for_input'
    });
    ledger.unblockRun(duplicateRunId, { unblockReason: 'clear duplicate test' });
    assert.throws(() => {
      ledger.appendRunBlockedState({
        runId: duplicateRunId,
        id: 'rbs_duplicate_test',
        blockedReason: 'waiting_for_input'
      });
    }, /UNIQUE|constraint/i);
  });

  // Summary
  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  // Cleanup
  db.close();

  fs.rmSync(rootDir, { recursive: true, force: true });

  if (failed > 0) {
    process.exit(1);
  }

  console.log('Phase 1A tests completed successfully.\n');
}

run();
