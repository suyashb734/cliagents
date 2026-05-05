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

function describeGitError(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  const stdout = error?.stdout ? String(error.stdout).trim() : '';
  return stderr || stdout || error?.message || 'unknown git error';
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

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathExists(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    return path.resolve(targetPath);
  }
}

function resolvePhysicalPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const parts = resolved.split(path.sep).filter(Boolean);
  let cursor = path.isAbsolute(resolved) ? path.sep : '';
  const missingParts = [];
  let foundMissing = false;

  for (const part of parts) {
    if (foundMissing) {
      missingParts.push(part);
      continue;
    }

    const next = path.join(cursor, part);
    if (pathExists(next)) {
      cursor = next;
      continue;
    }
    foundMissing = true;
    missingParts.push(part);
  }

  const physicalCursor = safeRealpath(cursor || resolved);
  return missingParts.length > 0
    ? path.join(physicalCursor, ...missingParts)
    : physicalCursor;
}

function resolveRepoRoot(workspaceRoot) {
  try {
    const repoRoot = runGit(['-C', workspaceRoot, 'rev-parse', '--show-toplevel']);
    if (!repoRoot) {
      throw new Error(`Unable to resolve git repository root for ${workspaceRoot}`);
    }
    return path.resolve(repoRoot);
  } catch (error) {
    throw new Error(`Unable to resolve git repository root for ${workspaceRoot}: ${describeGitError(error)}`);
  }
}

function tryResolveRepoRoot(workspaceRoot) {
  try {
    return resolveRepoRoot(workspaceRoot);
  } catch {
    return null;
  }
}

function buildAllowedWorktreeRoots(workspaceRoot, repoRoot) {
  const roots = [];
  const addRoot = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return;
    }
    const resolved = path.resolve(trimmed);
    if (!roots.includes(resolved)) {
      roots.push(resolved);
    }
  };

  addRoot(workspaceRoot);

  if (repoRoot) {
    addRoot(path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`));
  }

  addRoot(process.env.CLIAGENTS_WORKTREE_ROOT);
  return roots;
}

function assertInsideAllowedWorktreeRoots(resolvedPath, allowedRoots) {
  const normalizedPath = resolvePhysicalPath(resolvedPath);
  const normalizedRoots = allowedRoots.map((root) => resolvePhysicalPath(root));
  if (normalizedRoots.some((root) => isPathInside(normalizedPath, root))) {
    return path.resolve(resolvedPath);
  }

  throw new Error(
    `worktreePath must be inside an allowed worktree root: ${normalizedRoots.join(', ')}`
  );
}

function resolveRequestedWorktreePath(workspaceRoot, requestedPath, allowedRoots = []) {
  const trimmed = String(requestedPath || '').trim();
  if (!trimmed) {
    return null;
  }

  const resolvedPath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceRoot || process.cwd(), trimmed);

  return assertInsideAllowedWorktreeRoots(resolvedPath, allowedRoots);
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

  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required to prepare assignment worktree isolation');
  }

  let repoRoot = tryResolveRepoRoot(workspaceRoot);
  const allowedRoots = buildAllowedWorktreeRoots(workspaceRoot, repoRoot);
  const resolvedWorktreePath = resolveRequestedWorktreePath(workspaceRoot, requestedPath, allowedRoots);
  if (!resolvedWorktreePath) {
    throw new Error('Unable to resolve worktree path');
  }

  const existingWorktreeStat = pathExists(resolvedWorktreePath);
  if (existingWorktreeStat) {
    const realWorktreePath = safeRealpath(resolvedWorktreePath);
    assertInsideAllowedWorktreeRoots(realWorktreePath, allowedRoots.map(safeRealpath));
    if (!existingWorktreeStat.isDirectory()) {
      throw new Error(`worktreePath exists but is not a directory: ${resolvedWorktreePath}`);
    }

    const currentBranch = tryRunGit(['-C', resolvedWorktreePath, 'branch', '--show-current']) || requestedBranch || null;
    const existingRepoRoot = tryRunGit(['-C', resolvedWorktreePath, 'rev-parse', '--show-toplevel']) || repoRoot || workspaceRoot;
    const metadata = buildIsolationMetadata(assignment?.metadata || {}, {
      mode: 'git_worktree',
      repoRoot: existingRepoRoot,
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

  let created = false;
  if (!pathExists(resolvedWorktreePath)) {
    if (!requestedBranch) {
      throw new Error('worktreeBranch is required when preparing a missing worktree path');
    }
    if (!repoRoot) {
      repoRoot = resolveRepoRoot(workspaceRoot);
    }

    const parentPath = path.dirname(resolvedWorktreePath);
    assertInsideAllowedWorktreeRoots(parentPath, allowedRoots);
    const parentExisted = !!pathExists(parentPath);
    fs.mkdirSync(parentPath, { recursive: true });
    const addArgs = ['-C', repoRoot, 'worktree', 'add'];
    if (!branchExists(repoRoot, requestedBranch)) {
      addArgs.push('-b', requestedBranch);
      addArgs.push(resolvedWorktreePath, 'HEAD');
    } else {
      addArgs.push(resolvedWorktreePath, requestedBranch || 'HEAD');
    }
    try {
      runGit(addArgs);
    } catch (error) {
      if (!parentExisted) {
        fs.rmSync(parentPath, { recursive: true, force: true });
      }
      throw new Error(`Failed to prepare assignment worktree at ${resolvedWorktreePath}: ${describeGitError(error)}`);
    }
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
