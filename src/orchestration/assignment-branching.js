'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runGit(repoPath, args = []) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function tryRunGit(repoPath, args = []) {
  try {
    return runGit(repoPath, args);
  } catch {
    return null;
  }
}

function describeGitError(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  const stdout = error?.stdout ? String(error.stdout).trim() : '';
  return stderr || stdout || error?.message || 'unknown git error';
}

function resolveRepoRoot(workspaceRoot) {
  const trimmed = String(workspaceRoot || '').trim();
  if (!trimmed) {
    return null;
  }
  return tryRunGit(trimmed, ['rev-parse', '--show-toplevel']) || null;
}

function currentBranch(workspaceRoot) {
  const trimmed = String(workspaceRoot || '').trim();
  if (!trimmed) {
    return null;
  }
  return tryRunGit(trimmed, ['branch', '--show-current']) || null;
}

function headSha(workspaceRoot, ref = 'HEAD') {
  const trimmed = String(workspaceRoot || '').trim();
  if (!trimmed) {
    return null;
  }
  return tryRunGit(trimmed, ['rev-parse', ref]) || null;
}

function todayStamp(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
}

function slugifyBranchPart(value, fallback = 'work') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function shortId(value, fallback = 'task') {
  return slugifyBranchPart(String(value || '').replace(/^task[_-]?/, ''), fallback).slice(0, 16);
}

function normalizeWritePaths(value) {
  const rawPaths = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? value.split(',') : []);
  const normalized = [];
  for (const rawPath of rawPaths) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) {
      continue;
    }
    const normalizedPath = trimmed
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '');
    if (
      path.isAbsolute(normalizedPath)
      || normalizedPath === '..'
      || normalizedPath.startsWith('../')
      || normalizedPath.includes('/../')
    ) {
      throw new Error(`writePaths must be relative paths inside the workspace: ${trimmed}`);
    }
    if (!normalized.includes(normalizedPath || '.')) {
      normalized.push(normalizedPath || '.');
    }
  }
  return normalized.sort();
}

function buildDefaultBranchName({ task, role, now = Date.now() }) {
  const taskPart = shortId(task?.id, 'task');
  const rolePart = slugifyBranchPart(role, 'work');
  const titlePart = slugifyBranchPart(task?.title, 'assignment');
  return `task/${taskPart}-${rolePart}-${titlePart}-${todayStamp(now)}`;
}

function defaultWorktreePathForBranch(task, branchName) {
  const workspaceRoot = String(task?.workspaceRoot || '').trim();
  if (!workspaceRoot || !branchName) {
    return null;
  }
  const repoRoot = resolveRepoRoot(workspaceRoot);
  if (!repoRoot) {
    return null;
  }
  const safeBranch = branchName.replace(/[^a-zA-Z0-9._-]+/g, '__');
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`, safeBranch);
}

function shouldAllocateBranch(input = {}) {
  return input.autoBranch === true
    || input.auto_branch === true
    || input.branchName !== undefined
    || input.branch_name !== undefined
    || input.baseBranch !== undefined
    || input.base_branch !== undefined
    || input.mergeTarget !== undefined
    || input.merge_target !== undefined
    || input.writePaths !== undefined
    || input.write_paths !== undefined;
}

function buildAssignmentBranchPlan(task, input = {}, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const workspaceRoot = String(task?.workspaceRoot || '').trim() || null;
  const role = String(input.role || '').trim().toLowerCase() || 'work';
  const explicitBranch = String(input.branchName || input.branch_name || '').trim();
  const explicitWorktreeBranch = String(input.worktreeBranch || input.worktree_branch || '').trim();
  const branchName = explicitBranch || explicitWorktreeBranch || buildDefaultBranchName({ task, role, now });
  const baseBranch = String(input.baseBranch || input.base_branch || '').trim()
    || currentBranch(workspaceRoot)
    || 'main';
  const mergeTarget = String(input.mergeTarget || input.merge_target || '').trim() || baseBranch;
  const writePaths = normalizeWritePaths(input.writePaths ?? input.write_paths ?? []);
  const worktreePath = String(input.worktreePath || input.worktree_path || '').trim()
    || defaultWorktreePathForBranch(task, branchName);
  const baseSha = workspaceRoot ? headSha(workspaceRoot, baseBranch) || headSha(workspaceRoot, 'HEAD') : null;

  if (!worktreePath) {
    throw new Error('autoBranch requires a git workspaceRoot or an explicit worktreePath');
  }

  return {
    baseBranch,
    branchName,
    mergeTarget,
    worktreePath,
    worktreeBranch: explicitWorktreeBranch || branchName,
    writePaths,
    branchStatus: 'planned',
    baseSha
  };
}

function readBranchSnapshot(workspaceRoot, branchName) {
  const repoRoot = resolveRepoRoot(workspaceRoot);
  if (!repoRoot || !branchName) {
    return { repoRoot, exists: false, headSha: null };
  }
  const head = headSha(repoRoot, branchName);
  return {
    repoRoot,
    exists: Boolean(head),
    headSha: head
  };
}

function readDiffStats(workspaceRoot, baseRef, headRef) {
  const repoRoot = resolveRepoRoot(workspaceRoot);
  if (!repoRoot || !baseRef || !headRef) {
    return null;
  }
  const shortstat = tryRunGit(repoRoot, ['diff', '--shortstat', `${baseRef}..${headRef}`]) || '';
  const nameStatus = tryRunGit(repoRoot, ['diff', '--name-status', `${baseRef}..${headRef}`]) || '';
  return {
    shortstat,
    files: nameStatus
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, file] = line.split(/\s+/, 2);
        return { status, file };
      })
  };
}

function assertCleanWorkspace(repoRoot) {
  const status = tryRunGit(repoRoot, ['status', '--porcelain=v1']);
  if (status) {
    throw new Error(`merge target workspace has uncommitted changes: ${repoRoot}`);
  }
}

function integrateAssignmentBranch(task, assignment, options = {}) {
  const workspaceRoot = String(task?.workspaceRoot || '').trim();
  const branchName = String(assignment?.branchName || assignment?.worktreeBranch || '').trim();
  const targetBranch = String(options.mergeTarget || assignment?.mergeTarget || assignment?.baseBranch || '').trim();

  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required to integrate an assignment branch');
  }
  if (!branchName) {
    throw new Error('branchName or worktreeBranch is required to integrate an assignment branch');
  }
  if (!targetBranch) {
    throw new Error('mergeTarget or baseBranch is required to integrate an assignment branch');
  }

  const repoRoot = resolveRepoRoot(workspaceRoot);
  if (!repoRoot) {
    throw new Error(`Unable to resolve git repository root for ${workspaceRoot}`);
  }
  assertCleanWorkspace(repoRoot);

  const beforeSha = headSha(repoRoot, 'HEAD');
  const originalBranch = currentBranch(repoRoot);
  const branchHead = headSha(repoRoot, branchName);
  if (!branchHead) {
    throw new Error(`assignment branch does not exist: ${branchName}`);
  }

  try {
    runGit(repoRoot, ['checkout', targetBranch]);
    runGit(repoRoot, ['merge', '--no-ff', '--no-edit', branchName]);
    const afterSha = headSha(repoRoot, 'HEAD');
    const diffStats = readDiffStats(repoRoot, beforeSha, afterSha);
    return {
      repoRoot,
      targetBranch,
      branchName,
      originalBranch,
      beforeSha,
      branchHead,
      afterSha,
      diffStats
    };
  } catch (error) {
    throw new Error(`Failed to integrate assignment branch ${branchName} into ${targetBranch}: ${describeGitError(error)}`);
  }
}

module.exports = {
  buildAssignmentBranchPlan,
  integrateAssignmentBranch,
  normalizeWritePaths,
  readBranchSnapshot,
  readDiffStats,
  shouldAllocateBranch
};
