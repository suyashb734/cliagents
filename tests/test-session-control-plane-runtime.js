#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { ClaudeCodeDetector, CodexCliDetector } = require('../src/status-detectors');
const {
  PersistentSessionManager,
  TerminalStatus
} = require('../src/tmux/session-manager');

function makeTempDir(prefix) {
  const baseDir = path.join('/Users/mojave/Documents/AI-projects/cliagents', '.tmp-tests');
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

function normalizeUuid(value) {
  const compact = String(value || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    return null;
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
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
  const originalClaudePath = process.env.CLIAGENTS_CLAUDE_PATH;

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

  try {
    process.env.CLIAGENTS_CLAUDE_PATH = '/usr/local/bin/claude';
    const manager = new PersistentSessionManager({
      db,
      tmuxClient: fakeTmux,
      logDir,
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });
    manager.registerStatusDetector('codex-cli', new CodexCliDetector());
    manager.registerStatusDetector('claude-code', new ClaudeCodeDetector());

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

    const claudeRootSessionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const claudeProviderThreadRef = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const claudeRoot = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'main',
      workDir: rootDir,
      rootSessionId: claudeRootSessionId,
      originClient: 'claude',
      externalSessionRef: 'claude:managed:bind-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'claude',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      },
      permissionMode: 'default'
    });
    const claudeHistory = fakeTmux.getHistory(claudeRoot.sessionName, claudeRoot.windowName);
    assert(claudeHistory.includes(`--session-id ${claudeProviderThreadRef}`), 'expected managed Claude root to bind an exact provider session id');
    assert.strictEqual(claudeRoot.providerThreadRef, claudeProviderThreadRef);
    const persistedClaudeRoot = db.getTerminal(claudeRoot.terminalId);
    assert.strictEqual(persistedClaudeRoot.provider_thread_ref, claudeProviderThreadRef);

    const qwenRootSessionId = 'cccccccccccccccccccccccccccccccc';
    const qwenProviderThreadRef = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const qwenRoot = await manager.createTerminal({
      adapter: 'qwen-cli',
      role: 'main',
      workDir: rootDir,
      rootSessionId: qwenRootSessionId,
      originClient: 'qwen',
      externalSessionRef: 'qwen:managed:bind-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'qwen',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      }
    });
    const qwenHistory = fakeTmux.getHistory(qwenRoot.sessionName, qwenRoot.windowName);
    assert(qwenHistory.includes(`--session-id ${qwenProviderThreadRef}`), 'expected managed Qwen root to bind an exact provider session id');
    assert.strictEqual(qwenRoot.providerThreadRef, qwenProviderThreadRef);

    const recoveredClaudeRoot = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'main',
      workDir: rootDir,
      originClient: 'claude',
      externalSessionRef: 'claude:managed:continue-test',
      sessionKind: 'main',
      permissionMode: 'default',
      sessionMetadata: {
        clientName: 'claude',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true,
        providerResumeLatest: true
      }
    });
    const recoveredClaudeHistory = fakeTmux.getHistory(recoveredClaudeRoot.sessionName, recoveredClaudeRoot.windowName);
    assert(recoveredClaudeHistory.includes('--continue'), 'expected recovered Claude root to continue the latest provider session');
    assert(!recoveredClaudeHistory.includes('--session-id'), 'did not expect a fresh provider session binding for recovered Claude root');

    const recoveredClaudeResumeThreadRef = 'cccccccc-1111-2222-3333-444444444444';
    const recoveredClaudeExactRoot = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'main',
      workDir: rootDir,
      originClient: 'claude',
      externalSessionRef: 'claude:managed:exact-resume-test',
      sessionKind: 'main',
      permissionMode: 'default',
      sessionMetadata: {
        clientName: 'claude',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true,
        providerResumeSessionId: recoveredClaudeResumeThreadRef
      }
    });
    const recoveredClaudeExactHistory = fakeTmux.getHistory(recoveredClaudeExactRoot.sessionName, recoveredClaudeExactRoot.windowName);
    assert(recoveredClaudeExactHistory.includes(`--resume ${recoveredClaudeResumeThreadRef}`), 'expected recovered Claude root to resume the exact provider session');
    assert(!recoveredClaudeExactHistory.includes('--continue'), 'did not expect recovered Claude root with an exact session id to fall back to latest-session continue');
    assert.strictEqual(recoveredClaudeExactRoot.providerThreadRef, recoveredClaudeResumeThreadRef);
    const persistedRecoveredClaudeExactRoot = db.getTerminal(recoveredClaudeExactRoot.terminalId);
    assert.strictEqual(persistedRecoveredClaudeExactRoot.provider_thread_ref, recoveredClaudeResumeThreadRef);

    const recoveredGeminiRoot = await manager.createTerminal({
      adapter: 'gemini-cli',
      role: 'main',
      workDir: rootDir,
      originClient: 'gemini',
      externalSessionRef: 'gemini:managed:continue-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'gemini',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true,
        providerResumeLatest: true
      }
    });
    const recoveredGeminiHistory = fakeTmux.getHistory(recoveredGeminiRoot.sessionName, recoveredGeminiRoot.windowName);
    assert(recoveredGeminiHistory.includes('--resume latest'), 'expected recovered Gemini root to resume the latest provider session');

    const recoveredQwenRoot = await manager.createTerminal({
      adapter: 'qwen-cli',
      role: 'main',
      workDir: rootDir,
      originClient: 'qwen',
      externalSessionRef: 'qwen:managed:continue-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'qwen',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true,
        providerResumeLatest: true
      }
    });
    const recoveredQwenHistory = fakeTmux.getHistory(recoveredQwenRoot.sessionName, recoveredQwenRoot.windowName);
    assert(recoveredQwenHistory.includes('--continue'), 'expected recovered Qwen root to continue the latest provider session');
    assert(!recoveredQwenHistory.includes('--session-id'), 'did not expect a fresh provider session binding for recovered Qwen root');

    const recoveredOpenCodeRoot = await manager.createTerminal({
      adapter: 'opencode-cli',
      role: 'main',
      workDir: rootDir,
      originClient: 'opencode',
      externalSessionRef: 'opencode:managed:continue-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'opencode',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true,
        providerResumeLatest: true
      }
    });
    const recoveredOpenCodeHistory = fakeTmux.getHistory(recoveredOpenCodeRoot.sessionName, recoveredOpenCodeRoot.windowName);
    assert(recoveredOpenCodeHistory.includes('--continue'), 'expected recovered OpenCode root to continue the latest provider session');

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

    const claudeWorkerRootSessionId = 'dddddddddddddddddddddddddddddddd';
    const expectedClaudeChildThreadRef = null;
    const claudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: claudeWorkerRootSessionId,
      parentSessionId: claudeWorkerRootSessionId,
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-1',
      permissionMode: 'auto',
      systemPrompt: 'Review carefully and be explicit about regressions.',
      allowedTools: ['Read', 'Write'],
      workDir: rootDir
    });
    const claudeWorkerReadyHistory = fakeTmux.getHistory(claudeWorker.sessionName, claudeWorker.windowName);
    assert(claudeWorkerReadyHistory.includes('CLAUDE_READY_FOR_ORCHESTRATION'), 'expected Claude worker ready marker');
    assert.strictEqual(claudeWorker.providerThreadRef, expectedClaudeChildThreadRef);

    await manager.sendInput(claudeWorker.terminalId, 'Review the managed-root recovery patch.');
    const liveClaudeWorker = manager.terminals.get(claudeWorker.terminalId);
    const claudeWorkerHistory = fakeTmux.getHistory(liveClaudeWorker.sessionName, liveClaudeWorker.windowName);
    const rootProviderThreadRef = normalizeUuid(claudeWorkerRootSessionId);
    const claudeWorkerProviderThreadRef = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    assert.strictEqual(liveClaudeWorker.providerThreadRef, null);
    assert(claudeWorkerHistory.includes('/usr/local/bin/claude'), `expected explicit Claude path, got: ${claudeWorkerHistory}`);
    assert(!claudeWorkerHistory.includes('--session-id'), `did not expect first Claude worker send to bind a provider session id, got: ${claudeWorkerHistory}`);
    assert(!claudeWorkerHistory.includes(`--session-id ${rootProviderThreadRef}`), `Claude worker should not bind to broker root session id, got: ${claudeWorkerHistory}`);
    assert(!claudeWorkerHistory.includes('--resume'), `did not expect first Claude worker send to resume a provider thread, got: ${claudeWorkerHistory}`);
    assert(claudeWorkerHistory.includes('--dangerously-skip-permissions'), `expected Claude worker auto-approval flag, got: ${claudeWorkerHistory}`);
    assert(claudeWorkerHistory.includes('--allowed-tools "Read,Write"'), `expected Claude worker tool restriction, got: ${claudeWorkerHistory}`);
    assert(claudeWorkerHistory.includes('--system-prompt "Review carefully and be explicit about regressions."'), `expected Claude worker system prompt on first send, got: ${claudeWorkerHistory}`);

    const persistedClaudeWorker = db.getTerminal(claudeWorker.terminalId);
    assert.strictEqual(persistedClaudeWorker.provider_thread_ref, liveClaudeWorker.providerThreadRef);

    fs.writeFileSync(
      liveClaudeWorker.logPath,
      [
        liveClaudeWorker.activeRun.startMarker,
        `{"type":"system","session_id":"${claudeWorkerProviderThreadRef}"}`,
        'Claude review complete.',
        `${liveClaudeWorker.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      liveClaudeWorker.sessionName,
      liveClaudeWorker.windowName,
      `{"type":"system","session_id":"${claudeWorkerProviderThreadRef}"}\nClaude review complete.\n`
    );
    fakeTmux.setCurrentCommand(liveClaudeWorker.sessionName, liveClaudeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(claudeWorker.terminalId), TerminalStatus.COMPLETED);
    assert.strictEqual(liveClaudeWorker.providerThreadRef, claudeWorkerProviderThreadRef);

    const persistedClaudeWorkerAfterCompletion = db.getTerminal(claudeWorker.terminalId);
    assert.strictEqual(persistedClaudeWorkerAfterCompletion.provider_thread_ref, claudeWorkerProviderThreadRef);

    const beforeClaudeResumeHistory = fakeTmux.getHistory(liveClaudeWorker.sessionName, liveClaudeWorker.windowName);
    await manager.sendInput(claudeWorker.terminalId, 'Continue the same review with follow-up concerns.');
    const resumedClaudeWorkerHistory = fakeTmux.getHistory(liveClaudeWorker.sessionName, liveClaudeWorker.windowName).slice(beforeClaudeResumeHistory.length);
    assert(resumedClaudeWorkerHistory.includes(`--resume ${claudeWorkerProviderThreadRef}`), `expected Claude worker follow-up send to resume its provider thread, got: ${resumedClaudeWorkerHistory}`);
    fs.writeFileSync(
      liveClaudeWorker.logPath,
      [
        liveClaudeWorker.activeRun.startMarker,
        `{"type":"system","session_id":"${claudeWorkerProviderThreadRef}"}`,
        'Claude follow-up review complete.',
        `${liveClaudeWorker.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      liveClaudeWorker.sessionName,
      liveClaudeWorker.windowName,
      `{"type":"system","session_id":"${claudeWorkerProviderThreadRef}"}\nClaude follow-up review complete.\n`
    );
    fakeTmux.setCurrentCommand(liveClaudeWorker.sessionName, liveClaudeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(claudeWorker.terminalId), TerminalStatus.COMPLETED);

    const reusedClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: claudeWorkerRootSessionId,
      parentSessionId: claudeWorkerRootSessionId,
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-1',
      permissionMode: 'auto',
      systemPrompt: 'Review carefully and be explicit about regressions.',
      allowedTools: ['Read', 'Write'],
      workDir: rootDir
    });
    assert.strictEqual(reusedClaudeWorker.reused, true);
    assert.strictEqual(reusedClaudeWorker.terminalId, claudeWorker.terminalId);
    assert.strictEqual(liveClaudeWorker.providerThreadRef, null);
    assert.strictEqual(liveClaudeWorker.messageCount, 0);
    assert.strictEqual(liveClaudeWorker.status, TerminalStatus.IDLE);

    const beforeReusedClaudeHistory = fakeTmux.getHistory(liveClaudeWorker.sessionName, liveClaudeWorker.windowName);
    await manager.sendInput(reusedClaudeWorker.terminalId, 'Start a fresh Claude review task.');
    const reusedClaudeHistory = fakeTmux.getHistory(liveClaudeWorker.sessionName, liveClaudeWorker.windowName).slice(beforeReusedClaudeHistory.length);
    assert(!reusedClaudeHistory.includes(`--resume ${claudeWorkerProviderThreadRef}`), `did not expect reused Claude worker to resume the prior provider thread, got: ${reusedClaudeHistory}`);
    assert(!reusedClaudeHistory.includes('--session-id'), `did not expect reused Claude worker to bind a provider session id before output sync, got: ${reusedClaudeHistory}`);

    const implicitClaudeChild = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      rootSessionId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-implicit',
      sessionMetadata: {
        providerResumeSessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      },
      permissionMode: 'auto',
      workDir: rootDir
    });
    assert.strictEqual(implicitClaudeChild.sessionKind, 'subagent');
    assert.strictEqual(manager.terminals.get(implicitClaudeChild.terminalId).providerThreadRef, null);

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
    if (originalClaudePath === undefined) {
      delete process.env.CLIAGENTS_CLAUDE_PATH;
    } else {
      process.env.CLIAGENTS_CLAUDE_PATH = originalClaudePath;
    }
    db.close();
  }
}

run().catch((error) => {
  console.error('\nSession control-plane runtime tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
