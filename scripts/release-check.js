#!/usr/bin/env node

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const steps = [
  ['git diff whitespace/conflict-marker check', 'git', ['diff', '--check']],
  ['canonical docs map check', process.execPath, ['scripts/check-canonical-map.js']],
  ['focused broker suite', process.execPath, ['scripts/run-with-supported-node.js', 'tests/test-focused-surface.js']],
  ['auth fail-closed suite', process.execPath, ['scripts/run-with-supported-node.js', 'tests/test-auth-fail-closed.js']],
  ['runtime consistency suite', process.execPath, ['scripts/run-with-supported-node.js', 'tests/test-runtime-consistency.js']],
  ['npm pack content allowlist', process.execPath, ['scripts/check-pack-contents.js']],
  ['tracked artifact audit', process.execPath, ['scripts/check-tracked-artifacts.js']],
  ['production dependency audit', 'pnpm', ['audit', '--prod']]
];

function runStep([label, command, args]) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function main() {
  for (const step of steps) {
    runStep(step);
  }
  console.log('\n✅ release:check passed');
}

try {
  main();
} catch (error) {
  console.error(`\nrelease:check failed: ${error.message || String(error)}`);
  process.exit(1);
}
