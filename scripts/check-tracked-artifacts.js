#!/usr/bin/env node

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function runGitLsFiles() {
  const result = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git ls-files failed');
  }

  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function isForbiddenTrackedPath(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const parts = normalized.split('/');
  const basename = parts[parts.length - 1];

  if (parts.includes('node_modules')) {
    return false;
  }
  if (parts[0] === 'data' || parts[0] === 'logs') {
    return true;
  }
  if (basename === '.env') {
    return true;
  }
  if (/^\.env\.(?!example$).+/.test(basename)) {
    return true;
  }
  if (basename === 'local-api-key') {
    return true;
  }
  if (/^(token|tokens|.*[-_.]token|.*[-_.]tokens)$/i.test(basename)) {
    return true;
  }
  if (/\.(db|sqlite|sqlite3|db-wal|db-shm|log)$/i.test(basename)) {
    return true;
  }

  return false;
}

function main() {
  const files = runGitLsFiles();
  const forbidden = files.filter(isForbiddenTrackedPath);

  if (forbidden.length > 0) {
    console.error('Tracked local artifacts are not allowed in a public alpha release:');
    for (const filePath of forbidden) {
      console.error(`- ${filePath}`);
    }
    process.exit(1);
  }

  console.log('✅ No tracked local data, logs, DBs, .env files, or token artifacts found');
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
