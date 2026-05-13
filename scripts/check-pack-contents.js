#!/usr/bin/env node

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function runPackDryRun() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm pack --dry-run failed');
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Unable to parse npm pack JSON output: ${error.message}\n${result.stdout}`);
  }
}

function isForbiddenPackedPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  const basename = parts[parts.length - 1];

  if (parts.includes('data') || parts.includes('logs')) {
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
  const packs = runPackDryRun();
  const entries = Array.isArray(packs) ? packs : [packs];
  const files = entries.flatMap((entry) => Array.isArray(entry.files) ? entry.files : []);
  const forbidden = files
    .map((file) => file.path)
    .filter(isForbiddenPackedPath);

  if (forbidden.length > 0) {
    console.error('npm pack would include forbidden local artifacts:');
    for (const filePath of forbidden) {
      console.error(`- ${filePath}`);
    }
    process.exit(1);
  }

  console.log(`✅ npm pack dry-run contents are release-safe (${files.length} files checked)`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
