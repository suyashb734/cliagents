#!/usr/bin/env node

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const ALLOWED_BRANCHES = [
  /^main$/,
  /^develop$/,
  /^release\/[a-z0-9][a-z0-9._-]*$/,
  /^feature\/[a-z0-9][a-z0-9._-]*$/,
  /^fix\/[a-z0-9][a-z0-9._-]*$/,
  /^docs\/[a-z0-9][a-z0-9._-]*$/,
  /^task\/[a-z0-9][a-z0-9._-]*-\d{8}$/,
  /^research\/[a-z0-9][a-z0-9._-]*$/,
  /^safety\/[a-z0-9][a-z0-9._-]*-\d{8}$/,
  /^chore\/[a-z0-9][a-z0-9._-]*$/
];

const WEAK_SLUG_PATTERNS = [
  /(^|[-_.])(wip|misc|temp|tmp|stuff|changes|integration|cleanup)([-_.]|$)/
];

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  });
  if (options.allowFailure) {
    return result;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function getBranchName() {
  const branch = git(['branch', '--show-current'], { allowFailure: true });
  const name = branch.stdout.trim();
  if (name) {
    return name;
  }
  if (process.env.GITHUB_HEAD_REF) {
    return process.env.GITHUB_HEAD_REF;
  }
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  return '';
}

function hasMain() {
  const result = git(['rev-parse', '--verify', 'main'], { allowFailure: true });
  return result.status === 0;
}

function countRevs(range) {
  const result = git(['rev-list', '--count', range], { allowFailure: true });
  if (result.status !== 0) {
    return null;
  }
  return Number(result.stdout.trim());
}

function main() {
  const branch = getBranchName();
  const errors = [];
  const warnings = [];

  if (!branch) {
    errors.push('detached HEAD or unknown branch; create or check out a named branch before non-trivial work');
  } else if (!ALLOWED_BRANCHES.some((pattern) => pattern.test(branch))) {
    errors.push(`branch "${branch}" does not match allowed branch patterns`);
  }

  if (branch.length > 80) {
    errors.push(`branch "${branch}" is too long; keep names at or below 80 characters`);
  }

  if (WEAK_SLUG_PATTERNS.some((pattern) => pattern.test(branch))) {
    warnings.push(`branch "${branch}" uses a weak slug; prefer a specific outcome name`);
  }

  const status = git(['status', '--short']);
  if (status) {
    warnings.push('working tree has uncommitted changes');
  }

  let ahead = null;
  let behind = null;
  if (branch && branch !== 'main' && hasMain()) {
    ahead = countRevs(`main..${branch}`);
    behind = countRevs(`${branch}..main`);
  }

  console.log(`Branch: ${branch || '(detached)'}`);
  if (ahead !== null && behind !== null) {
    console.log(`Compared with main: ahead ${ahead}, behind ${behind}`);
  }

  if (status) {
    console.log('\nUncommitted changes:');
    console.log(status);
  }

  if (warnings.length) {
    console.log('\nWarnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (errors.length) {
    console.error('\nBranch hygiene failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    console.error('\nSee docs/reference/BRANCH-MANAGEMENT.md for branch roles and naming rules.');
    process.exit(1);
  }

  console.log('\nBranch hygiene check passed');
}

try {
  main();
} catch (error) {
  console.error(`Branch hygiene check failed: ${error.message || String(error)}`);
  process.exit(1);
}
