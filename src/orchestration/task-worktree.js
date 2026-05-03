'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runGit(args = [], options = {}) {
  const output = execFileSync('git', args, {
    cwd: options.cwd || undefined,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return String(output || '').trim();
}

function tryRunGit(args = [], options = {}) {
  try {
    return runGit(args, options);
  } catch {
    return null;
  }
}

function branchExists(repoRoot, branchName) {
  if (!repoRoot || !branchName) {
    return false;
  }

  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', branchName], {
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

function resolveRequestedWorktreePath(workspaceRoot, requestedPath) {
  const trimmed = String(requestedPath || '').trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  return path.resolve(workspaceRoot || process.cwd(), trimmed);
}

function buildIsolationMetadata(existingMetadata, isolationPatch) {
  const metadata = existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
    ? { ...existingMetadata }
    : {};
  const previousIsolation = metadata.isolation && typeof metadata.isolation === 'object' && !Array.isArray(metadata.isolation)
    ? metadata.isolation
    : {};

  metadata.isolation = {
    ...previousIsolation,
    ...isolationPatch
  };

  return metadata;
}

function prepareTaskAssignmentWorktree(task, assignment) {
  const workspaceRoot = String(task?.workspaceRoot || '').trim() || null;
  const requestedPath = String(assignment?.worktreePath || '').trim() || null;
  const requestedBranch = String(assignment?.worktreeBranch || '').trim() || null;

  if (!requestedPath) {
    return {
      workingDirectory: workspaceRoot,
      worktreePath: null,
      worktreeBranch: null,
      metadata: assignment?.metadata || {},
      isolation: null
    };
  }

  const resolvedWorktreePath = resolveRequestedWorktreePath(workspaceRoot, requestedPath);
  if (!resolvedWorktreePath) {
    throw new Error('Unable to resolve worktree path');
  }

  if (fs.existsSync(resolvedWorktreePath) && !fs.statSync(resolvedWorktreePath).isDirectory()) {
    throw new Error(`worktreePath exists but is not a directory: ${resolvedWorktreePath}`);
  }

  if (fs.existsSync(resolvedWorktreePath)) {
    const currentBranch = tryRunGit(['-C', resolvedWorktreePath, 'branch', '--show-current']) || requestedBranch || null;
    const repoRoot = tryRunGit(['-C', resolvedWorktreePath, 'rev-parse', '--show-toplevel'])
      || (workspaceRoot ? tryRunGit(['-C', workspaceRoot, 'rev-parse', '--show-toplevel']) : null)
      || workspaceRoot;
    const metadata = buildIsolationMetadata(assignment?.metadata || {}, {
      mode: 'git_worktree',
      repoRoot,
      worktreePath: resolvedWorktreePath,
      branch: currentBranch,
      preparedAt: Date.now(),
      preparedBy: 'start_task_assignment',
      created: false
    });

    return {
      workingDirectory: resolvedWorktreePath,
      worktreePath: resolvedWorktreePath,
      worktreeBranch: currentBranch,
      metadata,
      isolation: metadata.isolation
    };
  }

  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required to prepare assignment worktree isolation');
  }

  const repoRoot = runGit(['-C', workspaceRoot, 'rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    throw new Error(`Unable to resolve git repository root for ${workspaceRoot}`);
  }

  let created = false;
  if (!fs.existsSync(resolvedWorktreePath)) {
    if (!requestedBranch) {
      throw new Error('worktreeBranch is required when preparing a missing worktree path');
    }

    fs.mkdirSync(path.dirname(resolvedWorktreePath), { recursive: true });
    const addArgs = ['-C', repoRoot, 'worktree', 'add'];
    if (!branchExists(repoRoot, requestedBranch)) {
      addArgs.push('-b', requestedBranch);
      addArgs.push(resolvedWorktreePath, 'HEAD');
    } else {
      addArgs.push(resolvedWorktreePath, requestedBranch || 'HEAD');
    }
    runGit(addArgs);
    created = true;
  }
  const currentBranch = tryRunGit(['-C', resolvedWorktreePath, 'branch', '--show-current']) || requestedBranch || null;
  const metadata = buildIsolationMetadata(assignment?.metadata || {}, {
    mode: 'git_worktree',
    repoRoot,
    worktreePath: resolvedWorktreePath,
    branch: currentBranch,
    preparedAt: Date.now(),
    preparedBy: 'start_task_assignment',
    created
  });

  return {
    workingDirectory: resolvedWorktreePath,
    worktreePath: resolvedWorktreePath,
    worktreeBranch: currentBranch,
    metadata,
    isolation: metadata.isolation
  };
}

module.exports = {
  prepareTaskAssignmentWorktree
};
