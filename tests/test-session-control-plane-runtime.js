#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { CodexCliDetector } = require('../src/status-detectors');
const {
  PersistentSessionManager,
  TerminalStatus
} = require('../src/tmux/session-manager');

function makeTempDir(prefix) {
  const baseDir = path.join('/Users/mojave/Documents/AI-projects/cliagents', '.tmp-tests');
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

class FakeTmuxClient {
  constructor() {
    this.histories = new Map();
    this.commands = new Map();
  }

  _key(sessionName, windowName) {
    return `${sessionName}:${windowName}`;
  }

  listSessions() {
    return [];
  }

  createSession() {
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

  setHistory(sessionName, windowName, output) {
    this.histories.set(this._key(sessionName, windowName), output);
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
  const rootDir = makeTempDir('cliagents-session-control-runtime-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const logDir = path.join(rootDir, 'logs');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });
  const fakeTmux = new FakeTmuxClient();

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

  try {
    const manager = new PersistentSessionManager({
      db,
      tmuxClient: fakeTmux,
      logDir,
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });
    manager.registerStatusDetector('codex-cli', new CodexCliDetector());

    const terminal = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'worker',
      agentProfile: 'review_codex-cli',
      rootSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      parentSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-42',
      lineageDepth: 1,
      sessionMetadata: {
        clientName: 'opencode',
        toolName: 'delegate_task'
      }
    });

    const persistedTerminal = db.getTerminal(terminal.terminalId);
    assert.strictEqual(persistedTerminal.root_session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(persistedTerminal.parent_session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(persistedTerminal.session_kind, 'reviewer');
    assert.strictEqual(persistedTerminal.origin_client, 'mcp');
    assert.strictEqual(persistedTerminal.external_session_ref, 'opencode:thread-42');

    const recoveredRoot = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'main',
      workDir: rootDir,
      originClient: 'codex',
      externalSessionRef: 'codex:managed:resume-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true,
        providerResumeCommand: 'codex resume 019d94a6-2cd8-7742-8e4e-123456789abc',
        providerResumeSessionId: '019d94a6-2cd8-7742-8e4e-123456789abc'
      }
    });
    const recoveredHistory = fakeTmux.getHistory(recoveredRoot.sessionName, recoveredRoot.windowName);
    assert(recoveredHistory.includes('codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'), 'expected recovered root to launch Codex in resume mode');
    assert.strictEqual(recoveredRoot.providerThreadRef, '019d94a6-2cd8-7742-8e4e-123456789abc');
    const persistedRecoveredRoot = db.getTerminal(recoveredRoot.terminalId);
    assert.strictEqual(persistedRecoveredRoot.provider_thread_ref, '019d94a6-2cd8-7742-8e4e-123456789abc');

    let events = db.listSessionEvents({ rootSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event_type, 'session_started');
    assert.strictEqual(events[0].session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(events[1].event_type, 'session_started');
    assert.strictEqual(events[1].session_id, terminal.terminalId);

    await manager.sendInput(terminal.terminalId, 'Review the implementation carefully.');
    const liveTerminal = manager.terminals.get(terminal.terminalId);
    assert.strictEqual(liveTerminal.status, TerminalStatus.PROCESSING);
    assert(liveTerminal.activeRun, 'tracked one-shot run should be active');

    fs.writeFileSync(
      liveTerminal.logPath,
      [
        liveTerminal.activeRun.startMarker,
        'Running review...',
        `${liveTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(liveTerminal.sessionName, liveTerminal.windowName, 'Running review...\n');
    fakeTmux.setCurrentCommand(liveTerminal.sessionName, liveTerminal.windowName, 'zsh');

    const status = manager.getStatus(terminal.terminalId);
    assert.strictEqual(status, TerminalStatus.COMPLETED);

    const completedTerminal = db.getTerminal(terminal.terminalId);
    assert.strictEqual(completedTerminal.status, TerminalStatus.COMPLETED);

    events = db.listSessionEvents({ rootSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[2].event_type, 'session_terminated');
    assert.strictEqual(events[2].payload_json.exitCode, 0);

    const rootTerminalId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rootSessionName = 'cliagents-root';
    const rootWindowName = 'codex-cli-root';
    const rootLogPath = path.join(logDir, `${rootTerminalId}.log`);
    fs.writeFileSync(rootLogPath, '', 'utf8');
    db.registerTerminal(
      rootTerminalId,
      rootSessionName,
      rootWindowName,
      'codex-cli',
      null,
      'main',
      rootDir,
      rootLogPath,
      {
        rootSessionId: rootTerminalId,
        parentSessionId: null,
        sessionKind: 'main',
        originClient: 'codex',
        externalSessionRef: 'codex:thread-1',
        lineageDepth: 0,
        sessionMetadata: {
          clientName: 'codex',
          attachMode: 'managed-root-launch',
          managedLaunch: true
        }
      }
    );
    db.addSessionEvent({
      rootSessionId: rootTerminalId,
      sessionId: rootTerminalId,
      parentSessionId: null,
      eventType: 'session_started',
      originClient: 'codex',
      idempotencyKey: `${rootTerminalId}:${rootTerminalId}:session_started:test-root`,
      payloadSummary: 'codex-cli session started',
      payloadJson: {
        adapter: 'codex-cli',
        role: 'main',
        sessionKind: 'main'
      },
      metadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      }
    });
    manager.terminals.set(rootTerminalId, {
      terminalId: rootTerminalId,
      sessionName: rootSessionName,
      windowName: rootWindowName,
      adapter: 'codex-cli',
      agentProfile: null,
      role: 'main',
      workDir: rootDir,
      model: null,
      logPath: rootLogPath,
      status: TerminalStatus.IDLE,
      createdAt: new Date(),
      lastActive: new Date(),
      activeRun: null,
      rootSessionId: rootTerminalId,
      parentSessionId: null,
      sessionKind: 'main',
      originClient: 'codex',
      externalSessionRef: 'codex:thread-1',
      lineageDepth: 0,
      sessionMetadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      }
    });
    fakeTmux.setHistory(
      rootSessionName,
      rootWindowName,
      [
        '╭──────────────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.120.0)                   │',
        '│                                              │',
        '│ model:     gpt-5.4 xhigh   /model to change  │',
        '╰──────────────────────────────────────────────╯',
        '',
        '  Tip: New Use /fast to enable our fastest inference at 2X plan usage.',
        '',
        '› Summarize recent commits'
      ].join('\n')
    );

    const draftStatus = manager.getStatus(rootTerminalId);
    assert.strictEqual(draftStatus, TerminalStatus.IDLE);
    assert.strictEqual(db.getHistory(rootTerminalId).length, 0);

    fakeTmux.setHistory(
      rootSessionName,
      rootWindowName,
      [
        '╭──────────────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.120.0)                   │',
        '│                                              │',
        '│ model:     gpt-5.4 xhigh   /model to change  │',
        '╰──────────────────────────────────────────────╯',
        '',
        '  Tip: New Use /fast to enable our fastest inference at 2X plan usage.',
        '',
        '› Summarize recent commits',
        '',
        '• Summary of the recent commits: the repo has shifted toward control-plane hardening, root-session UX, and run-ledger persistence.',
        '',
        '› Improve documentation in @filename',
        '',
        '  gpt-5.4 xhigh · ~/Documents/AI-projects/cliagents'
      ].join('\n')
    );

    const rootStatus = manager.getStatus(rootTerminalId);
    assert.strictEqual(rootStatus, TerminalStatus.IDLE);

    const rootMessages = db.getHistory(rootTerminalId);
    assert.strictEqual(rootMessages.length, 2);
    assert.strictEqual(rootMessages[0].role, 'user');
    assert.strictEqual(rootMessages[0].content, 'Summarize recent commits');
    assert.strictEqual(rootMessages[1].role, 'assistant');
    assert(rootMessages[1].content.includes('control-plane hardening'));
    assert(!rootMessages[1].content.includes('Improve documentation in @filename'));

    const rootEvents = db.listSessionEvents({ rootSessionId: rootTerminalId });
    assert(rootEvents.some((event) => event.event_type === 'message_sent'));
    assert(rootEvents.some((event) => event.event_type === 'message_received'));

    fakeTmux.setHistory(
      rootSessionName,
      rootWindowName,
      [
        '╭──────────────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.120.0)                   │',
        '╰──────────────────────────────────────────────╯',
        '',
        '■ Conversation interrupted - tell the model what to do differently.',
        'Something went wrong? Hit `/feedback` to report the issue.',
        'To continue this session, run codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'
      ].join('\n')
    );

    const interruptedTerminal = manager.getTerminal(rootTerminalId);
    assert(interruptedTerminal, 'interrupted root terminal should still be visible');
    assert.strictEqual(interruptedTerminal.status, TerminalStatus.ERROR);
    assert(interruptedTerminal.attention, 'interrupted root should expose attention metadata');
    assert.strictEqual(interruptedTerminal.attention.code, 'conversation_interrupted');
    assert.strictEqual(
      interruptedTerminal.attention.resumeCommand,
      'codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'
    );

    const interruptedEvents = db.listSessionEvents({ rootSessionId: rootTerminalId });
    const terminatedEvent = interruptedEvents.find((event) => (
      event.event_type === 'session_terminated'
      && event.payload_json?.status === 'error'
      && event.payload_json?.attentionCode === 'conversation_interrupted'
    ));
    assert(terminatedEvent, 'interrupted root should record attention metadata in session events');

    console.log('✅ Session control-plane runtime writes metadata, emits events, and reconciles tracked completion from logs');
    console.log('✅ Managed root transcript sync persists interactive turns from terminal output');
    console.log('✅ Interrupted Codex roots expose resume metadata through the terminal/runtime layer');
    console.log('\nSession control-plane runtime tests passed');
  } finally {
    global.setTimeout = realSetTimeout;
    db.close();
  }
}

run().catch((error) => {
  console.error('\nSession control-plane runtime tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
