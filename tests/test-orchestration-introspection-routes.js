#!/usr/bin/env node

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOrchestrationRouter } = require('../src/server/orchestration-router');
const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');
const { getModelRoutingService } = require('../src/services/model-routing');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

process.chdir(path.resolve(__dirname, '..'));

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', createOrchestrationRouter({
    adapterAuthInspector() {
      return {
        authenticated: true,
        reason: 'test default override'
      };
    },
    ...context
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function stopApp(serverHandle) {
  await new Promise((resolve, reject) => {
    serverHandle.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
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

async function waitFor(predicate, timeoutMs = 2000, pollMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

function createRuntimeAdapter(overrides = {}) {
  return {
    name: overrides.name || 'runtime-adapter',
    async isAvailable() {
      return overrides.available !== undefined ? overrides.available : true;
    },
    getCapabilities() {
      return overrides.capabilities || {
        usesOfficialCli: true,
        executionMode: 'direct-session',
        supportsMultiTurn: true,
        supportsResume: true
      };
    },
    getContract() {
      return overrides.contract || {
        version: '2026-04-11',
        executionMode: 'direct-session',
        capabilities: this.getCapabilities()
      };
    },
    getAvailableModels() {
      return overrides.models || [];
    },
    getProviderSummary() {
      return overrides.runtimeProviders || [];
    }
  };
}

async function testAdaptersRouteIncludesRuntimeMetadata() {
  const sessionManager = {
    async createTerminal() {
      throw new Error('createTerminal should not be called for adapter listing');
    },
    async sendInput() {
      throw new Error('sendInput should not be called for adapter listing');
    }
  };

  const runtimeOnlyAdapter = createRuntimeAdapter({
    name: 'runtime-only',
    capabilities: {
      usesOfficialCli: false,
      executionMode: 'api',
      supportsMultiTurn: false
    }
  });

  const qwenRuntimeAdapter = createRuntimeAdapter({
    name: 'qwen-cli',
    capabilities: {
      usesOfficialCli: true,
      executionMode: 'direct-session',
      supportsMultiTurn: true,
      supportsResume: true,
      supportsStreaming: true
    }
  });

  const apiSessionManager = {
    getAdapterNames() {
      return ['runtime-only', 'qwen-cli'];
    },
    getAdapter(name) {
      if (name === 'runtime-only') {
        return runtimeOnlyAdapter;
      }
      if (name === 'qwen-cli') {
        return qwenRuntimeAdapter;
      }
      return null;
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager,
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'GET', '/orchestration/adapters');
    assert.strictEqual(res.status, 200);
    assert(res.data.adapters['runtime-only'], 'runtime-only adapter should be listed');
    assert.strictEqual(res.data.adapters['runtime-only'].configured, false);
    assert.strictEqual(res.data.adapters['runtime-only'].runtimeRegistered, true);
    assert.strictEqual(res.data.adapters['runtime-only'].available, true);
    assert.strictEqual(res.data.adapters['runtime-only'].authenticated, false);
    assert.strictEqual(res.data.adapters['runtime-only'].runtimeCapabilities.executionMode, 'api');
    assert.strictEqual(res.data.adapters['runtime-only'].childSessionSupport.collaboratorReady, false);

    assert(res.data.adapters['qwen-cli'], 'configured adapter should still be listed');
    assert.strictEqual(typeof res.data.adapters['qwen-cli'].configured, 'boolean');
    assert.strictEqual(res.data.adapters['qwen-cli'].runtimeRegistered, true);
    assert.strictEqual(res.data.adapters['qwen-cli'].available, true);
    assert.strictEqual(typeof res.data.adapters['qwen-cli'].authenticated, 'boolean');
    assert.strictEqual(res.data.adapters['qwen-cli'].runtimeContract.executionMode, 'direct-session');
    assert.strictEqual(res.data.adapters['qwen-cli'].childSessionSupport.collaboratorReady, true);
  } finally {
    await stopApp(server);
  }
}

async function testRouteResponseIncludesRuntimeAdapterMetadata() {
  const createCalls = [];
  const sendCalls = [];

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: 'term-route-1' };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    }
  };

  const apiSessionManager = {
    getAdapterNames() {
      return ['qwen-cli'];
    },
    getAdapter(name) {
      if (name !== 'qwen-cli') {
        return null;
      }
      return createRuntimeAdapter({
        name,
        capabilities: {
          usesOfficialCli: true,
          executionMode: 'direct-session',
          supportsMultiTurn: true,
          supportsResume: true,
          supportsStreaming: true,
          supportsSystemPrompt: true
        },
        contract: {
          version: '2026-04-11',
          executionMode: 'direct-session',
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true
          },
          notes: ['test contract']
        }
      });
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager,
    db: { db: null },
    adapterAuthInspector() {
      return {
        authenticated: true,
        reason: 'test override'
      };
    }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/route', {
      forceRole: 'plan',
      forceAdapter: 'qwen-cli',
      message: 'Create a short implementation plan.',
      rootSessionId: 'root-route-test-1'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.terminalId, 'term-route-1');
    assert.strictEqual(res.data.profile, 'plan_qwen-cli');
    assert.strictEqual(res.data.adapter, 'qwen-cli');
    assert.strictEqual(res.data.runtimeAvailable, true);
    assert.strictEqual(res.data.runtimeAuthenticated, true);
    assert.strictEqual(res.data.runtimeCapabilities.executionMode, 'direct-session');
    assert.strictEqual(res.data.runtimeChildSessionSupport.collaboratorReady, true);
    assert.strictEqual(res.data.runtimeContract.version, '2026-04-11');
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].message, 'Create a short implementation plan.');
  } finally {
    await stopApp(server);
  }
}

async function testRecommendModelRouteReturnsBrokerPolicyRecommendation() {
  const opencodeRuntimeAdapter = createRuntimeAdapter({
    name: 'opencode-cli',
    models: [
      { id: 'openrouter/qwen/qwen3.6-plus' },
      { id: 'minimax-coding-plan/MiniMax-M2.7' }
    ],
    runtimeProviders: [
      { name: 'OpenRouter' },
      { name: 'MiniMax Coding Plan (minimax.io)' }
    ]
  });

  const { server, baseUrl } = await startApp({
    sessionManager: {
      async createTerminal() {
        throw new Error('createTerminal should not be called for model recommendation');
      },
      async sendInput() {
        throw new Error('sendInput should not be called for model recommendation');
      }
    },
    apiSessionManager: {
      getAdapterNames() {
        return ['opencode-cli'];
      },
      getAdapter(name) {
        return name === 'opencode-cli' ? opencodeRuntimeAdapter : null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/model-routing/recommend', {
      adapter: 'opencode-cli',
      role: 'implement'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.selectedModel, 'minimax-coding-plan/MiniMax-M2.7');
    assert.strictEqual(res.data.selectedProvider, 'minimax-coding-plan');
    assert.strictEqual(res.data.selectedFamily, 'minimax');
  } finally {
    await stopApp(server);
  }
}

async function testRoutePropagatesSessionGraphMetadata() {
  const createCalls = [];
  const sendCalls = [];

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: 'term-route-graph-1' };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return ['qwen-cli'];
      },
      getAdapter(name) {
        return name === 'qwen-cli' ? createRuntimeAdapter({ name }) : null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/route', {
      forceRole: 'review',
      forceAdapter: 'qwen-cli',
      message: 'Review this control-plane change.',
      rootSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      parentSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-42',
      lineageDepth: 1,
      sessionMetadata: { clientName: 'opencode' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(createCalls[0].rootSessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(createCalls[0].parentSessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(createCalls[0].originClient, 'mcp');
    assert.strictEqual(createCalls[0].externalSessionRef, 'opencode:thread-42');
    assert.strictEqual(createCalls[0].lineageDepth, 1);
    assert.strictEqual(createCalls[0].sessionKind, 'reviewer');
    assert.deepStrictEqual(createCalls[0].sessionMetadata, {
      clientName: 'opencode',
      externalSessionRef: 'opencode:thread-42',
      clientSessionRef: 'opencode:thread-42'
    });
  } finally {
    await stopApp(server);
  }
}

async function testRouteAutoAppliesRecommendedOpencodeModel() {
  const createCalls = [];
  const sendCalls = [];

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: 'term-opencode-route-1' };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    }
  };

  const opencodeRuntimeAdapter = createRuntimeAdapter({
    name: 'opencode-cli',
    capabilities: {
      usesOfficialCli: true,
      executionMode: 'direct-session',
      supportsMultiTurn: true,
      supportsStreaming: true,
      supportsSystemPrompt: true,
      supportsFilesystemWrite: true
    },
    models: [
      { id: 'openrouter/qwen/qwen3.6-plus' },
      { id: 'minimax-coding-plan/MiniMax-M2.7' }
    ],
    runtimeProviders: [
      { name: 'OpenRouter' },
      { name: 'MiniMax Coding Plan (minimax.io)' }
    ]
  });

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return ['opencode-cli'];
      },
      getAdapter(name) {
        return name === 'opencode-cli' ? opencodeRuntimeAdapter : null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/route', {
      forceRole: 'implement',
      forceAdapter: 'opencode-cli',
      message: 'Implement the requested broker change.'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].adapter, 'opencode-cli');
    assert.strictEqual(createCalls[0].model, 'minimax-coding-plan/MiniMax-M2.7');
    assert.strictEqual(res.data.model, 'minimax-coding-plan/MiniMax-M2.7');
    assert.strictEqual(res.data.modelRecommendation.selectedProvider, 'minimax-coding-plan');
    assert.strictEqual(sendCalls.length, 1);
  } finally {
    await stopApp(server);
  }
}

async function testRouteSkipsDegradedOpencodeModelLane() {
  const createCalls = [];
  const sendCalls = [];
  const modelRoutingService = getModelRoutingService();
  modelRoutingService.resetModelHealth({ adapter: 'opencode-cli' });
  modelRoutingService.recordModelFailure({
    adapter: 'opencode-cli',
    model: 'opencode-go/qwen3.6-plus',
    failureClass: 'timeout',
    reason: 'Timed out waiting for completion.'
  });

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: 'term-opencode-route-health-1' };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    }
  };

  const opencodeRuntimeAdapter = createRuntimeAdapter({
    name: 'opencode-cli',
    capabilities: {
      usesOfficialCli: true,
      executionMode: 'direct-session',
      supportsMultiTurn: true,
      supportsStreaming: true,
      supportsSystemPrompt: true,
      supportsFilesystemWrite: true
    },
    models: [
      { id: 'opencode-go/qwen3.6-plus' },
      { id: 'opencode-go/glm-5.1' }
    ],
    runtimeProviders: [
      { name: 'OpenCode Go' }
    ]
  });

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return ['opencode-cli'];
      },
      getAdapter(name) {
        return name === 'opencode-cli' ? opencodeRuntimeAdapter : null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/route', {
      forceType: 'review-bugs',
      forceRole: 'review',
      forceAdapter: 'opencode-cli',
      message: 'Review the requested broker change.'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].model, 'opencode-go/glm-5.1');
    assert.strictEqual(res.data.model, 'opencode-go/glm-5.1');
    assert.strictEqual(res.data.modelRecommendation.selectedFamily, 'glm');
    assert.strictEqual(res.data.modelRecommendation.strategy, 'config-ranked-health-fallback');
    assert.strictEqual(sendCalls.length, 1);
  } finally {
    modelRoutingService.resetModelHealth({ adapter: 'opencode-cli' });
    await stopApp(server);
  }
}

async function testDestroyTerminalRouteDistinguishesMissingTerminal() {
  const destroyedTerminalIds = [];
  const sessionManager = {
    async destroyTerminal(terminalId) {
      if (terminalId === 'missing-terminal') {
        return false;
      }
      destroyedTerminalIds.push(terminalId);
      return true;
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return [];
      },
      getAdapter() {
        return null;
      }
    },
    db: { db: null }
  });

  try {
    const okRes = await request(baseUrl, 'DELETE', '/orchestration/terminals/live-terminal');
    assert.strictEqual(okRes.status, 200);
    assert.strictEqual(okRes.data.success, true);
    assert.deepStrictEqual(destroyedTerminalIds, ['live-terminal']);

    const missingRes = await request(baseUrl, 'DELETE', '/orchestration/terminals/missing-terminal');
    assert.strictEqual(missingRes.status, 404);
    assert.strictEqual(missingRes.data.error.code, 'terminal_not_found');
    assert(String(missingRes.data.error.message || '').includes('missing-terminal'));
  } finally {
    await stopApp(server);
  }
}

async function testInputRouteReturnsTerminalBusyConflict() {
  const sessionManager = {
    async createTerminal() {
      throw new Error('not used');
    },
    async sendInput() {
      const error = new Error('Terminal child-1 is busy (processing). Wait for it to finish before sending more input.');
      error.code = 'terminal_busy';
      error.statusCode = 409;
      error.terminalId = 'child-1';
      error.terminalStatus = 'processing';
      error.retryAfterMs = 1000;
      throw error;
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return [];
      },
      getAdapter() {
        return null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/terminals/child-1/input', {
      message: 'Follow up while still running.'
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.error.code, 'terminal_busy');
    assert.strictEqual(res.data.error.terminalId, 'child-1');
    assert.strictEqual(res.data.error.status, 'processing');
    assert.strictEqual(res.data.error.retryAfterMs, 1000);
  } finally {
    await stopApp(server);
  }
}

async function testOutputRouteSupportsVisibleAnsiModes() {
  const outputCalls = [];
  const sessionManager = {
    getOutput(terminalId, options) {
      outputCalls.push({ terminalId, options });
      return '\u001b[32mvisible pane\u001b[0m';
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return [];
      },
      getAdapter() {
        return null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'GET', '/orchestration/terminals/output-term-1/output?lines=120&mode=visible&format=ansi');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.mode, 'visible');
    assert.strictEqual(res.data.format, 'ansi');
    assert.strictEqual(res.data.output, '\u001b[32mvisible pane\u001b[0m');
    assert.deepStrictEqual(outputCalls, [{
      terminalId: 'output-term-1',
      options: {
        lines: 120,
        mode: 'visible',
        format: 'ansi'
      }
    }]);
  } finally {
    await stopApp(server);
  }
}

async function testInputRouteRejectsAttachedRootsAsReadOnly() {
  const rootDir = makeTempDir('cliagents-root-read-only-route-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const sendCalls = [];

  db.registerTerminal(
    'attached-root-terminal',
    'cliagents-attached-root',
    '0',
    'codex-cli',
    'main_codex-cli',
    'main',
    rootDir,
    path.join(rootDir, 'attached-root.log'),
    {
      rootSessionId: 'attached-root-session',
      sessionKind: 'attach',
      originClient: 'codex',
      externalSessionRef: 'codex:thread-attached'
    }
  );
  db.addSessionEvent({
    rootSessionId: 'attached-root-session',
    sessionId: 'attached-root-session',
    eventType: 'session_started',
    originClient: 'codex',
    idempotencyKey: 'attached-root-start',
    payloadJson: {
      sessionKind: 'attach',
      adapter: 'codex-cli',
      externalSessionRef: 'codex:thread-attached'
    },
    metadata: {
      clientName: 'codex',
      attachMode: 'explicit-http-attach'
    }
  });

  const { server, baseUrl } = await startApp({
    sessionManager: {
      getTerminal(terminalId) {
        return terminalId === 'attached-root-terminal'
          ? {
              terminalId: 'attached-root-terminal',
              rootSessionId: 'attached-root-session',
              sessionKind: 'attach',
              originClient: 'codex'
            }
          : null;
      },
      getOutput() {
        return '';
      },
      async sendInput(terminalId, message) {
        sendCalls.push({ terminalId, message });
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
    const res = await request(baseUrl, 'POST', '/orchestration/terminals/attached-root-terminal/input', {
      message: 'Continue.'
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.error.code, 'root_read_only');
    assert.strictEqual(res.data.error.rootSessionId, 'attached-root-session');
    assert.strictEqual(sendCalls.length, 0);
  } finally {
    await stopApp(server);
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testInputRouteAllowsAttachedRootChildBrokerWork() {
  const rootDir = makeTempDir('cliagents-root-child-work-input-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const sendCalls = [];

  const rootSessionId = 'attached-root-session';
  const rootTerminalId = 'attached-root-terminal';
  const childTerminalId = 'attached-child-terminal-84';

  db.registerTerminal(
    rootTerminalId,
    'tmux-attached-1',
    '0',
    'codex-cli',
    'main_codex-cli',
    'attach',
    rootDir,
    path.join(rootDir, 'attached-root.log'),
    {
      rootSessionId,
      sessionKind: 'attach',
      originClient: 'codex'
    }
  );
  db.addSessionEvent({
    rootSessionId,
    sessionId: rootSessionId,
    eventType: 'session_started',
    originClient: 'codex',
    idempotencyKey: 'attached-root-start',
    payloadJson: {
      sessionKind: 'attach',
      adapter: 'codex-cli'
    },
    metadata: {
      attachMode: 'explicit-http-attach'
    }
  });

  for (let index = 1; index <= 84; index += 1) {
    const terminalId = index === 84 ? childTerminalId : `attached-child-terminal-${index}`;
    db.registerTerminal(
      terminalId,
      'tmux-attached-1',
      String(index),
      'codex-cli',
      index === 84 ? null : 'worker_codex-cli',
      index === 84 ? 'review' : 'worker',
      rootDir,
      path.join(rootDir, `${terminalId}.log`),
      {
        rootSessionId,
        parentSessionId: rootSessionId,
        sessionKind: index === 84 ? 'review' : 'worker',
        agentProfile: index === 84 ? null : 'researcher',
        originClient: 'codex'
      }
    );
  }

  const { server, baseUrl } = await startApp({
    sessionManager: {
      getTerminal(terminalId) {
        if (terminalId === rootTerminalId) {
          return {
            terminalId: rootTerminalId,
            rootSessionId,
            sessionKind: 'attach',
            originClient: 'codex'
          };
        }
        if (terminalId === childTerminalId) {
          return {
            terminalId: childTerminalId,
            rootSessionId,
            parentSessionId: rootSessionId,
            harnessSessionId: childTerminalId,
            sessionKind: 'review',
            originClient: 'codex'
          };
        }
        return null;
      },
      getOutput() {
        return '';
      },
      async sendInput(terminalId, message) {
        sendCalls.push({ terminalId, message });
      },
      getStatus() {
        return 'idle';
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
    const res = await request(baseUrl, 'POST', `/orchestration/terminals/${childTerminalId}/input`, {
      message: 'Continue.'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].terminalId, childTerminalId);
    assert.strictEqual(sendCalls[0].message, 'Continue.');
  } finally {
    await stopApp(server);
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testInputRouteRejectsDbOnlyAttachedRootChildSpoof() {
  const rootDir = makeTempDir('cliagents-root-child-spoof-input-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const sendCalls = [];

  const rootSessionId = 'attached-root-session';
  const childTerminalId = 'spoofed-child-terminal';

  db.registerTerminal(
    'attached-root-terminal',
    'tmux-attached-1',
    '0',
    'codex-cli',
    'main_codex-cli',
    'attach',
    rootDir,
    path.join(rootDir, 'attached-root.log'),
    {
      rootSessionId,
      sessionKind: 'attach',
      originClient: 'codex'
    }
  );
  db.registerTerminal(
    childTerminalId,
    'tmux-attached-1',
    '1',
    'codex-cli',
    'review_codex-cli',
    'review',
    rootDir,
    path.join(rootDir, 'spoofed-child.log'),
    {
      rootSessionId,
      parentSessionId: rootSessionId,
      sessionKind: 'review',
      originClient: 'mcp'
    }
  );
  db.addSessionEvent({
    rootSessionId,
    sessionId: rootSessionId,
    eventType: 'session_started',
    originClient: 'codex',
    idempotencyKey: 'attached-root-spoof-start',
    payloadJson: {
      sessionKind: 'attach',
      adapter: 'codex-cli'
    },
    metadata: {
      attachMode: 'explicit-http-attach'
    }
  });

  const { server, baseUrl } = await startApp({
    sessionManager: {
      getTerminal() {
        return null;
      },
      getOutput() {
        return '';
      },
      async sendInput(terminalId, message) {
        sendCalls.push({ terminalId, message });
      },
      getStatus() {
        return 'idle';
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
    const res = await request(baseUrl, 'POST', `/orchestration/terminals/${childTerminalId}/input`, {
      message: 'Continue.'
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.error.code, 'root_read_only');
    assert.strictEqual(sendCalls.length, 0);
  } finally {
    await stopApp(server);
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testRootSessionRoutesExposeAttentionSummary() {
  const rootDir = makeTempDir('cliagents-root-session-routes-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  const { server, baseUrl } = await startApp({
    sessionManager: {
      async createTerminal() {
        throw new Error('not used');
      },
      async sendInput() {
        throw new Error('not used');
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
    db.registerTerminal(
      'child-monitor-1',
      'cliagents-root',
      '0',
      'codex-cli',
      'review_codex-cli',
      'worker',
      '/tmp/project',
      '/tmp/root.log',
      {
        rootSessionId: 'root-route-1',
        parentSessionId: 'root-route-1',
        sessionKind: 'reviewer',
        originClient: 'mcp',
        providerThreadRef: 'thread-child-1',
        sessionMetadata: { sessionLabel: 'child-reviewer' }
      }
    );
    db.updateStatus('child-monitor-1', 'waiting_user_answer');
    db.addSessionEvent({
      rootSessionId: 'root-route-1',
      sessionId: 'root-route-1',
      eventType: 'session_started',
      originClient: 'mcp',
      idempotencyKey: 'root-route-start',
      payloadJson: { sessionKind: 'attach' }
    });
    db.addSessionEvent({
      rootSessionId: 'root-route-1',
      sessionId: 'child-monitor-1',
      parentSessionId: 'root-route-1',
      eventType: 'user_input_requested',
      originClient: 'mcp',
      idempotencyKey: 'root-route-input',
      payloadJson: { question: 'Need approval' }
    });
    db.addMessage('child-monitor-1', 'assistant', 'Need approval before continuing.');
    const oldOccurredAt = Date.now() - (2 * 60 * 60 * 1000);
    db.addSessionEvent({
      rootSessionId: 'legacy-route-stale',
      sessionId: 'legacy-route-stale',
      eventType: 'session_started',
      originClient: 'legacy',
      idempotencyKey: 'legacy-route-start',
      occurredAt: oldOccurredAt,
      payloadJson: { sessionKind: 'legacy' }
    });
    db.addSessionEvent({
      rootSessionId: 'legacy-route-stale',
      sessionId: 'legacy-route-stale',
      eventType: 'session_stale',
      originClient: 'legacy',
      idempotencyKey: 'legacy-route-stale-flag',
      occurredAt: oldOccurredAt + 1,
      payloadJson: {}
    });
    db.registerTerminal(
      'system-detached-1',
      'cliagents-system',
      '0',
      'codex-cli',
      'review_codex-cli',
      'worker',
      rootDir,
      path.join(rootDir, 'system.log'),
      {
        rootSessionId: 'system-detached-root',
        sessionKind: 'reviewer',
        originClient: 'system',
        lineageDepth: 0
      }
    );
    db.updateStatus('system-detached-1', 'processing');
    db.addSessionEvent({
      rootSessionId: 'system-detached-root',
      sessionId: 'system-detached-root',
      eventType: 'session_started',
      originClient: 'system',
      idempotencyKey: 'system-detached-route-start',
      payloadJson: { sessionKind: 'reviewer', adapter: 'codex-cli' }
    });

    const listRes = await request(baseUrl, 'GET', '/orchestration/root-sessions?limit=10');
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.data.archivedCount, 1);
    assert.strictEqual(listRes.data.scope, 'user');
    assert.strictEqual(listRes.data.roots.length, 1);
    assert.strictEqual(listRes.data.roots[0].rootSessionId, 'root-route-1');
    assert.strictEqual(listRes.data.roots[0].status, 'blocked');
    assert.strictEqual(listRes.data.roots[0].rootMode, 'attached');
    assert(listRes.data.roots[0].activitySummary, 'root summary should expose activity summary');
    assert.strictEqual(listRes.data.hiddenDetachedCount, 1);
    assert.strictEqual(listRes.data.hiddenNonUserCount, 0);
    assert.strictEqual(listRes.data.statusFilter, 'all');
    assert.strictEqual(listRes.data.roots[0].live, true);
    assert(listRes.data.roots[0].lastMessageAt, 'root list should expose message recency');
    assert.strictEqual(listRes.data.roots[0].messageCount, 1);
    assert.strictEqual(listRes.data.roots[0].recoveryCapability, 'exact_provider_resume');

    const liveListRes = await request(baseUrl, 'GET', '/orchestration/root-sessions?limit=10&statusFilter=live');
    assert.strictEqual(liveListRes.status, 200);
    assert.strictEqual(liveListRes.data.statusFilter, 'live');
    assert.strictEqual(liveListRes.data.roots.length, 1);
    assert.strictEqual(liveListRes.data.roots[0].rootSessionId, 'root-route-1');

    const archivedListRes = await request(baseUrl, 'GET', '/orchestration/root-sessions?limit=10&includeArchived=1&scope=all');
    assert.strictEqual(archivedListRes.status, 200);
    assert.strictEqual(archivedListRes.data.archivedCount, 1);
    assert(archivedListRes.data.roots.some((root) => root.rootSessionId === 'legacy-route-stale' && root.archived === true));

    const detachedListRes = await request(baseUrl, 'GET', '/orchestration/root-sessions?limit=10&scope=detached');
    assert.strictEqual(detachedListRes.status, 200);
    assert.strictEqual(detachedListRes.data.scope, 'detached');
    assert.strictEqual(detachedListRes.data.roots.length, 1);
    assert.strictEqual(detachedListRes.data.roots[0].rootSessionId, 'system-detached-root');
    assert.strictEqual(detachedListRes.data.roots[0].rootType, 'detached_worker_root');

    const detailRes = await request(baseUrl, 'GET', '/orchestration/root-sessions/root-route-1?eventLimit=20&terminalLimit=10');
    assert.strictEqual(detailRes.status, 200);
    assert.strictEqual(detailRes.data.rootSessionId, 'root-route-1');
    assert.strictEqual(detailRes.data.status, 'blocked');
    assert.strictEqual(detailRes.data.rootType, 'attached_client_root');
    assert.strictEqual(detailRes.data.rootMode, 'attached');
    assert.strictEqual(detailRes.data.sessionKind, 'attached');
    assert.strictEqual(detailRes.data.visibility, 'read-only');
    assert.strictEqual(detailRes.data.replyCapability, 'partial');
    assert.strictEqual(detailRes.data.runtimeHost, null);
    assert(detailRes.data.lastMessageAt, 'detail snapshot should expose message recency');
    assert.strictEqual(detailRes.data.messageCount, 1);
    assert.strictEqual(detailRes.data.recoveryCapability, 'exact_provider_resume');
    assert(detailRes.data.activitySummary, 'detail snapshot should expose activity summary');
    assert(detailRes.data.attention.reasons.some((reason) => reason.code === 'user_input_required'));

    db.registerTerminal(
      'child-monitor-other-root',
      'cliagents-root',
      '1',
      'gemini-cli',
      'research_gemini-cli',
      'worker',
      '/tmp/project',
      '/tmp/other-root.log',
      {
        rootSessionId: 'root-route-2',
        parentSessionId: 'root-route-2',
        sessionKind: 'subagent',
        originClient: 'mcp',
        sessionMetadata: { sessionLabel: 'other-root-child' }
      }
    );
    db.updateStatus('child-monitor-other-root', 'completed');

    const childrenRes = await request(baseUrl, 'GET', '/orchestration/root-sessions/root-route-1/children?limit=10');
    assert.strictEqual(childrenRes.status, 200);
    assert.strictEqual(childrenRes.data.rootSessionId, 'root-route-1');
    assert.strictEqual(childrenRes.data.count, 1);
    assert.strictEqual(childrenRes.data.children.length, 1);
    assert.strictEqual(childrenRes.data.children[0].terminalId, 'child-monitor-1');
    assert.strictEqual(childrenRes.data.children[0].sessionLabel, 'child-reviewer');
    assert.strictEqual(childrenRes.data.children[0].sessionKind, 'reviewer');
    assert.strictEqual(childrenRes.data.children[0].status, 'waiting_user_answer');
    assert.strictEqual(childrenRes.data.children[0].providerThreadRefPresent, true);
    assert.strictEqual(childrenRes.data.children[0].runtimeHost, 'tmux');
    assert.strictEqual(childrenRes.data.children[0].runtimeId, 'cliagents-root:0');
    assert.strictEqual(childrenRes.data.children[0].runtimeFidelity, 'managed');
    assert(childrenRes.data.children[0].runtimeCapabilities.includes('send_input'));
    assert(!childrenRes.data.children.some((child) => child.terminalId === 'child-monitor-other-root'));

    const missingRes = await request(baseUrl, 'GET', '/orchestration/root-sessions/does-not-exist');
    assert.strictEqual(missingRes.status, 404);
    const missingChildrenRes = await request(baseUrl, 'GET', '/orchestration/root-sessions/does-not-exist/children');
    assert.strictEqual(missingChildrenRes.status, 404);
    assert.strictEqual(missingChildrenRes.data.error.code, 'root_session_not_found');
  } finally {
    await stopApp(server);
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function testRoleRoutingFallsBackWhenPreferredAdapterIsUnavailable() {
  const createCalls = [];
  const sendCalls = [];

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: 'term-route-fallback-1' };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    }
  };

  const apiSessionManager = {
    getAdapterNames() {
      return ['gemini-cli', 'codex-cli', 'qwen-cli'];
    },
    getAdapter(name) {
      if (name === 'qwen-cli') {
        return createRuntimeAdapter({
          name,
          available: false,
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true,
            supportsSystemPrompt: true
          }
        });
      }
      if (name === 'codex-cli') {
        return createRuntimeAdapter({
          name,
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true,
            supportsSystemPrompt: true
          }
        });
      }
      if (name === 'qwen-cli') {
        return createRuntimeAdapter({
          name,
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true,
            supportsSystemPrompt: true
          }
        });
      }
      return null;
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager,
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/route', {
      forceRole: 'plan',
      message: 'Create a fallback-safe implementation plan.'
    });

    assert.strictEqual(res.status, 200);
    assert.notStrictEqual(res.data.adapter, 'qwen-cli');
    assert(res.data.profile.startsWith('plan_'));
    assert.strictEqual(res.data.routingDecision.strategy, 'fallback');
    assert.strictEqual(res.data.routingDecision.requestedRole, 'plan');
    assert.strictEqual(res.data.routingDecision.requestedAdapter, 'qwen-cli');
    assert.strictEqual(res.data.routingDecision.selectedAdapter, res.data.adapter);
    assert(res.data.routingDecision.candidates.some((candidate) => candidate.adapter === 'qwen-cli' && candidate.available === false));
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].adapter, res.data.adapter);
    assert.strictEqual(sendCalls.length, 1);
  } finally {
    await stopApp(server);
  }
}

async function testAutoDetectedRoutingFallsBackUsingRuntimeMetadata() {
  const createCalls = [];
  const sendCalls = [];

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: 'term-route-autodetect-1' };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    }
  };

  const apiSessionManager = {
    getAdapterNames() {
      return ['gemini-cli', 'codex-cli', 'qwen-cli'];
    },
    getAdapter(name) {
      if (name === 'qwen-cli') {
        return createRuntimeAdapter({
          name,
          available: false,
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true,
            supportsSystemPrompt: true
          }
        });
      }
      if (name === 'codex-cli') {
        return createRuntimeAdapter({
          name,
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true,
            supportsSystemPrompt: true
          }
        });
      }
      if (name === 'qwen-cli') {
        return createRuntimeAdapter({
          name,
          capabilities: {
            usesOfficialCli: true,
            executionMode: 'direct-session',
            supportsMultiTurn: true,
            supportsSystemPrompt: true,
            reasoning: true
          }
        });
      }
      return null;
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager,
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/route', {
      message: 'Plan the implementation for a new run-ledger reconciliation worker.'
    });

    assert.strictEqual(res.status, 200);
    assert.notStrictEqual(res.data.adapter, 'qwen-cli');
    assert.strictEqual(res.data.taskType, 'plan');
    assert(res.data.profile.startsWith('plan_'));
    assert.strictEqual(res.data.routingDecision.strategy, 'fallback');
    assert.strictEqual(res.data.routingDecision.requestedRole, 'plan');
    assert.strictEqual(res.data.routingDecision.requestedAdapter, 'qwen-cli');
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].adapter, res.data.adapter);
    assert.strictEqual(sendCalls.length, 1);
  } finally {
    await stopApp(server);
  }
}

async function testWorkflowRoutePropagatesModelOverrides() {
  const createCalls = [];
  const sendCalls = [];
  let completionCount = 0;

  const sessionManager = {
    async createTerminal(options) {
      createCalls.push(options);
      return { terminalId: `term-workflow-${createCalls.length}` };
    },
    async sendInput(terminalId, message) {
      sendCalls.push({ terminalId, message });
    },
    async waitForCompletion(terminalId) {
      completionCount += 1;
      return `completed:${terminalId}`;
    }
  };

  const { server, baseUrl } = await startApp({
    sessionManager,
    apiSessionManager: {
      getAdapterNames() {
        return ['gemini-cli', 'codex-cli', 'qwen-cli'];
      },
      getAdapter() {
        return null;
      }
    },
    db: { db: null }
  });

  try {
    const res = await request(baseUrl, 'POST', '/orchestration/workflows/feature', {
      message: 'Implement the requested feature safely.',
      modelsByAdapter: {
        'qwen-cli': 'qwen-max',
        'codex-cli': 'o4-mini'
      },
      workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'completed');
    assert.strictEqual(createCalls.length, 3);
    assert.strictEqual(sendCalls.length, 3);
    assert.strictEqual(completionCount, 3);
    assert.strictEqual(createCalls[0].adapter, 'qwen-cli');
    assert.strictEqual(createCalls[0].model, 'qwen-max');
    assert.strictEqual(createCalls[1].adapter, 'codex-cli');
    assert.strictEqual(createCalls[1].model, 'o4-mini');
    assert.strictEqual(createCalls[2].adapter, 'codex-cli');
    assert.strictEqual(createCalls[2].model, 'o4-mini');
    assert(createCalls.every((call) => call.workDir === '/Users/mojave/Documents/AI-projects/cliagents'));
  } finally {
    await stopApp(server);
  }
}

async function testSessionEventsRouteReturnsReplayOrderedEvents() {
  const rootDir = makeTempDir('cliagents-session-events-route-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });

  const rootSessionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  db.addSessionEvent({
    rootSessionId,
    sessionId: rootSessionId,
    eventType: 'session_started',
    originClient: 'mcp',
    idempotencyKey: `${rootSessionId}:${rootSessionId}:session_started:root`,
    payloadSummary: 'root attached'
  });
  db.addSessionEvent({
    rootSessionId,
    sessionId: 'cccccccccccccccccccccccccccccccc',
    parentSessionId: rootSessionId,
    eventType: 'session_started',
    originClient: 'mcp',
    idempotencyKey: `${rootSessionId}:cccccccccccccccccccccccccccccccc:session_started:child`,
    payloadSummary: 'child started'
  });

  const { server, baseUrl } = await startApp({
    sessionManager: {
      async createTerminal() {
        throw new Error('not used');
      },
      async sendInput() {
        throw new Error('not used');
      }
    },
    apiSessionManager: null,
    db
  });

  try {
    const res = await request(baseUrl, 'GET', `/orchestration/session-events?rootSessionId=${rootSessionId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.events.length, 2);
    assert.strictEqual(res.data.events[0].sequence_no, 1);
    assert.strictEqual(res.data.events[0].payload_summary, 'root attached');
    assert.strictEqual(res.data.events[1].sequence_no, 2);
    assert.strictEqual(res.data.events[1].payload_summary, 'child started');

    const cursorRes = await request(baseUrl, 'GET', `/orchestration/session-events?rootSessionId=${rootSessionId}&after_sequence_no=1`);
    assert.strictEqual(cursorRes.status, 200);
    assert.strictEqual(cursorRes.data.events.length, 1);
    assert.strictEqual(cursorRes.data.events[0].sequence_no, 2);
    assert.strictEqual(cursorRes.data.events[0].payload_summary, 'child started');
  } finally {
    await stopApp(server);
    db.close();
  }
}

async function testReconcileRouteRecoversStaleRuns() {
  const previousWriteFlag = process.env.RUN_LEDGER_ENABLED;
  process.env.RUN_LEDGER_ENABLED = '1';

  const rootDir = makeTempDir('cliagents-orchestration-introspection-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });
  const ledger = new RunLedgerService(db);
  const now = Date.now();

  const staleRunId = ledger.createRun({
    kind: 'plan-review',
    status: 'running',
    currentStep: 'judge',
    activeParticipantCount: 1,
    startedAt: now - 90000,
    lastHeartbeatAt: now - 90000,
    inputSummary: 'Reconcile this stale plan review.'
  });

  const reviewerId = ledger.addParticipant({
    runId: staleRunId,
    participantRole: 'reviewer',
    participantName: 'codex-reviewer',
    adapter: 'codex-cli',
    status: 'completed',
    startedAt: now - 90000,
    endedAt: now - 85000
  });

  const judgeId = ledger.addParticipant({
    runId: staleRunId,
    participantRole: 'judge',
    participantName: 'judge',
    adapter: 'codex-cli',
    status: 'running',
    currentStep: 'judge',
    startedAt: now - 90000,
    lastHeartbeatAt: now - 90000
  });

  ledger.appendOutput({
    runId: staleRunId,
    participantId: reviewerId,
    outputKind: 'participant_final',
    content: 'Reviewer output is present.',
    createdAt: now - 84000
  });

  ledger.appendStep({
    runId: staleRunId,
    participantId: judgeId,
    stepKey: 'judge',
    stepName: 'judge',
    status: 'running',
    startedAt: now - 90000,
    lastHeartbeatAt: now - 90000
  });

  let appHandle = null;

  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal() {
          throw new Error('not used');
        },
        async sendInput() {
          throw new Error('not used');
        }
      },
      apiSessionManager: null,
      db
    });

    const res = await request(appHandle.baseUrl, 'POST', '/orchestration/runs/reconcile', {
      staleMs: 30000,
      limit: 10
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.reconciledCount, 1);
    assert.strictEqual(res.data.runs[0].runId, staleRunId);
    assert.strictEqual(res.data.runs[0].status, 'partial');
    assert.strictEqual(res.data.runs[0].reason, 'stale_judge');

    const detail = ledger.getRunDetail(staleRunId);
    assert.strictEqual(detail.run.status, 'partial');
    assert.strictEqual(detail.run.decisionSource, 'recovery');
    assert.strictEqual(detail.participants.find((participant) => participant.id === judgeId).status, 'abandoned');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
    if (previousWriteFlag === undefined) {
      delete process.env.RUN_LEDGER_ENABLED;
    } else {
      process.env.RUN_LEDGER_ENABLED = previousWriteFlag;
    }
  }
}

async function testAgentServerSweepAutoReconcilesStaleRuns() {
  const previousWriteFlag = process.env.RUN_LEDGER_ENABLED;
  process.env.RUN_LEDGER_ENABLED = '1';

  const orchestrationDataDir = makeTempDir('cliagents-sweeper-data-');
  const orchestrationLogDir = makeTempDir('cliagents-sweeper-logs-');
  let testServer = null;

  try {
    testServer = await startTestServer({
      orchestration: {
        dataDir: orchestrationDataDir,
        logDir: orchestrationLogDir,
        workDir: '/Users/mojave/Documents/AI-projects/cliagents',
        runLedgerReconcileIntervalMs: 50,
        runLedgerReconcileStaleMs: 100,
        runLedgerReconcileLimit: 10
      }
    });

    const ledger = new RunLedgerService(testServer.server.orchestration.db);
    const now = Date.now();
    const runId = ledger.createRun({
      kind: 'plan-review',
      status: 'running',
      currentStep: 'judge',
      activeParticipantCount: 1,
      inputSummary: 'Auto reconcile this stale run.',
      startedAt: now - 1000,
      lastHeartbeatAt: now - 1000
    });

    const reviewerId = ledger.addParticipant({
      runId,
      participantRole: 'reviewer',
      participantName: 'codex-reviewer',
      adapter: 'codex-cli',
      status: 'completed',
      startedAt: now - 1000,
      endedAt: now - 900
    });

    const judgeId = ledger.addParticipant({
      runId,
      participantRole: 'judge',
      participantName: 'judge',
      adapter: 'codex-cli',
      status: 'running',
      currentStep: 'judge',
      startedAt: now - 1000,
      lastHeartbeatAt: now - 1000
    });

    ledger.appendOutput({
      runId,
      participantId: reviewerId,
      outputKind: 'participant_final',
      content: 'Reviewer output still exists.',
      createdAt: now - 850
    });

    ledger.appendStep({
      runId,
      participantId: judgeId,
      stepKey: 'judge',
      stepName: 'judge',
      status: 'running',
      startedAt: now - 1000,
      lastHeartbeatAt: now - 1000
    });

    await waitFor(() => {
      const detail = ledger.getRunDetail(runId);
      return detail?.run?.status === 'partial';
    }, 3000, 50);

    const detail = ledger.getRunDetail(runId);
    assert.strictEqual(detail.run.status, 'partial');
    assert.strictEqual(detail.run.decisionSource, 'recovery');
    assert.strictEqual(detail.participants.find((participant) => participant.id === judgeId).status, 'abandoned');
  } finally {
    if (testServer) {
      await stopTestServer(testServer);
    }
    if (previousWriteFlag === undefined) {
      delete process.env.RUN_LEDGER_ENABLED;
    } else {
      process.env.RUN_LEDGER_ENABLED = previousWriteFlag;
    }
  }
}

async function testRootSessionAttachRouteCreatesAndReusesClientRoot() {
  const rootDir = makeTempDir('cliagents-root-attach-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal() {
          throw new Error('not used');
        },
        async sendInput() {
          throw new Error('not used');
        }
      },
      apiSessionManager: null,
      db
    });

    const attachBody = {
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-attach-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    };

    const first = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/attach', attachBody);
    assert.strictEqual(first.status, 200);
    assert(first.data.rootSessionId, 'attach route should return a rootSessionId');
    assert.strictEqual(first.data.attachedRoot, true);
    assert.strictEqual(first.data.reusedAttachedRoot, false);
    assert.strictEqual(first.data.originClient, 'mcp');
    assert.strictEqual(first.data.sessionMetadata.attachMode, 'explicit-http-attach');
    const attachedRootTerminal = db.getTerminal(first.data.rootSessionId);
    assert.strictEqual(attachedRootTerminal.runtime_host, 'adopted');
    assert.strictEqual(attachedRootTerminal.runtime_fidelity, 'adopted-partial');
    assert(JSON.parse(attachedRootTerminal.runtime_capabilities).includes('inspect_history'));

    const second = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/attach', attachBody);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.rootSessionId, first.data.rootSessionId);
    assert.strictEqual(second.data.attachedRoot, false);
    assert.strictEqual(second.data.reusedAttachedRoot, true);

    const events = db.listSessionEvents({ rootSessionId: first.data.rootSessionId, limit: 20 });
    assert.strictEqual(events.length, 1, 're-attaching should not create duplicate root attach events');
    assert.strictEqual(events[0].payload_json.externalSessionRef, 'opencode:thread-attach-1');
    assert.strictEqual(events[0].payload_json.attachMode, 'explicit-http-attach');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
  }
}

async function testRouteImplicitlyAttachesAndReusesClientRoot() {
  const rootDir = makeTempDir('cliagents-route-attach-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const createCalls = [];
  const sendCalls = [];

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal(options) {
          createCalls.push(options);
          return { terminalId: `term-${createCalls.length}`, reused: false, reuseReason: null };
        },
        async sendInput(terminalId, message) {
          sendCalls.push({ terminalId, message });
        }
      },
      apiSessionManager: {
        getAdapterNames() {
          return ['codex-cli', 'qwen-cli'];
        },
        getAdapter(name) {
          if (!['codex-cli', 'qwen-cli'].includes(name)) {
            return null;
          }
          return createRuntimeAdapter({
            name,
            capabilities: {
              usesOfficialCli: true,
              executionMode: 'direct-session',
              supportsMultiTurn: true
            }
          });
        }
      },
      db
    });

    const body = {
      message: 'Review this change',
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-route-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    };

    const first = await request(appHandle.baseUrl, 'POST', '/orchestration/route', body);
    assert.strictEqual(first.status, 428, 'Implicit attach should now be rejected with 428');
    assert.strictEqual(first.data.error.code, 'root_session_required');
    assert.strictEqual(createCalls.length, 0, 'No terminal should be created for rejected implicit attach');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
  }
}

async function testRouteRejectsConflictingRootBinding() {
  const rootDir = makeTempDir('cliagents-route-binding-conflict-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const createCalls = [];
  const sendCalls = [];

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal(options) {
          createCalls.push(options);
          return { terminalId: `term-${createCalls.length}`, reused: false, reuseReason: null };
        },
        async sendInput(terminalId, message) {
          sendCalls.push({ terminalId, message });
        }
      },
      apiSessionManager: {
        getAdapterNames() {
          return ['codex-cli'];
        },
        getAdapter(name) {
          if (name !== 'codex-cli') {
            return null;
          }
          return createRuntimeAdapter({
            name,
            capabilities: {
              usesOfficialCli: true,
              executionMode: 'direct-session',
              supportsMultiTurn: true
            }
          });
        }
      },
      db
    });

    const attach = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/attach', {
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-route-conflict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(attach.status, 200);
    assert(attach.data.rootSessionId);

    const conflict = await request(appHandle.baseUrl, 'POST', '/orchestration/route', {
      message: 'Review this change',
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      rootSessionId: 'ffffffffffffffffffffffffffffffff',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-route-conflict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.data.error.code, 'root_session_binding_conflict');
    assert.strictEqual(conflict.data.error.details.rootSessionId, 'ffffffffffffffffffffffffffffffff');
    assert.strictEqual(conflict.data.error.details.conflictingRootSessionId, attach.data.rootSessionId);
    assert.strictEqual(createCalls.length, 0, 'conflicting root binding should reject before terminal creation');
    assert.strictEqual(sendCalls.length, 0, 'conflicting root binding should reject before sending input');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
  }
}

async function testAttachRouteRejectsConflictingRootBinding() {
  const rootDir = makeTempDir('cliagents-attach-binding-conflict-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal() {
          throw new Error('not used');
        },
        async sendInput() {
          throw new Error('not used');
        }
      },
      apiSessionManager: null,
      db
    });

    const first = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/attach', {
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-attach-conflict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(first.status, 200);
    assert(first.data.rootSessionId);

    const conflict = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/attach', {
      rootSessionId: 'abababababababababababababababab',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-attach-conflict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.data.error.code, 'root_session_binding_conflict');
    assert.strictEqual(conflict.data.error.details.rootSessionId, 'abababababababababababababababab');
    assert.strictEqual(conflict.data.error.details.conflictingRootSessionId, first.data.rootSessionId);
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
  }
}

async function testStrictRootAttachRejectsDetachedRouteCalls() {
  const previousFlag = process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
  process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH = '1';

  const rootDir = makeTempDir('cliagents-route-strict-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const createCalls = [];
  const sendCalls = [];

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal(options) {
          createCalls.push(options);
          return { terminalId: `term-${createCalls.length}`, reused: false, reuseReason: null };
        },
        async sendInput(terminalId, message) {
          sendCalls.push({ terminalId, message });
        }
      },
      apiSessionManager: {
        getAdapterNames() {
          return ['codex-cli'];
        },
        getAdapter(name) {
          if (name !== 'codex-cli') {
            return null;
          }
          return createRuntimeAdapter({
            name,
            capabilities: {
              usesOfficialCli: true,
              executionMode: 'direct-session',
              supportsMultiTurn: true
            }
          });
        }
      },
      db
    });

    const detached = await request(appHandle.baseUrl, 'POST', '/orchestration/route', {
      message: 'Review this change',
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      sessionMetadata: {
        clientName: 'opencode',
        attachMode: 'implicit-first-use'
      }
    });
    assert.strictEqual(detached.status, 428);
    assert.strictEqual(detached.data.error.code, 'root_session_required');
    assert.strictEqual(createCalls.length, 0, 'strict mode should reject before terminal creation');
    assert.strictEqual(sendCalls.length, 0, 'strict mode should reject before sending input');

    const attached = await request(appHandle.baseUrl, 'POST', '/orchestration/route', {
      message: 'Review this change',
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-route-strict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(attached.status, 428);
    assert.strictEqual(attached.data.error.code, 'root_session_required');
    assert.strictEqual(createCalls.length, 0);
    assert.strictEqual(sendCalls.length, 0);

    const explicitRoot = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/attach', {
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-route-strict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(explicitRoot.status, 200);
    assert(explicitRoot.data.rootSessionId);

    const attachedAfterEnsure = await request(appHandle.baseUrl, 'POST', '/orchestration/route', {
      message: 'Review this change',
      forceRole: 'review',
      forceAdapter: 'codex-cli',
      originClient: 'mcp',
      externalSessionRef: 'opencode:thread-route-strict-1',
      sessionMetadata: {
        clientName: 'opencode'
      }
    });
    assert.strictEqual(attachedAfterEnsure.status, 200);
    assert.strictEqual(attachedAfterEnsure.data.rootSessionId, explicitRoot.data.rootSessionId);
    assert.strictEqual(attachedAfterEnsure.data.attachedRoot, false);
    assert.strictEqual(attachedAfterEnsure.data.reusedAttachedRoot, true);
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(sendCalls.length, 1);
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
    if (previousFlag === undefined) {
      delete process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
    } else {
      process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH = previousFlag;
    }
  }
}

async function testStrictRootAttachRejectsDetachedWorkflowCalls() {
  const previousFlag = process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
  process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH = '1';

  const rootDir = makeTempDir('cliagents-workflow-strict-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal() {
          throw new Error('not used');
        },
        async sendInput() {
          throw new Error('not used');
        }
      },
      apiSessionManager: {
        getAdapterNames() {
          return ['codex-cli'];
        },
        getAdapter(name) {
          if (name !== 'codex-cli') {
            return null;
          }
          return createRuntimeAdapter({
            name,
            capabilities: {
              usesOfficialCli: true,
              executionMode: 'direct-session',
              supportsMultiTurn: true
            }
          });
        }
      },
      db
    });

    const detached = await request(appHandle.baseUrl, 'POST', '/orchestration/workflows/feature', {
      message: 'Implement this feature'
    });
    assert.strictEqual(detached.status, 428);
    assert.strictEqual(detached.data.error.code, 'root_session_required');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
    if (previousFlag === undefined) {
      delete process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
    } else {
      process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH = previousFlag;
    }
  }
}

async function testManagedRootLaunchRouteCreatesInteractiveRootTerminal() {
  const previousGraphWrites = process.env.SESSION_GRAPH_WRITES_ENABLED;
  process.env.SESSION_GRAPH_WRITES_ENABLED = '1';

  const createCalls = [];
  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal(options) {
          createCalls.push(options);
          return {
            terminalId: 'root-term-1',
            sessionName: 'cliagents-root-1',
            windowName: 'claude-root-1',
            adapter: options.adapter,
            role: options.role,
            rootSessionId: 'root-term-1',
            parentSessionId: null,
            sessionKind: options.sessionKind,
            originClient: options.originClient,
            externalSessionRef: options.externalSessionRef,
            status: 'idle'
          };
        },
        getAttachCommand(terminalId) {
          assert.strictEqual(terminalId, 'root-term-1');
          return 'tmux attach -t "cliagents-root-1"';
        }
      },
      apiSessionManager: null,
      db: { db: null }
    });

    const response = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/launch', {
      adapter: 'claude',
      workingDirectory: '/tmp/cliagents-managed-root',
      model: 'claude-sonnet-4-5-20250514',
      systemPrompt: 'Return concise answers.',
      deferProviderStartUntilAttached: true,
      launchEnvironment: {
        TERM_PROGRAM: 'iTerm.app',
        COLORTERM: 'truecolor',
        COLUMNS: '180',
        LINES: '48',
        SSH_AUTH_SOCK: '/tmp/should-not-pass'
      }
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].adapter, 'claude-code');
    assert.strictEqual(createCalls[0].role, 'main');
    assert.strictEqual(createCalls[0].sessionKind, 'main');
    assert.strictEqual(createCalls[0].originClient, 'claude');
    assert.strictEqual(createCalls[0].permissionMode, 'default');
    assert.strictEqual(createCalls[0].preferReuse, false);
    assert.strictEqual(createCalls[0].forceFreshSession, true);
    assert.strictEqual(createCalls[0].workDir, '/tmp/cliagents-managed-root');
    assert.strictEqual(createCalls[0].sessionMetadata.attachMode, 'managed-root-launch');
    assert.strictEqual(createCalls[0].sessionMetadata.launchSource, 'http-root-launch');
    assert.strictEqual(createCalls[0].sessionMetadata.launchProfile, 'guarded-root');
    assert.strictEqual(createCalls[0].sessionMetadata.clientName, 'claude');
    assert.strictEqual(createCalls[0].sessionMetadata.workspaceRoot, '/tmp/cliagents-managed-root');
    assert.strictEqual(createCalls[0].sessionMetadata.providerStartMode, 'after-attach');
    assert.strictEqual(createCalls[0].deferProviderStartUntilAttached, true);
    assert(createCalls[0].systemPrompt.includes('broker-managed root agent inside cliagents'));
    assert(createCalls[0].systemPrompt.includes('list_models'));
    assert(createCalls[0].systemPrompt.includes('Return concise answers.'));
    assert.deepStrictEqual(createCalls[0].launchEnvironment, {
      TERM_PROGRAM: 'iTerm.app',
      COLORTERM: 'truecolor',
      COLUMNS: '180',
      LINES: '48'
    });
    assert.deepStrictEqual(createCalls[0].sessionMetadata.launchEnvironment, {
      TERM_PROGRAM: 'iTerm.app',
      COLORTERM: 'truecolor',
      COLUMNS: '180',
      LINES: '48'
    });
    assert(createCalls[0].externalSessionRef.startsWith('claude:managed:'));
    assert.strictEqual(response.data.attachCommand, 'tmux attach -t "cliagents-root-1"');
    assert.strictEqual(response.data.managedRoot, true);
    assert.strictEqual(response.data.providerStartMode, 'after-attach');
    assert.strictEqual(response.data.rootSessionId, 'root-term-1');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    if (previousGraphWrites === undefined) {
      delete process.env.SESSION_GRAPH_WRITES_ENABLED;
    } else {
      process.env.SESSION_GRAPH_WRITES_ENABLED = previousGraphWrites;
    }
  }
}

async function testRootAdoptRouteCreatesManagedRootFromExistingTmuxTarget() {
  const previousGraphWrites = process.env.SESSION_GRAPH_WRITES_ENABLED;
  process.env.SESSION_GRAPH_WRITES_ENABLED = '1';

  const adoptCalls = [];
  const sessionEvents = [];
  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async adoptTerminal(options) {
          adoptCalls.push(options);
          return {
            terminalId: 'adopted-root-1',
            sessionName: options.sessionName,
            windowName: options.windowName,
            adapter: options.adapter,
            role: options.role,
            rootSessionId: options.rootSessionId,
            parentSessionId: null,
            sessionKind: options.sessionKind,
            originClient: options.originClient,
            externalSessionRef: options.externalSessionRef,
            status: 'idle',
            taskState: 'idle',
            processState: 'alive'
          };
        },
        getAttachCommand(terminalId) {
          assert.strictEqual(terminalId, 'adopted-root-1');
          return 'tmux attach -t "workspace"';
        }
      },
      apiSessionManager: null,
      db: {
        db: null,
        addSessionEvent(event) {
          sessionEvents.push(event);
          return event;
        }
      }
    });

    const response = await request(appHandle.baseUrl, 'POST', '/orchestration/root-sessions/adopt', {
      adapter: 'claude',
      tmuxTarget: 'workspace:agent',
      workingDirectory: '/tmp/cliagents-adopt-root',
      model: 'claude-opus-4-6'
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(adoptCalls.length, 1);
    assert.strictEqual(adoptCalls[0].adapter, 'claude-code');
    assert.strictEqual(adoptCalls[0].sessionName, 'workspace');
    assert.strictEqual(adoptCalls[0].windowName, 'agent');
    assert.strictEqual(adoptCalls[0].role, 'main');
    assert.strictEqual(adoptCalls[0].sessionKind, 'main');
    assert.strictEqual(adoptCalls[0].originClient, 'claude');
    assert.strictEqual(adoptCalls[0].workDir, '/tmp/cliagents-adopt-root');
    assert.strictEqual(adoptCalls[0].sessionMetadata.attachMode, 'root-adopt');
    assert.strictEqual(adoptCalls[0].sessionMetadata.launchSource, 'http-root-adopt');
    assert.strictEqual(adoptCalls[0].sessionMetadata.clientName, 'claude');
    assert.strictEqual(adoptCalls[0].sessionMetadata.tmuxTarget, 'workspace:agent');
    assert.strictEqual(sessionEvents.length, 1);
    assert.strictEqual(sessionEvents[0].eventType, 'session_started');
    assert.strictEqual(response.data.adoptedRoot, true);
    assert.strictEqual(response.data.tmuxTarget, 'workspace:agent');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    if (previousGraphWrites === undefined) {
      delete process.env.SESSION_GRAPH_WRITES_ENABLED;
    } else {
      process.env.SESSION_GRAPH_WRITES_ENABLED = previousGraphWrites;
    }
  }
}

async function testPruneOrphanedTerminalsRoute() {
  const rootDir = makeTempDir('cliagents-prune-orphaned-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  db.registerTerminal('old-orphan-1', 'cliagents-old-1', 'old-win-1', 'codex-cli', 'review_codex-cli', 'worker', rootDir, path.join(rootDir, 'old-1.log'));
  db.registerTerminal('old-orphan-2', 'cliagents-old-2', 'old-win-2', 'qwen-cli', 'review_qwen-cli', 'worker', rootDir, path.join(rootDir, 'old-2.log'));
  db.registerTerminal('fresh-orphan', 'cliagents-fresh', 'fresh-win', 'codex-cli', 'review_codex-cli', 'worker', rootDir, path.join(rootDir, 'fresh.log'));

  db.updateStatus('old-orphan-1', 'orphaned');
  db.updateStatus('old-orphan-2', 'orphaned');
  db.updateStatus('fresh-orphan', 'orphaned');

  db.db.prepare("UPDATE terminals SET created_at = datetime('now', '-240 hours') WHERE terminal_id IN (?, ?)").run('old-orphan-1', 'old-orphan-2');
  db.db.prepare("UPDATE terminals SET created_at = datetime('now', '-2 hours') WHERE terminal_id = ?").run('fresh-orphan');

  let appHandle = null;
  try {
    appHandle = await startApp({
      sessionManager: {
        async createTerminal() {
          throw new Error('not used');
        },
        async sendInput() {
          throw new Error('not used');
        }
      },
      apiSessionManager: null,
      db
    });

    const dryRun = await request(appHandle.baseUrl, 'POST', '/orchestration/terminals/prune-orphaned', {
      olderThanHours: 24,
      limit: 10,
      dryRun: true
    });
    assert.strictEqual(dryRun.status, 200);
    assert.strictEqual(dryRun.data.dryRun, true);
    assert.strictEqual(dryRun.data.candidateCount, 2);
    assert.strictEqual(db.listTerminals({ status: 'orphaned' }).length, 3);

    const prune = await request(appHandle.baseUrl, 'POST', '/orchestration/terminals/prune-orphaned', {
      olderThanHours: 24,
      limit: 10
    });
    assert.strictEqual(prune.status, 200);
    assert.strictEqual(prune.data.deletedCount, 2);

    const remainingOrphans = db.listTerminals({ status: 'orphaned' });
    assert.strictEqual(remainingOrphans.length, 1);
    assert.strictEqual(remainingOrphans[0].terminal_id || remainingOrphans[0].terminalId, 'fresh-orphan');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
  }
}

async function run() {
  const previousRequireRootAttach = process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
  delete process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
  console.log('Running orchestration introspection route tests...');

  try {
    await testAdaptersRouteIncludesRuntimeMetadata();
    console.log('  ✓ adapters route exposes configured and runtime metadata');

    await testRouteResponseIncludesRuntimeAdapterMetadata();
    console.log('  ✓ route response includes runtime adapter capability data');

    await testRecommendModelRouteReturnsBrokerPolicyRecommendation();
    console.log('  ✓ model-routing endpoint returns broker-ranked recommendations');

    await testRoutePropagatesSessionGraphMetadata();
    console.log('  ✓ route path propagates session graph metadata into terminal creation');

    await testRouteAutoAppliesRecommendedOpencodeModel();
    console.log('  ✓ route path auto-applies recommended opencode model when no override is provided');

    await testRouteSkipsDegradedOpencodeModelLane();
    console.log('  ✓ route path skips degraded opencode model lanes and falls back by family order');

    await testDestroyTerminalRouteDistinguishesMissingTerminal();
    console.log('  ✓ terminal destroy route returns 404 for missing terminals');

    await testOutputRouteSupportsVisibleAnsiModes();
    console.log('  ✓ terminal output route supports visible/ansi modes without breaking defaults');

    await testInputRouteReturnsTerminalBusyConflict();
    console.log('  ✓ terminal input route returns 409 for busy terminals');

    await testInputRouteRejectsAttachedRootsAsReadOnly();
    console.log('  ✓ terminal input route rejects attached roots as read-only');

    await testInputRouteAllowsAttachedRootChildBrokerWork();
    console.log('  ✓ terminal input route allows broker-owned child work under attached roots');

    await testInputRouteRejectsDbOnlyAttachedRootChildSpoof();
    console.log('  ✓ terminal input route rejects DB-only child spoofing under attached roots');

    await testRootSessionRoutesExposeAttentionSummary();
    console.log('  ✓ root-session routes expose attention summaries and detail snapshots');

    await testRoleRoutingFallsBackWhenPreferredAdapterIsUnavailable();
    console.log('  ✓ role-based routing falls back when the default adapter is unhealthy');

    await testAutoDetectedRoutingFallsBackUsingRuntimeMetadata();
    console.log('  ✓ auto-detected routing falls back using runtime adapter metadata');

    await testWorkflowRoutePropagatesModelOverrides();
    console.log('  ✓ workflow route propagates model overrides and working directory');

    await testSessionEventsRouteReturnsReplayOrderedEvents();
    console.log('  ✓ session-events route replays ordered control-plane events');

    await testReconcileRouteRecoversStaleRuns();
    console.log('  ✓ stale-run reconciliation route recovers stuck runs');

    await testAgentServerSweepAutoReconcilesStaleRuns();
    console.log('  ✓ agent server sweep auto-reconciles stale runs');

    await testRootSessionAttachRouteCreatesAndReusesClientRoot();
    console.log('  ✓ explicit root attach route reuses the same client/session root');

    await testRouteImplicitlyAttachesAndReusesClientRoot();
    console.log('  ✓ route path rejects implicit client-root creation');

    await testRouteRejectsConflictingRootBinding();
    console.log('  ✓ route path rejects conflicting rootSessionId/externalSessionRef bindings');

    await testAttachRouteRejectsConflictingRootBinding();
    console.log('  ✓ explicit attach rejects conflicting rootSessionId/externalSessionRef bindings');

    await testStrictRootAttachRejectsDetachedRouteCalls();
    console.log('  ✓ strict root attach rejects detached route calls');

    await testStrictRootAttachRejectsDetachedWorkflowCalls();
    console.log('  ✓ strict root attach rejects detached workflow calls');

    await testManagedRootLaunchRouteCreatesInteractiveRootTerminal();
    console.log('  ✓ managed root launch creates an interactive broker-owned root terminal');

    await testRootAdoptRouteCreatesManagedRootFromExistingTmuxTarget();
    console.log('  ✓ root adopt route registers an existing tmux target as a managed root');

    await testPruneOrphanedTerminalsRoute();
    console.log('  ✓ orphaned-terminal prune route removes only historical orphan rows');

    console.log('All orchestration introspection route tests passed.');
  } finally {
    if (previousRequireRootAttach === undefined) {
      delete process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH;
    } else {
      process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH = previousRequireRootAttach;
    }
  }
}

run().catch((error) => {
  console.error('Orchestration introspection route tests failed:', error);
  process.exit(1);
});
