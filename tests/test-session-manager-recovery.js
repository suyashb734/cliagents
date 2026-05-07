#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { PersistentSessionManager } = require('../src/tmux/session-manager');

function makeTempDir(prefix) {
  const baseDir = path.join(os.homedir(), '.cliagents-test-tmp');
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

class FakeRecoveryTmux {
  constructor(activeSessionNames = []) {
    this.activeSessionNames = new Set(activeSessionNames);
  }

  sessionExists(sessionName) {
    return this.activeSessionNames.has(sessionName);
  }

  listSessions(prefix = '') {
    return Array.from(this.activeSessionNames)
      .filter((name) => String(name).startsWith(prefix))
      .map((name) => ({ name }));
  }

  getHistory() {
    return '';
  }

  getPaneCurrentCommand() {
    return 'zsh';
  }

  killSession() {
    return true;
  }

  cleanupStaleSessions() {
    return 0;
  }
}

async function run() {
  const rootDir = makeTempDir('cliagents-session-recovery-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  const terminalId = 'abcdabcdabcdabcdabcdabcdabcdabcd';
  db.registerTerminal(
    terminalId,
    'cliagents-abcdab',
    'review_codex-cli-abcdabcd',
    'codex-cli',
    'review_codex-cli',
    'worker',
    rootDir,
    path.join(rootDir, 'logs', `${terminalId}.log`),
    {
      rootSessionId: 'feedfeedfeedfeedfeedfeedfeedfeed',
      parentSessionId: 'feedfeedfeedfeedfeedfeedfeedfeed',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-9',
      lineageDepth: 1,
      sessionMetadata: { clientName: 'opencode' },
      model: 'gpt-5.4',
      requestedModel: 'gpt-5.5',
      effectiveModel: 'gpt-5.4'
    }
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };

  try {
    const orphanManager = new PersistentSessionManager({
      db,
      tmuxClient: new FakeRecoveryTmux([]),
      logDir: path.join(rootDir, 'logs'),
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });

    const staleEvents = db.listSessionEvents({ rootSessionId: 'feedfeedfeedfeedfeedfeedfeedfeed' });
    assert(staleEvents.some((event) => event.event_type === 'session_stale'));
    assert(!warnings.some((message) => message.includes('sessionId is required')));

    const orphanWarningsBefore = warnings.length;
    const orphanReplayManager = new PersistentSessionManager({
      db,
      tmuxClient: new FakeRecoveryTmux([]),
      logDir: path.join(rootDir, 'logs'),
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });
    assert.strictEqual(orphanReplayManager.terminals.size, 0);
    assert.strictEqual(db.listSessionEvents({ rootSessionId: 'feedfeedfeedfeedfeedfeedfeedfeed' }).filter((event) => event.event_type === 'session_stale').length, 1);
    assert.strictEqual(warnings.length, orphanWarningsBefore);

    const recoveredManager = new PersistentSessionManager({
      db,
      tmuxClient: new FakeRecoveryTmux(['cliagents-abcdab']),
      logDir: path.join(rootDir, 'logs'),
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });

    const recoveredTerminal = recoveredManager.terminals.get(terminalId);
    assert(recoveredTerminal, 'recovered terminal should be loaded into memory');
    assert.strictEqual(recoveredTerminal.terminalId, terminalId);
    assert.strictEqual(recoveredTerminal.rootSessionId, 'feedfeedfeedfeedfeedfeedfeedfeed');
    assert.strictEqual(recoveredTerminal.parentSessionId, 'feedfeedfeedfeedfeedfeedfeedfeed');
    assert.strictEqual(recoveredTerminal.originClient, 'mcp');
    assert.strictEqual(recoveredTerminal.requestedModel, 'gpt-5.5');
    assert.strictEqual(recoveredTerminal.effectiveModel, 'gpt-5.4');
    assert.strictEqual(recoveredTerminal.model, 'gpt-5.4');
    assert(!warnings.some((message) => message.includes('sessionId is required')));

    db.addSessionEvent({
      rootSessionId: 'root-root-root-root-root-root-root-1',
      sessionId: 'root-root-root-root-root-root-root-1',
      parentSessionId: null,
      eventType: 'session_started',
      originClient: 'codex',
      idempotencyKey: 'root-root-root-root-root-root-root-1:root-root-root-root-root-root-root-1:session_started:manual-attach',
      payloadSummary: 'Manual root attach',
      payloadJson: { attachMode: 'manual' }
    });
    const beforeRootAttachCount = db.listSessionEvents({ rootSessionId: 'root-root-root-root-root-root-root-1' })
      .filter((event) => event.session_id === 'root-root-root-root-root-root-root-1' && event.event_type === 'session_started')
      .length;
    recoveredManager._recordSessionStarted({
      terminalId: 'child-child-child-child-child-child-1',
      adapter: 'codex-cli',
      agentProfile: 'review_codex-cli',
      role: 'worker',
      workDir: rootDir,
      rootSessionId: 'root-root-root-root-root-root-root-1',
      parentSessionId: 'root-root-root-root-root-root-root-1',
      sessionKind: 'subagent',
      originClient: 'codex',
      externalSessionRef: 'codex:workspace:test',
      sessionMetadata: { clientName: 'codex' }
    });
    const afterRootAttachCount = db.listSessionEvents({ rootSessionId: 'root-root-root-root-root-root-root-1' })
      .filter((event) => event.session_id === 'root-root-root-root-root-root-root-1' && event.event_type === 'session_started')
      .length;
    assert.strictEqual(afterRootAttachCount, beforeRootAttachCount, 'existing attached roots should not get duplicate implicit root attach events');

    const ghostTerminalId = 'feedfeedfeedfeedfeedfeedfeedfeed';
    recoveredManager.terminals.set(ghostTerminalId, {
      terminalId: ghostTerminalId,
      sessionName: 'cliagents-ghosted',
      windowName: 'review_codex-cli-ghosted',
      adapter: 'codex-cli',
      agentProfile: 'review_codex-cli',
      role: 'worker',
      workDir: rootDir,
      logPath: path.join(rootDir, 'logs', `${ghostTerminalId}.log`),
      status: 'processing',
      createdAt: new Date(),
      lastActive: new Date(),
      activeRun: {
        runId: 'ghost-run-1',
        startMarker: '__CLIAGENTS_RUN_START__ghost-run-1',
        exitMarkerPrefix: '__CLIAGENTS_RUN_EXIT__ghost-run-1__',
        baselineOutputLength: 0,
        startedAt: new Date()
      },
      rootSessionId: ghostTerminalId,
      parentSessionId: null,
      sessionKind: 'reviewer',
      originClient: 'system',
      externalSessionRef: null,
      lineageDepth: 0,
      sessionMetadata: null
    });

    const listedTerminalIds = recoveredManager.listTerminals().map((terminal) => terminal.terminalId);
    assert(!listedTerminalIds.includes(ghostTerminalId), 'stale in-memory terminals without tmux or DB backing should be evicted');
    assert.strictEqual(recoveredManager.terminals.has(ghostTerminalId), false);

    console.log('✅ Session manager startup recovery preserves terminal IDs and control-plane metadata from DB rows');
  } finally {
    console.warn = originalWarn;
    db.close();
  }
}

run().catch((error) => {
  console.error('\nSession manager recovery tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
