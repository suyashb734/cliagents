#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { ClaudeCodeDetector, CodexCliDetector, OpencodeCliDetector } = require('../src/status-detectors');
const {
  PersistentSessionManager,
  TerminalStatus
} = require('../src/tmux/session-manager');

function makeTempDir(prefix) {
  const baseDir = path.join(os.homedir(), '.cliagents-test-tmp');
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
    this.createCalls = [];
    this.resizeCalls = [];
    this.statusVisibilityCalls = [];
    this.respawnCalls = [];
    this.specialKeys = [];
    this.existingSessions = new Set();
    this.attachedCounts = new Map();
  }

  _key(sessionName, windowName) {
    return `${sessionName}:${windowName}`;
  }

  listSessions() {
    return Array.from(this.existingSessions).map((name) => ({
      name,
      attached: (this.attachedCounts.get(name) || 0) > 0
    }));
  }

  createSession(sessionName, windowName, terminalId, options = {}) {
    this.createCalls.push({ sessionName, windowName, terminalId, options });
    this.existingSessions.add(sessionName);
    this.attachedCounts.set(sessionName, 0);
    return true;
  }

  setEnvironment() {
    return true;
  }

  resizePane(sessionName, windowName, width, height) {
    this.resizeCalls.push({ sessionName, windowName, width, height });
    return true;
  }

  setSessionStatusVisible(sessionName, visible) {
    this.statusVisibilityCalls.push({ sessionName, visible });
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

  respawnPane(sessionName, windowName, command) {
    const key = this._key(sessionName, windowName);
    this.respawnCalls.push({ sessionName, windowName, command });
    this.histories.set(key, `${this.histories.get(key) || ''}${command}\n`);
    return true;
  }

  sendSpecialKey(sessionName, windowName, key) {
    this.specialKeys.push({ sessionName, windowName, key });
    return true;
  }

  getHistory(sessionName, windowName) {
    return this.histories.get(this._key(sessionName, windowName)) || '';
  }

  getPaneCurrentCommand(sessionName, windowName) {
    return this.commands.get(this._key(sessionName, windowName)) || 'zsh';
  }

  sessionExists(sessionName) {
    return this.existingSessions.has(sessionName);
  }

  getSessionAttachedCount(sessionName) {
    return this.attachedCounts.get(sessionName) || 0;
  }

  setSessionAttachedCount(sessionName, count) {
    this.attachedCounts.set(sessionName, count);
  }

  setHistory(sessionName, windowName, output) {
    this.existingSessions.add(sessionName);
    this.histories.set(this._key(sessionName, windowName), output);
  }

  setCurrentCommand(sessionName, windowName, command) {
    this.commands.set(this._key(sessionName, windowName), command);
  }

  killSession(sessionName) {
    this.existingSessions.delete(sessionName);
    this.attachedCounts.delete(sessionName);
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
      dataDir: rootDir,
      localApiKeyFilePath: path.join(rootDir, 'local-api-key'),
      brokerBaseUrl: 'http://127.0.0.1:4999',
      logDir,
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });
    manager.registerStatusDetector('codex-cli', new CodexCliDetector());
    manager.registerStatusDetector('claude-code', new ClaudeCodeDetector());
    manager.registerStatusDetector('opencode-cli', new OpencodeCliDetector());

    assert.strictEqual(manager._extractQwenAttention('[API Error: 401 invalid access token or token expired]').code, 'auth_expired');
    assert.strictEqual(manager._extractGeminiAttention('RateLimitError: capacity on this model').code, 'provider_capacity');
    assert.strictEqual(manager._extractOpencodeAttention('Error: no active provider configured').code, 'provider_unavailable');
    assert.strictEqual(manager._extractOpencodeAttention('Subscription quota exceeded. You can continue using free models.').code, 'quota_exhausted');
    assert.strictEqual(manager._extractOpencodeAttention('OpenCode authentication failed').code, 'auth_expired');

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
    const workerCreateCall = fakeTmux.createCalls.find((call) => call.terminalId === terminal.terminalId);
    assert.strictEqual(workerCreateCall.options.env.CLIAGENTS_URL, 'http://127.0.0.1:4999');
    assert.strictEqual(workerCreateCall.options.env.CLIAGENTS_DATA_DIR, rootDir);
    assert.strictEqual(workerCreateCall.options.env.CLIAGENTS_LOCAL_API_KEY_FILE, path.join(rootDir, 'local-api-key'));

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
    assert(fakeTmux.respawnCalls.some((call) => call.sessionName === recoveredRoot.sessionName),
      'expected managed Codex root startup to respawn the pane directly');
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
    assert(fakeTmux.respawnCalls.some((call) => call.sessionName === claudeRoot.sessionName),
      'expected managed Claude root startup to respawn the pane directly');
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

    const geometryRoot = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'main',
      workDir: rootDir,
      rootSessionId: 'dddddddddddddddddddddddddddddddd',
      originClient: 'codex',
      externalSessionRef: 'codex:managed:geometry-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      },
      launchEnvironment: {
        TERM_PROGRAM: 'iTerm.app',
        COLUMNS: '180',
        LINES: '48'
      }
    });
    const geometryCreateCall = fakeTmux.createCalls.find((call) => call.terminalId === geometryRoot.terminalId);
    assert(geometryCreateCall, 'expected managed root tmux create call to be recorded');
    assert.strictEqual(geometryCreateCall.options.width, 180);
    assert.strictEqual(geometryCreateCall.options.height, 48);
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_ROOT_SESSION_ID,
      'dddddddddddddddddddddddddddddddd',
      'expected managed root launch to export its broker root id into the provider environment'
    );
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_CLIENT_SESSION_REF,
      'codex:managed:geometry-test',
      'expected managed root launch to export its client session ref into the provider environment'
    );
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_CLIENT_NAME,
      'codex',
      'expected managed root launch to export the root client name into the provider environment'
    );
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_WORKSPACE_ROOT,
      rootDir,
      'expected managed root launch to export the workspace root into the provider environment'
    );
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_MANAGED_ROOT,
      '1',
      'expected managed root launch to mark the provider environment as broker-managed'
    );
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_URL,
      'http://127.0.0.1:4999',
      'expected managed roots to inherit the broker URL for nested cliagents calls'
    );
    assert.strictEqual(
      geometryCreateCall.options.env.CLIAGENTS_LOCAL_API_KEY_FILE,
      path.join(rootDir, 'local-api-key'),
      'expected managed roots to inherit the local-token file path without copying the token'
    );
    assert(
      fakeTmux.resizeCalls.some((call) => (
        call.sessionName === geometryRoot.sessionName
        && call.windowName === geometryRoot.windowName
        && call.width === 180
        && call.height === 48
      )),
      'expected managed root launch geometry to resize the tmux pane before CLI startup'
    );
    assert(
      fakeTmux.statusVisibilityCalls.some((call) => (
        call.sessionName === geometryRoot.sessionName
        && call.visible === false
      )),
      'expected managed root launch to hide the tmux status bar so the provider owns the full pane'
    );

    const deferredRoot = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'main',
      workDir: rootDir,
      rootSessionId: 'ffffffffffffffffffffffffffffffff',
      originClient: 'codex',
      externalSessionRef: 'codex:managed:attach-first-test',
      sessionKind: 'main',
      sessionMetadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      },
      deferProviderStartUntilAttached: true
    });
    const deferredHistoryBeforeAttach = fakeTmux.getHistory(deferredRoot.sessionName, deferredRoot.windowName);
    assert.strictEqual(deferredRoot.deferredProviderStart, true);
    assert.strictEqual(deferredRoot.providerStartState, 'pending_attach');
    assert.strictEqual(
      deferredHistoryBeforeAttach.trim(),
      '',
      'expected managed root launch to wait for tmux attach before starting the provider'
    );

    fakeTmux.setSessionAttachedCount(deferredRoot.sessionName, 1);
    let deferredHistoryAfterAttach = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      deferredHistoryAfterAttach = fakeTmux.getHistory(deferredRoot.sessionName, deferredRoot.windowName);
      if (deferredHistoryAfterAttach.includes('codex')) {
        break;
      }
    }
    assert(
      deferredHistoryAfterAttach.includes('codex'),
      'expected deferred managed root launch to start Codex after a tmux client attaches'
    );

    const orphanedOutputRoot = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'main',
      workDir: rootDir,
      rootSessionId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      originClient: 'claude',
      externalSessionRef: 'claude:managed:orphaned-output-test',
      sessionKind: 'main',
      permissionMode: 'default',
      sessionMetadata: {
        clientName: 'claude',
        attachMode: 'managed-root-launch',
        managedLaunch: true
      }
    });
    const orphanedLiveTerminal = manager.terminals.get(orphanedOutputRoot.terminalId);
    fs.writeFileSync(orphanedLiveTerminal.logPath, 'Persisted output after tmux exit\n', 'utf8');
    fakeTmux.existingSessions.delete(orphanedLiveTerminal.sessionName);
    let orphanedTailBytes = null;
    const originalReadLogTail = manager.readLogTail.bind(manager);
    manager.readLogTail = (terminalId, bytes) => {
      orphanedTailBytes = bytes;
      return originalReadLogTail(terminalId, bytes);
    };
    const orphanedOutput = manager.getOutput(orphanedOutputRoot.terminalId, 400);
    assert(orphanedOutput.includes('Persisted output after tmux exit'), 'expected output route fallback to log tail for orphaned terminals');
    assert.strictEqual(orphanedTailBytes, 50000, 'expected orphaned output fallback to cap log tail reads');
    assert.strictEqual(manager.getStatus(orphanedOutputRoot.terminalId), 'orphaned');
    const persistedOrphanedTerminal = db.getTerminal(orphanedOutputRoot.terminalId);
    assert.strictEqual(persistedOrphanedTerminal.status, 'orphaned');

    const recoveredCodexFreshRoot = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'main',
      workDir: rootDir,
      originClient: 'codex',
      externalSessionRef: 'codex:managed:fresh-recovery-test',
      sessionKind: 'main',
      permissionMode: 'default',
      sessionMetadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        recoveredManagedRoot: true
      }
    });
    const recoveredCodexFreshHistory = fakeTmux.getHistory(recoveredCodexFreshRoot.sessionName, recoveredCodexFreshRoot.windowName);
    assert(!recoveredCodexFreshHistory.includes('resume --last'), 'did not expect recovered Codex root without an exact handle to resume the latest provider session');

    const codexProviderPickerRoot = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'main',
      workDir: rootDir,
      originClient: 'codex',
      externalSessionRef: 'codex:managed:provider-picker-test',
      sessionKind: 'main',
      permissionMode: 'default',
      sessionMetadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        providerResumePicker: true
      }
    });
    const codexProviderPickerHistory = fakeTmux.getHistory(codexProviderPickerRoot.sessionName, codexProviderPickerRoot.windowName);
    assert(codexProviderPickerHistory.includes('codex resume'), 'expected Codex provider resume picker launch to run codex resume');
    assert(!codexProviderPickerHistory.includes('resume --last'), 'did not expect provider picker launch to skip the native picker');

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

    const opencodeWorkerRootSessionId = '12121212121212121212121212121212';
    const opencodeWorker = await manager.createTerminal({
      adapter: 'opencode-cli',
      role: 'worker',
      agentProfile: 'implement_opencode-cli',
      rootSessionId: opencodeWorkerRootSessionId,
      parentSessionId: opencodeWorkerRootSessionId,
      sessionKind: 'implementer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-opencode-model',
      systemPrompt: 'Reply with MODEL_OK only.',
      model: 'minimax-coding-plan/MiniMax-M2.7',
      workDir: rootDir
    });
    const opencodeWorkerReadyHistory = fakeTmux.getHistory(opencodeWorker.sessionName, opencodeWorker.windowName);
    assert(opencodeWorkerReadyHistory.includes('OPENCODE_READY_FOR_ORCHESTRATION'), 'expected OpenCode worker ready marker');

    await manager.sendInput(opencodeWorker.terminalId, 'Reply with MODEL_OK only.');
    const liveOpencodeWorker = manager.terminals.get(opencodeWorker.terminalId);
    const opencodeWorkerHistory = fakeTmux.getHistory(liveOpencodeWorker.sessionName, liveOpencodeWorker.windowName);
    assert(
      opencodeWorkerHistory.includes('opencode run --model minimax-coding-plan/MiniMax-M2.7'),
      `expected OpenCode worker command to preserve provider-qualified model id, got: ${opencodeWorkerHistory}`
    );

    const opencodeWorkerProviderThreadRef = 'ses_2651e0383ffe3W01hCA74Q7mYy';
    fs.writeFileSync(
      liveOpencodeWorker.logPath,
      [
        liveOpencodeWorker.activeRun.startMarker,
        `{"type":"step_start","sessionID":"${opencodeWorkerProviderThreadRef}"}`,
        '{"type":"text","text":"MODEL_OK"}',
        `${liveOpencodeWorker.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      liveOpencodeWorker.sessionName,
      liveOpencodeWorker.windowName,
      `{"type":"step_start","sessionID":"${opencodeWorkerProviderThreadRef}"}\n{"type":"text","text":"MODEL_OK"}\n`
    );
    fakeTmux.setCurrentCommand(liveOpencodeWorker.sessionName, liveOpencodeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(opencodeWorker.terminalId), TerminalStatus.COMPLETED);
    assert.strictEqual(liveOpencodeWorker.providerThreadRef, opencodeWorkerProviderThreadRef);

    const persistedOpencodeWorker = db.getTerminal(opencodeWorker.terminalId);
    assert.strictEqual(persistedOpencodeWorker.provider_thread_ref, opencodeWorkerProviderThreadRef);

    const beforeOpencodeResumeHistory = fakeTmux.getHistory(liveOpencodeWorker.sessionName, liveOpencodeWorker.windowName);
    await manager.sendInput(opencodeWorker.terminalId, 'Reply with MODEL_OK only again.');
    const resumedOpencodeWorkerHistory = fakeTmux.getHistory(liveOpencodeWorker.sessionName, liveOpencodeWorker.windowName).slice(beforeOpencodeResumeHistory.length);
    assert(
      resumedOpencodeWorkerHistory.includes(`--session ${opencodeWorkerProviderThreadRef}`),
      `expected OpenCode follow-up send to resume the provider session, got: ${resumedOpencodeWorkerHistory}`
    );
    assert(
      resumedOpencodeWorkerHistory.includes('opencode run --model minimax-coding-plan/MiniMax-M2.7'),
      `expected OpenCode follow-up send to keep the provider-qualified model id, got: ${resumedOpencodeWorkerHistory}`
    );
    fs.writeFileSync(
      liveOpencodeWorker.logPath,
      [
        liveOpencodeWorker.activeRun.startMarker,
        `{"type":"step_start","sessionID":"${opencodeWorkerProviderThreadRef}"}`,
        '{"type":"text","text":"MODEL_OK"}',
        `${liveOpencodeWorker.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      liveOpencodeWorker.sessionName,
      liveOpencodeWorker.windowName,
      `{"type":"step_start","sessionID":"${opencodeWorkerProviderThreadRef}"}\n{"type":"text","text":"MODEL_OK"}\n`
    );
    fakeTmux.setCurrentCommand(liveOpencodeWorker.sessionName, liveOpencodeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(opencodeWorker.terminalId), TerminalStatus.COMPLETED);

    const geminiCollaboratorRootSessionId = '34343434343434343434343434343434';
    const geminiCollaborator = await manager.createTerminal({
      adapter: 'gemini-cli',
      role: 'worker',
      agentProfile: 'research_gemini-cli',
      rootSessionId: geminiCollaboratorRootSessionId,
      parentSessionId: geminiCollaboratorRootSessionId,
      sessionKind: 'collaborator',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-gemini-collaborator',
      sessionLabel: 'gemini-architect',
      sessionMetadata: {
        clientName: 'codex',
        toolName: 'delegate_task',
        collaborator: true,
        sessionLabel: 'gemini-architect'
      },
      workDir: rootDir
    });
    await manager.sendInput(geminiCollaborator.terminalId, 'Research the first architectural option.');
    const liveGeminiCollaborator = manager.terminals.get(geminiCollaborator.terminalId);
    const firstGeminiCollaboratorHistory = fakeTmux.getHistory(
      liveGeminiCollaborator.sessionName,
      liveGeminiCollaborator.windowName
    );
    assert(
      !firstGeminiCollaboratorHistory.includes('--session-id'),
      `did not expect first Gemini collaborator send to resume a provider session, got: ${firstGeminiCollaboratorHistory}`
    );

    const geminiCollaboratorProviderThreadRef = '34343434-3434-3434-3434-343434343434';
    fs.writeFileSync(
      liveGeminiCollaborator.logPath,
      [
        liveGeminiCollaborator.activeRun.startMarker,
        `__CLIAGENTS_PROVIDER_SESSION__${geminiCollaboratorProviderThreadRef}`,
        `{"session_id":"${geminiCollaboratorProviderThreadRef}"}`,
        '{"result":"Gemini collaborator completed."}',
        `${liveGeminiCollaborator.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      liveGeminiCollaborator.sessionName,
      liveGeminiCollaborator.windowName,
      `__CLIAGENTS_PROVIDER_SESSION__${geminiCollaboratorProviderThreadRef}\n{"session_id":"${geminiCollaboratorProviderThreadRef}"}\n{"result":"Gemini collaborator completed."}\n`
    );
    fakeTmux.setCurrentCommand(liveGeminiCollaborator.sessionName, liveGeminiCollaborator.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(geminiCollaborator.terminalId), TerminalStatus.COMPLETED);
    assert.strictEqual(liveGeminiCollaborator.providerThreadRef, geminiCollaboratorProviderThreadRef);

    const reusedGeminiCollaborator = await manager.createTerminal({
      adapter: 'gemini-cli',
      role: 'worker',
      agentProfile: 'research_gemini-cli',
      rootSessionId: geminiCollaboratorRootSessionId,
      parentSessionId: geminiCollaboratorRootSessionId,
      sessionKind: 'collaborator',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-gemini-collaborator',
      sessionLabel: 'gemini-architect',
      sessionMetadata: {
        clientName: 'codex',
        toolName: 'delegate_task',
        collaborator: true,
        sessionLabel: 'gemini-architect'
      },
      workDir: rootDir
    });
    assert.strictEqual(reusedGeminiCollaborator.reused, true);
    assert.strictEqual(reusedGeminiCollaborator.terminalId, geminiCollaborator.terminalId);
    assert.strictEqual(liveGeminiCollaborator.providerThreadRef, geminiCollaboratorProviderThreadRef);
    assert.strictEqual(liveGeminiCollaborator.messageCount, 1);

    const beforeGeminiCollaboratorResumeHistory = fakeTmux.getHistory(
      liveGeminiCollaborator.sessionName,
      liveGeminiCollaborator.windowName
    );
    await manager.sendInput(reusedGeminiCollaborator.terminalId, 'Continue from the same Gemini collaborator session.');
    const resumedGeminiCollaboratorHistory = fakeTmux.getHistory(
      liveGeminiCollaborator.sessionName,
      liveGeminiCollaborator.windowName
    ).slice(beforeGeminiCollaboratorResumeHistory.length);
    const resumedGeminiCollaboratorScriptPath = liveGeminiCollaborator.activeRun?.wrapperScriptPath || null;
    const resumedGeminiCollaboratorSource = resumedGeminiCollaboratorScriptPath
      ? fs.readFileSync(resumedGeminiCollaboratorScriptPath, 'utf8')
      : resumedGeminiCollaboratorHistory;
    assert(
      resumedGeminiCollaboratorSource.includes(`--session-id "${geminiCollaboratorProviderThreadRef}"`),
      `expected Gemini collaborator reuse to preserve provider session continuity, got: ${resumedGeminiCollaboratorSource}`
    );

    const opencodeFatalWorker = await manager.createTerminal({
      adapter: 'opencode-cli',
      role: 'worker',
      agentProfile: 'implement_opencode-cli',
      rootSessionId: 'efefefefefefefefefefefefefefefef',
      parentSessionId: 'efefefefefefefefefefefefefefefef',
      sessionKind: 'implementer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-opencode-quota',
      model: 'opencode-go/qwen3.6-plus',
      workDir: rootDir
    });
    await manager.sendInput(opencodeFatalWorker.terminalId, 'Reply with MODEL_OK only.');
    const liveOpencodeFatalWorker = manager.terminals.get(opencodeFatalWorker.terminalId);
    const opencodeFatalHistory = fakeTmux.getHistory(liveOpencodeFatalWorker.sessionName, liveOpencodeFatalWorker.windowName);
    assert(
      opencodeFatalHistory.includes('--print-logs'),
      `expected OpenCode worker command to print provider logs, got: ${opencodeFatalHistory}`
    );
    assert(
      opencodeFatalHistory.includes('--log-level ERROR'),
      `expected OpenCode worker command to request error-level logs, got: ${opencodeFatalHistory}`
    );
    fakeTmux.setHistory(
      liveOpencodeFatalWorker.sessionName,
      liveOpencodeFatalWorker.windowName,
      `${opencodeFatalHistory}\nERROR 2026-04-20T10:55:30 service=llm error={"error":{"type":"SubscriptionUsageLimitError","message":"Subscription quota exceeded. You can continue using free models."}}\n`
    );
    fakeTmux.setCurrentCommand(liveOpencodeFatalWorker.sessionName, liveOpencodeFatalWorker.windowName, 'opencode');
    assert.strictEqual(manager.getStatus(opencodeFatalWorker.terminalId), TerminalStatus.ERROR);
    assert.strictEqual(liveOpencodeFatalWorker.attention?.code, 'quota_exhausted');
    assert(
      fakeTmux.specialKeys.some((entry) =>
        entry.sessionName === liveOpencodeFatalWorker.sessionName
        && entry.windowName === liveOpencodeFatalWorker.windowName
        && entry.key === 'C-c'
      ),
      'expected fatal OpenCode worker errors to interrupt the stuck process'
    );

    let events = db.listSessionEvents({ rootSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event_type, 'session_started');
    assert.strictEqual(events[0].session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(events[1].event_type, 'session_started');
    assert.strictEqual(events[1].session_id, terminal.terminalId);

    await manager.sendInput(terminal.terminalId, 'Review the implementation carefully.');
    const liveTerminal = manager.terminals.get(terminal.terminalId);
    const codexWorkerThreadRef = 'thread-codex-123';
    assert.strictEqual(liveTerminal.status, TerminalStatus.PROCESSING);
    let livenessEvents = db.listRootIoEvents({
      terminalId: terminal.terminalId,
      eventKind: 'liveness',
      limit: 10
    });
    assert(
      livenessEvents.some((event) => event.metadata.nextStatus === TerminalStatus.PROCESSING && event.metadata.source === 'session-manager.sendInput'),
      'sendInput should persist a processing liveness root IO event'
    );
    assert(liveTerminal.activeRun, 'tracked one-shot run should be active');

    const codexWorkerLog = [
      liveTerminal.activeRun.startMarker,
      `{"type":"thread.started","thread_id":"${codexWorkerThreadRef}"}`,
      '{"type":"item.completed","item":{"type":"agent_message","text":"Running review..."}}',
      `${liveTerminal.activeRun.exitMarkerPrefix}0`
    ].join('\n');
    fs.writeFileSync(liveTerminal.logPath, codexWorkerLog, 'utf8');
    fakeTmux.setHistory(
      liveTerminal.sessionName,
      liveTerminal.windowName,
      `{"type":"thread.started","thread_id":"${codexWorkerThreadRef}"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Running review..."}}\n`
    );
    fakeTmux.setCurrentCommand(liveTerminal.sessionName, liveTerminal.windowName, 'zsh');

    const status = manager.getStatus(terminal.terminalId);
    assert.strictEqual(status, TerminalStatus.COMPLETED);
    assert.strictEqual(liveTerminal.providerThreadRef, codexWorkerThreadRef);
    livenessEvents = db.listRootIoEvents({
      terminalId: terminal.terminalId,
      eventKind: 'liveness',
      limit: 10
    });
    assert(
      livenessEvents.some((event) => event.metadata.nextStatus === TerminalStatus.COMPLETED && event.metadata.source === 'session-manager.status'),
      'status transition should persist a completed liveness root IO event'
    );
    const screenSnapshots = db.listRootIoEvents({
      terminalId: terminal.terminalId,
      eventKind: 'screen_snapshot',
      limit: 10
    });
    assert(
      screenSnapshots.some((event) => event.contentFull.includes('Running review') && event.metadata.source === 'session-manager.getStatus'),
      'getStatus should persist a deduplicated screen snapshot root IO event'
    );
    const logOutputEvents = db.listRootIoEvents({
      terminalId: terminal.terminalId,
      eventKind: 'output',
      limit: 10
    });
    const codexOutputEvent = logOutputEvents.find((event) => (
      event.logPath === liveTerminal.logPath
      && event.logOffsetStart === 0
      && event.logOffsetEnd === Buffer.byteLength(codexWorkerLog, 'utf8')
      && event.contentFull.includes('Running review')
    ));
    assert(codexOutputEvent, 'getStatus should persist terminal-log output chunks with byte offsets');
    assert.strictEqual(codexOutputEvent.metadata.storedLogOffsetEnd, Buffer.byteLength(codexWorkerLog, 'utf8'));
    const screenSnapshotCount = screenSnapshots.length;
    const logOutputEventCount = logOutputEvents.length;
    assert.strictEqual(manager.getStatus(terminal.terminalId), TerminalStatus.COMPLETED);
    assert.strictEqual(
      db.listRootIoEvents({ terminalId: terminal.terminalId, eventKind: 'screen_snapshot', limit: 10 }).length,
      screenSnapshotCount,
      'unchanged getStatus output should not duplicate screen snapshot root IO events'
    );
    assert.strictEqual(
      db.listRootIoEvents({ terminalId: terminal.terminalId, eventKind: 'output', limit: 10 }).length,
      logOutputEventCount,
      'unchanged getStatus output should not duplicate terminal-log output root IO events'
    );

    const persistedCodexWorker = db.getTerminal(terminal.terminalId);
    assert.strictEqual(persistedCodexWorker.provider_thread_ref, codexWorkerThreadRef);

    const completedTerminal = db.getTerminal(terminal.terminalId);
    assert.strictEqual(completedTerminal.status, TerminalStatus.COMPLETED);

    events = db.listSessionEvents({ rootSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[2].event_type, 'session_terminated');
    assert.strictEqual(events[2].payload_json.exitCode, 0);

    const beforeCodexResumeHistory = fakeTmux.getHistory(liveTerminal.sessionName, liveTerminal.windowName);
    await manager.sendInput(terminal.terminalId, 'Continue the same implementation review.');
    const resumedCodexWorkerHistory = fakeTmux.getHistory(liveTerminal.sessionName, liveTerminal.windowName).slice(beforeCodexResumeHistory.length);
    assert(resumedCodexWorkerHistory.includes('codex exec -m gpt-5.4 --full-auto --json --skip-git-repo-check'), `expected stateless Codex worker command with broker-safe model, got: ${resumedCodexWorkerHistory}`);
    assert(!resumedCodexWorkerHistory.includes('codex exec resume'), `did not expect resumed Codex worker command, got: ${resumedCodexWorkerHistory}`);
    assert(!resumedCodexWorkerHistory.includes(codexWorkerThreadRef), `did not expect Codex worker command to inject provider thread ref, got: ${resumedCodexWorkerHistory}`);

    fs.writeFileSync(
      liveTerminal.logPath,
      [
        liveTerminal.activeRun.startMarker,
        `{"type":"thread.started","thread_id":"${codexWorkerThreadRef}"}`,
        '{"type":"item.completed","item":{"type":"agent_message","text":"Review follow-up complete."}}',
        `${liveTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      liveTerminal.sessionName,
      liveTerminal.windowName,
      `{"type":"thread.started","thread_id":"${codexWorkerThreadRef}"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Review follow-up complete."}}\n`
    );
    fakeTmux.setCurrentCommand(liveTerminal.sessionName, liveTerminal.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(terminal.terminalId), TerminalStatus.COMPLETED);

    const completedRunId = liveTerminal.activeRun.runId;
    const recoveredManager = new PersistentSessionManager({
      db,
      tmuxClient: fakeTmux,
      logDir,
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });
    recoveredManager.registerStatusDetector('codex-cli', new CodexCliDetector());
    recoveredManager.registerStatusDetector('claude-code', new ClaudeCodeDetector());
    const recoveredTrackedWorker = recoveredManager.terminals.get(terminal.terminalId);
    assert(recoveredTrackedWorker, 'expected completed codex worker to be recovered into a fresh manager');
    assert.strictEqual(recoveredTrackedWorker.activeRun, null, 'recovered terminals should start without in-memory activeRun state');
    assert.strictEqual(recoveredManager.getStatus(terminal.terminalId), TerminalStatus.COMPLETED);
    assert(recoveredTrackedWorker.activeRun, 'expected tracked run markers to be reconstructed after recovery');
    assert.strictEqual(recoveredTrackedWorker.activeRun.runId, completedRunId);

    const reusedCodexWorker = await manager.createTerminal({
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
    assert.strictEqual(reusedCodexWorker.reused, true);
    assert.strictEqual(reusedCodexWorker.terminalId, terminal.terminalId);
    const reusedTrackedTerminal = manager.terminals.get(terminal.terminalId);
    assert.strictEqual(reusedTrackedTerminal.providerThreadRef, null);
    assert.strictEqual(reusedTrackedTerminal.messageCount, 0);

    const resumedCodexWorker = await manager.createTerminal({
      adapter: 'codex-cli',
      role: 'worker',
      agentProfile: 'review_codex-cli',
      rootSessionId: 'acacacacacacacacacacacacacacacac',
      parentSessionId: 'acacacacacacacacacacacacacacacac',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'qwen:thread-resume',
      sessionMetadata: {
        providerResumeSessionId: 'codex-thread-resume-42'
      },
      workDir: rootDir
    });
    assert.strictEqual(manager.terminals.get(resumedCodexWorker.terminalId).providerThreadRef, 'codex-thread-resume-42');
    await manager.sendInput(resumedCodexWorker.terminalId, 'Resume the interrupted codex worker session.');
    const recoveredCodexWorkerHistory = fakeTmux.getHistory(resumedCodexWorker.sessionName, resumedCodexWorker.windowName);
    assert(
      recoveredCodexWorkerHistory.includes("codex exec -m gpt-5.4 --full-auto --json --skip-git-repo-check 'Resume the interrupted codex worker session.'"),
      `expected codex worker recovery metadata to keep broker-safe one-shot execution, got: ${recoveredCodexWorkerHistory}`
    );
    assert(
      !recoveredCodexWorkerHistory.includes('codex exec resume'),
      `did not expect codex worker recovery metadata to force resume, got: ${recoveredCodexWorkerHistory}`
    );
    assert(
      !recoveredCodexWorkerHistory.includes('codex-thread-resume-42'),
      `did not expect codex worker recovery metadata to inject provider thread ref into the command, got: ${recoveredCodexWorkerHistory}`
    );

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
    const claudeWrappedScriptPath = liveClaudeWorker.activeRun?.wrapperScriptPath || null;
    const claudeInvocationSource = claudeWrappedScriptPath
      ? fs.readFileSync(claudeWrappedScriptPath, 'utf8')
      : claudeWorkerHistory;
    const rootProviderThreadRef = normalizeUuid(claudeWorkerRootSessionId);
    const claudeWorkerProviderThreadRef = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    assert.strictEqual(liveClaudeWorker.providerThreadRef, null);
    assert(claudeWrappedScriptPath, `expected Claude worker send to persist a wrapper script path, got: ${claudeWorkerHistory}`);
    assert(claudeWorkerHistory.includes(claudeWrappedScriptPath), `expected Claude worker send to invoke the wrapper script directly, got: ${claudeWorkerHistory}`);
    assert(claudeInvocationSource.includes('/usr/local/bin/claude'), `expected explicit Claude path, got: ${claudeInvocationSource}`);
    assert(!claudeInvocationSource.includes('--session-id'), `did not expect first Claude worker send to bind a provider session id, got: ${claudeInvocationSource}`);
    assert(!claudeInvocationSource.includes(`--session-id ${rootProviderThreadRef}`), `Claude worker should not bind to broker root session id, got: ${claudeInvocationSource}`);
    assert(!claudeInvocationSource.includes('--resume'), `did not expect first Claude worker send to resume a provider thread, got: ${claudeInvocationSource}`);
    assert(claudeInvocationSource.includes('--dangerously-skip-permissions'), `expected Claude worker auto-approval flag, got: ${claudeInvocationSource}`);
    assert(claudeInvocationSource.includes('--allowed-tools "Read,Write"'), `expected Claude worker tool restriction, got: ${claudeInvocationSource}`);
    assert(claudeInvocationSource.includes('--system-prompt "Review carefully and be explicit about regressions."'), `expected Claude worker system prompt on first send, got: ${claudeInvocationSource}`);

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
    const resumedClaudeWrappedScriptPath = liveClaudeWorker.activeRun?.wrapperScriptPath || null;
    const resumedClaudeInvocationSource = resumedClaudeWrappedScriptPath
      ? fs.readFileSync(resumedClaudeWrappedScriptPath, 'utf8')
      : resumedClaudeWorkerHistory;
    assert(resumedClaudeWrappedScriptPath, `expected resumed Claude worker send to persist a wrapper script path, got: ${resumedClaudeWorkerHistory}`);
    assert(resumedClaudeWorkerHistory.includes(resumedClaudeWrappedScriptPath), `expected resumed Claude worker send to invoke the wrapper script directly, got: ${resumedClaudeWorkerHistory}`);
    assert(resumedClaudeInvocationSource.includes(`--resume ${claudeWorkerProviderThreadRef}`), `expected Claude worker follow-up send to resume its provider thread, got: ${resumedClaudeInvocationSource}`);
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
    const reusedClaudeWrappedScriptMatch = reusedClaudeHistory.match(/\/bin\/sh (?:"([^"]+\.sh)"|'([^']+\.sh)')/);
    const reusedClaudeInvocationSource = reusedClaudeWrappedScriptMatch
      ? fs.readFileSync(reusedClaudeWrappedScriptMatch[1] || reusedClaudeWrappedScriptMatch[2], 'utf8')
      : reusedClaudeHistory;
    assert(!reusedClaudeInvocationSource.includes(`--resume ${claudeWorkerProviderThreadRef}`), `did not expect reused Claude worker to resume the prior provider thread, got: ${reusedClaudeInvocationSource}`);
    assert(!reusedClaudeInvocationSource.includes('--session-id'), `did not expect reused Claude worker to bind a provider session id before output sync, got: ${reusedClaudeInvocationSource}`);

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

    const wrappedClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      parentSessionId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-wrapped',
      permissionMode: 'auto',
      systemPrompt: 'Review carefully and be explicit about regressions.',
      workDir: rootDir
    });
    await manager.sendInput(
      wrappedClaudeWorker.terminalId,
      `Review this deliberately long message and return concrete risks only. ${'very '.repeat(160)}carefully.`
    );
    const liveWrappedClaudeWorker = manager.terminals.get(wrappedClaudeWorker.terminalId);
    const wrappedClaudeHistory = fakeTmux.getHistory(
      liveWrappedClaudeWorker.sessionName,
      liveWrappedClaudeWorker.windowName
    );
    const wrappedScriptPath = liveWrappedClaudeWorker.activeRun.wrapperScriptPath;
    assert(wrappedScriptPath, 'expected long Claude worker send to persist a wrapper script path');
    assert(wrappedClaudeHistory.includes(wrappedScriptPath), `expected long Claude worker send to invoke the wrapper script directly, got: ${wrappedClaudeHistory}`);
    assert(!wrappedClaudeHistory.includes('/bin/sh '), 'expected wrapper script to execute directly without a shell wrapper');
    const wrappedScriptBody = fs.readFileSync(wrappedScriptPath, 'utf8');
    assert(wrappedScriptBody.includes(liveWrappedClaudeWorker.activeRun.startMarker), 'expected wrapper script to include tracked run start marker');
    assert(wrappedScriptBody.includes('/usr/local/bin/claude'), 'expected wrapper script to invoke Claude directly');
    assert(wrappedScriptBody.includes('Review this deliberately long message'), 'expected wrapper script to preserve the long Claude prompt');

    const malformedClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'abababababababababababababababab',
      parentSessionId: 'abababababababababababababababab',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-malformed',
      permissionMode: 'auto',
      workDir: rootDir
    });
    await manager.sendInput(malformedClaudeWorker.terminalId, 'Trigger malformed shell parsing.');
    const liveMalformedClaudeWorker = manager.terminals.get(malformedClaudeWorker.terminalId);
    const malformedPrompt = [
      `printf '\\n${liveMalformedClaudeWorker.activeRun.startMarker}\\n'; "/opt/homebrew/bin/claude" -p "Broken prompt`,
      'dquote>'
    ].join('\n');
    fs.writeFileSync(liveMalformedClaudeWorker.logPath, malformedPrompt, 'utf8');
    fakeTmux.setHistory(
      liveMalformedClaudeWorker.sessionName,
      liveMalformedClaudeWorker.windowName,
      malformedPrompt
    );
    fakeTmux.setCurrentCommand(liveMalformedClaudeWorker.sessionName, liveMalformedClaudeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(malformedClaudeWorker.terminalId), TerminalStatus.ERROR);
    assert.strictEqual(manager.terminals.get(malformedClaudeWorker.terminalId).attention?.code, 'shell_parse_blocked');

    const streamingClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'cccccccccccccccccccccccccccccccc',
      parentSessionId: 'cccccccccccccccccccccccccccccccc',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-streaming',
      permissionMode: 'auto',
      workDir: rootDir
    });
    await manager.sendInput(streamingClaudeWorker.terminalId, 'Stream partial JSON output.');
    const liveStreamingClaudeWorker = manager.terminals.get(streamingClaudeWorker.terminalId);
    const streamingPrompt = [
      liveStreamingClaudeWorker.activeRun.startMarker,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Still reviewing..."}]}}'
    ].join('\n');
    fs.writeFileSync(liveStreamingClaudeWorker.logPath, streamingPrompt, 'utf8');
    fakeTmux.setHistory(
      liveStreamingClaudeWorker.sessionName,
      liveStreamingClaudeWorker.windowName,
      streamingPrompt
    );
    fakeTmux.setCurrentCommand(liveStreamingClaudeWorker.sessionName, liveStreamingClaudeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(streamingClaudeWorker.terminalId), TerminalStatus.PROCESSING);

    const incompleteClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'edededededededededededededededed',
      parentSessionId: 'edededededededededededededededed',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-incomplete',
      permissionMode: 'auto',
      workDir: rootDir
    });
    await manager.sendInput(incompleteClaudeWorker.terminalId, 'Trigger missing exit marker handling.');
    const liveIncompleteClaudeWorker = manager.terminals.get(incompleteClaudeWorker.terminalId);
    const incompletePrompt = [
      liveIncompleteClaudeWorker.activeRun.startMarker,
      'Claude review almost finished.',
      'mojave@host cliagents % '
    ].join('\n');
    fs.writeFileSync(liveIncompleteClaudeWorker.logPath, incompletePrompt, 'utf8');
    fakeTmux.setHistory(
      liveIncompleteClaudeWorker.sessionName,
      liveIncompleteClaudeWorker.windowName,
      incompletePrompt
    );
    fakeTmux.setCurrentCommand(liveIncompleteClaudeWorker.sessionName, liveIncompleteClaudeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(incompleteClaudeWorker.terminalId), TerminalStatus.ERROR,
      'Missing exit marker with plain prose should remain ERROR');

    const successIncompleteClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'fafafafafafafafafafafafafafafafa',
      parentSessionId: 'fafafafafafafafafafafafafafafafa',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-success-incomplete',
      permissionMode: 'auto',
      workDir: rootDir
    });
    await manager.sendInput(successIncompleteClaudeWorker.terminalId, 'Trigger missing exit marker but with completion marker.');
    const liveSuccessIncompleteClaudeWorker = manager.terminals.get(successIncompleteClaudeWorker.terminalId);
    const successIncompletePrompt = [
      liveSuccessIncompleteClaudeWorker.activeRun.startMarker,
      '⏺ Claude review complete.',
      'mojave@host cliagents % '
    ].join('\n');
    fs.writeFileSync(liveSuccessIncompleteClaudeWorker.logPath, successIncompletePrompt, 'utf8');
    fakeTmux.setHistory(
      liveSuccessIncompleteClaudeWorker.sessionName,
      liveSuccessIncompleteClaudeWorker.windowName,
      successIncompletePrompt
    );
    fakeTmux.setCurrentCommand(liveSuccessIncompleteClaudeWorker.sessionName, liveSuccessIncompleteClaudeWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(successIncompleteClaudeWorker.terminalId), TerminalStatus.COMPLETED,
      'Missing exit marker but with completion marker and prompt return should be COMPLETED');

    const streamJsonSuccessWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'gagagagagagagagagagagagagagagagag',
      parentSessionId: 'gagagagagagagagagagagagagagagagag',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-stream-json-success',
      permissionMode: 'auto',
      workDir: rootDir
    });
    await manager.sendInput(streamJsonSuccessWorker.terminalId, 'Trigger stream-json result without exit marker.');
    const liveStreamJsonSuccessWorker = manager.terminals.get(streamJsonSuccessWorker.terminalId);
    const streamJsonSuccessPrompt = [
      liveStreamJsonSuccessWorker.activeRun.startMarker,
      '{"type":"result","session_id":"sess_abc","message":{"content":"Review complete."}}',
      'mojave@host cliagents % '
    ].join('\n');
    fs.writeFileSync(liveStreamJsonSuccessWorker.logPath, streamJsonSuccessPrompt, 'utf8');
    fakeTmux.setHistory(
      liveStreamJsonSuccessWorker.sessionName,
      liveStreamJsonSuccessWorker.windowName,
      streamJsonSuccessPrompt
    );
    fakeTmux.setCurrentCommand(liveStreamJsonSuccessWorker.sessionName, liveStreamJsonSuccessWorker.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(streamJsonSuccessWorker.terminalId), TerminalStatus.COMPLETED,
      'Missing exit marker but with stream-json result and prompt return should be COMPLETED');

    const truncatedClaudeWorker = await manager.createTerminal({
      adapter: 'claude-code',
      role: 'worker',
      agentProfile: 'review_claude-code',
      rootSessionId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      parentSessionId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      sessionKind: 'reviewer',
      originClient: 'mcp',
      externalSessionRef: 'codex:thread-truncated-tail',
      permissionMode: 'auto',
      workDir: rootDir
    });
    const liveTruncatedClaudeWorker = manager.terminals.get(truncatedClaudeWorker.terminalId);
    const oversizedBaseline = `${'previous output line\n'.repeat(600)}mojave@host cliagents % `;
    fakeTmux.setHistory(
      liveTruncatedClaudeWorker.sessionName,
      liveTruncatedClaudeWorker.windowName,
      oversizedBaseline
    );
    await manager.sendInput(truncatedClaudeWorker.terminalId, 'Trigger truncated tmux history completion.');
    const truncatedCompletionPrompt = [
      liveTruncatedClaudeWorker.activeRun.startMarker,
      '{"type":"assistant","session_id":"sess_trunc","message":{"content":[{"type":"text","text":"Reviewing..."}]}}',
      '{"type":"result","session_id":"sess_trunc","message":{"content":[{"type":"text","text":"Review complete after truncation."}]}}',
      `${liveTruncatedClaudeWorker.activeRun.exitMarkerPrefix}0`
    ].join('\n');
    fs.writeFileSync(liveTruncatedClaudeWorker.logPath, [
      liveTruncatedClaudeWorker.activeRun.startMarker,
      '{"type":"assistant","session_id":"sess_trunc","message":{"content":[{"type":"text","text":"Reviewing..."}]}}'
    ].join('\n'), 'utf8');
    fakeTmux.setHistory(
      liveTruncatedClaudeWorker.sessionName,
      liveTruncatedClaudeWorker.windowName,
      truncatedCompletionPrompt
    );
    fakeTmux.setCurrentCommand(liveTruncatedClaudeWorker.sessionName, liveTruncatedClaudeWorker.windowName, 'zsh');
    const originalGetOutput = manager.getOutput.bind(manager);
    manager.getOutput = function getOutputWithTruncatedTail(terminalId, lines, options) {
      if (terminalId === truncatedClaudeWorker.terminalId) {
        return truncatedCompletionPrompt;
      }
      return originalGetOutput(terminalId, lines, options);
    };
    try {
      assert.strictEqual(manager.getStatus(truncatedClaudeWorker.terminalId), TerminalStatus.COMPLETED,
        'Tracked runs should remain COMPLETED even when the current tmux snapshot is shorter than the original baseline');
    } finally {
      manager.getOutput = originalGetOutput;
    }

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
