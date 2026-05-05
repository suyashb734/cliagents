#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { OrchestrationDB } = require('../src/database/db');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeSessionManager() {
  const state = {
    createCalls: [],
    sendCalls: [],
    terminals: new Map()
  };
  let counter = 0;

  return {
    state,
    async createTerminal(options = {}) {
      counter += 1;
      const terminalId = `term-${counter}`;
      const terminal = {
        terminalId,
        adapter: options.adapter || 'codex-cli',
        model: options.model || null,
        role: options.agentProfile || null,
        status: 'processing',
        taskState: 'processing',
        rootSessionId: options.rootSessionId || null,
        parentSessionId: options.parentSessionId || null,
        sessionKind: options.sessionKind || null
      };
      state.createCalls.push({
        ...options,
        terminalId
      });
      state.terminals.set(terminalId, terminal);
      return {
        terminalId,
        reused: false,
        reuseReason: null
      };
    },
    async sendInput(terminalId, message) {
      state.sendCalls.push({ terminalId, message });
      return { terminalId, message };
    },
    getTerminal(terminalId) {
      return state.terminals.get(terminalId) || null;
    }
  };
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', createOrchestrationRouter(context));

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

async function request(baseUrl, method, route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function initRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ['init', '-b', 'main']);
  runGit(repoDir, ['config', 'user.email', 'cliagents-test@example.com']);
  runGit(repoDir, ['config', 'user.name', 'cliagents test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# isolation\n', 'utf8');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, ['commit', '-m', 'initial commit']);
}

async function run() {
  const rootDir = makeTempDir('cliagents-task-worktree-');
  const repoDir = path.join(rootDir, 'repo');
  const worktreeDir = path.join(rootDir, 'repo-worktrees', 'task-exec');
  const escapedWorktreeDir = path.join(rootDir, 'escaped-worktrees', 'task-exec');
  const branchName = 'task/task-exec';
  initRepo(repoDir);

  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const sessionManager = createFakeSessionManager();
  let serverHandle = null;

  try {
    serverHandle = await startApp({
      db,
      sessionManager,
      adapterAuthInspector: () => ({ authenticated: true, reason: null })
    });

    const createTaskRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/tasks', {
      title: 'Implement in isolated worktree',
      workspaceRoot: repoDir
    });
    assert.strictEqual(createTaskRes.status, 200);
    const taskId = createTaskRes.data.task.id;

    const escapedAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Attempt to escape the allowed worktree root.',
      worktreePath: escapedWorktreeDir,
      worktreeBranch: 'task/escape'
    });
    assert.strictEqual(escapedAssignmentRes.status, 200);
    const escapedStartRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${escapedAssignmentRes.data.assignment.id}/start`,
      {
        rootSessionId: 'root-task-isolation',
        parentSessionId: 'root-task-isolation',
        originClient: 'test',
        externalSessionRef: 'test:task-isolation'
      }
    );
    assert.strictEqual(escapedStartRes.status, 500);
    assert.strictEqual(escapedStartRes.data.error.code, 'task_assignment_start_failed');
    assert.match(escapedStartRes.data.error.message, /allowed worktree root/);
    assert.strictEqual(sessionManager.state.createCalls.length, 0);

    const createAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Implement the feature in an isolated worktree.',
      worktreePath: worktreeDir,
      worktreeBranch: branchName
    });
    assert.strictEqual(createAssignmentRes.status, 200);
    const assignmentId = createAssignmentRes.data.assignment.id;

    const startAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments/${assignmentId}/start`, {
      rootSessionId: 'root-task-isolation',
      parentSessionId: 'root-task-isolation',
      originClient: 'test',
      externalSessionRef: 'test:task-isolation'
    });
    assert.strictEqual(startAssignmentRes.status, 200);
    assert.strictEqual(startAssignmentRes.data.assignment.worktreePath, worktreeDir);
    assert.strictEqual(startAssignmentRes.data.assignment.worktreeBranch, branchName);
    assert.strictEqual(startAssignmentRes.data.assignment.metadata.isolation.mode, 'git_worktree');
    assert.strictEqual(startAssignmentRes.data.assignment.metadata.isolation.created, true);
    assert.strictEqual(sessionManager.state.createCalls[0].workDir, worktreeDir);

    assert(fs.existsSync(worktreeDir), 'worktree directory should be created on start');
    assert.strictEqual(runGit(worktreeDir, ['branch', '--show-current']), branchName);

    const worktreeList = runGit(repoDir, ['worktree', 'list', '--porcelain']);
    const listedWorktrees = worktreeList
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => fs.realpathSync(line.slice('worktree '.length).trim()));
    assert(
      listedWorktrees.includes(fs.realpathSync(worktreeDir)),
      'git worktree list should include the prepared assignment worktree'
    );

    console.log('✅ Task assignment start prepares and uses a real git worktree isolation path');
  } finally {
    if (serverHandle) {
      await stopApp(serverHandle.server);
    }
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('\nTask worktree isolation tests passed');
}).catch((error) => {
  console.error('\nTask worktree isolation tests failed:', error);
  process.exit(1);
});
