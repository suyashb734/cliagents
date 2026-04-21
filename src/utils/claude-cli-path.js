'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_CLI_PATH_ENV_VARS = ['CLIAGENTS_CLAUDE_PATH', 'CLAUDE_CODE_PATH'];

function normalizeCandidatePath(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getConfiguredClaudeCliPath(options = {}) {
  const configuredPath = normalizeCandidatePath(options.claudePath);
  if (configuredPath) {
    return configuredPath;
  }

  for (const envVar of CLAUDE_CLI_PATH_ENV_VARS) {
    const envPath = normalizeCandidatePath(process.env[envVar]);
    if (envPath) {
      return envPath;
    }
  }

  return null;
}

function getClaudeCliCandidatePaths() {
  const homeDir = process.env.HOME || os.homedir() || '';
  return [
    path.join(path.dirname(process.execPath), 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    path.join(homeDir, '.npm-global', 'bin', 'claude'),
    path.join(homeDir, 'node_modules', '.bin', 'claude')
  ];
}

function resolveClaudeCliPath(options = {}) {
  const configuredPath = getConfiguredClaudeCliPath(options);
  if (configuredPath) {
    return configuredPath;
  }

  try {
    const whichResult = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    }).trim();
    if (whichResult) {
      return whichResult;
    }
  } catch {
    // Fall through to common install paths.
  }

  for (const candidatePath of getClaudeCliCandidatePaths()) {
    if (candidatePath && fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return options.fallbackToBareCommand === false ? null : 'claude';
}

module.exports = {
  CLAUDE_CLI_PATH_ENV_VARS,
  getConfiguredClaudeCliPath,
  getClaudeCliCandidatePaths,
  resolveClaudeCliPath
};
