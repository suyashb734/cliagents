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
  const repoNestedWorktreeDir = path.join(repoDir, 'nested-task-exec');
  const invalidBranchWorktreeDir = path.join(rootDir, 'repo-worktrees', 'invalid-branch');
  const unregisteredWorktreeDir = path.join(rootDir, 'repo-worktrees', 'unregistered');
  const existingBranchWorktreeDir = path.join(rootDir, 'repo-worktrees', 'existing-branch');
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

    const repoNestedAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Attempt to run inside the primary repository.',
      worktreePath: repoNestedWorktreeDir,
      worktreeBranch: 'task/nested'
    });
    assert.strictEqual(repoNestedAssignmentRes.status, 200);
    const repoNestedStartRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${repoNestedAssignmentRes.data.assignment.id}/start`,
      {
        rootSessionId: 'root-task-isolation',
        parentSessionId: 'root-task-isolation',
        originClient: 'test',
        externalSessionRef: 'test:task-isolation'
      }
    );
    assert.strictEqual(repoNestedStartRes.status, 500);
    assert.strictEqual(repoNestedStartRes.data.error.code, 'task_assignment_start_failed');
    assert.match(repoNestedStartRes.data.error.message, /allowed worktree root|outside the primary repository root/);
    assert.strictEqual(sessionManager.state.createCalls.length, 0);

    const invalidBranchAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Attempt to use an invalid branch name.',
      worktreePath: invalidBranchWorktreeDir,
      worktreeBranch: 'bad branch'
    });
    assert.strictEqual(invalidBranchAssignmentRes.status, 200);
    const invalidBranchStartRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${invalidBranchAssignmentRes.data.assignment.id}/start`,
      {
        rootSessionId: 'root-task-isolation',
        parentSessionId: 'root-task-isolation',
        originClient: 'test',
        externalSessionRef: 'test:task-isolation'
      }
    );
    assert.strictEqual(invalidBranchStartRes.status, 500);
    assert.strictEqual(invalidBranchStartRes.data.error.code, 'task_assignment_start_failed');
    assert.match(invalidBranchStartRes.data.error.message, /Invalid worktreeBranch/);
    assert.strictEqual(sessionManager.state.createCalls.length, 0);

    runGit(repoDir, ['worktree', 'add', '-b', 'task/existing-branch', existingBranchWorktreeDir, 'HEAD']);
    const branchMismatchAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Attempt to reuse a worktree on the wrong branch.',
      worktreePath: existingBranchWorktreeDir,
      worktreeBranch: 'task/different-branch'
    });
    assert.strictEqual(branchMismatchAssignmentRes.status, 200);
    const branchMismatchStartRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${branchMismatchAssignmentRes.data.assignment.id}/start`,
      {
        rootSessionId: 'root-task-isolation',
        parentSessionId: 'root-task-isolation',
        originClient: 'test',
        externalSessionRef: 'test:task-isolation'
      }
    );
    assert.strictEqual(branchMismatchStartRes.status, 500);
    assert.strictEqual(branchMismatchStartRes.data.error.code, 'task_assignment_start_failed');
    assert.match(branchMismatchStartRes.data.error.message, /expected "task\/different-branch"/);
    assert.strictEqual(sessionManager.state.createCalls.length, 0);

    fs.mkdirSync(unregisteredWorktreeDir, { recursive: true });
    const unregisteredAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Attempt to reuse an unregistered directory.',
      worktreePath: unregisteredWorktreeDir,
      worktreeBranch: 'task/unregistered'
    });
    assert.strictEqual(unregisteredAssignmentRes.status, 200);
    const unregisteredStartRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${unregisteredAssignmentRes.data.assignment.id}/start`,
      {
        rootSessionId: 'root-task-isolation',
        parentSessionId: 'root-task-isolation',
        originClient: 'test',
        externalSessionRef: 'test:task-isolation'
      }
    );
    assert.strictEqual(unregisteredStartRes.status, 500);
    assert.strictEqual(unregisteredStartRes.data.error.code, 'task_assignment_start_failed');
    assert.match(unregisteredStartRes.data.error.message, /registered git worktree/);
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
    assert.strictEqual(startAssignmentRes.data.assignment.metadata.isolation.existing, false);
    assert.strictEqual(startAssignmentRes.data.assignment.metadata.isolation.dirty, false);
    assert.strictEqual(startAssignmentRes.data.assignment.metadata.isolation.requestedBranch, branchName);
    assert(startAssignmentRes.data.assignment.metadata.isolation.head, 'isolation metadata should record the prepared HEAD');
    assert.strictEqual(startAssignmentRes.data.assignment.isolation.mode, 'git_worktree');
    assert.strictEqual(startAssignmentRes.data.assignment.isolation.branch, branchName);
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

    const autoAssignmentRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Implement an automatically branched slice.',
      autoBranch: true,
      writePaths: ['src/auto.js']
    });
    assert.strictEqual(autoAssignmentRes.status, 200);
    assert(autoAssignmentRes.data.assignment.branch.branchName.startsWith('task/'), 'auto branch should use task namespace');
    assert(autoAssignmentRes.data.assignment.branch.worktreePath.includes('repo-worktrees'), 'auto branch should allocate a worktree path');
    assert.deepStrictEqual(autoAssignmentRes.data.assignment.branch.writePaths, ['src/auto.js']);
    assert.strictEqual(autoAssignmentRes.data.assignment.branch.pathLease.status, 'active');

    const autoConflictRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments`, {
      role: 'executor',
      instructions: 'Attempt to edit the same auto path.',
      autoBranch: true,
      writePaths: ['src']
    });
    assert.strictEqual(autoConflictRes.status, 409);
    assert.strictEqual(autoConflictRes.data.error.code, 'path_lease_conflict');

    const autoAssignmentId = autoAssignmentRes.data.assignment.id;
    const autoStartRes = await request(serverHandle.baseUrl, 'POST', `/orchestration/tasks/${taskId}/assignments/${autoAssignmentId}/start`, {
      rootSessionId: 'root-task-isolation',
      parentSessionId: 'root-task-isolation',
      originClient: 'test',
      externalSessionRef: 'test:task-isolation'
    });
    assert.strictEqual(autoStartRes.status, 200);
    assert.strictEqual(autoStartRes.data.assignment.branch.status, 'running');
    const autoWorktreePath = autoStartRes.data.assignment.worktreePath;
    const autoBranchName = autoStartRes.data.assignment.branch.branchName;
    assert.strictEqual(runGit(autoWorktreePath, ['branch', '--show-current']), autoBranchName);

    fs.mkdirSync(path.join(autoWorktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(autoWorktreePath, 'src', 'auto.js'), 'module.exports = 42;\n', 'utf8');
    runGit(autoWorktreePath, ['add', 'src/auto.js']);
    runGit(autoWorktreePath, ['commit', '-m', 'add auto branch file']);

    const acceptBranchRes = await request(
      serverHandle.baseUrl,
      'PATCH',
      `/orchestration/tasks/${taskId}/assignments/${autoAssignmentId}/branch`,
      {
        branchStatus: 'accepted',
        testStatus: 'passed',
        reviewStatus: 'approved',
        refresh: true
      }
    );
    assert.strictEqual(acceptBranchRes.status, 200);
    assert.strictEqual(acceptBranchRes.data.assignment.branch.status, 'accepted');
    assert.strictEqual(acceptBranchRes.data.assignment.branch.testStatus, 'passed');
    assert(acceptBranchRes.data.assignment.branch.headSha, 'accepted branch should record head sha');

    const integrateRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/tasks/${taskId}/assignments/${autoAssignmentId}/integrate`,
      {}
    );
    assert.strictEqual(integrateRes.status, 200);
    assert.strictEqual(integrateRes.data.assignment.branch.status, 'integrated');
    assert.strictEqual(integrateRes.data.assignment.status, 'completed');
    assert.strictEqual(integrateRes.data.assignment.branch.pathLease.status, 'released');
    assert(fs.existsSync(path.join(repoDir, 'src', 'auto.js')), 'integrated branch should merge into the primary workspace');

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
