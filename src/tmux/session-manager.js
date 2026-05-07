/**
 * PersistentSessionManager - Manages persistent CLI sessions via tmux
 *
 * This manager creates long-running tmux sessions for CLI agents,
 * enabling multi-agent orchestration with message passing and status tracking.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const TmuxClient = require('./client');
const { MANAGED_ROOT_ADAPTERS } = require('../adapters/active-surface');
const GeminiCliAdapter = require('../adapters/gemini-cli');
const { isCollaboratorReadyAdapter } = require('../orchestration/child-session-support');
const { getModelRoutingService } = require('../services/model-routing');
const { resolveClaudeCliPath } = require('../utils/claude-cli-path');
const { extractOutput, stripAnsiCodes } = require('../utils/output-extractor');
const {
  RUNTIME_HOSTS,
  RUNTIME_FIDELITY,
  resolveRuntimeHostMetadata
} = require('../runtime/host-model');

const inferGeminiBrokerDefaultModel = GeminiCliAdapter.inferGeminiBrokerDefaultModel;
const TRACKED_RUN_INLINE_COMMAND_MAX_LENGTH = 400;
const TRACKED_RUN_SCRIPT_ROOT = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'cliagents-tracked-run-scripts')
  : '/tmp/cliagents-tracked-run-scripts';

function parseSessionMetadata(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return rawValue || null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

/**
 * SECURITY: Escape a string for use in shell double quotes
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeForDoubleQuotes(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\\/g, '\\\\')     // Backslashes first
    .replace(/"/g, '\\"')       // Double quotes
    .replace(/\$/g, '\\$')      // Dollar signs (variable expansion)
    .replace(/`/g, '\\`')       // Backticks (command substitution)
    .replace(/!/g, '\\!')       // History expansion
    .replace(/\n/g, '\\n')      // Newlines
    .replace(/\r/g, '\\r');     // Carriage returns
}

/**
 * SECURITY: Validate a path doesn't contain dangerous characters
 * @param {string} pathStr - Path to validate
 * @returns {boolean} - Whether the path is safe
 */
function isPathSafe(pathStr) {
  if (typeof pathStr !== 'string') return false;
  // Disallow command substitution, shell metacharacters
  const dangerousPatterns = [
    /\$\(/,       // Command substitution $(...)
    /`/,          // Backtick substitution
    /;/,          // Command separator
    /\|/,         // Pipe
    /&/,          // Background/AND
    /\n/,         // Newlines
    /\r/,         // Carriage returns
    /\0/,         // Null bytes
  ];
  return !dangerousPatterns.some(pattern => pattern.test(pathStr));
}

/**
 * Generate a 32-character terminal ID (128-bit entropy)
 */
function generateTerminalId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a short run identifier for tracked one-shot orchestration commands.
 */
function generateRunId() {
  return crypto.randomBytes(8).toString('hex');
}

const SAFE_TMUX_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MIN_ORPHANED_LOG_TAIL_BYTES = 5000;
const MAX_ORPHANED_LOG_TAIL_BYTES = 50000;
const DEFAULT_MANAGED_ROOT_STARTUP_DELAY_MS = 1500;
const DEFAULT_WORKER_STARTUP_DELAY_MS = 250;
const DEFAULT_DEFERRED_PROVIDER_ATTACH_TIMEOUT_MS = 20000;
const DEFERRED_PROVIDER_ATTACH_POLL_INTERVAL_MS = 150;
const DEFAULT_POST_ATTACH_PROVIDER_START_DELAY_MS = 120;
const DEFAULT_CODEX_ORCHESTRATION_MODEL = process.env.CLIAGENTS_CODEX_ORCHESTRATION_MODEL || 'gpt-5.4';
const ENABLE_STATUS_DEBUG_LOGS = process.env.CLIAGENTS_STATUS_DEBUG === '1';

const BROKER_MODEL_ALIASES = Object.freeze({
  'claude-code': Object.freeze({
    opus: 'claude-opus-4-7',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5'
  }),
  'codex-cli': Object.freeze({
    gpt5: 'gpt-5.5',
    gpt5mini: 'gpt-5.4-mini',
    codex: 'gpt-5.5',
    codexmini: 'gpt-5.4-mini'
  })
});

function hashSessionShape(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function summarizeMessage(content, maxLength = 120) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeTerminalOutputOptions(linesOrOptions, maybeOptions = null) {
  if (linesOrOptions && typeof linesOrOptions === 'object' && !Array.isArray(linesOrOptions)) {
    return {
      lines: Number.isFinite(linesOrOptions.lines) ? linesOrOptions.lines : 200,
      mode: String(linesOrOptions.mode || 'history').trim().toLowerCase() === 'visible' ? 'visible' : 'history',
      format: String(linesOrOptions.format || 'plain').trim().toLowerCase() === 'ansi' ? 'ansi' : 'plain'
    };
  }

  const merged = maybeOptions && typeof maybeOptions === 'object'
    ? maybeOptions
    : {};
  return {
    lines: Number.isFinite(linesOrOptions) ? linesOrOptions : 200,
    mode: String(merged.mode || 'history').trim().toLowerCase() === 'visible' ? 'visible' : 'history',
    format: String(merged.format || 'plain').trim().toLowerCase() === 'ansi' ? 'ansi' : 'plain'
  };
}

function summarizeTerminalActivity(content, maxLength = 240) {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return '';
  }

  const bestLine = lines[lines.length - 1];
  if (bestLine.length <= maxLength) {
    return bestLine;
  }
  return `${bestLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildTerminalBusyError(terminalId, status) {
  const currentStatus = String(status || TerminalStatus.PROCESSING);
  const error = new Error(
    `Terminal ${terminalId} is busy (${currentStatus}). Wait for it to finish before sending more input.`
  );
  error.code = 'terminal_busy';
  error.statusCode = 409;
  error.terminalId = terminalId;
  error.terminalStatus = currentStatus;
  error.retryAfterMs = 1000;
  return error;
}

/**
 * Terminal status enum
 */
const TerminalStatus = {
  IDLE: 'idle',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  WAITING_PERMISSION: 'waiting_permission',
  WAITING_USER_ANSWER: 'waiting_user_answer',
  ERROR: 'error'
};

const SUPPORTED_ORCHESTRATION_ADAPTERS = new Set(MANAGED_ROOT_ADAPTERS);

function resolveGeminiCommandModel(model) {
  if (model && model !== 'default') {
    return model;
  }
  return inferGeminiBrokerDefaultModel() || null;
}

function resolveCodexOneShotModel(model) {
  const normalizedModel = normalizeBrokerModelAlias('codex-cli', model);
  if (normalizedModel && normalizedModel !== 'default') {
    return normalizedModel;
  }
  return DEFAULT_CODEX_ORCHESTRATION_MODEL || null;
}

function normalizeBrokerModelAlias(adapter, model) {
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) {
    return null;
  }
  const aliases = BROKER_MODEL_ALIASES[adapter] || null;
  return aliases?.[normalizedModel.toLowerCase()] || normalizedModel;
}

function resolveTerminalModel(adapter, role, sessionKind, model) {
  const normalizedModel = normalizeBrokerModelAlias(adapter, model);
  if (adapter === 'codex-cli' && (role === 'worker' || sessionKind === 'child')) {
    return resolveCodexOneShotModel(normalizedModel);
  }
  return normalizedModel || null;
}

function normalizeUuid(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
    return trimmed;
  }

  const compact = trimmed.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/.test(compact)) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }

  return null;
}

const SAFE_PROVIDER_THREAD_REF_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function normalizeProviderThreadRef(adapter, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  if (adapter === 'claude-code' || adapter === 'gemini-cli') {
    return normalizeUuid(trimmed);
  }

  if (SAFE_PROVIDER_THREAD_REF_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function getLastMatchValue(text, regex) {
  const matches = [...String(text || '').matchAll(regex)];
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1][1] || null;
}

function normalizeReportedModelId(adapter, value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 160) {
    return null;
  }

  const stripped = raw
    .replace(/^models\//, '')
    .replace(/^[`"']+|[`"'.,;:]+$/g, '')
    .trim();
  if (!stripped || stripped.toLowerCase() === 'default' || stripped.toLowerCase() === 'unknown') {
    return null;
  }

  const normalized = normalizeBrokerModelAlias(adapter, stripped);
  if (!/^[A-Za-z0-9._:@/-]+$/.test(normalized)) {
    return null;
  }

  if (adapter === 'codex-cli') {
    return /^(?:gpt-|o\d|codex-)/i.test(normalized) ? normalized : null;
  }
  if (adapter === 'claude-code') {
    return /^claude-/i.test(normalized) ? normalized : null;
  }
  if (adapter === 'gemini-cli') {
    return /^gemini-/i.test(normalized) ? normalized : null;
  }
  if (adapter === 'qwen-cli') {
    return /^(?:qwen|openrouter\/qwen|opencode-go\/qwen)/i.test(normalized) ? normalized : null;
  }
  if (adapter === 'opencode-cli') {
    return /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:@/-]+$/.test(normalized)
      || /^(?:minimax|qwen|glm|kimi|deepseek|claude|gemini)/i.test(normalized)
      ? normalized
      : null;
  }

  return normalized;
}

function collectReportedModelCandidates(adapter, value, candidates = []) {
  if (value == null) {
    return candidates;
  }

  if (typeof value === 'string') {
    const normalized = normalizeReportedModelId(adapter, value);
    if (normalized) {
      candidates.push(normalized);
    }
    return candidates;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReportedModelCandidates(adapter, entry, candidates);
    }
    return candidates;
  }

  if (typeof value !== 'object') {
    return candidates;
  }

  for (const key of ['model', 'modelId', 'model_id', 'selectedModel', 'selected_model', 'effectiveModel', 'effective_model']) {
    collectReportedModelCandidates(adapter, value[key], candidates);
  }

  for (const key of ['modelUsage', 'models']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
      for (const modelId of Object.keys(value[key])) {
        collectReportedModelCandidates(adapter, modelId, candidates);
      }
    }
  }

  for (const key of ['usage', 'stats', 'metadata', 'responseMetadata', 'result']) {
    if (value[key] && typeof value[key] === 'object') {
      collectReportedModelCandidates(adapter, value[key], candidates);
    }
  }

  return candidates;
}

function parseJsonObjectsFromOutput(output) {
  const objects = [];
  const lines = String(output || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      continue;
    }
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON terminal noise.
    }
  }
  return objects;
}

function inferEffectiveModelFromOutput(adapter, output) {
  const source = String(output || '');
  if (!source.trim()) {
    return null;
  }

  const candidates = [];
  for (const object of parseJsonObjectsFromOutput(source)) {
    collectReportedModelCandidates(adapter, object, candidates);
  }

  const regexes = [
    /"model"\s*:\s*"([^"]+)"/g,
    /"model_id"\s*:\s*"([^"]+)"/g,
    /"modelId"\s*:\s*"([^"]+)"/g,
    /"modelUsage"\s*:\s*\{\s*"([^"]+)"/g,
    /"models"\s*:\s*\{\s*"([^"]+)"/g,
    /\bmodel:\s*([A-Za-z0-9._:@/-]+)/gi,
    /│\s*model:\s*([A-Za-z0-9._:@/-]+)/gi,
    /\b([A-Za-z0-9._:-]+\/(?:claude|gemini|qwen|glm|kimi|deepseek|minimax)[A-Za-z0-9._:@/-]*)\b/gi
  ];
  for (const regex of regexes) {
    for (const match of source.matchAll(regex)) {
      collectReportedModelCandidates(adapter, match[1], candidates);
    }
  }

  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function hasTrackedRunStartMarker(text, runId) {
  if (!text || !runId) {
    return false;
  }

  const pattern = new RegExp(`(?:^|\\n)__CLIAGENTS_RUN_START__${runId}(?=\\n|$)`);
  return pattern.test(String(text));
}

function matchTrackedRunExitMarker(text, exitMarkerPrefix) {
  if (!text || !exitMarkerPrefix) {
    return null;
  }

  const pattern = new RegExp(`(?:^|\\n)${exitMarkerPrefix}(\\d+)(?=\\n|$)`);
  return String(text).match(pattern);
}

function extractLatestTrackedRun(text) {
  const source = String(text || '');
  if (!source) {
    return null;
  }

  const startMatches = [...source.matchAll(/__CLIAGENTS_RUN_START__([a-f0-9]{16})/g)];
  if (startMatches.length === 0) {
    return null;
  }

  const startMatch = startMatches[startMatches.length - 1];
  const runId = startMatch[1];
  const startMarker = `__CLIAGENTS_RUN_START__${runId}`;
  const exitMarkerPrefix = `__CLIAGENTS_RUN_EXIT__${runId}__`;
  const exitMatches = [...source.matchAll(new RegExp(`${exitMarkerPrefix}(\\d+)`, 'g'))];
  const exitMatch = exitMatches.length > 0 ? exitMatches[exitMatches.length - 1] : null;

  return {
    runId,
    startMarker,
    exitMarkerPrefix,
    startIndex: startMatch.index || 0,
    exitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null
  };
}

function isShellContinuationPrompt(line) {
  const normalized = String(line || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /^(?:dquote|quote|bquote|cmdsubst|heredoc|for|while|if|else|select|case|arith|subsh)>\s*$/.test(normalized);
}

function isShellProcessCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return ['zsh', 'bash', 'sh', 'fish', 'login', 'tmux'].includes(normalized);
}

function extractProviderThreadRefFromOutput(adapter, output, detector = null) {
  const text = String(output || '');
  if (!text) {
    return null;
  }

  const explicitMarker = getLastMatchValue(text, /__CLIAGENTS_PROVIDER_SESSION__([^\s]+)/g);
  if (explicitMarker) {
    return normalizeProviderThreadRef(adapter, explicitMarker);
  }

  switch (adapter) {
    case 'claude-code': {
      const fromDetector = typeof detector?.extractSessionId === 'function'
        ? detector.extractSessionId(text)
        : null;
      const sessionId = fromDetector || getLastMatchValue(text, /"session[_-]?id"\s*:\s*"([^"]+)"/gi);
      return normalizeProviderThreadRef(adapter, sessionId);
    }
    case 'codex-cli':
      return normalizeProviderThreadRef(adapter, getLastMatchValue(text, /"thread_id"\s*:\s*"([^"]+)"/g));
    case 'qwen-cli':
      return normalizeProviderThreadRef(adapter, getLastMatchValue(text, /"session_id"\s*:\s*"([^"]+)"/g));
    case 'opencode-cli':
      return normalizeProviderThreadRef(adapter, getLastMatchValue(text, /"sessionID"\s*:\s*"([^"]+)"/g));
    case 'gemini-cli': {
      const sessionId = getLastMatchValue(text, /"session[_-]?id"\s*:\s*"([^"]+)"/gi);
      return normalizeProviderThreadRef(adapter, sessionId);
    }
    default:
      return null;
  }
}

function escapeForSingleQuotes(str) {
  return String(str || '').replace(/'/g, "'\\''");
}

function buildFirstTurnPrompt(message, terminal) {
  const messageCount = Number.isInteger(terminal?.messageCount) ? terminal.messageCount : 0;
  if (!messageCount && terminal?.systemPrompt) {
    return `${terminal.systemPrompt}\n\n${message}`;
  }
  return message;
}

function supportsManagedRootSessionBinding(adapter) {
  return adapter === 'claude-code' || adapter === 'qwen-cli';
}

function resolveCodexResumeSessionId(options = {}) {
  const directSessionId = String(options.resumeSessionId || '').trim();
  if (directSessionId && /^[A-Za-z0-9._:-]+$/.test(directSessionId)) {
    return directSessionId;
  }

  const resumeCommand = String(options.resumeCommand || '').trim();
  const commandMatch = resumeCommand.match(/^codex\s+resume\s+([A-Za-z0-9._:-]+)/i);
  if (commandMatch) {
    return String(commandMatch[1] || '').trim() || null;
  }

  return null;
}

function resolveProviderResumeSessionId(adapter, options = {}) {
  if (adapter === 'codex-cli') {
    return resolveCodexResumeSessionId(options);
  }

  const directSessionId = String(options.resumeSessionId || '').trim();
  if (directSessionId && /^[A-Za-z0-9._:-]+$/.test(directSessionId)) {
    return directSessionId;
  }

  return null;
}

function buildGeminiOneShotRunnerCommand(message, terminal) {
  const runnerPath = path.join(__dirname, '../scripts/run-gemini-oneshot.js');
  const workDir = terminal.workDir || process.cwd();
  const resolvedModel = resolveGeminiCommandModel(terminal.model);
  const providerThreadRef = terminal.disableSessionResume === true
    ? null
    : normalizeProviderThreadRef('gemini-cli', terminal.providerThreadRef);
  const prompt = buildFirstTurnPrompt(message, terminal);

  const args = [
    `"${escapeForDoubleQuotes(process.execPath)}"`,
    `"${escapeForDoubleQuotes(runnerPath)}"`,
    '--message',
    `"${escapeForDoubleQuotes(prompt)}"`,
    '--workdir',
    `"${escapeForDoubleQuotes(workDir)}"`
  ];

  if (resolvedModel) {
    args.push('--model', `"${escapeForDoubleQuotes(resolvedModel)}"`);
  }

  if (providerThreadRef) {
    args.push('--session-id', `"${escapeForDoubleQuotes(providerThreadRef)}"`);
  }

  return args.join(' ');
}

function buildClaudeOneShotCommand(message, terminal) {
  const claudePath = resolveClaudeCliPath();
  const workDir = terminal.workDir || process.cwd();
  const providerThreadRef = normalizeUuid(terminal.providerThreadRef || null);
  const messageCount = Number.isInteger(terminal.messageCount) ? terminal.messageCount : 0;
  const permissionMode = terminal.permissionMode || 'auto';

  const args = [
    `"${escapeForDoubleQuotes(claudePath)}"`
  ];

  const resolvedModel = normalizeBrokerModelAlias('claude-code', terminal.model);
  if (resolvedModel) {
    args.push('--model', `"${escapeForDoubleQuotes(resolvedModel)}"`);
  }

  args.push(
    '-p',
    `"${escapeForDoubleQuotes(message)}"`,
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config'
  );

  if (!messageCount && terminal.systemPrompt) {
    args.push('--system-prompt', `"${escapeForDoubleQuotes(terminal.systemPrompt)}"`);
  }

  if (Array.isArray(terminal.allowedTools) && terminal.allowedTools.length > 0) {
    args.push('--allowed-tools', `"${escapeForDoubleQuotes(terminal.allowedTools.join(','))}"`);
  }

  if (providerThreadRef) {
    if (messageCount > 0) {
      args.push('--resume', providerThreadRef);
    } else {
      args.push('--session-id', providerThreadRef);
    }
  }

  args.push('--add-dir', `"${escapeForDoubleQuotes(workDir)}"`);

  if (permissionMode) {
    const validModes = ['plan', 'default', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk'];
    if (validModes.includes(permissionMode)) {
      args.push('--permission-mode', permissionMode);
    } else if (permissionMode === 'interceptor') {
      args.push('--permission-mode', 'default');
    } else {
      args.push('--dangerously-skip-permissions');
    }
  } else {
    args.push('--dangerously-skip-permissions');
  }

  return {
    command: args.join(' '),
    providerThreadRef
  };
}

function buildCodexOneShotCommand(message, terminal) {
  const prompt = buildFirstTurnPrompt(message, terminal);
  const escapedPrompt = escapeForSingleQuotes(prompt);
  const args = ['CI=true', 'codex', 'exec'];

  const resolvedModel = resolveCodexOneShotModel(terminal.model);
  if (resolvedModel) {
    args.push('-m', resolvedModel);
  }
  args.push('--full-auto', '--json', '--skip-git-repo-check');
  args.push(`'${escapedPrompt}'`);

  return args.join(' ');
}

function buildQwenOneShotCommand(message, terminal) {
  const prompt = buildFirstTurnPrompt(message, terminal);
  const escapedPrompt = escapeForSingleQuotes(prompt);
  const providerThreadRef = normalizeProviderThreadRef('qwen-cli', terminal.providerThreadRef);
  const args = ['qwen'];

  if (terminal.model && terminal.model !== 'default') {
    args.push('-m', terminal.model);
  }
  if (providerThreadRef) {
    args.push('-r', providerThreadRef);
  }
  args.push('-p', `'${escapedPrompt}'`, '-o', 'stream-json', '-y');

  if (Array.isArray(terminal.allowedTools) && terminal.allowedTools.length > 0) {
    for (const tool of terminal.allowedTools) {
      args.push('--allowed-tools', `'${escapeForSingleQuotes(tool)}'`);
    }
  }

  return args.join(' ');
}

function buildOpencodeOneShotCommand(message, terminal) {
  const prompt = buildFirstTurnPrompt(message, terminal);
  const escapedPrompt = escapeForSingleQuotes(prompt);
  const providerThreadRef = normalizeProviderThreadRef('opencode-cli', terminal.providerThreadRef);
  const args = ['opencode', 'run'];

  if (terminal.model && terminal.model !== 'default') {
    args.push('--model', terminal.model);
  }
  if (providerThreadRef) {
    args.push('--session', providerThreadRef);
  }
  args.push(
    '--print-logs',
    '--log-level', 'ERROR',
    '--format', 'json',
    '--dangerously-skip-permissions'
  );
  args.push(`'${escapedPrompt}'`);

  return args.join(' ');
}

function deriveControlPlaneSessionKind(options = {}) {
  const explicitSessionKind = String(options.sessionKind || '').trim();
  if (explicitSessionKind) {
    return explicitSessionKind;
  }

  const metadata = options.sessionMetadata && typeof options.sessionMetadata === 'object'
    ? options.sessionMetadata
    : {};
  if (metadata.collaborator === true) {
    return 'collaborator';
  }

  if (options.parentSessionId) {
    return 'subagent';
  }

  const role = String(options.role || '').trim().toLowerCase();

  if (role === 'main' || metadata.managedLaunch === true) {
    return 'main';
  }

  return 'subagent';
}

function shouldResetProviderStateOnReuse(terminal) {
  if (!terminal) {
    return false;
  }

  return terminal.role !== 'main'
    && terminal.sessionKind !== 'main'
    && terminal.sessionKind !== 'collaborator';
}

function shouldPreserveRichTerminalUi(options = {}) {
  const role = String(options.role || '').trim().toLowerCase();
  const sessionKind = String(options.sessionKind || '').trim().toLowerCase();
  const metadata = options.sessionMetadata && typeof options.sessionMetadata === 'object'
    ? options.sessionMetadata
    : {};

  return role === 'main' || sessionKind === 'main' || metadata.managedLaunch === true;
}

function shouldStartRichProviderViaRespawn(terminal) {
  if (!terminal) {
    return false;
  }

  return shouldPreserveRichTerminalUi({
    role: terminal.role,
    sessionKind: terminal.sessionKind,
    sessionMetadata: terminal.sessionMetadata || null
  });
}

function shouldExitShellOnProviderExit(options = {}) {
  const metadata = options.sessionMetadata && typeof options.sessionMetadata === 'object'
    ? options.sessionMetadata
    : {};

  if (
    options.keepShellOnProviderExit === true
    || metadata.keepShellOnProviderExit === true
    || process.env.CLIAGENTS_KEEP_SHELL_ON_PROVIDER_EXIT === '1'
  ) {
    return false;
  }

  return shouldPreserveRichTerminalUi(options);
}

function buildManagedRootProviderEnvironmentPrefix(options = {}) {
  if (!shouldPreserveRichTerminalUi(options)) {
    return '';
  }
  if (options.providerNativeEnvironment === true) {
    return '';
  }

  return [
    'unset NO_COLOR CLICOLOR; ',
    'TERM="${TERM:-tmux-256color}"',
    'COLORTERM="${COLORTERM:-truecolor}"',
    'FORCE_COLOR=1',
    'CLICOLOR_FORCE=1'
  ].join(' ');
}

function wrapManagedRootProviderCommand(command, options = {}) {
  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand) {
    return normalizedCommand;
  }

  const commandWithExec = (!shouldExitShellOnProviderExit(options) || normalizedCommand.startsWith('exec '))
    ? normalizedCommand
    : `exec ${normalizedCommand}`;
  const envPrefix = buildManagedRootProviderEnvironmentPrefix(options);

  return envPrefix ? `${envPrefix} ${commandWithExec}` : commandWithExec;
}

function parseStartupDelayMs(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 30000) {
    return fallback;
  }
  return parsed;
}

function resolveTerminalStartupDelayMs(options = {}) {
  const userFacingTerminal = shouldPreserveRichTerminalUi(options);
  if (userFacingTerminal) {
    return parseStartupDelayMs(
      process.env.CLIAGENTS_MANAGED_ROOT_STARTUP_DELAY_MS,
      DEFAULT_MANAGED_ROOT_STARTUP_DELAY_MS
    );
  }

  return parseStartupDelayMs(
    process.env.CLIAGENTS_WORKER_STARTUP_DELAY_MS,
    DEFAULT_WORKER_STARTUP_DELAY_MS
  );
}

function resolveDeferredProviderAttachTimeoutMs() {
  return parseStartupDelayMs(
    process.env.CLIAGENTS_DEFERRED_PROVIDER_ATTACH_TIMEOUT_MS,
    DEFAULT_DEFERRED_PROVIDER_ATTACH_TIMEOUT_MS
  );
}

function normalizeLaunchEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    normalized[key] = trimmed;
  }
  return normalized;
}

function buildManagedRootControlPlaneEnv(options = {}) {
  const {
    role = null,
    sessionKind = null,
    rootSessionId = null,
    externalSessionRef = null,
    clientName = null,
    workspaceRoot = null,
    sessionMetadata = null
  } = options;

  const normalizedSessionKind = String(sessionKind || '').trim().toLowerCase();
  const metadata = sessionMetadata && typeof sessionMetadata === 'object'
    ? sessionMetadata
    : {};
  const managedLaunch = metadata.managedLaunch === true || metadata.attachMode === 'managed-root-launch';
  const isManagedRoot = normalizedSessionKind === 'main' && (role === 'main' || managedLaunch);
  if (!isManagedRoot || !rootSessionId || !externalSessionRef) {
    return {};
  }

  const resolvedClientName = String(clientName || metadata.clientName || '').trim();
  const resolvedWorkspaceRoot = String(
    workspaceRoot || metadata.workspaceRoot || ''
  ).trim();

  return {
    CLIAGENTS_ROOT_SESSION_ID: String(rootSessionId),
    CLIAGENTS_CLIENT_SESSION_REF: String(externalSessionRef),
    CLIAGENTS_CLIENT_NAME: resolvedClientName || null,
    CLIAGENTS_WORKSPACE_ROOT: resolvedWorkspaceRoot || null,
    CLIAGENTS_MANAGED_ROOT: '1'
  };
}

function parseLaunchDimension(value, { min = 10, max = 1000 } = {}) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function resolveLaunchGeometry(launchEnvironment) {
  const normalized = normalizeLaunchEnvironment(launchEnvironment);
  const width = parseLaunchDimension(normalized.COLUMNS, { min: 20, max: 1000 });
  const height = parseLaunchDimension(normalized.LINES, { min: 10, max: 400 });
  if (!width && !height) {
    return null;
  }
  return {
    width: width || 200,
    height: height || 50
  };
}

/**
 * CLI command builders for each adapter
 */
const CLI_COMMANDS = {
  'claude-code': (options = {}) => {
    const isOrchestration = options.role === 'worker' || options.orchestration;
    if (isOrchestration) {
      return 'echo "CLAUDE_READY_FOR_ORCHESTRATION"';
    }

    const args = [resolveClaudeCliPath()];
    const resumeSessionId = resolveProviderResumeSessionId('claude-code', options);

    // Permission mode: plan, default, acceptEdits, bypassPermissions, interceptor, etc.
    // 'plan' mode creates plans without executing (read-only)
    // 'interceptor' mode: don't skip permissions, let PermissionInterceptor handle prompts
    if (options.permissionMode) {
      const validModes = ['plan', 'default', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk'];
      if (validModes.includes(options.permissionMode)) {
        args.push('--permission-mode', options.permissionMode);
      } else if (options.permissionMode === 'interceptor') {
        // Interceptor mode: use 'default' permission mode so prompts appear
        args.push('--permission-mode', 'default');
      }
    } else if (options.dangerouslySkipPermissions !== false) {
      // Default: skip permission prompts for non-interactive use
      args.push('--dangerously-skip-permissions');
    }

    // Print output as JSON for parsing
    args.push('--output-format', 'stream-json');

    // Model selection
    const resolvedModel = normalizeBrokerModelAlias('claude-code', options.model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else if (options.resumeLatest) {
      args.push('--continue');
    } else if (options.providerSessionId) {
      args.push('--session-id', options.providerSessionId);
    }

    // System prompt (if any - initial conversation prompt)
    // SECURITY: Properly escape all shell metacharacters
    if (options.systemPrompt) {
      const escapedPrompt = escapeForDoubleQuotes(options.systemPrompt);
      args.push('--system-prompt', `"${escapedPrompt}"`);
    }

    // Allowed tools restriction
    if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    return wrapManagedRootProviderCommand(args.join(' '), options);
  },

  'gemini-cli': (options = {}) => {
    // For orchestration contexts (handoff/delegation), Gemini interactive mode shows
    // "untrusted folder" banners that block automation. Solution: don't start interactive
    // Gemini at all. Instead, print a ready marker and handle -p invocations in sendInput().
    const isOrchestration = options.role === 'worker' || options.orchestration;

    if (isOrchestration) {
      // Orchestration mode: don't start interactive CLI
      // Just echo a ready marker so waitForStatus(IDLE) succeeds
      // Actual gemini -p commands will be run per-message in sendInput()
      return 'echo "GEMINI_READY_FOR_ORCHESTRATION"';
    }

    // User-facing session: normal interactive mode
    const args = ['gemini'];
    const resumeSessionId = resolveProviderResumeSessionId('gemini-cli', options);

    // Permission mode handling:
    // - 'auto' (default) or 'bypassPermissions': Use yolo mode (auto-approve all)
    // - 'default' or 'interceptor': Don't use yolo mode (will prompt for confirmations)
    // - Other modes: Gemini doesn't support fine-grained modes, fall back to yolo
    // NOTE: Gemini CLI doesn't have --allowedTools or read-only mode like Claude
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode === 'default') {
      // Don't add yolo mode - will prompt for confirmations
    } else if (options.yoloMode !== false) {
      // 'auto', 'interceptor', 'bypassPermissions' all use yolo for Gemini
      // (PermissionInterceptor only works for Claude Code, not Gemini)
      args.push('--approval-mode', 'yolo');
    }

    const resolvedModel = resolveGeminiCommandModel(options.model);
    if (resolvedModel) {
      args.push('-m', resolvedModel);
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else if (options.resumeLatest) {
      args.push('--resume', 'latest');
    }

    return wrapManagedRootProviderCommand(args.join(' '), options);
  },

  'codex-cli': (options = {}) => {
    // For orchestration contexts (handoff/delegation), Codex interactive mode can show
    // pre-filled prompts and conversational "What would you like me to do?" responses
    // that get detected as WAITING_USER_ANSWER, blocking automation.
    // Solution: don't start interactive Codex at all. Use non-interactive `codex exec` instead.
    const isOrchestration = options.role === 'worker' || options.orchestration;

    if (isOrchestration) {
      // Orchestration mode: don't start interactive CLI
      // Just echo a ready marker so waitForStatus(IDLE) succeeds
      // Actual codex exec commands will be run per-message in sendInput()
      return 'echo "CODEX_READY_FOR_ORCHESTRATION"';
    }

    // User-facing session: preserve the native Codex terminal UI.
    // Avoid CI=true here because Codex switches to a less rich terminal mode.
    const resumeSessionId = resolveCodexResumeSessionId(options);
    const args = resumeSessionId
      ? ['codex', 'resume', resumeSessionId]
      : (options.resumePicker ? ['codex', 'resume'] : (options.resumeLatest ? ['codex', 'resume', '--last'] : ['codex']));

    // Permission mode handling:
    // - 'auto' (default) or 'bypassPermissions': Use bypass mode (auto-approve all)
    // - 'default' or 'interceptor': Don't use bypass mode (will prompt for confirmations)
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode === 'default') {
      // Don't add bypass flag - will prompt for confirmations
    } else {
      // 'auto', 'interceptor', 'bypassPermissions' all use bypass for Codex
      // (PermissionInterceptor only works for Claude Code, not Codex)
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    // Model selection
    const resolvedModel = normalizeBrokerModelAlias('codex-cli', options.model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    return wrapManagedRootProviderCommand(args.join(' '), {
      ...options,
      providerNativeEnvironment: true
    });
  },

  'qwen-cli': (options = {}) => {
    // For orchestration contexts, run one-shot qwen commands per message
    // instead of keeping an interactive shell open.
    const isOrchestration = options.role === 'worker' || options.orchestration;

    if (isOrchestration) {
      return 'echo "QWEN_READY_FOR_ORCHESTRATION"';
    }

    const args = ['qwen'];
    const resumeSessionId = resolveProviderResumeSessionId('qwen-cli', options);

    // Permission handling: default to yolo for automation unless explicitly default mode.
    const permissionMode = options.permissionMode || 'auto';
    if (permissionMode !== 'default') {
      args.push('-y');
    }

    if (options.model) {
      args.push('-m', options.model);
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else if (options.resumeLatest) {
      args.push('--continue');
    } else if (options.providerSessionId) {
      args.push('--session-id', options.providerSessionId);
    }

    return wrapManagedRootProviderCommand(args.join(' '), options);
  },

  'opencode-cli': (options = {}) => {
    const isOrchestration = options.role === 'worker' || options.orchestration;
    if (isOrchestration) {
      return 'echo "OPENCODE_READY_FOR_ORCHESTRATION"';
    }

    const args = ['opencode'];
    const resumeSessionId = resolveProviderResumeSessionId('opencode-cli', options);
    if (options.model) {
      args.push('--model', options.model);
    }
    if (resumeSessionId) {
      args.push('--session', resumeSessionId);
    } else if (options.resumeLatest) {
      args.push('--continue');
    }
    return wrapManagedRootProviderCommand(args.join(' '), options);
  }
};

class PersistentSessionManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.db - Database instance (optional, for Phase 3)
   * @param {TmuxClient} options.tmuxClient - TmuxClient instance (optional)
   * @param {string} options.tmuxSocketPath - Optional tmux socket path for broker isolation
   * @param {string} options.logDir - Directory for log files
   * @param {string} options.workDir - Default working directory
   */
  constructor(options = {}) {
    super();

    this.db = options.db || null;
    this.tmux = options.tmuxClient || new TmuxClient({
      logDir: options.logDir || path.join(process.cwd(), 'logs'),
      socketPath: options.tmuxSocketPath || null
    });
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.workDir = options.workDir || process.cwd();

    // In-memory terminal registry
    this.terminals = new Map();

    // Status detectors (will be populated in Phase 2)
    this.statusDetectors = new Map();
    this.sessionGraphWritesEnabled = options.sessionGraphWritesEnabled ?? process.env.SESSION_GRAPH_WRITES_ENABLED === '1';
    this.sessionEventsEnabled = options.sessionEventsEnabled ?? process.env.SESSION_EVENTS_ENABLED === '1';
    this.shellCommands = new Set(['bash', 'sh', 'zsh', 'fish']);
    this.reuseReservationTtlMs = Math.max(Number(options.reuseReservationTtlMs || 60000), 1000);
    this.modelRoutingService = options.modelRoutingService || getModelRoutingService({
      configPath: options.modelRoutingPath || path.join(process.cwd(), 'config', 'model-routing.json')
    });

    // Ensure directories exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Recover terminals from database on startup
    this._recoverFromDatabase();
  }

  /**
   * Recover terminals from database that still have active tmux sessions
   * This handles Node.js restarts while tmux sessions persist
   */
  _recoverFromDatabase() {
    if (!this.db) {
      return;
    }

    try {
      const dbTerminals = this.db.listTerminals ? this.db.listTerminals() : [];
      const activeSessions = this.tmux.listSessions('');
      const activeSessionNames = new Set(activeSessions.map(s => s.name));

      let recovered = 0;
      let orphaned = 0;

      for (const dbTerminal of dbTerminals) {
        const terminalId = dbTerminal.terminalId || dbTerminal.terminal_id;
        const sessionName = dbTerminal.sessionName || dbTerminal.session_name;
        const windowName = dbTerminal.windowName || dbTerminal.window_name;
        const adapter = dbTerminal.adapter;
        const agentProfile = dbTerminal.agentProfile || dbTerminal.agent_profile;
        const role = dbTerminal.role || 'worker';
        const workDir = dbTerminal.workDir || dbTerminal.work_dir || this.workDir;
        const createdAt = dbTerminal.createdAt || dbTerminal.created_at;
        const lastActive = dbTerminal.lastActive || dbTerminal.last_active || createdAt;
        const rootSessionId = dbTerminal.rootSessionId || dbTerminal.root_session_id || terminalId;
        const parentSessionId = dbTerminal.parentSessionId || dbTerminal.parent_session_id || null;
        const sessionKind = dbTerminal.sessionKind || dbTerminal.session_kind || 'legacy';
        const originClient = dbTerminal.originClient || dbTerminal.origin_client || 'legacy';
        const externalSessionRef = dbTerminal.externalSessionRef || dbTerminal.external_session_ref || null;
        const lineageDepth = Number.isInteger(dbTerminal.lineageDepth)
          ? dbTerminal.lineageDepth
          : (Number.isInteger(dbTerminal.lineage_depth) ? dbTerminal.lineage_depth : 0);
        const sessionMetadata = parseSessionMetadata(dbTerminal.sessionMetadata || dbTerminal.session_metadata);
        const harnessSessionId = dbTerminal.harnessSessionId || dbTerminal.harness_session_id || terminalId;
        const providerThreadRef = dbTerminal.providerThreadRef || dbTerminal.provider_thread_ref || null;
        const adoptedAt = dbTerminal.adoptedAt || dbTerminal.adopted_at || null;
        const captureMode = dbTerminal.captureMode || dbTerminal.capture_mode || 'raw-tty';
        const runtimeMetadata = resolveRuntimeHostMetadata({
          ...dbTerminal,
          terminalId,
          sessionName,
          windowName,
          sessionMetadata,
          adoptedAt
        });

        if (!terminalId || !sessionName || !windowName || !adapter) {
          continue;
        }

        if (dbTerminal.status === 'orphaned' && !activeSessionNames.has(sessionName)) {
          continue;
        }

        // Check if tmux session still exists
        if (activeSessionNames.has(sessionName)) {
          // Recover this terminal into memory
          const recoveredTerminal = {
            terminalId,
            sessionName,
            windowName,
            adapter,
            agentProfile,
            role,
            workDir,
            logPath: path.join(this.logDir, `${terminalId}.log`),
            status: dbTerminal.status || TerminalStatus.IDLE,
            createdAt: new Date(createdAt),
            lastActive: new Date(lastActive),
            activeRun: null,
            rootSessionId,
            parentSessionId,
            sessionKind,
            originClient,
            externalSessionRef,
            lineageDepth,
            sessionMetadata,
            harnessSessionId,
            providerThreadRef,
            adoptedAt,
            captureMode,
            runtimeHost: runtimeMetadata.runtimeHost,
            runtimeId: runtimeMetadata.runtimeId,
            runtimeCapabilities: runtimeMetadata.runtimeCapabilities,
            runtimeFidelity: runtimeMetadata.runtimeFidelity,
            recovered: true
          };
          this._attachReuseInternals(recoveredTerminal, this._buildReuseContext({
            adapter: recoveredTerminal.adapter,
            agentProfile: recoveredTerminal.agentProfile,
            role: recoveredTerminal.role,
            workDir: recoveredTerminal.workDir,
            model: recoveredTerminal.model || null,
            allowedTools: recoveredTerminal.allowedTools || null,
            permissionMode: recoveredTerminal.permissionMode || 'auto',
            rootSessionId: recoveredTerminal.rootSessionId,
            parentSessionId: recoveredTerminal.parentSessionId,
            sessionKind: recoveredTerminal.sessionKind
          }));
          this.terminals.set(terminalId, recoveredTerminal);
          recovered++;
        } else {
          // Session no longer exists, mark as orphaned in DB
          if (this.db.updateStatus) {
            this.db.updateStatus(terminalId, 'orphaned');
          }
          this._recordSessionTerminated({
            terminalId,
            adapter,
            activeRun: null,
            rootSessionId,
            parentSessionId,
            originClient,
            sessionMetadata
          }, 'orphaned');
          orphaned++;
        }
      }

      if (recovered > 0 || orphaned > 0) {
        console.log(`[SessionManager] Startup recovery: ${recovered} terminals recovered, ${orphaned} orphaned`);
      }
    } catch (error) {
      console.error('[SessionManager] Failed to recover terminals:', error.message);
    }
  }

  /**
   * Register a status detector for an adapter
   * @param {string} adapter - Adapter name
   * @param {Object} detector - Status detector instance
   */
  registerStatusDetector(adapter, detector) {
    this.statusDetectors.set(adapter, detector);
  }

  /**
   * Return the last non-empty line from captured terminal output.
   * @param {string} output
   * @returns {string}
   */
  _getLastNonEmptyLine(output) {
    const lines = String(output || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : '';
  }

  _normalizeInteractiveOutput(output) {
    return stripAnsiCodes(String(output || ''))
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u0008/g, '')
      .replace(/\u0000/g, '');
  }

  _normalizeMessageContent(content) {
    return String(content || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
  }

  _validateAdoptableTmuxName(name, field) {
    const value = String(name || '').trim();
    if (!value) {
      throw new Error(`${field} is required`);
    }
    if (!SAFE_TMUX_NAME_PATTERN.test(value)) {
      throw new Error(`${field} must use only alphanumeric characters, dashes, or underscores for adopt mode`);
    }
    return value;
  }

  _supportsInteractiveTranscriptSync(terminal) {
    if (!terminal || !this.db) {
      return false;
    }

    const sessionKind = String(terminal.sessionKind || '').trim().toLowerCase();
    const metadata = terminal.sessionMetadata && typeof terminal.sessionMetadata === 'object'
      ? terminal.sessionMetadata
      : null;

    return Boolean(
      ['codex-cli', 'claude-code'].includes(terminal.adapter)
      && (terminal.role === 'main' || sessionKind === 'main' || sessionKind === 'attach' || metadata?.managedLaunch)
    );
  }

  _ensureInteractiveTranscriptState(terminal) {
    if (!terminal) {
      return null;
    }

    if (!terminal._interactiveTranscriptState) {
      const latestUser = this.db?.getLatestMessage
        ? this.db.getLatestMessage(terminal.terminalId, { role: 'user' })
        : null;
      const latestAssistant = this.db?.getLatestMessage
        ? this.db.getLatestMessage(terminal.terminalId, { role: 'assistant' })
        : null;

      terminal._interactiveTranscriptState = {
        awaitingAssistant: false,
        latestUserContent: latestUser ? this._normalizeMessageContent(latestUser.content) : null,
        latestAssistantContent: latestAssistant ? this._normalizeMessageContent(latestAssistant.content) : null
      };
    }

    return terminal._interactiveTranscriptState;
  }

  _getInteractivePromptPattern(adapter) {
    const promptPatterns = {
      'codex-cli': /(?:^|\n)›\s*([^\n]+?)\s*(?=\n|$)/g,
      'claude-code': /(?:^|\n)❯\s*([^\n]+?)\s*(?=\n|$)/g
    };

    return promptPatterns[adapter] || null;
  }

  _hasInteractiveAssistantMarker(output, adapter) {
    const markers = {
      'codex-cli': /(?:^|\n)\s*•\s+/,
      'claude-code': /(?:^|\n)\s*⏺\s+/
    };

    const pattern = markers[adapter];
    return pattern ? pattern.test(output) : false;
  }

  _extractLatestCompletedInteractiveTurn(output, adapter) {
    const cleanedOutput = this._normalizeInteractiveOutput(output);
    const pattern = this._getInteractivePromptPattern(adapter);
    if (!pattern) {
      return null;
    }

    const matches = [...cleanedOutput.matchAll(pattern)];
    if (matches.length === 0) {
      return null;
    }

    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const promptText = this._normalizeMessageContent(matches[index][1]);
      if (!promptText) {
        continue;
      }
      if (/^(?:gpt-|claude|context left|\? for shortcuts)/i.test(promptText)) {
        continue;
      }

      const startIndex = matches[index].index || 0;
      const nextMatch = matches[index + 1];
      const endIndex = nextMatch && typeof nextMatch.index === 'number'
        ? nextMatch.index
        : cleanedOutput.length;
      const segment = cleanedOutput.slice(startIndex, endIndex);
      if (!this._hasInteractiveAssistantMarker(segment, adapter)) {
        continue;
      }

      const assistantText = this._normalizeMessageContent(
        extractOutput(segment, adapter, { stripAnsi: false })
      );
      if (!assistantText || assistantText === promptText) {
        continue;
      }

      return {
        user: promptText,
        assistant: assistantText
      };
    }

    return null;
  }

  _recordInteractiveTranscriptMessage(terminal, role, content) {
    if (!terminal || !this.db) {
      return null;
    }

    const normalizedContent = this._normalizeMessageContent(content);
    if (!normalizedContent) {
      return null;
    }

    const syncState = this._ensureInteractiveTranscriptState(terminal);
    const latestKey = role === 'assistant' ? 'latestAssistantContent' : 'latestUserContent';
    if (syncState?.[latestKey] === normalizedContent) {
      return null;
    }

    const messageId = this.db.addMessage(terminal.terminalId, role, normalizedContent, {
      metadata: {
        adapter: terminal.adapter,
        sessionKind: terminal.sessionKind || null,
        source: 'interactive-root-sync',
        derived: true
      }
    });

    if (syncState) {
      syncState[latestKey] = normalizedContent;
    }

    this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: role === 'assistant' ? 'message_received' : 'message_sent',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        role === 'assistant' ? 'message_received' : 'message_sent',
        `interactive-${messageId}`
      ),
      payloadSummary: summarizeMessage(`${role}: ${normalizedContent}`),
      payloadJson: {
        messageId,
        role,
        adapter: terminal.adapter,
        source: 'interactive-root-sync'
      },
      metadata: terminal.sessionMetadata || null
    });

    return messageId;
  }

  _syncInteractiveTranscript(terminal, output, nextStatus) {
    if (!this._supportsInteractiveTranscriptSync(terminal)) {
      return;
    }

    const syncState = this._ensureInteractiveTranscriptState(terminal);
    if (!syncState) {
      return;
    }

    const cleanedOutput = this._normalizeInteractiveOutput(output);
    if (!cleanedOutput.trim()) {
      return;
    }

    const isSettledStatus = [
      TerminalStatus.IDLE,
      TerminalStatus.COMPLETED,
      TerminalStatus.ERROR
    ].includes(nextStatus);

    if (!isSettledStatus) {
      return;
    }

    const completedTurn = this._extractLatestCompletedInteractiveTurn(cleanedOutput, terminal.adapter);
    if (!completedTurn) {
      return;
    }

    const insertedUserMessage = this._recordInteractiveTranscriptMessage(terminal, 'user', completedTurn.user);
    if (insertedUserMessage || this._normalizeMessageContent(completedTurn.user) === syncState.latestUserContent) {
      syncState.awaitingAssistant = true;
    }

    const insertedAssistantMessage = this._recordInteractiveTranscriptMessage(terminal, 'assistant', completedTurn.assistant);
    if (insertedAssistantMessage || this._normalizeMessageContent(completedTurn.assistant) === syncState.latestAssistantContent) {
      syncState.awaitingAssistant = false;
    }
  }

  _isShellLikeCommand(command) {
    return !!command && this.shellCommands.has(String(command).trim());
  }

  _buildSessionEventIdempotencyKey(rootSessionId, sessionId, eventType, stableStepKey) {
    return `${rootSessionId}:${sessionId}:${eventType}:${stableStepKey}`;
  }

  _recordSessionEvent(event) {
    if (!this.sessionEventsEnabled || !this.db?.addSessionEvent) {
      return null;
    }

    try {
      return this.db.addSessionEvent(event);
    } catch (error) {
      console.warn('[SessionManager] Failed to record session event:', error.message);
      return null;
    }
  }

  _ensureImplicitRootAttach(terminal) {
    if (!terminal || !this.sessionEventsEnabled || !terminal.rootSessionId) {
      return null;
    }

    if (terminal.rootSessionId === terminal.terminalId || !terminal.parentSessionId) {
      return null;
    }

    if (typeof this.db?.listSessionEvents === 'function') {
      try {
        const existingRootEvents = this.db.listSessionEvents({
          rootSessionId: terminal.rootSessionId,
          limit: 25
        });
        const hasRootAttach = existingRootEvents.some((event) => (
          event.session_id === terminal.rootSessionId
          && event.event_type === 'session_started'
        ));
        if (hasRootAttach) {
          return null;
        }
      } catch (error) {
        console.warn('[SessionManager] Failed to inspect existing root-session events:', error.message);
      }
    }

    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId,
      sessionId: terminal.rootSessionId,
      parentSessionId: null,
      eventType: 'session_started',
      originClient: terminal.originClient,
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId,
        terminal.rootSessionId,
        'session_started',
        'implicit-root-attach'
      ),
      payloadSummary: `Implicit root attach via ${terminal.originClient || 'unknown'}`,
      payloadJson: {
        attachMode: 'implicit-first-use',
        externalSessionRef: terminal.externalSessionRef || null,
        sessionKind: 'attach'
      },
      metadata: terminal.sessionMetadata || null
    });
  }

  _recordSessionStarted(terminal) {
    if (!terminal) {
      return null;
    }

    this._ensureImplicitRootAttach(terminal);
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_started',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_started',
        'terminal-created'
      ),
      payloadSummary: `${terminal.adapter} session started`,
      payloadJson: {
        adapter: terminal.adapter,
        agentProfile: terminal.agentProfile || null,
        role: terminal.role || 'worker',
        model: terminal.model || null,
        workDir: terminal.workDir || null,
        sessionKind: terminal.sessionKind || 'legacy'
      },
      metadata: terminal.sessionMetadata || null
    });
  }

  _recordSessionAdopted(terminal, extra = {}) {
    if (!terminal) {
      return null;
    }

    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_adopted',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_adopted',
        `${terminal.sessionName}:${terminal.windowName}`
      ),
      payloadSummary: `${terminal.adapter} session adopted`,
      payloadJson: {
        adapter: terminal.adapter,
        role: terminal.role || 'worker',
        sessionKind: terminal.sessionKind || 'legacy',
        tmuxTarget: `${terminal.sessionName}:${terminal.windowName}`,
        workDir: terminal.workDir || null,
        model: terminal.model || null,
        harnessSessionId: terminal.harnessSessionId || null,
        providerThreadRef: terminal.providerThreadRef || null
      },
      metadata: extra.metadata || terminal.sessionMetadata || null
    });
  }

  _recordSessionResumed(terminal, extra = {}) {
    if (!terminal) {
      return null;
    }

    terminal._resumeCount = (terminal._resumeCount || 0) + 1;
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_resumed',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_resumed',
        `resume-${terminal._resumeCount}`
      ),
      payloadSummary: `${terminal.adapter} session resumed`,
      payloadJson: {
        adapter: terminal.adapter,
        agentProfile: terminal.agentProfile || null,
        role: terminal.role || 'worker',
        model: terminal.model || null,
        workDir: terminal.workDir || null,
        sessionKind: terminal.sessionKind || 'legacy',
        reuseReason: extra.reuseReason || 'compatible-root-session'
      },
      metadata: extra.metadata || terminal.sessionMetadata || null
    });
  }

  _recordSessionTerminated(terminal, status, extra = {}) {
    if (!terminal || !['completed', 'error', 'orphaned'].includes(status)) {
      return null;
    }

    const stableStepKey = terminal.activeRun?.runId
      ? `run-${terminal.activeRun.runId}`
      : `status-${status}`;
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: status === 'orphaned' ? 'session_stale' : 'session_terminated',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        status === 'orphaned' ? 'session_stale' : 'session_terminated',
        stableStepKey
      ),
      payloadSummary: `${terminal.adapter} session ${status}`,
      payloadJson: {
        adapter: terminal.adapter,
        status,
        exitCode: extra.exitCode ?? null,
        runId: terminal.activeRun?.runId || null,
        attentionCode: extra.attention?.code || null,
        attentionMessage: extra.attention?.message || null,
        resumeCommand: extra.attention?.resumeCommand || null,
        resumeSessionId: extra.attention?.resumeSessionId || null
      },
      metadata: extra.metadata || null
    });
  }

  _shouldTrackModelHealth(terminal) {
    const model = String(terminal?.model || '').trim();
    if (!terminal || !model || model === 'default') {
      return false;
    }

    if (terminal.sessionKind === 'main' || terminal.role === 'main') {
      return false;
    }

    return Boolean(this.modelRoutingService?.getAdapterPolicy?.(terminal.adapter));
  }

  _classifyModelExecutionFailure(terminal, nextStatus, extra = {}) {
    const attentionCode = String(extra.attention?.code || '').trim();
    if (attentionCode) {
      return {
        failureClass: attentionCode,
        reason: extra.attention?.message || `Terminal reported attention code '${attentionCode}'.`
      };
    }

    if (nextStatus !== TerminalStatus.ERROR) {
      return null;
    }

    const exitCode = Number.isInteger(extra.exitCode)
      ? extra.exitCode
      : (Number.isInteger(terminal?.activeRun?.exitCode) ? terminal.activeRun.exitCode : null);

    if (Number.isInteger(exitCode)) {
      return {
        failureClass: 'exit_nonzero',
        reason: `Process exited with code ${exitCode}.`
      };
    }

    return {
      failureClass: 'execution_error',
      reason: 'Terminal entered an error state without a classified provider attention code.'
    };
  }

  _recordModelExecutionOutcome(terminal, nextStatus, extra = {}) {
    if (!this._shouldTrackModelHealth(terminal)) {
      return null;
    }

    const failure = this._classifyModelExecutionFailure(terminal, nextStatus, extra);
    if (failure) {
      return this.modelRoutingService.recordModelFailure({
        adapter: terminal.adapter,
        model: terminal.model,
        failureClass: failure.failureClass,
        reason: failure.reason
      });
    }

    if (nextStatus === TerminalStatus.COMPLETED) {
      return this.modelRoutingService.recordModelSuccess({
        adapter: terminal.adapter,
        model: terminal.model
      });
    }

    return null;
  }

  _applyStatusUpdate(terminal, nextStatus, extra = {}) {
    if (!terminal || !nextStatus || terminal.status === nextStatus) {
      return nextStatus;
    }

    terminal.status = nextStatus;
    if (Object.prototype.hasOwnProperty.call(extra, 'attention')) {
      terminal.attention = extra.attention || null;
    }
    if (this.db) {
      this.db.updateStatus(terminal.terminalId, nextStatus);
    }
    this._interruptFatalTrackedRun(terminal, nextStatus);
    this._recordModelExecutionOutcome(terminal, nextStatus, extra);
    this.emit('status-change', { terminalId: terminal.terminalId, status: nextStatus });

    if ([TerminalStatus.COMPLETED, TerminalStatus.ERROR].includes(nextStatus)) {
      this._recordSessionTerminated(terminal, nextStatus, extra);
    } else if (nextStatus === 'orphaned') {
      this._recordSessionTerminated(terminal, 'orphaned', extra);
    }

    return nextStatus;
  }

  _interruptFatalTrackedRun(terminal, nextStatus) {
    if (!terminal || nextStatus !== TerminalStatus.ERROR || !terminal.activeRun) {
      return false;
    }

    if (terminal.adapter !== 'opencode-cli' || terminal.activeRun.interruptRequested) {
      return false;
    }

    const currentCommand = this._getCurrentCommand(terminal);
    if (isShellProcessCommand(currentCommand)) {
      return false;
    }

    try {
      this.tmux.sendSpecialKey(terminal.sessionName, terminal.windowName, 'C-c');
      terminal.activeRun.interruptRequested = true;
      return true;
    } catch {
      return false;
    }
  }

  _resolveMissingSessionStatus(terminal, detector) {
    const attention = this._getTerminalAttention(terminal);
    if (attention?.code === 'conversation_interrupted') {
      return TerminalStatus.ERROR;
    }

    const dbTerminal = this.db?.getTerminal ? this.db.getTerminal(terminal.terminalId) : null;
    const dbStatus = dbTerminal?.status || null;
    if ([TerminalStatus.COMPLETED, TerminalStatus.ERROR, 'orphaned'].includes(dbStatus)) {
      return dbStatus;
    }

    const trackedRunStatus = this._detectTrackedRunStatus(terminal, '', detector);
    if (trackedRunStatus && trackedRunStatus !== TerminalStatus.PROCESSING) {
      return trackedRunStatus;
    }

    return 'orphaned';
  }

  _reconcileTerminalBacking(terminal) {
    if (!terminal) {
      return null;
    }

    if (typeof this.tmux.sessionExists !== 'function') {
      return terminal;
    }

    if (this.tmux.sessionExists(terminal.sessionName)) {
      return terminal;
    }

    const detector = this.statusDetectors.get(terminal.adapter);
    const resolvedStatus = this._resolveMissingSessionStatus(terminal, detector);
    const attention = this._getTerminalAttention(terminal);
    this._applyStatusUpdate(terminal, resolvedStatus, {
      exitCode: terminal.activeRun?.exitCode ?? null,
      attention
    });

    if (['completed', 'error', 'orphaned'].includes(resolvedStatus)) {
      terminal.activeRun = null;
    }

    const dbTerminal = this.db?.getTerminal ? this.db.getTerminal(terminal.terminalId) : null;
    if (!dbTerminal) {
      this.terminals.delete(terminal.terminalId);
      return null;
    }

    terminal.status = dbTerminal.status || terminal.status;
    terminal.lastActive = dbTerminal.last_active ? new Date(dbTerminal.last_active) : terminal.lastActive;
    return terminal;
  }

  /**
   * Wrap a one-shot orchestration command with explicit run lifecycle markers.
   * @param {Object} terminal
   * @param {string} command
   * @returns {string}
   */
  _wrapTrackedOneShotCommand(terminal, command) {
    const runId = generateRunId();
    const startMarker = `__CLIAGENTS_RUN_START__${runId}`;
    const exitMarkerPrefix = `__CLIAGENTS_RUN_EXIT__${runId}__`;
    const baselineOutput = this.tmux.getHistory(terminal.sessionName, terminal.windowName, 500);

    terminal.activeRun = {
      runId,
      startMarker,
      exitMarkerPrefix,
      baselineOutputLength: baselineOutput.length,
      startedAt: new Date(),
      command
    };

    const wrappedCommand = `printf '\\n${startMarker}\\n'; ${command}; __cliagents_status=$?; printf '\\n${exitMarkerPrefix}%s\\n' "$__cliagents_status"`;
    if (wrappedCommand.length <= TRACKED_RUN_INLINE_COMMAND_MAX_LENGTH || !terminal.logPath) {
      return wrappedCommand;
    }

    fs.mkdirSync(TRACKED_RUN_SCRIPT_ROOT, { recursive: true });

    const scriptPath = path.join(TRACKED_RUN_SCRIPT_ROOT, `${terminal.terminalId}-${runId}.sh`);
    const scriptBody = [
      '#!/bin/sh',
      `trap 'rm -f -- "$0"' EXIT`,
      wrappedCommand,
      ''
    ].join('\n');

    fs.writeFileSync(scriptPath, scriptBody, { mode: 0o700 });
    terminal.activeRun.wrapperScriptPath = scriptPath;
    return scriptPath;
  }

  _updateProviderThreadRef(terminal, providerThreadRef) {
    const normalizedProviderThreadRef = normalizeProviderThreadRef(terminal?.adapter, providerThreadRef);
    if (!terminal || !normalizedProviderThreadRef || terminal.providerThreadRef === normalizedProviderThreadRef) {
      return terminal?.providerThreadRef || null;
    }

    terminal.providerThreadRef = normalizedProviderThreadRef;
    if (this.db?.updateTerminalBinding) {
      this.db.updateTerminalBinding(terminal.terminalId, {
        providerThreadRef: normalizedProviderThreadRef
      });
    }

    return normalizedProviderThreadRef;
  }

  _syncProviderThreadRefFromOutput(terminal, output, detector) {
    if (!terminal || !output) {
      return terminal?.providerThreadRef || null;
    }

    const providerThreadRef = extractProviderThreadRefFromOutput(terminal.adapter, output, detector);
    if (!providerThreadRef) {
      return terminal.providerThreadRef || null;
    }

    return this._updateProviderThreadRef(terminal, providerThreadRef);
  }

  _recordEffectiveModelVerification(terminal, effectiveModel, previousModel, options = {}) {
    if (!terminal || !effectiveModel) {
      return null;
    }

    const runId = terminal.activeRun?.runId || null;
    const changed = Boolean(previousModel && previousModel !== effectiveModel);
    const stableStepKey = runId ? `run-${runId}-${effectiveModel}` : `model-${effectiveModel}`;
    return this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'model_verified',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'model_verified',
        stableStepKey
      ),
      payloadSummary: changed
        ? `${terminal.adapter} effective model changed from ${previousModel} to ${effectiveModel}`
        : `${terminal.adapter} effective model verified as ${effectiveModel}`,
      payloadJson: {
        adapter: terminal.adapter,
        requestedModel: previousModel || null,
        effectiveModel,
        changed,
        runId,
        source: options.source || null
      },
      metadata: terminal.sessionMetadata || null
    });
  }

  _syncEffectiveModelFromOutput(terminal, output, options = {}) {
    if (!terminal || !output) {
      return terminal?.model || null;
    }

    const effectiveModel = inferEffectiveModelFromOutput(terminal.adapter, output);
    if (!effectiveModel) {
      return terminal.model || null;
    }

    const previousModel = String(terminal.model || '').trim() || null;
    const verifiedKey = `${terminal.activeRun?.runId || 'session'}:${effectiveModel}`;
    if (terminal._lastEffectiveModelVerificationKey === verifiedKey) {
      return terminal.model || effectiveModel;
    }
    terminal._lastEffectiveModelVerificationKey = verifiedKey;

    if (previousModel !== effectiveModel) {
      terminal.model = effectiveModel;
      if (this.db?.touchTerminalMessage) {
        this.db.touchTerminalMessage(terminal.terminalId, {
          model: effectiveModel,
          timestamp: Date.now()
        });
      }
    }

    this._recordEffectiveModelVerification(terminal, effectiveModel, previousModel, options);
    return effectiveModel;
  }

  _restoreTrackedRunFromPersistence(terminal, output, detector) {
    if (!terminal || terminal.activeRun) {
      return terminal?.activeRun || null;
    }

    const outputText = String(output || '');
    let recoveredRun = extractLatestTrackedRun(outputText);
    let source = 'output';
    let logTail = '';

    if (!recoveredRun && terminal.logPath) {
      logTail = this.readLogTail(terminal.terminalId, 12000);
      recoveredRun = extractLatestTrackedRun(logTail);
      source = 'log';
    }

    if (!recoveredRun) {
      return null;
    }

    const canRestoreFromPersistence = terminal.recovered === true
      || [TerminalStatus.PROCESSING, TerminalStatus.COMPLETED, TerminalStatus.ERROR].includes(terminal.status);
    if (!canRestoreFromPersistence) {
      return null;
    }

    terminal.activeRun = {
      runId: recoveredRun.runId,
      startMarker: recoveredRun.startMarker,
      exitMarkerPrefix: recoveredRun.exitMarkerPrefix,
      baselineOutputLength: source === 'output' ? recoveredRun.startIndex : 0,
      startedAt: terminal.lastActive || terminal.createdAt || new Date(),
      command: null,
      recovered: true
    };

    if (recoveredRun.exitCode != null) {
      terminal.activeRun.exitCode = recoveredRun.exitCode;
      terminal.activeRun.completedAt = new Date();
    }

    if (source === 'log') {
      this._syncProviderThreadRefFromOutput(terminal, logTail, detector);
    }

    return terminal.activeRun;
  }

  /**
   * Detect state for the currently tracked one-shot run, if any.
   * @param {Object} terminal
   * @param {string} output
   * @param {Object} detector
   * @returns {string|null}
   */
  _detectTrackedRunStatus(terminal, output, detector) {
    const run = terminal.activeRun;
    if (!run) {
      return null;
    }

    const outputText = String(output || '');
    const lastStartIndex = outputText.lastIndexOf(run.startMarker);
    const tail = lastStartIndex >= 0
      ? outputText.slice(lastStartIndex)
      : (run.baselineOutputLength > 0 && run.baselineOutputLength < outputText.length)
        ? outputText.slice(run.baselineOutputLength)
        : outputText;
    this._syncProviderThreadRefFromOutput(terminal, tail, detector);
    this._syncEffectiveModelFromOutput(terminal, tail, { source: 'tracked-run-output' });
    const sawStartMarkerInTail = hasTrackedRunStartMarker(tail, run.runId);
    const exitMatch = matchTrackedRunExitMarker(tail, run.exitMarkerPrefix);

    if (exitMatch) {
      const exitCode = Number.parseInt(exitMatch[1], 10);
      run.exitCode = exitCode;
      run.completedAt = new Date();
      return exitCode === 0 ? TerminalStatus.COMPLETED : TerminalStatus.ERROR;
    }

    const logTail = terminal.logPath ? this.readLogTail(terminal.terminalId, 12000) : '';
    this._syncProviderThreadRefFromOutput(terminal, logTail, detector);
    this._syncEffectiveModelFromOutput(terminal, logTail, { source: 'tracked-run-log' });
    const sawStartMarkerInLog = hasTrackedRunStartMarker(logTail, run.runId);
    const logExitMatch = matchTrackedRunExitMarker(logTail, run.exitMarkerPrefix);
    if (logExitMatch) {
      const exitCode = Number.parseInt(logExitMatch[1], 10);
      run.exitCode = exitCode;
      run.completedAt = new Date();
      return exitCode === 0 ? TerminalStatus.COMPLETED : TerminalStatus.ERROR;
    }

    if (detector) {
      const detected = detector.detectStatus(tail);
      if (detected === TerminalStatus.WAITING_PERMISSION || detected === TerminalStatus.WAITING_USER_ANSWER) {
        return detected;
      }
      if (detected === TerminalStatus.ERROR) {
        return TerminalStatus.ERROR;
      }
    }

    const lastNonEmptyLine = this._getLastNonEmptyLine(tail);
    if (isShellContinuationPrompt(lastNonEmptyLine)) {
      run.exitCode = 2;
      run.completedAt = new Date();
      return TerminalStatus.ERROR;
    }

    if (lastNonEmptyLine && /^[\w.-]+@[\w.-]+.*[#$%>]\s*$/.test(lastNonEmptyLine)) {
      if (sawStartMarkerInTail || sawStartMarkerInLog) {
        const hasSubstantiveOutput = this._hasSubstantiveRunOutput(
          [tail, logTail].filter(Boolean).join('\n'),
          detector
        );
        if (hasSubstantiveOutput) {
          if (run.exitCode == null) {
            run.exitCode = 0;
          }
          run.completedAt = new Date();
          return TerminalStatus.COMPLETED;
        }
        if (run.exitCode == null) {
          run.exitCode = 1;
        }
        run.completedAt = new Date();
        return run.exitCode !== 0 ? TerminalStatus.ERROR : TerminalStatus.COMPLETED;
      }
      return TerminalStatus.PROCESSING;
    }

    return TerminalStatus.PROCESSING;
  }

  _hasSubstantiveRunOutput(output, detector) {
    const tail = String(output || '');
    if (!tail) {
      return false;
    }
    if (detector && typeof detector.isStreamingJson === 'function' && detector.isStreamingJson(tail)) {
      const status = detector.detectFromStreamJson(tail);
      if (status === TerminalStatus.COMPLETED) {
        return true;
      }
    }
    if (/⏺\s+|Done\.|Completed\./i.test(tail)) {
      return true;
    }
    return false;
  }

  _buildReuseContext(options = {}) {
    const parentSessionId = options.parentSessionId || null;
    const normalizedAllowedTools = Array.isArray(options.allowedTools)
      ? [...options.allowedTools].map((tool) => String(tool || '').trim()).filter(Boolean).sort()
      : [];
    const sessionLabel = String(
      options.sessionLabel
      || options.sessionMetadata?.sessionLabel
      || ''
    ).trim() || null;

    return {
      rootSessionId: options.rootSessionId || null,
      adapter: options.adapter || 'codex-cli',
      agentProfile: options.agentProfile || null,
      role: options.role || 'worker',
      workDir: path.resolve(options.workDir || this.workDir),
      model: options.model || null,
      sessionKind: deriveControlPlaneSessionKind(options),
      permissionMode: options.permissionMode || 'auto',
      allowedTools: normalizedAllowedTools,
      sessionLabel,
      systemPromptHash: hashSessionShape(options.systemPrompt || '')
    };
  }

  _buildReuseSignature(reuseContext) {
    return hashSessionShape(JSON.stringify(reuseContext || {}));
  }

  _attachReuseInternals(terminal, reuseContext) {
    Object.defineProperty(terminal, '_reuseContext', {
      value: reuseContext,
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_reuseSignature', {
      value: this._buildReuseSignature(reuseContext),
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_resumeCount', {
      value: 0,
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_reservationId', {
      value: null,
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(terminal, '_reservationExpiresAt', {
      value: 0,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  _reserveTerminal(terminal) {
    if (!terminal) {
      return null;
    }

    terminal._reservationId = generateRunId();
    terminal._reservationExpiresAt = Date.now() + this.reuseReservationTtlMs;
    return terminal._reservationId;
  }

  _releaseTerminalReservation(terminal) {
    if (!terminal) {
      return;
    }

    terminal._reservationId = null;
    terminal._reservationExpiresAt = 0;
  }

  _isTerminalReserved(terminal) {
    if (!terminal || !terminal._reservationId) {
      return false;
    }

    if (terminal._reservationExpiresAt > Date.now()) {
      return true;
    }

    this._releaseTerminalReservation(terminal);
    return false;
  }

  _isReusableTerminalStatus(status) {
    return status === TerminalStatus.IDLE || status === TerminalStatus.COMPLETED;
  }

  _findReusableTerminal(options = {}) {
    const preferReuse = options.preferReuse ?? !!options.rootSessionId;
    if (!preferReuse || options.forceFreshSession || !options.rootSessionId) {
      return null;
    }

    const requestedSignature = this._buildReuseSignature(this._buildReuseContext(options));
    for (const terminal of this.terminals.values()) {
      if (!terminal || terminal.rootSessionId !== options.rootSessionId) {
        continue;
      }
      if (!terminal._reuseSignature || terminal._reuseSignature !== requestedSignature) {
        continue;
      }
      if (this._isTerminalReserved(terminal)) {
        continue;
      }

      const currentStatus = this.getStatus(terminal.terminalId);
      if (!this._isReusableTerminalStatus(currentStatus)) {
        continue;
      }

      return terminal;
    }

    return null;
  }

  _getProcessState(terminal) {
    if (!terminal) {
      return 'missing';
    }
    if (!this.tmux?.sessionExists) {
      return 'unknown';
    }
    return this.tmux.sessionExists(terminal.sessionName) ? 'alive' : 'exited';
  }

  _getCurrentCommand(terminal) {
    if (!terminal || typeof this.tmux?.getPaneCurrentCommand !== 'function') {
      return null;
    }
    return this.tmux.getPaneCurrentCommand(terminal.sessionName, terminal.windowName) || null;
  }

  _extractCodexAttention(output) {
    if (!output) {
      return null;
    }

    const detector = this.statusDetectors.get('codex-cli');
    if (detector && typeof detector.extractInterruption === 'function') {
      return detector.extractInterruption(output);
    }

    if (!/Conversation interrupted - tell the model what to do differently\./i.test(output)) {
      return null;
    }

    const resumeMatch = output.match(/To continue this session,\s*run\s*codex resume\s*([0-9a-f-\s]+)/i);
    const resumeSessionId = resumeMatch
      ? String(resumeMatch[1] || '').replace(/\s+/g, '').trim()
      : null;

    return {
      code: 'conversation_interrupted',
      message: 'Conversation interrupted - tell the model what to do differently.',
      resumeCommand: resumeSessionId ? `codex resume ${resumeSessionId}` : null,
      resumeSessionId: resumeSessionId || null
    };
  }

  _extractGeminiAttention(output) {
    if (!output) {
      return null;
    }

    if (/terminalquotaerror|resourceexhausted|quota(?:_exhausted)?|capacity on this model|quota will reset|rate.?limit/i.test(output)) {
      return {
        code: 'provider_capacity',
        message: 'Gemini capacity exhausted or quota limited the request.'
      };
    }

    if (/timed out waiting for terminal|request timed out|timed out/i.test(output)) {
      return {
        code: 'provider_timeout',
        message: 'Gemini orchestration request timed out before the broker observed completion.'
      };
    }

    return null;
  }

  _extractQwenAttention(output) {
    if (!output) {
      return null;
    }

    if (/401 invalid access token|token expired|invalid access token|authentication failed/i.test(output)) {
      return {
        code: 'auth_expired',
        message: 'Qwen access token is invalid or expired.'
      };
    }

    if (/quota|usage limit|rate.?limit/i.test(output)) {
      return {
        code: 'quota_exhausted',
        message: 'Qwen quota or usage limit blocked the request.'
      };
    }

    return null;
  }

  _extractOpencodeAttention(output) {
    if (!output) {
      return null;
    }

    if (/subscriptionusagelimiterror|quota exceeded|continue using free models|rate.?limit|capacity on this model/i.test(output)) {
      return {
        code: 'quota_exhausted',
        message: 'OpenCode provider quota or subscription limits blocked the request.'
      };
    }

    if (/unauthorized|forbidden|authentication failed|not authenticated|login required|invalid api key/i.test(output)) {
      return {
        code: 'auth_expired',
        message: 'OpenCode provider credentials are invalid, expired, or unavailable.'
      };
    }

    if (/timed out|deadline exceeded|request timeout/i.test(output)) {
      return {
        code: 'provider_timeout',
        message: 'OpenCode request timed out before the broker observed completion.'
      };
    }

    if (/no active provider|provider not found|not authenticated/i.test(output)) {
      return {
        code: 'provider_unavailable',
        message: 'OpenCode has no active provider available for this request.'
      };
    }

    return null;
  }

  _getTerminalAttention(terminal, options = {}) {
    if (!terminal) {
      return null;
    }

    const outputSources = [];
    if (typeof options.output === 'string' && options.output.trim()) {
      outputSources.push(options.output);
    }

    if (typeof options.logTail === 'string' && options.logTail.trim()) {
      outputSources.push(options.logTail);
    } else if (terminal.logPath) {
      const recentLog = this.readLogTail(terminal.terminalId, 12000);
      if (recentLog) {
        outputSources.push(recentLog);
      }
    }

    if (!outputSources.length && this.tmux?.getHistory) {
      const history = this.tmux.getHistory(terminal.sessionName, terminal.windowName, 250);
      if (history) {
        outputSources.push(history);
      }
    }

    const cleanedOutput = stripAnsiCodes(outputSources.join('\n'));
    if (!cleanedOutput.trim()) {
      terminal.attention = null;
      return null;
    }

    const lastNonEmptyLine = this._getLastNonEmptyLine(cleanedOutput);
    if (terminal.activeRun && isShellContinuationPrompt(lastNonEmptyLine)) {
      terminal.attention = {
        code: 'shell_parse_blocked',
        message: 'The shell is waiting for more input, likely because the brokered command has unmatched quoting.'
      };
      return terminal.attention;
    }

    let attention = null;
    if (terminal.adapter === 'codex-cli') {
      attention = this._extractCodexAttention(cleanedOutput);
    } else if (terminal.adapter === 'gemini-cli') {
      attention = this._extractGeminiAttention(cleanedOutput);
    } else if (terminal.adapter === 'qwen-cli') {
      attention = this._extractQwenAttention(cleanedOutput);
    } else if (terminal.adapter === 'opencode-cli') {
      attention = this._extractOpencodeAttention(cleanedOutput);
    }

    terminal.attention = attention || null;
    return terminal.attention;
  }

  _buildTerminalResponse(terminal, extra = {}) {
    const taskState = this.getStatus(terminal.terminalId);
    const processState = this._getProcessState(terminal);
    const attention = this._getTerminalAttention(terminal);
    const currentCommand = this._getCurrentCommand(terminal);
    const runtimeMetadata = resolveRuntimeHostMetadata(terminal);
    return {
      terminalId: terminal.terminalId,
      sessionName: terminal.sessionName,
      windowName: terminal.windowName,
      adapter: terminal.adapter,
      agentProfile: terminal.agentProfile,
      role: terminal.role,
      rootSessionId: terminal.rootSessionId,
      parentSessionId: terminal.parentSessionId,
      sessionKind: terminal.sessionKind,
      originClient: terminal.originClient,
      externalSessionRef: terminal.externalSessionRef,
      harnessSessionId: terminal.harnessSessionId || null,
      providerThreadRef: terminal.providerThreadRef || null,
      adoptedAt: terminal.adoptedAt || null,
      captureMode: terminal.captureMode || 'raw-tty',
      runtimeHost: runtimeMetadata.runtimeHost,
      runtimeId: runtimeMetadata.runtimeId,
      runtimeCapabilities: runtimeMetadata.runtimeCapabilities,
      runtimeFidelity: runtimeMetadata.runtimeFidelity,
      runtime: runtimeMetadata.runtime,
      workDir: terminal.workDir || null,
      model: terminal.model || null,
      sessionLabel: terminal.sessionMetadata?.sessionLabel || terminal.sessionLabel || null,
      sessionMetadata: terminal.sessionMetadata || null,
      deferredProviderStart: terminal.deferredProviderStart === true,
      providerStartState: terminal.providerStartState || 'started',
      createdAt: terminal.createdAt || null,
      lastActive: terminal.lastActive || null,
      logPath: terminal.logPath,
      status: taskState,
      taskState,
      processState,
      currentCommand,
      attention,
      reused: false,
      reuseReason: null,
      ...extra
    };
  }

  _reuseTerminal(terminal, options = {}) {
    const resetProviderState = options.resetProviderState === true || shouldResetProviderStateOnReuse(terminal);

    if (resetProviderState) {
      return this._reuseTerminalFresh(terminal, options);
    }

    return this._reuseTerminalContinue(terminal, options);
  }

  _prepareTerminalForReuse(terminal) {
    terminal.lastActive = new Date();
    terminal.status = TerminalStatus.IDLE;
    terminal.recovered = false;
    terminal.attention = null;
    terminal.activeRun = null;
    terminal.deferredProviderStart = false;
    terminal.providerStartState = 'started';
    terminal.pendingProviderCommand = null;
  }

  _refreshReuseSessionMetadata(terminal, sessionMetadata) {
    const nextMetadata = sessionMetadata && typeof sessionMetadata === 'object' && !Array.isArray(sessionMetadata)
      ? { ...sessionMetadata }
      : {};
    const sessionLabel = String(
      nextMetadata.sessionLabel
      || terminal.sessionLabel
      || terminal.sessionMetadata?.sessionLabel
      || ''
    ).trim();

    if (sessionLabel) {
      nextMetadata.sessionLabel = sessionLabel;
    }

    terminal.sessionMetadata = Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
    terminal.sessionLabel = sessionLabel || null;
    return terminal.sessionMetadata;
  }

  _reuseTerminalFresh(terminal, options = {}) {
    this._prepareTerminalForReuse(terminal);
    const sessionMetadata = this._refreshReuseSessionMetadata(terminal, options.sessionMetadata);
    terminal.providerThreadRef = null;
    terminal.messageCount = 0;
    this._reserveTerminal(terminal);
    if (this.db?.updateTerminalBinding) {
      this.db.updateTerminalBinding(terminal.terminalId, {
        providerThreadRef: null,
        status: TerminalStatus.IDLE,
        sessionMetadata: sessionMetadata || {}
      });
    } else if (this.db) {
      this.db.updateStatus(terminal.terminalId, terminal.status || TerminalStatus.IDLE);
    }

    const reuseReason = options.reuseReason || 'matching-root-session-shape';
    this._recordSessionResumed(terminal, {
      reuseReason,
      metadata: options.sessionMetadata || terminal.sessionMetadata || null
    });
    this.emit('terminal-reused', {
      terminalId: terminal.terminalId,
      adapter: terminal.adapter,
      rootSessionId: terminal.rootSessionId,
      reuseReason
    });

    return this._buildTerminalResponse(terminal, {
      reused: true,
      reuseReason
    });
  }

  _reuseTerminalContinue(terminal, options = {}) {
    this._prepareTerminalForReuse(terminal);
    const sessionMetadata = this._refreshReuseSessionMetadata(terminal, options.sessionMetadata);
    this._reserveTerminal(terminal);
    if (this.db?.updateTerminalBinding) {
      this.db.updateTerminalBinding(terminal.terminalId, {
        status: terminal.status || TerminalStatus.IDLE,
        sessionMetadata: sessionMetadata || {}
      });
    } else if (this.db) {
      this.db.updateStatus(terminal.terminalId, terminal.status || TerminalStatus.IDLE);
    }

    const reuseReason = options.reuseReason || 'matching-root-session-shape';
    this._recordSessionResumed(terminal, {
      reuseReason,
      metadata: options.sessionMetadata || terminal.sessionMetadata || null
    });
    this.emit('terminal-reused', {
      terminalId: terminal.terminalId,
      adapter: terminal.adapter,
      rootSessionId: terminal.rootSessionId,
      reuseReason
    });

    return this._buildTerminalResponse(terminal, {
      reused: true,
      reuseReason
    });
  }

  _getAttachedClientCount(sessionName) {
    if (!sessionName) {
      return 0;
    }
    if (typeof this.tmux.getSessionAttachedCount === 'function') {
      return this.tmux.getSessionAttachedCount(sessionName);
    }
    if (typeof this.tmux.listSessions === 'function') {
      const session = this.tmux.listSessions('')
        .find((entry) => entry?.name === sessionName);
      return session?.attached ? 1 : 0;
    }
    return 0;
  }

  async _waitForInteractiveCliReady(terminal) {
    if (!terminal) {
      return;
    }

    const { adapter, role, terminalId, sessionName, windowName } = terminal;

    if (adapter === 'gemini-cli' && role !== 'worker') {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const earlyOutput = this.tmux.getHistory(sessionName, windowName, 1000);
      if (earlyOutput && (earlyOutput.includes('Do you trust') || earlyOutput.includes('Trust folder'))) {
        console.log(`[SessionManager] Gemini trust prompt detected for ${terminalId}, auto-trusting...`);
        this.tmux.sendKeys(sessionName, windowName, '', true);
      }
    }

    try {
      await this.waitForStatus(terminalId, TerminalStatus.IDLE, 60000);
    } catch (error) {
      if (adapter === 'gemini-cli' && role !== 'worker') {
        const output = this.tmux.getHistory(sessionName, windowName, 1000);
        if (output && (output.includes('Do you trust') || output.includes('Trust folder'))) {
          console.log(`[SessionManager] Retrying Gemini trust prompt dismiss for ${terminalId}`);
          this.tmux.sendKeys(sessionName, windowName, '', true);
          try {
            await this.waitForStatus(terminalId, TerminalStatus.IDLE, 30000);
            return;
          } catch (retryError) {
            console.warn(`Terminal ${terminalId} may not be fully ready:`, retryError.message);
            return;
          }
        }
      }

      console.warn(`Terminal ${terminalId} may not be fully ready:`, error.message);
    }
  }

  async _startProviderCommand(terminal, cliCommand, options = {}) {
    if (!terminal || !cliCommand) {
      return false;
    }
    if (!this.terminals.has(terminal.terminalId)) {
      return false;
    }
    if (typeof this.tmux.sessionExists === 'function' && !this.tmux.sessionExists(terminal.sessionName)) {
      return false;
    }
    if (terminal.providerStartState === 'started') {
      return true;
    }

    const useRespawnStart = shouldStartRichProviderViaRespawn(terminal)
      && typeof this.tmux.respawnPane === 'function';
    const startupDelayMs = Number.isInteger(options.startupDelayMs) ? options.startupDelayMs : 0;
    if (!useRespawnStart && startupDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
    }

    terminal.providerStartState = 'starting';
    terminal.deferredProviderStart = false;
    terminal.pendingProviderCommand = null;
    if (useRespawnStart) {
      this.tmux.respawnPane(terminal.sessionName, terminal.windowName, cliCommand, {
        workingDir: terminal.workDir || null
      });
    } else {
      this.tmux.sendKeys(terminal.sessionName, terminal.windowName, cliCommand, true);
    }
    await this._waitForInteractiveCliReady(terminal);
    terminal.providerStartState = 'started';
    return true;
  }

  async _awaitAttachedClientAndStartProvider(terminal, cliCommand, options = {}) {
    if (!terminal || !cliCommand) {
      return false;
    }

    const attachTimeoutMs = Number.isInteger(options.attachTimeoutMs)
      ? options.attachTimeoutMs
      : DEFAULT_DEFERRED_PROVIDER_ATTACH_TIMEOUT_MS;
    const pollIntervalMs = Number.isInteger(options.pollIntervalMs)
      ? options.pollIntervalMs
      : DEFERRED_PROVIDER_ATTACH_POLL_INTERVAL_MS;
    const postAttachDelayMs = Number.isInteger(options.postAttachDelayMs)
      ? options.postAttachDelayMs
      : DEFAULT_POST_ATTACH_PROVIDER_START_DELAY_MS;
    const startedAt = Date.now();

    while ((Date.now() - startedAt) <= attachTimeoutMs) {
      if (!this.terminals.has(terminal.terminalId)) {
        return false;
      }
      if (typeof this.tmux.sessionExists === 'function' && !this.tmux.sessionExists(terminal.sessionName)) {
        return false;
      }
      if (this._getAttachedClientCount(terminal.sessionName) > 0) {
        return this._startProviderCommand(terminal, cliCommand, {
          startupDelayMs: postAttachDelayMs
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    console.warn(
      `[SessionManager] Managed root ${terminal.terminalId} was not attached within ${attachTimeoutMs}ms; starting provider anyway`
    );
    return this._startProviderCommand(terminal, cliCommand, {
      startupDelayMs: postAttachDelayMs
    });
  }

  /**
   * Create a new persistent terminal
   * @param {Object} options
   * @param {string} options.adapter - Adapter name from the active broker surface (gemini-cli, codex-cli, qwen-cli, opencode-cli, claude-code)
   * @param {string} options.agentProfile - Agent profile name (optional)
   * @param {string} options.role - Role (supervisor, worker)
   * @param {string} options.workDir - Working directory
   * @param {string} options.systemPrompt - System prompt
   * @param {string} options.model - Model to use
   * @param {Array<string>} options.allowedTools - Allowed tools list
   * @param {string} options.sessionLabel - Optional stable label for intentionally reusing a specific child session
   * @param {boolean} options.deferProviderStartUntilAttached - Delay provider startup until a tmux client attaches
   * @param {string} options.permissionMode - Permission mode ('auto'|'plan'|'default'|'acceptEdits'|'bypassPermissions'|'delegate'|'dontAsk')
   *   - 'auto' (default): Skip permissions for automated orchestration
   *   - 'plan': Read-only mode, creates plans without executing
   *   - 'default': Use CLI's default permission behavior
   *   - 'bypassPermissions': Skip all permission prompts
   *   - Others: Pass through to CLI
   * @returns {Promise<Object>} - Terminal info
   */
  async createTerminal(options = {}) {
    const {
      adapter = 'codex-cli',
      agentProfile = null,
      role = 'worker',
      workDir = this.workDir,
      systemPrompt = null,
      model = null,
      allowedTools = null,
      sessionLabel = null,
      // Permission mode support (Gap #4 resolution)
      // Modes: 'plan', 'default', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk', 'auto'
      // 'auto' (default) = skip permissions for automated use
      permissionMode = 'auto',
      rootSessionId = null,
      parentSessionId = null,
      sessionKind = null,
      originClient = null,
      externalSessionRef = null,
      providerThreadRef = null,
      lineageDepth = null,
      sessionMetadata = null,
      launchEnvironment = null,
      deferProviderStartUntilAttached = false,
      preferReuse = undefined,
      forceFreshSession = false
    } = options;
    const resolvedSessionLabel = String(sessionLabel || sessionMetadata?.sessionLabel || '').trim() || null;
    const resolvedSessionMetadata = sessionMetadata && typeof sessionMetadata === 'object'
      ? { ...sessionMetadata }
      : {};
    if (resolvedSessionLabel && !resolvedSessionMetadata.sessionLabel) {
      resolvedSessionMetadata.sessionLabel = resolvedSessionLabel;
    }

    const effectiveRootSessionId = rootSessionId || null;

    const controlPlaneEnabled = this.sessionGraphWritesEnabled && (
      !!rootSessionId ||
      !!parentSessionId ||
      !!originClient ||
      !!externalSessionRef
    );

    // Validate adapter
    if (!CLI_COMMANDS[adapter]) {
      throw new Error(`Unknown adapter: ${adapter}. Supported: ${Array.from(SUPPORTED_ORCHESTRATION_ADAPTERS).join(', ')}`);
    }

    if (!SUPPORTED_ORCHESTRATION_ADAPTERS.has(adapter)) {
      throw new Error(`Unsupported adapter: ${adapter}. Managed terminal surface only supports: ${Array.from(SUPPORTED_ORCHESTRATION_ADAPTERS).join(', ')}`);
    }

    // SECURITY: Validate agentProfile if provided (used in window name)
    if (agentProfile) {
      const SAFE_PROFILE_PATTERN = /^[a-zA-Z0-9_-]+$/;
      if (!SAFE_PROFILE_PATTERN.test(agentProfile) || agentProfile.length > 30) {
        throw new Error('Invalid agent profile: only alphanumeric, dash, underscore allowed (max 30 chars)');
      }
    }

    // SECURITY: Validate model name if provided (used as CLI argument)
    if (model) {
      const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9._:@/-]+$/;
      if (!SAFE_MODEL_PATTERN.test(model) || model.length > 100) {
        throw new Error('Invalid model name: only alphanumeric, dot, dash, underscore, slash, colon, and at-sign allowed (max 100 chars)');
      }
    }

    // SECURITY: Validate allowedTools if provided (used as CLI arguments)
    if (allowedTools && Array.isArray(allowedTools)) {
      const SAFE_TOOL_PATTERN = /^[a-zA-Z0-9_-]+$/;
      for (const tool of allowedTools) {
        if (!SAFE_TOOL_PATTERN.test(tool) || tool.length > 50) {
          throw new Error(`Invalid tool name: "${tool}". Only alphanumeric, dash, underscore allowed (max 50 chars)`);
        }
      }
    }

    const recoveryMetadata = resolvedSessionMetadata;
    const recoveredManagedRoot = recoveryMetadata.recoveredManagedRoot === true;
    const resolvedSessionKind = controlPlaneEnabled
      ? deriveControlPlaneSessionKind({
          role,
          parentSessionId,
          sessionKind,
          sessionMetadata: recoveryMetadata
        })
      : 'legacy';
    if (resolvedSessionKind === 'collaborator' && !isCollaboratorReadyAdapter(adapter)) {
      throw new Error(`Adapter '${adapter}' is not collaborator-ready in the current child-session runtime`);
    }
    const effectiveModel = resolveTerminalModel(adapter, role, resolvedSessionKind, model);
    const shouldHonorProviderResumeSessionId = (
      recoveredManagedRoot
      || resolvedSessionKind === 'main'
      || (
        adapter === 'codex-cli'
        && (
          String(recoveryMetadata.providerResumeSessionId || '').trim()
          || String(recoveryMetadata.providerResumeCommand || '').trim()
        )
      )
    );
    const providerResumeSessionId = shouldHonorProviderResumeSessionId
      ? resolveProviderResumeSessionId(adapter, {
          resumeSessionId: recoveryMetadata.providerResumeSessionId,
          resumeCommand: recoveryMetadata.providerResumeCommand
        })
      : null;
    const providerResumeCommand = adapter === 'codex-cli'
      ? String(recoveryMetadata.providerResumeCommand || '').trim() || null
      : null;

    const reusableTerminal = this._findReusableTerminal({
      adapter,
      agentProfile,
      role,
      workDir,
      systemPrompt,
      model: effectiveModel,
      allowedTools,
      sessionLabel: resolvedSessionLabel,
      permissionMode,
      rootSessionId,
      parentSessionId,
      sessionKind,
      preferReuse,
      forceFreshSession
    });
    if (reusableTerminal) {
      const preserveProviderStateOnReuse = resolvedSessionKind === 'main' || resolvedSessionKind === 'collaborator';
      return this._reuseTerminal(reusableTerminal, {
        reuseReason: 'matching-root-session-shape',
        sessionMetadata: Object.keys(resolvedSessionMetadata).length > 0 ? resolvedSessionMetadata : null,
        resetProviderState: !preserveProviderStateOnReuse
      });
    }

    // Generate IDs
    const terminalId = generateTerminalId();
    const resolvedRootSessionId = controlPlaneEnabled ? (effectiveRootSessionId || terminalId) : terminalId;
    const shouldBindManagedRootProviderSessionId = (
      !recoveredManagedRoot
      && supportsManagedRootSessionBinding(adapter)
      && resolvedSessionKind === 'main'
      && (role === 'main' || recoveryMetadata.managedLaunch === true)
    );
    const derivedManagedRootProviderSessionId = shouldBindManagedRootProviderSessionId
      ? normalizeUuid(providerThreadRef || resolvedRootSessionId)
      : null;
    const boundProviderSessionId = normalizeProviderThreadRef(
      adapter,
      providerThreadRef || derivedManagedRootProviderSessionId || null
    );
    const resolvedProviderThreadRef = boundProviderSessionId
      || normalizeProviderThreadRef(adapter, providerResumeSessionId || null)
      || null;
    const shouldResumeLatestProviderSession = Boolean(recoveryMetadata.providerResumeLatest === true) && !providerResumeSessionId;
    const sessionName = `cliagents-${terminalId.slice(0, 6)}`;
    // Truncate prefix to ensure window name stays under 50-char tmux limit
    // Format: prefix (max 23 chars) + dash + terminalId suffix (26 chars) = max 50
    const windowPrefix = (agentProfile || adapter).slice(0, 23);
    const windowName = `${windowPrefix}-${terminalId.slice(6)}`;

    // SECURITY: Validate working directory path
    if (!isPathSafe(workDir)) {
      throw new Error('Invalid working directory: contains dangerous characters');
    }

    // SECURITY: Reject system paths for workDir
    const resolvedWorkDir = path.resolve(workDir);
    const systemPaths = [
      '/etc',
      '/System',
      '/usr',
      '/var',
      '/root',
      '/bin',
      '/sbin',
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.aws'),
      path.join(os.homedir(), '.gnupg'),
      path.join(os.homedir(), '.config')
    ];
    for (const sysPath of systemPaths) {
      if (resolvedWorkDir === sysPath || resolvedWorkDir.startsWith(sysPath + path.sep)) {
        throw new Error(`Invalid working directory: System path ${sysPath} is not allowed`);
      }
    }

    // Ensure working directory exists
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Preserve richer native UI for user-facing managed roots; keep worker/orchestration
    // sessions plain for easier capture, parsing, and browser replay.
    const preserveRichTerminalUi = shouldPreserveRichTerminalUi({
      role,
      sessionKind: resolvedSessionKind,
      sessionMetadata: Object.keys(resolvedSessionMetadata).length > 0 ? resolvedSessionMetadata : null
    });
    const shouldDeferProviderStart = Boolean(
      deferProviderStartUntilAttached
      && preserveRichTerminalUi
      && resolvedSessionKind === 'main'
    );
    const managedRootControlPlaneEnv = buildManagedRootControlPlaneEnv({
      role,
      sessionKind: resolvedSessionKind,
      rootSessionId: resolvedRootSessionId,
      externalSessionRef,
      clientName: originClient || resolvedSessionMetadata?.clientName || null,
      workspaceRoot: workDir,
      sessionMetadata: Object.keys(resolvedSessionMetadata).length > 0 ? resolvedSessionMetadata : null
    });
    const sessionEnv = preserveRichTerminalUi
      ? {
          NO_COLOR: null,
          CI: null,
          ...normalizeLaunchEnvironment(launchEnvironment || resolvedSessionMetadata?.launchEnvironment),
          ...managedRootControlPlaneEnv
        }
      : {
          NO_COLOR: '1',
          ...managedRootControlPlaneEnv
        };
    const launchGeometry = preserveRichTerminalUi
      ? resolveLaunchGeometry(launchEnvironment || resolvedSessionMetadata?.launchEnvironment)
      : null;

    this.tmux.createSession(sessionName, windowName, terminalId, {
      workingDir: workDir,
      env: sessionEnv,
      width: launchGeometry?.width || null,
      height: launchGeometry?.height || null
    });
    if (preserveRichTerminalUi && typeof this.tmux.setSessionStatusVisible === 'function') {
      this.tmux.setSessionStatusVisible(sessionName, false);
    }
    if (launchGeometry && typeof this.tmux.resizePane === 'function') {
      this.tmux.resizePane(sessionName, windowName, launchGeometry.width, launchGeometry.height);
    }

    // Set up logging
    const logPath = path.join(this.logDir, `${terminalId}.log`);
    this.tmux.pipePaneToFile(sessionName, windowName, logPath);

    // Build and execute CLI command
    // Permission mode handling (Gap #4 resolution):
    // - 'auto' (default) or null/undefined: skip permissions for automated orchestration
    // - Other modes: pass through to CLI (e.g., 'plan', 'default', 'bypassPermissions')
    // Treat null/undefined as 'auto' for backwards compatibility
    const effectivePermissionMode = permissionMode || 'auto';
    const cliCommand = CLI_COMMANDS[adapter]({
      role,              // CRITICAL: needed for orchestration mode detection
      systemPrompt,
      model: effectiveModel,
      allowedTools,
      providerSessionId: derivedManagedRootProviderSessionId,
      resumeSessionId: providerResumeSessionId,
      resumeCommand: providerResumeCommand,
      resumePicker: adapter === 'codex-cli'
        && recoveryMetadata.providerResumePicker === true
        && !providerResumeSessionId
        && !shouldResumeLatestProviderSession,
      resumeLatest: shouldResumeLatestProviderSession,
      // Pass permissionMode if not 'auto', otherwise use legacy skip behavior
      permissionMode: effectivePermissionMode !== 'auto' ? effectivePermissionMode : null,
      dangerouslySkipPermissions: effectivePermissionMode === 'auto',
      yoloMode: true,
      autoApprove: true
    });

    // Store terminal info
    const terminal = {
      terminalId,
      sessionName,
      windowName,
      adapter,
      agentProfile,
      role,
      workDir,
      model: effectiveModel,
      systemPrompt,
      allowedTools: Array.isArray(allowedTools) ? [...allowedTools] : null,
      permissionMode: effectivePermissionMode,
      logPath,
      status: TerminalStatus.IDLE,
      createdAt: new Date(),
      lastActive: new Date(),
      activeRun: null,
      messageCount: 0,
      rootSessionId: resolvedRootSessionId,
      parentSessionId: controlPlaneEnabled ? (parentSessionId || null) : null,
      sessionKind: resolvedSessionKind,
      originClient: controlPlaneEnabled ? (originClient || 'system') : 'legacy',
      externalSessionRef: controlPlaneEnabled ? (externalSessionRef || null) : null,
      lineageDepth: Number.isInteger(lineageDepth)
        ? lineageDepth
        : (controlPlaneEnabled && parentSessionId ? 1 : 0),
      sessionMetadata: Object.keys(resolvedSessionMetadata).length > 0 ? resolvedSessionMetadata : null,
      sessionLabel: resolvedSessionLabel,
      harnessSessionId: terminalId,
      providerThreadRef: resolvedProviderThreadRef,
      adoptedAt: null,
      captureMode: 'raw-tty',
      ...resolveRuntimeHostMetadata({
        terminalId,
        sessionName,
        windowName,
        runtimeHost: RUNTIME_HOSTS.TMUX,
        runtimeFidelity: RUNTIME_FIDELITY.MANAGED
      }),
      deferredProviderStart: shouldDeferProviderStart,
      providerStartState: shouldDeferProviderStart ? 'pending_attach' : 'immediate',
      pendingProviderCommand: shouldDeferProviderStart ? cliCommand : null
    };

    this._attachReuseInternals(terminal, this._buildReuseContext({
      adapter,
      agentProfile,
      role,
      workDir,
      systemPrompt,
      model: effectiveModel,
      allowedTools,
      sessionLabel: resolvedSessionLabel,
      permissionMode: effectivePermissionMode,
      rootSessionId: terminal.rootSessionId,
      parentSessionId: terminal.parentSessionId,
      sessionKind: terminal.sessionKind,
      sessionMetadata: terminal.sessionMetadata || null
    }));
    this._reserveTerminal(terminal);

    this.terminals.set(terminalId, terminal);

    // Register in database if available (include workDir and logPath)
    if (this.db) {
      this.db.registerTerminal(
        terminalId,
        sessionName,
        windowName,
        adapter,
        agentProfile,
        role,
        workDir,
        logPath,
        {
          rootSessionId: terminal.rootSessionId,
          parentSessionId: terminal.parentSessionId,
          sessionKind: terminal.sessionKind,
          originClient: terminal.originClient,
          externalSessionRef: terminal.externalSessionRef,
          lineageDepth: terminal.lineageDepth,
          sessionMetadata: terminal.sessionMetadata,
          harnessSessionId: terminal.harnessSessionId,
          model: terminal.model || null,
          providerThreadRef: terminal.providerThreadRef,
          adoptedAt: terminal.adoptedAt,
          captureMode: terminal.captureMode,
          runtimeHost: terminal.runtimeHost,
          runtimeId: terminal.runtimeId,
          runtimeCapabilities: terminal.runtimeCapabilities,
          runtimeFidelity: terminal.runtimeFidelity
        }
      );
    }

    this._recordSessionStarted(terminal);

    // Emit creation event
    this.emit('terminal-created', { terminalId, adapter, role });

    // Give the pane a brief warm-up window before sending the first command.
    // User-facing managed roots get a slightly longer delay to avoid racing slow
    // shell init, while worker/subagent terminals stay fast by default.
    const startupDelayMs = resolveTerminalStartupDelayMs({
      role,
      sessionKind: resolvedSessionKind,
      sessionMetadata: Object.keys(resolvedSessionMetadata).length > 0 ? resolvedSessionMetadata : null
    });

    if (shouldDeferProviderStart) {
      const attachTimeoutMs = resolveDeferredProviderAttachTimeoutMs();
      void this._awaitAttachedClientAndStartProvider(terminal, cliCommand, {
        attachTimeoutMs,
        pollIntervalMs: DEFERRED_PROVIDER_ATTACH_POLL_INTERVAL_MS,
        postAttachDelayMs: Math.min(startupDelayMs || DEFAULT_POST_ATTACH_PROVIDER_START_DELAY_MS, 500)
      }).catch((error) => {
        terminal.providerStartState = 'failed';
        terminal.deferredProviderStart = false;
        console.warn(`Terminal ${terminalId} deferred provider start failed:`, error.message);
      });
    } else {
      await this._startProviderCommand(terminal, cliCommand, {
        startupDelayMs
      });
    }

    return this._buildTerminalResponse(terminal);
  }

  /**
   * Adopt an existing tmux session/window into the broker as a managed terminal.
   * First cut intentionally supports tmux targets with safe names only.
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async adoptTerminal(options = {}) {
    const adapter = options.adapter || 'codex-cli';
    const role = options.role || 'main';
    const sessionKind = options.sessionKind || 'main';
    const sessionName = this._validateAdoptableTmuxName(options.sessionName, 'sessionName');
    const windowName = this._validateAdoptableTmuxName(options.windowName, 'windowName');

    if (!CLI_COMMANDS[adapter]) {
      throw new Error(`Unknown adapter: ${adapter}. Supported: ${Array.from(SUPPORTED_ORCHESTRATION_ADAPTERS).join(', ')}`);
    }

    if (!SUPPORTED_ORCHESTRATION_ADAPTERS.has(adapter)) {
      throw new Error(`Unsupported adapter: ${adapter}. Managed terminal surface only supports: ${Array.from(SUPPORTED_ORCHESTRATION_ADAPTERS).join(', ')}`);
    }

    if (!this.tmux.sessionExists(sessionName)) {
      throw new Error(`tmux session not found: ${sessionName}`);
    }

    const windowExists = this.tmux.listWindows(sessionName).some((window) => window.name === windowName);
    if (!windowExists) {
      throw new Error(`tmux window not found: ${sessionName}:${windowName}`);
    }

    const existingTerminal = Array.from(this.terminals.values()).find((terminal) => (
      terminal.sessionName === sessionName && terminal.windowName === windowName
    ));
    const dbTerminal = !existingTerminal && this.db?.findTerminalByTmuxTarget
      ? this.db.findTerminalByTmuxTarget(sessionName, windowName)
      : null;

    const workDir = options.workDir
      || this.tmux.getPaneDirectory(sessionName, windowName)
      || this.workDir;
    const rootSessionId = options.rootSessionId || generateTerminalId();
    const parentSessionId = options.parentSessionId || null;
    const originClient = options.originClient || 'system';
    const externalSessionRef = options.externalSessionRef || null;
    const lineageDepth = Number.isInteger(options.lineageDepth)
      ? options.lineageDepth
      : (parentSessionId ? 1 : 0);
    const sessionMetadata = options.sessionMetadata && typeof options.sessionMetadata === 'object'
      ? { ...options.sessionMetadata }
      : null;
    const adoptedAt = options.adoptedAt || new Date().toISOString();
    const captureMode = options.captureMode || 'raw-tty';
    const providerThreadRef = options.providerThreadRef || null;
    const runtimeMetadata = resolveRuntimeHostMetadata({
      sessionName,
      windowName,
      adoptedAt,
      runtimeHost: options.runtimeHost || RUNTIME_HOSTS.TMUX,
      runtimeFidelity: options.runtimeFidelity || RUNTIME_FIDELITY.ADOPTED_PARTIAL,
      runtimeCapabilities: options.runtimeCapabilities || null
    });

    const logPath = path.join(this.logDir, `${(existingTerminal?.terminalId || dbTerminal?.terminal_id || generateTerminalId())}.log`);

    let terminal = existingTerminal;
    if (!terminal) {
      if (dbTerminal) {
        const terminalId = dbTerminal.terminal_id || dbTerminal.terminalId;
        terminal = {
          terminalId,
          sessionName,
          windowName,
          adapter: adapter || dbTerminal.adapter,
          agentProfile: dbTerminal.agent_profile || dbTerminal.agentProfile || null,
          role: role || dbTerminal.role || 'main',
          workDir,
          model: options.model || null,
          logPath: dbTerminal.log_path || dbTerminal.logPath || logPath,
          status: dbTerminal.status || TerminalStatus.IDLE,
          createdAt: new Date(dbTerminal.created_at || dbTerminal.createdAt || Date.now()),
          lastActive: new Date(dbTerminal.last_active || dbTerminal.lastActive || Date.now()),
          activeRun: null,
          rootSessionId,
          parentSessionId,
          sessionKind,
          originClient,
          externalSessionRef,
          lineageDepth,
          sessionMetadata,
          harnessSessionId: options.harnessSessionId || dbTerminal.harness_session_id || terminalId,
          providerThreadRef,
          adoptedAt,
          captureMode,
          runtimeHost: runtimeMetadata.runtimeHost,
          runtimeId: runtimeMetadata.runtimeId,
          runtimeCapabilities: runtimeMetadata.runtimeCapabilities,
          runtimeFidelity: runtimeMetadata.runtimeFidelity
        };
        this._attachReuseInternals(terminal, this._buildReuseContext({
          adapter: terminal.adapter,
          agentProfile: terminal.agentProfile,
          role: terminal.role,
          workDir: terminal.workDir,
          model: terminal.model || null,
          allowedTools: [],
          permissionMode: 'default',
          rootSessionId: terminal.rootSessionId,
          parentSessionId: terminal.parentSessionId,
          sessionKind: terminal.sessionKind
        }));
        this.terminals.set(terminalId, terminal);
      } else {
        const terminalId = logPath.match(/([a-f0-9]{32})\.log$/)?.[1] || generateTerminalId();
        terminal = {
          terminalId,
          sessionName,
          windowName,
          adapter,
          agentProfile: null,
          role,
          workDir,
          model: options.model || null,
          logPath,
          status: TerminalStatus.IDLE,
          createdAt: new Date(),
          lastActive: new Date(),
          activeRun: null,
          rootSessionId,
          parentSessionId,
          sessionKind,
          originClient,
          externalSessionRef,
          lineageDepth,
          sessionMetadata,
          harnessSessionId: options.harnessSessionId || terminalId,
          providerThreadRef,
          adoptedAt,
          captureMode,
          runtimeHost: runtimeMetadata.runtimeHost,
          runtimeId: runtimeMetadata.runtimeId || `${sessionName}:${windowName}`,
          runtimeCapabilities: runtimeMetadata.runtimeCapabilities,
          runtimeFidelity: runtimeMetadata.runtimeFidelity
        };
        this._attachReuseInternals(terminal, this._buildReuseContext({
          adapter: terminal.adapter,
          agentProfile: terminal.agentProfile,
          role: terminal.role,
          workDir: terminal.workDir,
          model: terminal.model || null,
          allowedTools: [],
          permissionMode: 'default',
          rootSessionId: terminal.rootSessionId,
          parentSessionId: terminal.parentSessionId,
          sessionKind: terminal.sessionKind
        }));
        this.terminals.set(terminalId, terminal);
      }
    } else {
      terminal.adapter = adapter || terminal.adapter;
      terminal.role = role || terminal.role;
      terminal.workDir = workDir || terminal.workDir;
      terminal.model = options.model || terminal.model || null;
      terminal.rootSessionId = rootSessionId;
      terminal.parentSessionId = parentSessionId;
      terminal.sessionKind = sessionKind;
      terminal.originClient = originClient;
      terminal.externalSessionRef = externalSessionRef;
      terminal.lineageDepth = lineageDepth;
      terminal.sessionMetadata = sessionMetadata;
      terminal.harnessSessionId = options.harnessSessionId || terminal.harnessSessionId || terminal.terminalId;
      terminal.providerThreadRef = providerThreadRef;
      terminal.adoptedAt = adoptedAt;
      terminal.captureMode = captureMode;
      terminal.runtimeHost = runtimeMetadata.runtimeHost;
      terminal.runtimeId = runtimeMetadata.runtimeId || `${sessionName}:${windowName}`;
      terminal.runtimeCapabilities = runtimeMetadata.runtimeCapabilities;
      terminal.runtimeFidelity = runtimeMetadata.runtimeFidelity;
      terminal.lastActive = new Date();
    }

    this.tmux.pipePaneToFile(sessionName, windowName, terminal.logPath);

    if (this.db) {
      if (dbTerminal || existingTerminal) {
        this.db.updateTerminalBinding(terminal.terminalId, {
          adapter: terminal.adapter,
          role: terminal.role,
          model: terminal.model || null,
          workDir: terminal.workDir,
          logPath: terminal.logPath,
          rootSessionId: terminal.rootSessionId,
          parentSessionId: terminal.parentSessionId,
          sessionKind: terminal.sessionKind,
          originClient: terminal.originClient,
          externalSessionRef: terminal.externalSessionRef,
          lineageDepth: terminal.lineageDepth,
          sessionMetadata: terminal.sessionMetadata,
          harnessSessionId: terminal.harnessSessionId,
          providerThreadRef: terminal.providerThreadRef,
          adoptedAt: terminal.adoptedAt,
          captureMode: terminal.captureMode,
          runtimeHost: terminal.runtimeHost,
          runtimeId: terminal.runtimeId,
          runtimeCapabilities: terminal.runtimeCapabilities,
          runtimeFidelity: terminal.runtimeFidelity,
          status: terminal.status
        });
      } else {
        this.db.registerTerminal(
          terminal.terminalId,
          terminal.sessionName,
          terminal.windowName,
          terminal.adapter,
          terminal.agentProfile,
          terminal.role,
          terminal.workDir,
          terminal.logPath,
          {
            rootSessionId: terminal.rootSessionId,
            parentSessionId: terminal.parentSessionId,
            sessionKind: terminal.sessionKind,
            originClient: terminal.originClient,
            externalSessionRef: terminal.externalSessionRef,
            lineageDepth: terminal.lineageDepth,
            sessionMetadata: terminal.sessionMetadata,
            harnessSessionId: terminal.harnessSessionId,
            model: terminal.model || null,
            providerThreadRef: terminal.providerThreadRef,
            adoptedAt: terminal.adoptedAt,
            captureMode: terminal.captureMode,
            runtimeHost: terminal.runtimeHost,
            runtimeId: terminal.runtimeId,
            runtimeCapabilities: terminal.runtimeCapabilities,
            runtimeFidelity: terminal.runtimeFidelity
          }
        );
      }
    }

    this._recordSessionStarted(terminal);
    this._recordSessionAdopted(terminal, {
      metadata: terminal.sessionMetadata || null
    });

    this.getStatus(terminal.terminalId);
    this.emit('terminal-adopted', {
      terminalId: terminal.terminalId,
      adapter: terminal.adapter,
      rootSessionId: terminal.rootSessionId,
      tmuxTarget: `${terminal.sessionName}:${terminal.windowName}`
    });

    return this._buildTerminalResponse(terminal, {
      adopted: true,
      tmuxTarget: `${terminal.sessionName}:${terminal.windowName}`
    });
  }

  /**
   * Recover existing sessions from tmux
   * @returns {Promise<number>} - Number of sessions recovered
   */
  async recoverSessions() {
    const sessions = this.tmux.listSessions('cliagents-');
    let recoveredCount = 0;

    for (const session of sessions) {
      const sessionName = session.name;
      const windows = this.tmux.listWindows(sessionName);
      if (windows.length === 0) continue;
      
      // We assume one window per session for this agent
      const windowName = windows[0].name;

      const envOutput = this.tmux._exec(
        ['show-environment', '-t', sessionName, 'CLIAGENTS_TERMINAL_ID'],
        { ignoreErrors: true, silent: true }
      );
      const envMatch = envOutput ? envOutput.match(/CLIAGENTS_TERMINAL_ID=([^\n]+)/) : null;
      const terminalId = envMatch ? envMatch[1].trim() : null;

      if (!terminalId || terminalId.length !== 32) {
        console.warn(`Skipping session ${sessionName}: Missing CLIAGENTS_TERMINAL_ID`);
        continue;
      }

      const suffix = terminalId.slice(6);
      let prefix = windowName;
      if (windowName.endsWith(`-${suffix}`)) {
        prefix = windowName.slice(0, -(suffix.length + 1));
      } else if (windowName.includes('-')) {
        prefix = windowName.split('-')[0];
      }
      
      const workDir = this.tmux.getPaneDirectory(sessionName, windowName) || this.workDir;
      const logPath = path.join(this.logDir, `${terminalId}.log`);
      
      // Attempt to guess adapter from prefix
      let adapter = prefix; 
      let agentProfile = null;
      
      // If the prefix matches a known adapter, assume it is one.
      if (CLI_COMMANDS[prefix]) {
         adapter = prefix;
      } else {
         // Assume it's a profile and fall back to the default supported coding adapter.
         agentProfile = prefix;
         adapter = 'codex-cli'; // Fallback
      }

      const terminal = {
        terminalId,
        sessionName,
        windowName,
        adapter,
        agentProfile,
        role: 'worker', // Default
        workDir,
        logPath,
        status: TerminalStatus.IDLE, // Reset to IDLE on recovery
        createdAt: session.created,
        lastActive: new Date(),
        activeRun: null
      };
      this._attachReuseInternals(terminal, this._buildReuseContext({
        adapter: terminal.adapter,
        agentProfile: terminal.agentProfile,
        role: terminal.role,
        workDir: terminal.workDir,
        model: terminal.model || null,
        allowedTools: terminal.allowedTools || null,
        permissionMode: terminal.permissionMode || 'auto',
        rootSessionId: terminal.rootSessionId || null,
        parentSessionId: terminal.parentSessionId || null,
        sessionKind: terminal.sessionKind || 'legacy'
      }));
      this.terminals.set(terminalId, terminal);
      recoveredCount++;
    }
    
    return recoveredCount;
  }

  /**
   * Send input to a terminal
   * @param {string} terminalId - Terminal ID
   * @param {string} message - Message to send
   * @param {Object} options - Additional options
   * @param {string} options.traceId - Trace ID for multi-agent workflows
   * @param {Object} options.metadata - Additional metadata
   */
  async sendInput(terminalId, message, options = {}) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    const currentStatus = this.getStatus(terminalId);
    if (
      currentStatus === TerminalStatus.PROCESSING
      || currentStatus === TerminalStatus.WAITING_PERMISSION
      || currentStatus === TerminalStatus.WAITING_USER_ANSWER
    ) {
      throw buildTerminalBusyError(terminalId, currentStatus);
    }

    this._releaseTerminalReservation(terminal);

    // For orchestration terminals, use non-interactive mode to avoid blocking prompts
    const isGeminiOrchestration = terminal.adapter === 'gemini-cli' && terminal.role === 'worker';
    const isClaudeOrchestration = terminal.adapter === 'claude-code' && terminal.role === 'worker';
    const isCodexOrchestration = terminal.adapter === 'codex-cli' && terminal.role === 'worker';
    const isQwenOrchestration = terminal.adapter === 'qwen-cli' && terminal.role === 'worker';
    const isOpencodeOrchestration = terminal.adapter === 'opencode-cli' && terminal.role === 'worker';
    const preservesProviderConversation = terminal.sessionKind === 'collaborator';

    if (
      (isGeminiOrchestration || isClaudeOrchestration || isQwenOrchestration || isOpencodeOrchestration)
      && Number.isInteger(terminal.messageCount)
      && terminal.messageCount > 0
    ) {
      const detector = this.statusDetectors.get(terminal.adapter);
      const recentOutput = [
        this.tmux?.getHistory ? this.tmux.getHistory(terminal.sessionName, terminal.windowName, 250) : '',
        terminal.logPath ? this.readLogTail(terminal.terminalId, 12000) : ''
      ].filter(Boolean).join('\n');
      this._syncProviderThreadRefFromOutput(terminal, recentOutput, detector);
    }

    if (isGeminiOrchestration) {
      // Run Gemini one-shot work through the helper so tmux workers get the same
      // model fallback behavior as the direct-session adapter path.
      const geminiCommand = buildGeminiOneShotRunnerCommand(message, {
        ...terminal,
        disableSessionResume: !preservesProviderConversation
      });
      terminal.messageCount = Number.isInteger(terminal.messageCount) ? terminal.messageCount + 1 : 1;

      // Send the tracked one-shot command
      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, geminiCommand),
        true
      );
    } else if (isClaudeOrchestration) {
      const claudeCommand = buildClaudeOneShotCommand(message, terminal);
      if (claudeCommand.providerThreadRef && claudeCommand.providerThreadRef !== terminal.providerThreadRef) {
        this._updateProviderThreadRef(terminal, claudeCommand.providerThreadRef);
      }
      terminal.messageCount = Number.isInteger(terminal.messageCount) ? terminal.messageCount + 1 : 1;

      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, claudeCommand.command),
        true
      );
    } else if (isCodexOrchestration) {
      const codexCommand = buildCodexOneShotCommand(message, terminal);
      terminal.messageCount = Number.isInteger(terminal.messageCount) ? terminal.messageCount + 1 : 1;

      // Send the tracked one-shot command
      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, codexCommand),
        true
      );
    } else if (isQwenOrchestration) {
      const qwenCommand = buildQwenOneShotCommand(message, terminal);
      terminal.messageCount = Number.isInteger(terminal.messageCount) ? terminal.messageCount + 1 : 1;

      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, qwenCommand),
        true
      );
    } else if (isOpencodeOrchestration) {
      const opencodeCommand = buildOpencodeOneShotCommand(message, terminal);
      terminal.messageCount = Number.isInteger(terminal.messageCount) ? terminal.messageCount + 1 : 1;

      this.tmux.sendKeys(
        terminal.sessionName,
        terminal.windowName,
        this._wrapTrackedOneShotCommand(terminal, opencodeCommand),
        true
      );
    } else {
      // Normal interactive mode: just send the message
      terminal.activeRun = null;
      this.tmux.sendKeys(terminal.sessionName, terminal.windowName, message, true);
    }

    // Update status
    terminal.status = TerminalStatus.PROCESSING;
    terminal.lastActive = new Date();

    if (this.db) {
      this.db.updateStatus(terminalId, TerminalStatus.PROCESSING);

      // Store input message in conversation history
      this.db.addMessage(terminalId, 'user', message, {
        traceId: options.traceId || null,
        metadata: {
          agentProfile: terminal.agentProfile,
          adapter: terminal.adapter,
          ...options.metadata
        }
      });
    }

    if (this._supportsInteractiveTranscriptSync(terminal)) {
      const syncState = this._ensureInteractiveTranscriptState(terminal);
      if (syncState) {
        syncState.latestUserContent = this._normalizeMessageContent(message);
        syncState.awaitingAssistant = true;
      }
    }

    this.emit('input-sent', { terminalId, message });
  }

  /**
   * Send a special key to a terminal
   * @param {string} terminalId - Terminal ID
   * @param {string} key - Key to send (Enter, Tab, C-c, etc.)
   */
  sendSpecialKey(terminalId, key) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    this.tmux.sendSpecialKey(terminal.sessionName, terminal.windowName, key);
    terminal.lastActive = new Date();
  }

  /**
   * Get terminal output/history
   * @param {string} terminalId - Terminal ID
   * @param {number} lines - Number of lines to retrieve
   * @returns {string} - Terminal output
   */
  getOutput(terminalId, lines = 200, options = null) {
    const outputOptions = normalizeTerminalOutputOptions(lines, options);
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    const reconciledTerminal = this._reconcileTerminalBacking(terminal);
    if (!reconciledTerminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    if (reconciledTerminal.status === 'orphaned') {
      const requestedBytes = Math.max(Number(outputOptions.lines) * 200, MIN_ORPHANED_LOG_TAIL_BYTES);
      const output = this.readLogTail(terminalId, Math.min(requestedBytes, MAX_ORPHANED_LOG_TAIL_BYTES));
      return outputOptions.format === 'ansi' ? output : stripAnsiCodes(output);
    }

    const preserveAnsi = outputOptions.format === 'ansi';
    if (outputOptions.mode === 'visible') {
      return this.tmux.getVisibleContent(
        reconciledTerminal.sessionName,
        reconciledTerminal.windowName,
        { preserveAnsi }
      );
    }

    return this.tmux.getHistory(
      reconciledTerminal.sessionName,
      reconciledTerminal.windowName,
      outputOptions.lines,
      { preserveAnsi }
    );
  }

  /**
   * Get current status of a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {string} - Status
   */
  getStatus(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    const reconciledTerminal = this._reconcileTerminalBacking(terminal);
    if (!reconciledTerminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    if (reconciledTerminal.status === 'orphaned') {
      return 'orphaned';
    }

    const output = this.getOutput(terminalId);
    // Use status detector if available
    const detector = this.statusDetectors.get(reconciledTerminal.adapter);
    this._syncEffectiveModelFromOutput(reconciledTerminal, output, { source: 'terminal-output' });
    this._restoreTrackedRunFromPersistence(reconciledTerminal, output, detector);
    const trackedRunStatus = this._detectTrackedRunStatus(reconciledTerminal, output, detector);
    const attention = this._getTerminalAttention(reconciledTerminal, { output });
    if (trackedRunStatus) {
      this._syncInteractiveTranscript(reconciledTerminal, output, trackedRunStatus);
      this._applyStatusUpdate(reconciledTerminal, trackedRunStatus, {
        exitCode: reconciledTerminal.activeRun?.exitCode ?? null,
        attention
      });
      return trackedRunStatus;
    }

    if (detector) {
      const detectedStatus = detector.detectStatus(output);
      this._syncInteractiveTranscript(reconciledTerminal, output, detectedStatus);

      // Update cached status
      this._applyStatusUpdate(reconciledTerminal, detectedStatus, { attention });

      return detectedStatus;
    }

    // Return cached status if no detector
    return reconciledTerminal.status;
  }

  /**
   * Wait for a specific status
   * @param {string} terminalId - Terminal ID
   * @param {string} targetStatus - Status to wait for
   * @param {number} timeoutMs - Timeout in milliseconds
   * @param {Object} options - Additional options
   * @param {boolean} options.assumeProcessingStarted - If true, assume processing has started
   *   (useful when there's been a delay after sending input)
   * @returns {Promise<void>}
   */
  async waitForStatus(terminalId, targetStatus, timeoutMs = 60000, options = {}) {
    const { assumeProcessingStarted = false } = options;
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const pollInterval = 500;
      let consecutiveErrors = 0;
      const errorThreshold = 3; // Require 3 consecutive ERROR readings before aborting
      let sawProcessing = assumeProcessingStarted; // Track if we've seen PROCESSING state

      const check = () => {
        try {
          const elapsed = Date.now() - startTime;
          if (elapsed > timeoutMs) {
            const error = new Error(`Timeout waiting for status '${targetStatus}' after ${timeoutMs}ms`);
            error.code = 'terminal_timeout';
            error.terminalId = terminalId;
            reject(error);
            return;
          }

          const currentStatus = this.getStatus(terminalId);

          // Track if we've seen PROCESSING (important for IDLE-as-COMPLETED detection)
          if (currentStatus === TerminalStatus.PROCESSING) {
            sawProcessing = true;
          }

          if (currentStatus === targetStatus) {
            resolve();
            return;
          }

          // Also accept 'completed' if waiting for 'idle' (completed implies ready for new input)
          if (targetStatus === TerminalStatus.IDLE && currentStatus === TerminalStatus.COMPLETED) {
            resolve();
            return;
          }

          // Also accept 'idle' if waiting for 'completed' (idle after task means task is done)
          // BUT only if we've seen PROCESSING first - this prevents accepting the initial
          // IDLE state before the CLI starts processing the input
          if (targetStatus === TerminalStatus.COMPLETED && currentStatus === TerminalStatus.IDLE && sawProcessing) {
            resolve();
            return;
          }

          // Error status should abort only if sustained (3 consecutive checks)
          // This prevents false positives from transient ERROR-looking output during CLI startup
          if (currentStatus === TerminalStatus.ERROR) {
            consecutiveErrors++;
            // Log what the detector is seeing for debugging
            const termInfo = this.terminals.get(terminalId);
            if (termInfo && ENABLE_STATUS_DEBUG_LOGS) {
              const output = this.tmux.getHistory(termInfo.sessionName, termInfo.windowName, 500);
              console.log(`[DEBUG] Terminal ${terminalId} (${termInfo.adapter}) ERROR detected (${consecutiveErrors}/${errorThreshold}), waiting for ${targetStatus}`);

              // Show which patterns are matching
              const detector = this.statusDetectors.get(termInfo.adapter);
              if (detector && detector.getMatchingPatterns) {
                const matchingPatterns = detector.getMatchingPatterns(output);
                console.log(`[DEBUG] Matching patterns:`, matchingPatterns);
              }

              console.log(`[DEBUG] Last 500 chars:`, JSON.stringify(output.slice(-500)));
            }
            if (consecutiveErrors >= errorThreshold) {
              reject(new Error('Terminal entered error state'));
              return;
            }
          } else {
            if (consecutiveErrors > 0 && ENABLE_STATUS_DEBUG_LOGS) {
              console.log(`[DEBUG] Terminal ${terminalId} status=${currentStatus}, resetting error count from ${consecutiveErrors}`);
            }
            consecutiveErrors = 0; // Reset on non-error status
          }

          setTimeout(check, pollInterval);
        } catch (error) {
          reject(error);
        }
      };

      check();
    });
  }

  /**
   * Wait for a terminal to complete its current task and return output
   * @param {string} terminalId - Terminal ID
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<string>} - Terminal output
   */
  async waitForCompletion(terminalId, timeoutMs = 300000) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    // Wait for CLI to start processing the input
    // This prevents accepting IDLE as "completed" before the CLI starts working
    // Different CLIs have different response times
    const processingDelays = {
      'codex-cli': 5000,    // Codex is slower to start processing
      'gemini-cli': 3000,   // Gemini is moderate
      'qwen-cli': 3000      // Qwen is moderate
    };
    const processingDelay = processingDelays[terminal.adapter] || 3000;
    await new Promise(resolve => setTimeout(resolve, processingDelay));

    // Wait for idle or completed status
    try {
      await this.waitForStatus(terminalId, TerminalStatus.COMPLETED, timeoutMs);
    } catch (error) {
      if (error?.code === 'terminal_timeout' && this._shouldTrackModelHealth(terminal)) {
        this.modelRoutingService.recordModelFailure({
          adapter: terminal.adapter,
          model: terminal.model,
          failureClass: 'timeout',
          reason: error.message
        });
      }
      throw error;
    }

    // Capture and return output
    const output = this.tmux.getHistory(terminal.sessionName, terminal.windowName, 500);

    // Try to extract just the response (adapter-specific parsing)
    return this._extractResponse(output, terminal.adapter);
  }

  /**
   * Extract response from terminal output (adapter-specific)
   * @param {string} output - Raw terminal output
   * @param {string} adapter - Adapter name
   * @returns {string} - Extracted response
   */
  _extractResponse(output, adapter) {
    // Use unified output extractor utility
    return extractOutput(output, adapter);
  }

  /**
   * Extract response from Codex CLI output
   * Codex shows responses after "• " bullet markers
   * Skip processing indicators like "Explored", "Working", "Reading"
   */
  _extractCodexResponse(output) {
    const lines = output.split('\n');
    const responseLines = [];
    let inResponse = false;
    let foundResponse = false;

    // Processing indicators to skip (these appear during work, not in final response)
    const skipPatterns = [
      /^•\s*(Explored|Working|Reading|Exploring|Acknowledging)/i,
      /^\s*└/,  // Tree structure indicators
      /esc to interrupt/i,
      /^─.*Worked for/  // Progress separator
    ];

    for (const line of lines) {
      // Skip processing indicators
      if (skipPatterns.some(p => p.test(line))) {
        continue;
      }

      // Start capturing at bullet points (Codex response format)
      if (line.startsWith('•')) {
        inResponse = true;
        foundResponse = true;
        responseLines.push(line);
      } else if (inResponse) {
        // Stop at the next prompt indicator
        if (line.startsWith('›') || line.includes('context left') || line.includes('? for shortcuts')) {
          inResponse = false;
        } else {
          responseLines.push(line);
        }
      }
    }

    return foundResponse ? responseLines.join('\n').trim() : output;
  }

  /**
   * Extract response from Gemini CLI output
   * Gemini shows responses with ✦ markers or plain text after prompts
   */
  _extractGeminiResponse(output) {
    const lines = output.split('\n');
    const responseLines = [];
    let foundResponse = false;

    for (const line of lines) {
      // Gemini response markers
      if (line.startsWith('✦') || line.startsWith('✓')) {
        foundResponse = true;
        responseLines.push(line);
      } else if (foundResponse) {
        // Stop at input box indicators
        if (line.includes('Type your message') || line.includes('╭─') || line.includes('╰─')) {
          break;
        }
        responseLines.push(line);
      }
    }

    return foundResponse ? responseLines.join('\n').trim() : output;
  }

  /**
   * Extract response from Claude Code output
   * Claude shows responses with ⏺ markers
   */
  _extractClaudeResponse(output) {
    const lines = output.split('\n');
    const responseLines = [];
    let inResponse = false;
    let foundResponse = false;

    for (const line of lines) {
      // Claude response markers
      if (line.includes('⏺')) {
        inResponse = true;
        foundResponse = true;
        responseLines.push(line);
      } else if (inResponse) {
        // Stop at prompt indicators
        if (line.startsWith('❯') || line.includes('────────') && !line.includes('⏺')) {
          inResponse = false;
        } else {
          responseLines.push(line);
        }
      }
    }

    return foundResponse ? responseLines.join('\n').trim() : output;
  }

  /**
   * Get terminal info
   * @param {string} terminalId - Terminal ID
   * @returns {Object} - Terminal info
   */
  getTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return null;
    }

    const reconciledTerminal = this._reconcileTerminalBacking(terminal);
    if (!reconciledTerminal) {
      return null;
    }

    const taskState = this.getStatus(terminalId);
    const attention = this._getTerminalAttention(reconciledTerminal);
    const runtimeMetadata = resolveRuntimeHostMetadata(reconciledTerminal);
    return {
      ...reconciledTerminal,
      ...runtimeMetadata,
      status: taskState,
      taskState,
      processState: this._getProcessState(reconciledTerminal),
      currentCommand: this._getCurrentCommand(reconciledTerminal),
      attention
    };
  }

  /**
   * List all terminals
   * @returns {Array} - List of terminal info objects
   */
  listTerminals() {
    return Array.from(this.terminals.values())
      .map((terminal) => this._reconcileTerminalBacking(terminal))
      .filter(Boolean)
      .map((terminal) => {
        const taskState = this.getStatus(terminal.terminalId);
        const attention = this._getTerminalAttention(terminal);
        const runtimeMetadata = resolveRuntimeHostMetadata(terminal);
        return {
          ...terminal,
          ...runtimeMetadata,
          status: taskState,
          taskState,
          processState: this._getProcessState(terminal),
          currentCommand: this._getCurrentCommand(terminal),
          attention
        };
      });
  }

  /**
   * Destroy a terminal
   * @param {string} terminalId - Terminal ID
   */
  async destroyTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    const currentStatus = this.getStatus(terminalId);
    const visibleOutput = this.getOutput(terminalId, {
      mode: 'visible',
      format: 'plain',
      lines: 120
    });
    const historyOutput = visibleOutput || this.getOutput(terminalId, {
      mode: 'history',
      format: 'plain',
      lines: 120
    });
    const activityExcerpt = summarizeMessage(stripAnsiCodes(historyOutput || ''), 320) || null;
    const currentCommand = this._getCurrentCommand(terminal);
    const attention = this._getTerminalAttention(terminal, { output: historyOutput });
    const activitySummary = attention?.message
      || summarizeTerminalActivity(historyOutput, 240)
      || (currentCommand
        ? `${String(currentStatus || 'unknown')} at ${currentCommand}`
        : `${String(currentStatus || 'unknown')} terminal destroyed`);

    this._recordSessionEvent({
      rootSessionId: terminal.rootSessionId || terminal.terminalId,
      sessionId: terminal.terminalId,
      parentSessionId: terminal.parentSessionId || null,
      eventType: 'session_destroyed',
      originClient: terminal.originClient || 'legacy',
      idempotencyKey: this._buildSessionEventIdempotencyKey(
        terminal.rootSessionId || terminal.terminalId,
        terminal.terminalId,
        'session_destroyed',
        terminal.activeRun?.runId || 'destroy'
      ),
      payloadSummary: `${terminal.adapter} session destroyed`,
      payloadJson: {
        adapter: terminal.adapter,
        status: currentStatus,
        activitySummary,
        activityExcerpt,
        activitySource: historyOutput ? 'output' : 'fallback',
        resumeCommand: attention?.resumeCommand || null,
        providerThreadRef: terminal.providerThreadRef || null
      },
      metadata: terminal.sessionMetadata || null
    });

    // Kill tmux session
    this.tmux.killSession(terminal.sessionName);

    // Remove from registry
    this.terminals.delete(terminalId);

    // Remove from database if available
    if (this.db) {
      this.db.deleteTerminal(terminalId);
    }

    this.emit('terminal-destroyed', { terminalId });
    return true;
  }

  _shouldPreserveTerminalOnStop(terminal) {
    if (!terminal) {
      return false;
    }
    const sessionKind = String(terminal.sessionKind || '').trim().toLowerCase();
    const metadata = terminal.sessionMetadata && typeof terminal.sessionMetadata === 'object'
      ? terminal.sessionMetadata
      : null;
    return Boolean(
      metadata?.managedLaunch
      || sessionKind === 'main'
      || sessionKind === 'attach'
    );
  }

  /**
   * Destroy all terminals
   */
  async destroyAllTerminals(options = {}) {
    const preserveManagedRoots = options.preserveManagedRoots === true;
    for (const terminalId of Array.from(this.terminals.keys())) {
      const terminal = this.terminals.get(terminalId);
      if (preserveManagedRoots && this._shouldPreserveTerminalOnStop(terminal)) {
        continue;
      }
      await this.destroyTerminal(terminalId);
    }
  }

  /**
   * Clean up stale terminals
   * @param {number} maxAgeMs - Maximum age in milliseconds
   * @returns {number} - Number of terminals cleaned up
   */
  cleanupStaleTerminals(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;

    for (const [terminalId, terminal] of this.terminals) {
      const age = now - terminal.createdAt.getTime();
      if (age > maxAgeMs) {
        this.destroyTerminal(terminalId);
        cleaned++;
      }
    }

    // Also clean up orphan tmux sessions
    cleaned += this.tmux.cleanupStaleSessions(maxAgeMs);

    return cleaned;
  }

  /**
   * Read log file for a terminal
   * @param {string} terminalId - Terminal ID
   * @returns {string} - Log content
   */
  readLog(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || !terminal.logPath) {
      return '';
    }

    try {
      return fs.readFileSync(terminal.logPath, 'utf8');
    } catch (error) {
      return '';
    }
  }

  /**
   * Read last N bytes from log file
   * @param {string} terminalId - Terminal ID
   * @param {number} bytes - Number of bytes
   * @returns {string} - Log tail
   */
  readLogTail(terminalId, bytes = 5000) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || !terminal.logPath) {
      return '';
    }

    try {
      const stats = fs.statSync(terminal.logPath);
      const size = stats.size;
      const start = Math.max(0, size - bytes);

      const fd = fs.openSync(terminal.logPath, 'r');
      const buffer = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);

      return buffer.toString('utf8');
    } catch (error) {
      return '';
    }
  }

  /**
   * Attach to a terminal (for debugging)
   * Returns the tmux attach command
   * @param {string} terminalId - Terminal ID
   * @returns {string} - Command to attach
   */
  getAttachCommand(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }

    const tmuxPrefix = this.tmux?.socketPath
      ? `tmux -S ${JSON.stringify(this.tmux.socketPath)}`
      : 'tmux';

    return `${tmuxPrefix} attach -t ${JSON.stringify(terminal.sessionName)}`;
  }
}

module.exports = {
  PersistentSessionManager,
  TerminalStatus,
  generateTerminalId,
  resolveTerminalStartupDelayMs,
  extractProviderThreadRefFromOutput,
  normalizeProviderThreadRef,
  inferEffectiveModelFromOutput,
  buildGeminiOneShotRunnerCommand,
  buildClaudeOneShotCommand,
  buildCodexOneShotCommand,
  buildQwenOneShotCommand,
  buildOpencodeOneShotCommand,
  // Export for testing
  CLI_COMMANDS
};
