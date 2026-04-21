#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const AgentServer = require('../src/server');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function waitFor(predicate, timeoutMs = 10000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

function tmuxSessionExists(sessionName, tmuxSocketPath = null) {
  try {
    const tmuxArgs = tmuxSocketPath
      ? `tmux -S ${JSON.stringify(tmuxSocketPath)} ls`
      : 'tmux ls';
    const output = execSync(tmuxArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.includes(`${sessionName}:`);
  } catch {
    return false;
  }
}

async function startServer({ dataDir, logDir, tmuxSocketPath, destroyTerminalsOnStop }) {
  const server = new AgentServer({
    host: '127.0.0.1',
    port: 0,
    cleanupOrphans: false,
    orchestration: {
      dataDir,
      logDir,
      tmuxSocketPath,
      workDir: '/Users/mojave/Documents/AI-projects/cliagents',
      destroyTerminalsOnStop
    }
  });
  await server.start();
  const address = server.server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function run() {
  const previousGraphWrites = process.env.SESSION_GRAPH_WRITES_ENABLED;
  process.env.SESSION_GRAPH_WRITES_ENABLED = '1';

  const dataDir = makeTempDir('cliagents-managed-root-data-');
  const logDir = makeTempDir('cliagents-managed-root-logs-');
  const tmuxDir = makeTempDir('cliagents-managed-root-tmux-');
  const tmuxSocketPath = path.join(tmuxDir, 'broker.sock');
  let serverOne = null;
  let serverTwo = null;
  let launchedTerminalId = null;
  let sessionName = null;

  try {
    serverOne = await startServer({
      dataDir,
      logDir,
      tmuxSocketPath,
      destroyTerminalsOnStop: false
    });

    const launch = await request(serverOne.baseUrl, 'POST', '/orchestration/root-sessions/launch', {
      adapter: 'claude',
      externalSessionRef: 'claude:test-managed-root-recovery',
      workDir: '/Users/mojave/Documents/AI-projects/cliagents'
    });

    assert.strictEqual(launch.status, 200);
    launchedTerminalId = launch.data.terminalId;
    sessionName = launch.data.sessionName;
    assert(launchedTerminalId, 'expected launched terminal id');
    assert(sessionName, 'expected tmux session name');

    await waitFor(async () => {
      const terminal = await request(serverOne.baseUrl, 'GET', `/orchestration/terminals/${launchedTerminalId}`);
      return terminal.status === 200 && terminal.data.status === 'idle';
    });

    assert(tmuxSessionExists(sessionName, tmuxSocketPath), 'managed root tmux session should exist before restart');

    await serverOne.server.stop();
    serverOne = null;

    assert(tmuxSessionExists(sessionName, tmuxSocketPath), 'managed root tmux session should survive broker shutdown');

    serverTwo = await startServer({
      dataDir,
      logDir,
      tmuxSocketPath,
      destroyTerminalsOnStop: true
    });

    await waitFor(async () => {
      const terminals = await request(serverTwo.baseUrl, 'GET', '/orchestration/terminals');
      return terminals.status === 200 && (terminals.data.count || 0) === 1;
    });

    const recoveredTerminal = await request(serverTwo.baseUrl, 'GET', `/orchestration/terminals/${launchedTerminalId}`);
    assert.strictEqual(recoveredTerminal.status, 200);
    assert.strictEqual(recoveredTerminal.data.status, 'idle');
    assert.strictEqual(recoveredTerminal.data.role, 'main');
    assert.strictEqual(recoveredTerminal.data.adapter, 'claude-code');
    assert.strictEqual(recoveredTerminal.data.rootSessionId, launchedTerminalId);

    const roots = await request(serverTwo.baseUrl, 'GET', '/orchestration/root-sessions?scope=user&limit=20');
    assert.strictEqual(roots.status, 200);
    const recoveredRoot = (roots.data.roots || []).find((root) => root.rootSessionId === launchedTerminalId);
    assert(recoveredRoot, 'expected recovered root session to remain visible');
    assert.strictEqual(recoveredRoot.status, 'idle');
    assert.strictEqual(recoveredRoot.counts.idle, 1);

    await request(serverTwo.baseUrl, 'DELETE', `/orchestration/terminals/${launchedTerminalId}`);
  } finally {
    if (serverOne) {
      await serverOne.server.stop();
    }
    if (serverTwo) {
      await serverTwo.server.stop();
    }

    if (sessionName && tmuxSessionExists(sessionName, tmuxSocketPath)) {
      execSync(`tmux -S ${JSON.stringify(tmuxSocketPath)} kill-session -t ${JSON.stringify(sessionName)}`, { stdio: 'ignore' });
    }

    for (const dirPath of [dataDir, logDir, tmuxDir]) {
      if (dirPath && fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    }

    if (previousGraphWrites === undefined) {
      delete process.env.SESSION_GRAPH_WRITES_ENABLED;
    } else {
      process.env.SESSION_GRAPH_WRITES_ENABLED = previousGraphWrites;
    }
  }

  console.log('✅ Managed root terminals survive broker restart and recover into the live control plane');
}

run().catch((error) => {
  console.error('\nManaged root recovery tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
