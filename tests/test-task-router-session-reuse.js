#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { PersistentSessionManager, TerminalStatus } = require('../src/tmux/session-manager');
const { TaskRouter } = require('../src/orchestration/task-router');

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

  setHistory(sessionName, windowName, content) {
    this.histories.set(this._key(sessionName, windowName), content);
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
  const rootDir = makeTempDir('cliagents-task-router-reuse-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const fakeTmux = new FakeTmuxClient();
  const originalHome = process.env.HOME;
  const originalClaudePath = process.env.CLIAGENTS_CLAUDE_PATH;

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

  try {
    process.env.HOME = rootDir;
    process.env.CLIAGENTS_CLAUDE_PATH = '/usr/local/bin/claude';
    fs.writeFileSync(path.join(rootDir, '.claude.json'), JSON.stringify({
      oauthAccount: {
        accountUuid: '2a2ffaa3-c00e-4f55-ab5d-f553ba1b8b72',
        emailAddress: 'suyash@example.com'
      }
    }, null, 2));

    const manager = new PersistentSessionManager({
      db,
      tmuxClient: fakeTmux,
      logDir: path.join(rootDir, 'logs'),
      workDir: rootDir,
      sessionGraphWritesEnabled: true,
      sessionEventsEnabled: true
    });
    const apiSessionManager = {
      getAdapter(name) {
        if (name === 'claude-code') {
          return {
            async isAvailable() {
              return true;
            },
            getCapabilities() {
              return {
                supportsMultiTurn: true,
                supportsResume: true,
                supportsSystemPrompt: true,
                supportsFilesystemWrite: true
              };
            },
            getContract() {
              return { capabilities: { supportsMultiTurn: true, supportsResume: true } };
            }
          };
        }
        return null;
      }
    };
    const router = new TaskRouter(manager, { apiSessionManager });

    const rootSessionId = 'dddddddddddddddddddddddddddddddd';
    const first = await router.routeTask('Review this patch for correctness.', {
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      model: 'o4-mini',
      rootSessionId,
      parentSessionId: rootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'opencode', toolName: 'delegate_task' }
    });

    const liveTerminal = manager.terminals.get(first.terminalId);
    fs.writeFileSync(
      liveTerminal.logPath,
      [
        liveTerminal.activeRun.startMarker,
        'First review complete.',
        `${liveTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setCurrentCommand(liveTerminal.sessionName, liveTerminal.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(first.terminalId), TerminalStatus.COMPLETED);

    const second = await router.routeTask('Review the follow-up patch for correctness.', {
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      model: 'o4-mini',
      rootSessionId,
      parentSessionId: rootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'opencode', toolName: 'delegate_task' }
    });

    assert.strictEqual(second.terminalId, first.terminalId);
    assert.strictEqual(second.reused, true);
    assert.strictEqual(fakeTmux.createCalls.length, 1);

    const researchRootSessionId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const opencodeFirst = await router.routeTask('Research the current OpenCode CLI docs.', {
      forceRole: 'research',
      forceAdapter: 'opencode-cli',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task' }
    });

    assert.strictEqual(opencodeFirst.adapter, 'opencode-cli');

    const opencodeTerminal = manager.terminals.get(opencodeFirst.terminalId);
    fs.writeFileSync(
      opencodeTerminal.logPath,
      [
        opencodeTerminal.activeRun.startMarker,
        'OpenCode research complete.',
        `${opencodeTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setCurrentCommand(opencodeTerminal.sessionName, opencodeTerminal.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(opencodeFirst.terminalId), TerminalStatus.COMPLETED);

    const opencodeSecond = await router.routeTask('Research the latest OpenCode releases.', {
      forceRole: 'research',
      forceAdapter: 'opencode-cli',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task' }
    });

    assert.strictEqual(opencodeSecond.terminalId, opencodeFirst.terminalId);
    assert.strictEqual(opencodeSecond.reused, true);

    const geminiResearch = await router.routeTask('Research the latest Gemini CLI release notes.', {
      forceRole: 'research',
      forceAdapter: 'gemini-cli',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task' }
    });

    assert.strictEqual(geminiResearch.adapter, 'gemini-cli');
    assert.notStrictEqual(geminiResearch.terminalId, opencodeFirst.terminalId);

    const claudeReview = await router.routeTask('Review the managed-root recovery design.', {
      forceRole: 'review',
      forceAdapter: 'claude-code',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task' }
    });

    assert.strictEqual(claudeReview.adapter, 'claude-code');
    const claudeTerminal = manager.terminals.get(claudeReview.terminalId);
    const claudeHistory = fakeTmux.getHistory(claudeTerminal.sessionName, claudeTerminal.windowName);
    const claudeWrappedScriptPath = claudeTerminal.activeRun?.wrapperScriptPath || null;
    const claudeInvocationSource = claudeWrappedScriptPath
      ? fs.readFileSync(claudeWrappedScriptPath, 'utf8')
      : claudeHistory;
    assert(claudeHistory.includes('CLAUDE_READY_FOR_ORCHESTRATION'), `Expected Claude ready marker, got: ${claudeHistory}`);
    assert(claudeWrappedScriptPath, `Expected Claude review to persist a wrapper script path, got: ${claudeHistory}`);
    assert(claudeHistory.includes(claudeWrappedScriptPath), `Expected Claude review to invoke the wrapper script directly, got: ${claudeHistory}`);
    assert(claudeInvocationSource.includes('/usr/local/bin/claude'), `Expected explicit Claude binary path, got: ${claudeInvocationSource}`);
    assert(!claudeInvocationSource.includes('--session-id'), `Did not expect first Claude child send to bind a provider session id, got: ${claudeInvocationSource}`);
    assert(!claudeInvocationSource.includes('--resume'), `Did not expect first Claude child send to resume a provider thread, got: ${claudeInvocationSource}`);
    assert(!claudeInvocationSource.includes(`--session-id ${normalizeUuid(researchRootSessionId)}`), `Claude child worker should not bind to the broker root session id, got: ${claudeInvocationSource}`);

    fs.writeFileSync(
      claudeTerminal.logPath,
      [
        claudeTerminal.activeRun.startMarker,
        'Claude architect review complete.',
        `${claudeTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setCurrentCommand(claudeTerminal.sessionName, claudeTerminal.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(claudeReview.terminalId), TerminalStatus.COMPLETED);

    const claudeCritic = await router.routeTask('Review the retry strategy from a second perspective.', {
      forceRole: 'review',
      forceAdapter: 'claude-code',
      sessionLabel: 'claude-critic',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task' }
    });
    assert.notStrictEqual(claudeCritic.terminalId, claudeReview.terminalId, 'different session labels should not collide');

    const claudeArchitectFirst = await router.routeTask('Act as the ongoing Claude architect collaborator.', {
      forceRole: 'review',
      forceAdapter: 'claude-code',
      sessionLabel: 'claude-architect',
      sessionKind: 'collaborator',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task', collaborator: true }
    });
    const claudeArchitectTerminal = manager.terminals.get(claudeArchitectFirst.terminalId);
    const claudeArchitectProviderThreadRef = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(
      claudeArchitectTerminal.logPath,
      [
        claudeArchitectTerminal.activeRun.startMarker,
        `{"type":"system","session_id":"${claudeArchitectProviderThreadRef}"}`,
        'Claude architect collaborator settled.',
        `${claudeArchitectTerminal.activeRun.exitMarkerPrefix}0`
      ].join('\n'),
      'utf8'
    );
    fakeTmux.setHistory(
      claudeArchitectTerminal.sessionName,
      claudeArchitectTerminal.windowName,
      `{"type":"system","session_id":"${claudeArchitectProviderThreadRef}"}\nClaude architect collaborator settled.\n`
    );
    fakeTmux.setCurrentCommand(claudeArchitectTerminal.sessionName, claudeArchitectTerminal.windowName, 'zsh');
    assert.strictEqual(manager.getStatus(claudeArchitectFirst.terminalId), TerminalStatus.COMPLETED);
    assert.strictEqual(claudeArchitectTerminal.providerThreadRef, claudeArchitectProviderThreadRef);

    const claudeArchitectSecond = await router.routeTask('Continue from the same Claude architect collaborator session.', {
      forceRole: 'review',
      forceAdapter: 'claude-code',
      sessionLabel: 'claude-architect',
      sessionKind: 'collaborator',
      rootSessionId: researchRootSessionId,
      parentSessionId: researchRootSessionId,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'codex', toolName: 'delegate_task', collaborator: true }
    });
    assert.strictEqual(
      claudeArchitectSecond.terminalId,
      claudeArchitectFirst.terminalId,
      'same session label should intentionally reuse the same collaborator session'
    );
    assert.strictEqual(claudeArchitectSecond.reused, true);
    assert.strictEqual(claudeArchitectTerminal.providerThreadRef, claudeArchitectProviderThreadRef);
    assert.strictEqual(claudeArchitectTerminal.messageCount, 2);
    const collaboratorFollowUpHistory = fakeTmux.getHistory(
      claudeArchitectTerminal.sessionName,
      claudeArchitectTerminal.windowName
    );
    const collaboratorFollowUpScriptPath = claudeArchitectTerminal.activeRun?.wrapperScriptPath || null;
    const collaboratorFollowUpSource = collaboratorFollowUpScriptPath
      ? fs.readFileSync(collaboratorFollowUpScriptPath, 'utf8')
      : collaboratorFollowUpHistory;
    assert.strictEqual(claudeArchitectTerminal.sessionKind, 'collaborator');
    assert(
      collaboratorFollowUpSource.includes(`--resume ${claudeArchitectProviderThreadRef}`),
      `expected collaborator follow-up to preserve provider-thread continuity, got: ${collaboratorFollowUpSource}`
    );

    await assert.rejects(
      router.routeTask('Try to route a Codex collaborator child.', {
        forceRole: 'review',
        forceAdapter: 'codex-cli',
        sessionKind: 'collaborator',
        sessionLabel: 'codex-collaborator',
        rootSessionId: researchRootSessionId,
        parentSessionId: researchRootSessionId,
        originClient: 'mcp',
        sessionMetadata: { clientName: 'codex', toolName: 'delegate_task', collaborator: true }
      }),
      /not collaborator-ready/
    );

    await assert.rejects(
      router.routeTask('Research an unsupported adapter path.', {
        forceRole: 'research',
        forceAdapter: 'missing-cli',
        rootSessionId: researchRootSessionId,
        parentSessionId: researchRootSessionId,
        originClient: 'mcp'
      }),
      /is not configured/
    );

    console.log('✅ TaskRouter reuses a settled compatible worker for the same root session');
  } finally {
    global.setTimeout = realSetTimeout;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalClaudePath === undefined) {
      delete process.env.CLIAGENTS_CLAUDE_PATH;
    } else {
      process.env.CLIAGENTS_CLAUDE_PATH = originalClaudePath;
    }
    db.close();
  }
}

run().catch((error) => {
  console.error('\nTask router session reuse tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
