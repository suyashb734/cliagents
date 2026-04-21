#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const {
  PersistentSessionManager,
  TerminalStatus
} = require('../src/tmux/session-manager');

function makeTempDir(prefix) {
  const baseDir = path.join(os.homedir(), '.cliagents-test-tmp');
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

class FakeTmuxClient {
  constructor() {
    this.histories = new Map();
    this.commands = new Map();
    this.createCalls = [];
  }

  _key(sessionName, windowName) {
    return `${sessionName}:${windowName}`;
  }

  listSessions() {
    return [];
  }

  createSession(sessionName, windowName, terminalId) {
    this.createCalls.push({ sessionName, windowName, terminalId });
    return true;
  }

  setEnvironment() {
    return true;
  }

  resizePane() {
    return true;
  }

  pipePaneToFile(_sessionName, _windowName, logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '');
    }
    return logPath;
  }

  sendKeys(sessionName, windowName, keys) {
    const key = this._key(sessionName, windowName);
    this.histories.set(key, `${this.histories.get(key) || ''}${keys}\n`);
  }

  sendSpecialKey() {
    return true;
  }

  getHistory(sessionName, windowName) {
    return this.histories.get(this._key(sessionName, windowName)) || '';
  }

  getPaneCurrentCommand(sessionName, windowName) {
    return this.commands.get(this._key(sessionName, windowName)) || 'zsh';
  }

  setCurrentCommand(sessionName, windowName, command) {
    this.commands.set(this._key(sessionName, windowName), command);
  }

  killSession() {
    return true;
  }

  cleanupStaleSessions() {
    return 0;
  }
}

async function run() {
  const rootDir = makeTempDir('cliagents-session-reuse-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const fakeTmux = new FakeTmuxClient();

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

  try {
    const manager = new PersistentSessionManager({
      db,
      tmuxClient: fakeTmux,
      logDir: path.join(rootDir, 'logs'),
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });

    const baseOptions = {
      adapter: 'codex-cli',
      role: 'worker',
      agentProfile: 'review_codex-cli',
      systemPrompt: 'Review this change carefully.',
      model: 'o4-mini',
      allowedTools: ['Read', 'Bash'],
      permissionMode: 'auto',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-42',
      sessionMetadata: { clientName: 'opencode', toolName: 'delegate_task' }
    };

    const reusableRoot = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const first = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: reusableRoot,
      parentSessionId: reusableRoot,
      sessionKind: 'reviewer'
    });
    await manager.sendInput(first.terminalId, 'Review the implementation.');
    const firstLiveTerminal = manager.terminals.get(first.terminalId);
    fs.writeFileSync(
      firstLiveTerminal.logPath,
      [
        firstLiveTerminal.activeRun.startMarker,
        'Review complete.',
        `${firstLiveTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setCurrentCommand(firstLiveTerminal.sessionName, firstLiveTerminal.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(first.terminalId), TerminalStatus.COMPLETED);

    const second = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: reusableRoot,
      parentSessionId: reusableRoot,
      sessionKind: 'reviewer'
    });

    assert.strictEqual(second.terminalId, first.terminalId);
    assert.strictEqual(second.reused, true);
    assert.strictEqual(fakeTmux.createCalls.length, 1);
    assert.strictEqual(db.listTerminals({ rootSessionId: reusableRoot }).length, 1);
    const reuseEvents = db.listSessionEvents({ rootSessionId: reusableRoot });
    assert(reuseEvents.some((event) => event.event_type === 'session_resumed'));

    const forcedFresh = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: reusableRoot,
      parentSessionId: reusableRoot,
      sessionKind: 'reviewer',
      forceFreshSession: true
    });
    assert.notStrictEqual(forcedFresh.terminalId, first.terminalId);
    assert.strictEqual(forcedFresh.reused, false);

    const busyRoot = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const busy = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: busyRoot,
      parentSessionId: busyRoot,
      sessionKind: 'reviewer'
    });
    await manager.sendInput(busy.terminalId, 'Check the implementation.');
    assert.strictEqual(manager.getStatus(busy.terminalId), TerminalStatus.PROCESSING);
    await assert.rejects(
      () => manager.sendInput(busy.terminalId, 'Follow up before completion.'),
      (error) => {
        assert.strictEqual(error.code, 'terminal_busy');
        assert.strictEqual(error.statusCode, 409);
        assert.strictEqual(error.terminalId, busy.terminalId);
        assert.strictEqual(error.terminalStatus, TerminalStatus.PROCESSING);
        return true;
      }
    );
    const originalGetStatus = manager.getStatus.bind(manager);
    manager.getStatus = () => TerminalStatus.WAITING_PERMISSION;
    await assert.rejects(
      () => manager.sendInput(busy.terminalId, 'Approve this while waiting for permission.'),
      (error) => {
        assert.strictEqual(error.code, 'terminal_busy');
        assert.strictEqual(error.terminalStatus, TerminalStatus.WAITING_PERMISSION);
        return true;
      }
    );
    manager.getStatus = () => TerminalStatus.WAITING_USER_ANSWER;
    await assert.rejects(
      () => manager.sendInput(busy.terminalId, 'Answer this while waiting for user input.'),
      (error) => {
        assert.strictEqual(error.code, 'terminal_busy');
        assert.strictEqual(error.terminalStatus, TerminalStatus.WAITING_USER_ANSWER);
        return true;
      }
    );
    manager.getStatus = originalGetStatus;

    const busyFollowUp = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: busyRoot,
      parentSessionId: busyRoot,
      sessionKind: 'reviewer'
    });
    assert.notStrictEqual(busyFollowUp.terminalId, busy.terminalId);

    const modelRoot = 'cccccccccccccccccccccccccccccccc';
    const modelOne = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: modelRoot,
      parentSessionId: modelRoot,
      sessionKind: 'reviewer'
    });
    const modelTwo = await manager.createTerminal({
      ...baseOptions,
      rootSessionId: modelRoot,
      parentSessionId: modelRoot,
      sessionKind: 'reviewer',
      model: 'gpt-5'
    });
    assert.notStrictEqual(modelTwo.terminalId, modelOne.terminalId);

    console.log('✅ Session manager reuses compatible worker terminals, skips busy terminals, and honors force-fresh/model boundaries');
  } finally {
    global.setTimeout = realSetTimeout;
    db.close();
  }
}

run().catch((error) => {
  console.error('\nSession reuse tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
