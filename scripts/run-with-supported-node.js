#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const fallbackSupportedRange = '>=20 <25';
const args = process.argv.slice(2);
const nodeArgs = [];
const callerCwd = typeof process.env.CLIAGENTS_CALLER_CWD === 'string' && process.env.CLIAGENTS_CALLER_CWD.trim()
  ? path.resolve(process.env.CLIAGENTS_CALLER_CWD)
  : null;

while (args[0] && args[0].startsWith('--node-arg=')) {
  nodeArgs.push(args.shift().slice('--node-arg='.length));
}

const script = args.shift();

if (!script) {
  console.error('[cliagents] Missing script path.');
  console.error('Usage: node scripts/run-with-supported-node.js [--node-arg=--watch] <script> [...args]');
  process.exit(1);
}

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/, '');
}

function isFallbackSupported(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  return Number.isFinite(major) && major >= 20 && major < 25;
}

function isExactVersion(version, expectedVersion) {
  return normalizeVersion(version) === normalizeVersion(expectedVersion);
}

function getPreferredNodeBinary() {
  const nvmrcPath = path.join(projectRoot, '.nvmrc');
  if (!fs.existsSync(nvmrcPath)) {
    return null;
  }

  const preferredVersion = normalizeVersion(fs.readFileSync(nvmrcPath, 'utf8'));
  if (!preferredVersion) {
    return null;
  }

  const home = process.env.HOME;
  if (!home) {
    return null;
  }

  const binary = path.join(home, '.nvm', 'versions', 'node', `v${preferredVersion}`, 'bin', 'node');
  if (!fs.existsSync(binary)) {
    return { preferredVersion, binary: null };
  }

  return { preferredVersion, binary };
}

function run(nodeBinary) {
  const targetScript = path.isAbsolute(script)
    ? script
    : path.join(projectRoot, script);
  const targetArgs = [...nodeArgs, targetScript, ...args];
  const result = spawnSync(nodeBinary, targetArgs, {
    stdio: 'inherit',
    cwd: callerCwd || projectRoot,
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

const preferred = getPreferredNodeBinary();

if (preferred?.preferredVersion && isExactVersion(process.version, preferred.preferredVersion)) {
  run(process.execPath);
}

if (preferred?.binary) {
  console.warn(
    `[cliagents] Re-executing with supported Node v${preferred.preferredVersion} (current ${process.version}).`
  );
  run(preferred.binary);
}

if (preferred?.preferredVersion) {
  console.error(`[cliagents] Unsupported Node ${process.version}. Supported version: ${preferred.preferredVersion}.`);
  console.error(`[cliagents] Install/use Node v${preferred.preferredVersion} and retry.`);
  console.error(`[cliagents] Tip: nvm use ${preferred.preferredVersion}`);
  process.exit(1);
}

if (isFallbackSupported()) {
  run(process.execPath);
}

console.error(`[cliagents] Unsupported Node ${process.version}. Supported versions: ${fallbackSupportedRange}.`);
process.exit(1);
