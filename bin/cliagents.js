#!/usr/bin/env node

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const wrapperPath = path.join(projectRoot, 'scripts', 'run-with-supported-node.js');
const args = [wrapperPath, 'src/index.js', ...process.argv.slice(2)];
const invocationCwd = process.cwd();

const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    CLIAGENTS_CALLER_CWD: invocationCwd
  },
  stdio: 'inherit'
});

if (result.error) {
  throw result.error;
}

process.exit(typeof result.status === 'number' ? result.status : 1);
