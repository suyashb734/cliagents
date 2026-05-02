#!/usr/bin/env node
/**
 * cliagents MCP Server
 *
 * Exposes cliagents orchestration as MCP tools that Claude Code can invoke.
 * This allows Claude to delegate tasks to other AI agents (Gemini, Codex, etc.)
 *
 * Usage:
 *   Add to Claude Code's MCP settings:
 *   {
 *     "mcpServers": {
 *       "cliagents": {
 *         "command": "node",
 *         "args": ["/path/to/cliagents-mcp-server.js"],
 *         "env": {
 *           "CLIAGENTS_URL": "http://localhost:4001"
 *         }
 *       }
 *     }
 *   }
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { ACTIVE_BROKER_ADAPTERS } = require('../adapters/active-surface');
const { getSkillsService } = require('../services/skills-service');
const { extractOutput } = require('../utils/output-extractor');
const {
  resolveManagedRootLaunchTarget,
  launchManagedRootSession,
  buildManagedRootRecoveryLaunchOptions,
  buildManagedRootContextLaunchOptions
} = require('../index');

const CLIAGENTS_URL = process.env.CLIAGENTS_URL || 'http://localhost:4001';
const CLIAGENTS_API_KEY = process.env.CLIAGENTS_API_KEY || process.env.CLI_AGENTS_API_KEY || null;
const MCP_POLL_INTERVAL_MS = parseInt(process.env.CLIAGENTS_MCP_POLL_MS || '3000', 10);
const MCP_SYNC_WAIT_MS = parseInt(process.env.CLIAGENTS_MCP_SYNC_WAIT_MS || '25000', 10);
const MCP_STATUS_RETRY_AFTER_MS = parseInt(process.env.CLIAGENTS_MCP_RETRY_AFTER_MS || String(Math.max(MCP_POLL_INTERVAL_MS * 2, 8000)), 10);
const SESSION_GRAPH_WRITES_ENABLED = process.env.SESSION_GRAPH_WRITES_ENABLED === '1';
const REQUIRE_ROOT_ATTACH = process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH === '1';

// Default timeouts for different task types (in seconds)
const TIMEOUTS = {
  simple: 180,      // 3 min - simple questions, quick lookups
  standard: 600,    // 10 min - code analysis, reviews
  complex: 1800,    // 30 min - multi-file analysis, large codebases
  unlimited: 0      // No timeout (use async mode instead)
};

// MCP Protocol helpers
function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: { code, message }
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

// HTTP client for cliagents API
async function callCliagents(method, path, body = null, requestTimeout = 600000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CLIAGENTS_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (CLIAGENTS_API_KEY) {
      headers['Authorization'] = `Bearer ${CLIAGENTS_API_KEY}`;
      headers['X-API-Key'] = CLIAGENTS_API_KEY;
    }
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: requestTimeout // Configurable timeout for long-running tasks
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Retry wrapper for quick operations (shared memory, etc.)
async function callWithRetry(method, path, body = null, maxRetries = 3, timeout = 30000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callCliagents(method, path, body, timeout);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedMcpRootContext = null;

function inferClientNameFromEnvironment() {
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) {
    return 'codex';
  }
  if (process.env.CLAUDE_THREAD_ID || process.env.CLAUDE_SESSION_ID) {
    return 'claude';
  }
  if (process.env.OPENCODE_THREAD_ID || process.env.OPENCODE_SESSION_ID) {
    return 'opencode';
  }
  if (process.env.QWEN_THREAD_ID || process.env.QWEN_SESSION_ID) {
    return 'qwen';
  }
  if (process.env.GEMINI_THREAD_ID || process.env.GEMINI_SESSION_ID) {
    return 'gemini';
  }
  return null;
}

function inferMcpClientName() {
  return process.env.CLIAGENTS_CLIENT_NAME
    || process.env.MCP_CLIENT_NAME
    || process.env.CLIENT_NAME
    || inferClientNameFromEnvironment()
    || 'mcp-client';
}

function normalizeOriginClient(clientName, fallbackOriginClient = null) {
  const normalizedClient = String(clientName || '').trim().toLowerCase();
  if (!normalizedClient) {
    return fallbackOriginClient || 'mcp';
  }

  if (normalizedClient === 'mcp' || normalizedClient === 'mcp-client') {
    return fallbackOriginClient || 'mcp';
  }

  if (normalizedClient.includes('codex')) return 'codex';
  if (normalizedClient.includes('claude')) return 'claude';
  if (normalizedClient.includes('opencode')) return 'opencode';
  if (normalizedClient.includes('qwen')) return 'qwen';
  if (normalizedClient.includes('gemini')) return 'gemini';
  if (normalizedClient.includes('openclaw')) return 'openclaw';

  return normalizedClient;
}

function inferClientNameFromSessionRef(externalSessionRef) {
  const normalizedRef = String(externalSessionRef || '').trim().toLowerCase();
  if (!normalizedRef) {
    return null;
  }

  if (normalizedRef.startsWith('codex') || normalizedRef.includes(':codex:')) return 'codex';
  if (normalizedRef.startsWith('claude') || normalizedRef.includes(':claude:')) return 'claude';
  if (normalizedRef.startsWith('opencode') || normalizedRef.includes(':opencode:')) return 'opencode';
  if (normalizedRef.startsWith('qwen') || normalizedRef.includes(':qwen:')) return 'qwen';
  if (normalizedRef.startsWith('gemini') || normalizedRef.includes(':gemini:')) return 'gemini';
  if (normalizedRef.startsWith('openclaw') || normalizedRef.includes(':openclaw:')) return 'openclaw';

  return null;
}

function inferWorkspaceRoot() {
  return process.env.CLIAGENTS_WORKSPACE_ROOT
    || process.env.PROJECT_ROOT
    || process.cwd();
}

function hasExplicitRootOverrides() {
  return Boolean(
    process.env.CLIAGENTS_ROOT_SESSION_ID
    || process.env.CLIAGENTS_CLIENT_SESSION_REF
  );
}

function inferMcpSessionScope() {
  return process.env.CLIAGENTS_MCP_SESSION_SCOPE
    || process.env.CLIAGENTS_SESSION_SCOPE
    || process.env.CLIAGENTS_CLIENT_THREAD_ID
    || process.env.CODEX_THREAD_ID
    || process.env.MCP_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || process.env.CLAUDE_THREAD_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.OPENCODE_THREAD_ID
    || process.env.OPENCODE_SESSION_ID
    || process.env.QWEN_THREAD_ID
    || process.env.QWEN_SESSION_ID
    || process.env.TERM_SESSION_ID
    || `ppid:${process.ppid || 'unknown'}`;
}

function buildStickyExternalSessionRef(clientName, workspaceRoot, sessionScope = inferMcpSessionScope()) {
  const digest = crypto
    .createHash('sha1')
    .update(`${clientName}|${workspaceRoot}|${sessionScope}`)
    .digest('hex')
    .slice(0, 12);
  return `${clientName}:session:${digest}`;
}

function getMcpRootStateDir() {
  return process.env.CLIAGENTS_MCP_STATE_DIR
    || path.join(os.homedir(), '.cliagents', 'mcp-state');
}

function getMcpRootStateFilePath(
  clientName = inferMcpClientName(),
  workspaceRoot = inferWorkspaceRoot(),
  sessionScope = inferMcpSessionScope()
) {
  const digest = crypto
    .createHash('sha1')
    .update(`${clientName}|${workspaceRoot}|${sessionScope}`)
    .digest('hex')
    .slice(0, 16);
  const safeClient = clientName.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const safeScope = String(sessionScope).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 32) || 'session';
  return path.join(getMcpRootStateDir(), `${safeClient}-${safeScope}-${digest}.json`);
}

function loadPersistedRootContext() {
  const filePath = getMcpRootStateFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.rootSessionId) {
      return null;
    }

    const clientName = parsed.clientName || inferMcpClientName();
    const workspaceRoot = inferWorkspaceRoot();
    const sessionScope = parsed.sessionScope || inferMcpSessionScope();
    const externalSessionRef = parsed.externalSessionRef || buildStickyExternalSessionRef(clientName, workspaceRoot, sessionScope);
    const sessionMetadata = parsed.sessionMetadata && typeof parsed.sessionMetadata === 'object'
      ? { ...parsed.sessionMetadata }
      : {};
    if (!sessionMetadata.clientName) {
      sessionMetadata.clientName = clientName;
    }
    if (!sessionMetadata.clientSessionRef) {
      sessionMetadata.clientSessionRef = externalSessionRef;
    }
    if (!sessionMetadata.externalSessionRef) {
      sessionMetadata.externalSessionRef = externalSessionRef;
    }
    if (!sessionMetadata.workspaceRoot) {
      sessionMetadata.workspaceRoot = workspaceRoot;
    }
    if (!sessionMetadata.mcpSessionScope) {
      sessionMetadata.mcpSessionScope = sessionScope;
    }

    return {
      clientName,
      rootSessionId: parsed.rootSessionId,
      externalSessionRef,
      originClient: parsed.originClient || 'mcp',
      sessionMetadata
    };
  } catch (error) {
    console.warn(`[cliagents-mcp] Failed to load persisted root context from ${filePath}: ${error.message}`);
    return null;
  }
}

function persistRootContext(rootContext) {
  if (!rootContext?.rootSessionId) {
    return;
  }

  const filePath = getMcpRootStateFilePath(
    rootContext.clientName || inferMcpClientName(),
    inferWorkspaceRoot()
  );
  const payload = {
      clientName: rootContext.clientName || inferMcpClientName(),
      rootSessionId: rootContext.rootSessionId,
      externalSessionRef: rootContext.externalSessionRef,
      originClient: rootContext.originClient || 'mcp',
      sessionScope: rootContext.sessionScope || inferMcpSessionScope(),
      sessionMetadata: rootContext.sessionMetadata || {}
    };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.warn(`[cliagents-mcp] Failed to persist root context to ${filePath}: ${error.message}`);
  }
}

function clearPersistedRootContext() {
  const filePath = getMcpRootStateFilePath();
  cachedMcpRootContext = null;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(`[cliagents-mcp] Failed to clear persisted root context at ${filePath}: ${error.message}`);
  }
}

function createImplicitRootContext() {
  const clientName = inferMcpClientName();
  const rootSessionId = process.env.CLIAGENTS_ROOT_SESSION_ID || crypto.randomBytes(16).toString('hex');
  const workspaceRoot = inferWorkspaceRoot();
  const sessionScope = inferMcpSessionScope();
  const externalSessionRef = process.env.CLIAGENTS_CLIENT_SESSION_REF || buildStickyExternalSessionRef(clientName, workspaceRoot, sessionScope);
  const explicitOverrides = hasExplicitRootOverrides();
  return {
    clientName,
    rootSessionId,
    externalSessionRef,
    sessionScope,
    originClient: normalizeOriginClient(clientName, 'mcp'),
    sessionMetadata: {
      attachMode: explicitOverrides ? 'explicit-env-overrides' : 'implicit-first-use',
      clientName,
      clientSessionRef: externalSessionRef,
      externalSessionRef,
      workspaceRoot,
      rootIdentitySource: explicitOverrides ? 'environment' : 'mcp-session-scope',
      mcpSessionScope: sessionScope,
      mcpProcessPid: process.pid
    }
  };
}

function getImplicitRootContext(options = {}) {
  const allowAutoCreate = options?.allowAutoCreate === true;
  if (!cachedMcpRootContext) {
    if (hasExplicitRootOverrides()) {
      cachedMcpRootContext = createImplicitRootContext();
    } else {
      cachedMcpRootContext = loadPersistedRootContext();
      if (!cachedMcpRootContext && allowAutoCreate && !REQUIRE_ROOT_ATTACH) {
        cachedMcpRootContext = createImplicitRootContext();
      }
    }
  }
  return cachedMcpRootContext;
}

function isAttachedRootContext(rootContext) {
  if (!rootContext?.rootSessionId) {
    return false;
  }

  const attachMode = String(rootContext?.sessionMetadata?.attachMode || '').trim().toLowerCase();
  return !attachMode.startsWith('implicit');
}

function getAttachedRootContext() {
  const rootContext = getImplicitRootContext();
  return isAttachedRootContext(rootContext) ? rootContext : null;
}

function setImplicitRootContext(rootContext) {
  if (!rootContext?.rootSessionId) {
    return null;
  }

  const clientName = rootContext.clientName || inferMcpClientName();
  const workspaceRoot = inferWorkspaceRoot();
  const sessionScope = rootContext.sessionScope || inferMcpSessionScope();
  const externalSessionRef = rootContext.externalSessionRef || buildStickyExternalSessionRef(clientName, workspaceRoot, sessionScope);
  const sessionMetadata = rootContext.sessionMetadata && typeof rootContext.sessionMetadata === 'object'
    ? { ...rootContext.sessionMetadata }
    : {};

  if (!sessionMetadata.clientName) {
    sessionMetadata.clientName = clientName;
  }
  if (!sessionMetadata.clientSessionRef) {
    sessionMetadata.clientSessionRef = externalSessionRef;
  }
  if (!sessionMetadata.externalSessionRef) {
    sessionMetadata.externalSessionRef = externalSessionRef;
  }
  if (!sessionMetadata.workspaceRoot) {
    sessionMetadata.workspaceRoot = workspaceRoot;
  }
  if (!sessionMetadata.mcpSessionScope) {
    sessionMetadata.mcpSessionScope = sessionScope;
  }

  cachedMcpRootContext = {
    clientName,
    rootSessionId: rootContext.rootSessionId,
    externalSessionRef,
    sessionScope,
    originClient: normalizeOriginClient(clientName, rootContext.originClient || 'mcp'),
    sessionMetadata
  };
  persistRootContext(cachedMcpRootContext);

  return cachedMcpRootContext;
}

function buildRootAttachRequiredMessage(toolName) {
  return `A cliagents root session is required before ${toolName}. Call ensure_root_session first. Serena project activation or creating .cliagents config does not attach a cliagents root session.`;
}

function requireAttachedRootContext(toolName) {
  const rootContext = getAttachedRootContext();
  if (!rootContext?.rootSessionId) {
    throw new Error(buildRootAttachRequiredMessage(toolName));
  }
  return rootContext;
}

function maybeThrowRootAttachError(response, toolName) {
  if (!response || response.status !== 428) {
    return;
  }
  const errorCode = response.data?.error?.code;
  if (errorCode !== 'root_session_required') {
    return;
  }
  const nextAction = response.data?.error?.nextAction || 'call ensure_root_session first';
  throw new Error(`${buildRootAttachRequiredMessage(toolName)} Next action: ${nextAction}.`);
}

function deriveDelegatedSessionKind(role) {
  if (role === 'review' || role === 'review-security' || role === 'review-performance') {
    return 'reviewer';
  }
  if (role === 'judge') {
    return 'judge';
  }
  if (role === 'monitor') {
    return 'monitor';
  }
  if (role === 'plan' || role === 'architect') {
    return 'workflow';
  }
  return 'subagent';
}

function buildRouteRequest({
  message,
  role,
  adapter,
  profile,
  systemPrompt,
  workingDirectory,
  model,
  sessionLabel,
  preferReuse,
  forceFreshSession,
  controlPlaneContext
}) {
  const routeRequest = { message };
  if (role) {
    routeRequest.forceRole = role;
    if (adapter) routeRequest.forceAdapter = adapter;
  } else {
    routeRequest.forceProfile = profile;
  }
  if (systemPrompt) {
    routeRequest.systemPrompt = systemPrompt;
  }
  if (workingDirectory) {
    routeRequest.workingDirectory = workingDirectory;
  }
  if (model) {
    routeRequest.model = model;
  }
  if (sessionLabel) {
    routeRequest.sessionLabel = sessionLabel;
  }
  if (typeof preferReuse === 'boolean') {
    routeRequest.preferReuse = preferReuse;
  }
  if (typeof forceFreshSession === 'boolean') {
    routeRequest.forceFreshSession = forceFreshSession;
  }
  if (controlPlaneContext) {
    routeRequest.rootSessionId = controlPlaneContext.rootSessionId;
    routeRequest.parentSessionId = controlPlaneContext.parentSessionId;
    routeRequest.sessionKind = controlPlaneContext.sessionKind;
    routeRequest.originClient = controlPlaneContext.originClient;
    routeRequest.externalSessionRef = controlPlaneContext.externalSessionRef;
    routeRequest.lineageDepth = controlPlaneContext.lineageDepth;
    routeRequest.sessionMetadata = controlPlaneContext.sessionMetadata;
  }
  return routeRequest;
}

async function fetchTerminalOutput(terminalId) {
  const outputRes = await callCliagents('GET', `/orchestration/terminals/${terminalId}/output`);
  if (outputRes.status !== 200) {
    return 'No output captured';
  }
  return outputRes.data?.output || outputRes.data || 'No output captured';
}

function inferSettledStateFromOutput(rawOutput) {
  const rawText = typeof rawOutput === 'string'
    ? rawOutput
    : (rawOutput == null ? '' : JSON.stringify(rawOutput));
  if (!rawText.trim()) {
    return null;
  }

  const exitMatches = Array.from(rawText.matchAll(/__CLIAGENTS_RUN_EXIT__([A-Za-z0-9_-]+)__(\d+)/g));
  const lastExitMatch = exitMatches.length > 0 ? exitMatches[exitMatches.length - 1] : null;
  if (lastExitMatch) {
    const exitCode = Number.parseInt(lastExitMatch[2], 10);
    return {
      status: exitCode === 0 ? 'completed' : 'error',
      state: exitCode === 0 ? 'completed' : 'error'
    };
  }

  const reasonMatches = Array.from(rawText.matchAll(/"terminal_reason"\s*:\s*"(completed|error)"/g));
  const lastReasonMatch = reasonMatches.length > 0 ? reasonMatches[reasonMatches.length - 1] : null;
  if (lastReasonMatch) {
    const status = lastReasonMatch[1];
    return {
      status,
      state: status === 'completed' ? 'completed' : 'error'
    };
  }

  return null;
}

function normalizeSnapshotOutput(rawOutput, adapter, status) {
  const rawText = typeof rawOutput === 'string'
    ? rawOutput
    : (rawOutput == null ? '' : JSON.stringify(rawOutput));

  const trimmedRaw = rawText.trim();
  if (!trimmedRaw) {
    return 'No output captured';
  }

  if (!adapter) {
    return trimmedRaw;
  }

  const extracted = String(extractOutput(trimmedRaw, adapter) || '').trim();
  if (!extracted) {
    return trimmedRaw;
  }

  if (status === 'completed' || status === 'idle') {
    return extracted;
  }

  return trimmedRaw;
}

async function waitForTerminalCompletion(terminalId, timeoutMs) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let lastStatus = 'queued';
  let terminal = null;

  while (Date.now() < deadline) {
    const snapshot = await fetchTerminalSnapshot(terminalId);

    if (snapshot.state === 'missing') {
      return {
        state: 'missing',
        lastStatus,
        terminal
      };
    }

    lastStatus = snapshot.status;
    terminal = snapshot.terminal;

    if (snapshot.state === 'completed' || snapshot.state === 'error' || snapshot.state === 'blocked') {
      if (!snapshot.output) {
        snapshot.output = await fetchTerminalOutput(terminalId);
      }
      return snapshot;
    }

    await sleep(MCP_POLL_INTERVAL_MS);
  }

  return {
    state: 'timeout',
    lastStatus,
    terminal
  };
}

function classifyTerminalState(status) {
  if (status === 'completed' || status === 'idle') return 'completed';
  if (status === 'error') return 'error';
  if (status === 'waiting_permission' || status === 'waiting_user_answer') return 'blocked';
  return 'running';
}

function isTerminalSettledStatus(status) {
  return ['completed', 'idle', 'error', 'waiting_permission', 'waiting_user_answer'].includes(status);
}

function getRetryAfterMs(status) {
  if (status === 'waiting_permission' || status === 'waiting_user_answer') {
    return 0;
  }
  if (status === 'completed' || status === 'idle' || status === 'error') {
    return null;
  }
  return MCP_STATUS_RETRY_AFTER_MS;
}

async function fetchTerminalSnapshot(terminalId, options = {}) {
  const { includeOutput = false } = options;
  const statusRes = await callCliagents('GET', `/orchestration/terminals/${terminalId}`);

  if (statusRes.status === 404) {
    return {
      terminalId,
      state: 'missing',
      status: 'missing',
      retryAfterMs: null
    };
  }

  if (statusRes.status !== 200) {
    throw new Error(`Failed to get status: ${JSON.stringify(statusRes.data)}`);
  }

  const terminal = statusRes.data || {};
  const status = terminal.status || 'queued';
  const state = classifyTerminalState(status);
  const snapshot = {
    terminalId,
    state,
    status,
    adapter: terminal.adapter,
    agentProfile: terminal.agentProfile,
    retryAfterMs: getRetryAfterMs(status),
    terminal
  };

  const shouldInspectRunningOutput = state === 'running';
  if (includeOutput || isTerminalSettledStatus(status) || shouldInspectRunningOutput) {
    const rawOutput = await fetchTerminalOutput(terminalId);
    const inferredSettlement = shouldInspectRunningOutput ? inferSettledStateFromOutput(rawOutput) : null;
    if (inferredSettlement) {
      snapshot.state = inferredSettlement.state;
      snapshot.status = inferredSettlement.status;
      snapshot.retryAfterMs = getRetryAfterMs(inferredSettlement.status);
      snapshot.terminal = {
        ...terminal,
        status: inferredSettlement.status,
        taskState: inferredSettlement.status
      };
    }

    if (includeOutput || isTerminalSettledStatus(snapshot.status) || inferredSettlement) {
      snapshot.output = normalizeSnapshotOutput(rawOutput, snapshot.adapter, snapshot.status);
    }
  }

  return snapshot;
}

async function fetchTaskSnapshots(terminalIds, options = {}) {
  return Promise.all((terminalIds || []).map((terminalId) => fetchTerminalSnapshot(terminalId, options)));
}

function snapshotSignature(snapshot) {
  return [
    snapshot.terminalId,
    snapshot.state,
    snapshot.status,
    snapshot.agentProfile || '',
    snapshot.adapter || ''
  ].join('|');
}

async function waitForTasks(terminalIds, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MCP_SYNC_WAIT_MS;
  const includeOutput = options.includeOutput !== false;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  let snapshots = await fetchTaskSnapshots(terminalIds, { includeOutput: false });
  while (Date.now() < deadline && snapshots.some((snapshot) => snapshot.state === 'running')) {
    await sleep(MCP_POLL_INTERVAL_MS);
    snapshots = await fetchTaskSnapshots(terminalIds, { includeOutput: false });
  }

  if (includeOutput) {
    snapshots = await Promise.all(snapshots.map(async (snapshot) => {
      if (snapshot.output || snapshot.state === 'running' || snapshot.state === 'missing') {
        return snapshot;
      }
      return fetchTerminalSnapshot(snapshot.terminalId, { includeOutput: true });
    }));
  }

  const allSettled = snapshots.every((snapshot) => snapshot.state !== 'running');
  return {
    allSettled,
    timedOut: !allSettled,
    retryAfterMs: allSettled ? null : MCP_STATUS_RETRY_AFTER_MS,
    tasks: snapshots,
    counts: {
      completed: snapshots.filter((snapshot) => snapshot.state === 'completed').length,
      failed: snapshots.filter((snapshot) => snapshot.state === 'error').length,
      blocked: snapshots.filter((snapshot) => snapshot.state === 'blocked').length,
      running: snapshots.filter((snapshot) => snapshot.state === 'running').length,
      missing: snapshots.filter((snapshot) => snapshot.state === 'missing').length
    }
  };
}

async function watchTasks(terminalIds, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MCP_SYNC_WAIT_MS;
  const includeOutput = options.includeOutput !== false;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  let baseline = await fetchTaskSnapshots(terminalIds, { includeOutput: false });
  if (baseline.every((snapshot) => snapshot.state !== 'running')) {
    const tasks = includeOutput
      ? await Promise.all(baseline.map((snapshot) => {
        if (snapshot.output || snapshot.state === 'running' || snapshot.state === 'missing') {
          return snapshot;
        }
        return fetchTerminalSnapshot(snapshot.terminalId, { includeOutput: true });
      }))
      : baseline;
    return {
      state: 'already_settled',
      timedOut: false,
      changed: tasks.map((snapshot) => snapshot.terminalId),
      changedCount: tasks.length,
      retryAfterMs: null,
      tasks
    };
  }

  const baselineByTerminal = new Map(baseline.map((snapshot) => [snapshot.terminalId, snapshotSignature(snapshot)]));

  while (Date.now() < deadline) {
    await sleep(MCP_POLL_INTERVAL_MS);
    let snapshots = await fetchTaskSnapshots(terminalIds, { includeOutput: false });
    const changedTasks = snapshots.filter((snapshot) => baselineByTerminal.get(snapshot.terminalId) !== snapshotSignature(snapshot));
    const allSettled = snapshots.every((snapshot) => snapshot.state !== 'running');

    if (changedTasks.length > 0 || allSettled) {
      if (includeOutput) {
        const changedIds = new Set(changedTasks.map((snapshot) => snapshot.terminalId));
        snapshots = await Promise.all(snapshots.map((snapshot) => {
          if (snapshot.output || snapshot.state === 'missing') {
            return snapshot;
          }
          if (snapshot.state !== 'running' || changedIds.has(snapshot.terminalId)) {
            return fetchTerminalSnapshot(snapshot.terminalId, { includeOutput: true });
          }
          return snapshot;
        }));
      }

      const finalChangedTasks = snapshots.filter((snapshot) => baselineByTerminal.get(snapshot.terminalId) !== snapshotSignature(snapshot));
      return {
        state: allSettled ? 'settled' : 'changed',
        timedOut: false,
        changed: finalChangedTasks.map((snapshot) => snapshot.terminalId),
        changedCount: finalChangedTasks.length,
        retryAfterMs: allSettled ? null : MCP_STATUS_RETRY_AFTER_MS,
        tasks: snapshots
      };
    }
  }

  return {
    state: 'timeout',
    timedOut: true,
    changed: [],
    changedCount: 0,
    retryAfterMs: MCP_STATUS_RETRY_AFTER_MS,
    tasks: baseline
  };
}

// Tool definitions
const TOOLS = [
  {
    name: 'delegate_task',
    description: `Delegate a task to another AI agent via cliagents orchestration. Use this when:
- You need a specialized perspective (security review, performance analysis)
- The task would benefit from a different AI's strengths (Claude for coding, Gemini for research, Codex for review)
- You want parallel execution of independent tasks

**WHY USE THIS:** Subagents use FREE CLI-authenticated tokens (Gemini, Codex) instead of Opus tokens. A code review that costs ~50K Opus tokens costs ~5K when delegated. Use for any task over ~3 tool calls.

**Role + Adapter Model** — choose WHAT to do and WHO does it:

Roles: plan, implement, review, review-security, review-performance, test, fix, research, architect, document

Adapters:
- gemini-cli: Fast (~30s), good for research, critique, and lightweight review.
- codex-cli: Strong default executor and reviewer for coding tasks.
- qwen-cli: Strong planner/reasoner with good session resume support.

**PARALLEL PATTERN (most useful):**
1. Launch multiple tasks with wait=false
2. Monitor them with check_tasks_status or wait_for_tasks instead of polling each terminal separately
3. Collect and synthesize results

Example:
  delegate_task(role="review", adapter="gemini-cli", wait=false, message="Review src/...")  → terminalId A
  delegate_task(role="review", adapter="codex-cli", wait=false, message="Review src/...")  → terminalId B
  check_tasks_status(terminalIds=[A, B])  → mixed status summary with retry guidance

Timeout presets: "simple" (3 min), "standard" (10 min, default), "complex" (30 min)

**WHEN NOT TO USE:** Small tasks (<3 tool calls), tasks needing user interaction, anything already in your context.`,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The task description to delegate'
        },
        role: {
          type: 'string',
          description: 'Role defining WHAT to do (plan, implement, review, etc.)',
          enum: ['plan', 'implement', 'review', 'review-security', 'review-performance',
                 'test', 'fix', 'research', 'architect', 'document']
        },
        adapter: {
          type: 'string',
          description: 'Adapter defining WHO does it. Optional - uses role default if not specified.',
          enum: ACTIVE_BROKER_ADAPTERS
        },
        profile: {
          type: 'string',
          description: 'LEGACY: Old profile name for backward compatibility. Use role+adapter instead.',
          enum: ['planner', 'implementer', 'reviewer-bugs', 'reviewer-security',
                 'reviewer-performance', 'tester', 'fixer', 'researcher',
                 'architect', 'documenter']
        },
        systemPrompt: {
          type: 'string',
          description: 'Custom system prompt. Optional - uses role default if not specified.'
        },
        model: {
          type: 'string',
          description: 'Optional model override for the selected adapter. Example: o4-mini, gemini-2.5-pro, qwen-max.'
        },
        sessionLabel: {
          type: 'string',
          description: 'Optional stable label for intentionally reusing the same child shell under the same root. This is a broker-side reuse hint, not a guarantee of provider conversation continuity; use reply_to_terminal when you need to continue an exact known terminal.'
        },
        preferReuse: {
          type: 'boolean',
          description: 'Prefer reusing a compatible settled worker for the same root session. Defaults to true when cliagents has a root session context.',
          default: true
        },
        forceFreshSession: {
          type: 'boolean',
          description: 'Force a brand-new worker session even if a compatible reusable worker exists.',
          default: false
        },
        timeout: {
          type: 'string',
          description: 'Timeout preset ("simple", "standard", "complex") or seconds. Default: "standard" (10 min)',
          default: 'standard'
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the agent (for code access). Defaults to current project.'
        },
        wait: {
          type: 'boolean',
          description: 'Return immediately with terminal ID (false, default) or wait briefly for completion (true). Use wait=true only for clearly short tasks. Long or uncertain tasks should stay async and be monitored with check_tasks_status or wait_for_tasks.',
          default: false
        }
      },
      required: ['message']
    }
  },
  {
    name: 'reply_to_terminal',
    description: `Send follow-up input to an existing cliagents terminal. Use this for long-lived collaborator sessions or when a task is waiting for human intervention and you want to continue the SAME terminal instead of routing a fresh task.`,
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: {
          type: 'string',
          description: 'Existing cliagents terminal ID to continue'
        },
        message: {
          type: 'string',
          description: 'Follow-up input, approval, denial, or steering message to send into the existing terminal'
        }
      },
      required: ['terminalId', 'message']
    }
  },
  {
    name: 'run_workflow',
    description: `Execute a predefined multi-agent workflow. Launches multiple subagents (Gemini + Codex + Qwen) in parallel or sequence.

Available workflows:
- code-review: 3 PARALLEL agents — architecture/challenge (qwen-cli) + security/research (gemini-cli) + implementation review (codex-cli)
- feature: SEQUENTIAL — plan (qwen) → implement (codex) → test (codex)
- bugfix: SEQUENTIAL — research (gemini) → fix (codex) → test (codex)
- full-cycle: Plan → implement → review → test → fix
- research: research (gemini) → document (qwen)

**ALWAYS use wait=false** (default). Workflows take 2-10 min. Returns terminal IDs to monitor with check_tasks_status or wait_for_tasks.`,
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          description: 'Workflow name',
          enum: ['code-review', 'feature', 'bugfix', 'full-cycle', 'research']
        },
        message: {
          type: 'string',
          description: 'Task description for the workflow'
        },
        model: {
          type: 'string',
          description: 'Optional default model override applied to every workflow step unless modelsByAdapter provides a more specific override.'
        },
        modelsByAdapter: {
          type: 'object',
          description: 'Optional per-adapter model overrides keyed by adapter name.',
          additionalProperties: {
            type: 'string'
          }
        },
        preferReuse: {
          type: 'boolean',
          description: 'Prefer reusing compatible settled workers for steps under the same root session.',
          default: true
        },
        forceFreshSession: {
          type: 'boolean',
          description: 'Force brand-new workers for every workflow step instead of reusing compatible settled workers.',
          default: false
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for workflow steps'
        },
        wait: {
          type: 'boolean',
          description: 'Wait for completion (true) or return immediately with workflow ID (false). Default: false for workflows to avoid timeout.',
          default: false
        },
        timeout: {
          type: 'string',
          description: 'Timeout preset: "standard" (10 min) or "complex" (30 min). Default: "complex"',
          default: 'complex'
        }
      },
      required: ['workflow', 'message']
    }
  },
  {
    name: 'run_discussion',
    description: `Run a bounded multi-round discussion across multiple agents and optionally judge the result. Use this for structured debate, consensus building, or pushing multiple agents to challenge each other before deciding next steps.

This calls cliagents' direct-session discussion route and returns the completed discussion plus a persisted run ID for later inspection. Keep discussions bounded: typically 2-3 participants and 2-3 rounds.`,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Primary task or question for the discussion'
        },
        context: {
          type: 'string',
          description: 'Optional extra context to include in every round prompt'
        },
        participants: {
          type: 'array',
          description: 'Participants taking part in the discussion',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              adapter: {
                type: 'string',
                enum: ACTIVE_BROKER_ADAPTERS
              },
              systemPrompt: { type: 'string' },
              model: { type: 'string' },
              timeout: { type: 'number' }
            },
            required: ['adapter']
          }
        },
        rounds: {
          type: 'array',
          description: 'Optional custom rounds. Defaults to position -> rebuttal -> convergence.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              instructions: { type: 'string' },
              transcriptMode: {
                type: 'string',
                enum: ['none', 'previous', 'all']
              }
            }
          }
        },
        judge: {
          type: 'object',
          description: 'Optional final judge. Set to null to skip judge synthesis.',
          properties: {
            name: { type: 'string' },
            adapter: {
              type: 'string',
              enum: ACTIVE_BROKER_ADAPTERS
            },
            systemPrompt: { type: 'string' },
            model: { type: 'string' },
            timeout: { type: 'number' }
          }
        },
        timeout: {
          type: 'string',
          description: 'Timeout preset ("simple", "standard", "complex") or seconds. Default: "complex"',
          default: 'complex'
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the discussion participants'
        }
      },
      required: ['message', 'participants']
    }
  },
  {
    name: 'get_run_detail',
    description: 'Fetch persisted orchestration run detail from the run ledger. Useful after consensus, review, or discussion runs when you need the full saved record.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'Run ID returned by cliagents orchestration routes'
        },
        format: {
          type: 'string',
          enum: ['summary', 'json'],
          description: 'Return a readable summary or the raw JSON detail. Default: summary',
          default: 'summary'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'list_runs',
    description: 'List persisted orchestration runs from the run ledger. Useful for discovering recent consensus, review, and discussion runs before fetching a specific run.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['consensus', 'plan-review', 'pr-review', 'discussion']
        },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'partial', 'failed', 'cancelled', 'abandoned']
        },
        adapter: {
          type: 'string',
          description: 'Filter runs that involved a specific adapter'
        },
        limit: {
          type: 'number',
          description: 'Maximum runs to return. Default: 20',
          default: 20
        },
        offset: {
          type: 'number',
          description: 'Pagination offset. Default: 0',
          default: 0
        },
        format: {
          type: 'string',
          enum: ['summary', 'json'],
          description: 'Return a readable summary or the raw JSON list response. Default: summary',
          default: 'summary'
        }
      }
    }
  },
  {
    name: 'list_agents',
    description: 'List available roles and adapters for task delegation. Shows what roles (plan, implement, review, etc.) are available and which active broker adapters can execute them.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_models',
    description: 'List available models for broker adapters. Pass an adapter for the full catalog, or omit it for a compact cross-adapter summary.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description: 'Optional adapter filter such as codex-cli, claude-code, gemini-cli, qwen-cli, or opencode-cli.'
        }
      }
    }
  },
  {
    name: 'recommend_model',
    description: 'Recommend a model for a task using broker-side routing policy and the live adapter catalog. Most useful for multi-provider adapters like opencode-cli.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description: 'Adapter to route for, such as opencode-cli.'
        },
        role: {
          type: 'string',
          description: 'Optional role such as implement, review, plan, or architect.'
        },
        taskType: {
          type: 'string',
          description: 'Optional task type when you want to bypass role inference.'
        },
        message: {
          type: 'string',
          description: 'Optional task text used to infer task type when role and taskType are omitted.'
        }
      },
      required: ['adapter']
    }
  },
  {
    name: 'get_terminal_output',
    description: 'Get the output from a delegated task terminal',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: {
          type: 'string',
          description: 'Terminal ID from delegate_task'
        },
        mode: {
          type: 'string',
          enum: ['history', 'visible'],
          description: 'Output mode. Default: history'
        },
        format: {
          type: 'string',
          enum: ['plain', 'ansi'],
          description: 'Output format. Default: plain'
        }
      },
      required: ['terminalId']
    }
  },
  {
    name: 'check_task_status',
    description: 'Check one delegated task. Returns status, output for settled states, and retry guidance for running tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: {
          type: 'string',
          description: 'Terminal ID from delegate_task with wait=false'
        }
      },
      required: ['terminalId']
    }
  },
  {
    name: 'check_tasks_status',
    description: 'Check multiple delegated tasks in one call. Use this instead of looping over check_task_status for each terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Terminal IDs to inspect together'
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include output for running tasks as well as settled tasks. Default: false',
          default: false
        }
      },
      required: ['terminalIds']
    }
  },
  {
    name: 'wait_for_tasks',
    description: 'Wait for multiple delegated tasks to settle or until a timeout is reached. Prefer this for bounded fan-out workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Terminal IDs to wait on'
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait time in milliseconds. Default: CLIAGENTS_MCP_SYNC_WAIT_MS'
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include output for settled tasks in the response. Default: true',
          default: true
        }
      },
      required: ['terminalIds']
    }
  },
  {
    name: 'watch_tasks',
    description: 'Watch one or more delegated tasks until something meaningful changes. Unlike wait_for_tasks, this returns as soon as any task changes status, needs input, fails, disappears, or all watched tasks settle.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Terminal IDs to watch for changes'
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum watch window in milliseconds. Default: CLIAGENTS_MCP_SYNC_WAIT_MS'
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include output for changed or settled tasks in the response. Default: true',
          default: true
        }
      },
      required: ['terminalIds']
    }
  },
  {
    name: 'ensure_root_session',
    description: 'Ensure a cliagents root session exists for this MCP client thread. This is the preferred entrypoint before delegation. It reuses an existing attached cliagents root session when possible or attaches one if missing. If externalSessionRef is omitted, cliagents derives a sticky per-session identity for this MCP process so multiple terminals in the same workspace do not collide.',
    inputSchema: {
      type: 'object',
      properties: {
        externalSessionRef: {
          type: 'string',
          description: 'Stable client/thread identifier for this top-level session. Reusing the same value ensures the same cliagents root session. Optional but recommended.'
        },
        clientName: {
          type: 'string',
          description: 'Optional client name override. Defaults to CLIAGENTS_CLIENT_NAME / MCP client name.'
        },
        sessionMetadata: {
          type: 'object',
          description: 'Optional metadata to persist on the cliagents root-session attach event.'
        }
      }
    }
  },
  {
    name: 'attach_root_session',
    description: 'Explicitly attach or reuse a stable cliagents root session for this MCP client. Prefer ensure_root_session unless you specifically want the lower-level attach operation. If externalSessionRef is omitted, cliagents derives a sticky per-session identity for this MCP process so multiple terminals in the same workspace do not collide.',
    inputSchema: {
      type: 'object',
      properties: {
        externalSessionRef: {
          type: 'string',
          description: 'Stable client/thread identifier. Reusing the same value attaches to the same cliagents root session.'
        },
        clientName: {
          type: 'string',
          description: 'Optional client name override. Defaults to CLIAGENTS_CLIENT_NAME / MCP client name.'
        },
        sessionMetadata: {
          type: 'object',
          description: 'Optional metadata to persist on the root attach event.'
        }
      }
    }
  },
  {
    name: 'reset_root_session',
    description: 'Clear the sticky MCP root-session binding for this client/workspace. Use this before starting a brand-new top-level thread when you do not want later delegation to reuse the previous root.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'launch_root_session',
    description: 'Launch, resume, or recover a broker-owned managed root terminal using the same control-plane path as `cliagents launch <adapter>`. Non-interactive behavior matches the CLI: by default it launches a fresh root unless you explicitly request resume/recover.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description: 'Root adapter to launch: codex-cli, claude-code, gemini-cli, qwen-cli, or opencode-cli.'
        },
        workDir: {
          type: 'string',
          description: 'Working directory for the managed root terminal.'
        },
        model: {
          type: 'string',
          description: 'Optional model override for the launched root.'
        },
        profile: {
          type: 'string',
          description: 'Optional managed-root launch profile. Defaults to guarded-root.'
        },
        permissionMode: {
          type: 'string',
          description: 'Optional permission mode override.'
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system prompt for the root terminal.'
        },
        externalSessionRef: {
          type: 'string',
          description: 'Optional stable external session ref for a fresh managed root.'
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allowed-tools restriction for the root terminal.'
        },
        forceNewRoot: {
          type: 'boolean',
          description: 'Always create a fresh managed root instead of looking for resumable or recoverable roots.'
        },
        resumeRootSessionId: {
          type: 'string',
          description: 'Resume a specific live managed root by broker root session id.'
        },
        resumeLatest: {
          type: 'boolean',
          description: 'Resume the most recent matching managed root if one exists, preferring live reattach and then a new linked root with carried context.'
        },
        recoverRootSessionId: {
          type: 'string',
          description: 'Recover a specific stale or shell-only managed root by broker root session id.'
        },
        recoverLatest: {
          type: 'boolean',
          description: 'Recover the most recent matching stale, interrupted, or shell-only managed root.'
        },
        resumeMode: {
          type: 'string',
          enum: ['new', 'reattach', 'exact', 'context'],
          description: 'Optional explicit resume mode override for launch routing.'
        },
        providerSessionId: {
          type: 'string',
          description: 'Provider-native session ID to exact-resume into a new managed root.'
        },
        sourceRootSessionId: {
          type: 'string',
          description: 'Optional source root session ID to link or carry context from when using exact or context resume.'
        }
      },
      required: ['adapter']
    }
  },
  {
    name: 'list_provider_sessions',
    description: 'List provider-local sessions that cliagents can import or exact-resume. V1 only implements Codex local-session discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description: 'Provider adapter name. Defaults to codex-cli.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum sessions to return. Default: 20'
        },
        includeArchived: {
          type: 'boolean',
          description: 'Whether to include archived provider sessions. Default: false'
        }
      }
    }
  },
  {
    name: 'import_provider_session',
    description: 'Import a provider-local session as a read-only attached root that can later anchor exact resume or child broker work.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description: 'Provider adapter name. Defaults to codex-cli.'
        },
        providerSessionId: {
          type: 'string',
          description: 'Provider-native session ID to import.'
        },
        externalSessionRef: {
          type: 'string',
          description: 'Optional stable external session ref to bind to the imported root.'
        },
        rootSessionId: {
          type: 'string',
          description: 'Optional existing root session id to bind to the imported provider session.'
        }
      },
      required: ['providerSessionId']
    }
  },
  {
    name: 'adopt_root_session',
    description: 'Adopt an existing tmux-backed root terminal into cliagents as a remotely monitorable and executable root session.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description: 'Root adapter to adopt: codex-cli, claude-code, gemini-cli, qwen-cli, or opencode-cli.'
        },
        tmuxTarget: {
          type: 'string',
          description: 'tmux target in the form session:window. Use this or sessionName/windowName.'
        },
        sessionName: {
          type: 'string',
          description: 'tmux session name for the existing root.'
        },
        windowName: {
          type: 'string',
          description: 'tmux window name for the existing root.'
        },
        workDir: {
          type: 'string',
          description: 'Optional working directory to associate with the adopted root.'
        },
        model: {
          type: 'string',
          description: 'Optional model override to record on the adopted root.'
        },
        externalSessionRef: {
          type: 'string',
          description: 'Optional stable external session ref for the adopted root.'
        },
        rootSessionId: {
          type: 'string',
          description: 'Optional existing root session id to bind the adopted root to.'
        }
      },
      required: ['adapter']
    }
  },
  {
    name: 'list_root_sessions',
    description: 'List recent root sessions tracked by cliagents. Use this to discover main agent sessions and whether any need attention.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of root sessions to list. Default: 20'
        }
      }
    }
  },
  {
    name: 'get_root_session_status',
    description: 'Get a detailed snapshot for one root session, including child sessions, attention reasons, and the latest conclusion.',
    inputSchema: {
      type: 'object',
      properties: {
        rootSessionId: {
          type: 'string',
          description: 'Root session ID to inspect. Defaults to the current implicit MCP root session when available.'
        },
        eventLimit: {
          type: 'number',
          description: 'Maximum number of session events to include. Default: 120'
        },
        terminalLimit: {
          type: 'number',
          description: 'Maximum number of terminals to include. Default: 50'
        },
        format: {
          type: 'string',
          enum: ['summary', 'json'],
          description: 'Return a human summary or raw JSON. Default: summary'
        }
      }
    }
  },
  {
    name: 'list_child_sessions',
    description: 'List child terminals for the current root session. Use this to discover active workers and their status.',
    inputSchema: {
      type: 'object',
      properties: {
        rootSessionId: {
          type: 'string',
          description: 'Root session ID to list children for. Defaults to the current implicit MCP root session.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of child sessions to list. Default: 50'
        }
      }
    }
  },
  {
    name: 'get_usage_summary',
    description: 'Read persisted usage totals for a root session, run, or terminal. Terminal scope also returns recent usage history.',
    inputSchema: {
      type: 'object',
      properties: {
        rootSessionId: {
          type: 'string',
          description: 'Root session ID to summarize.'
        },
        runId: {
          type: 'string',
          description: 'Run ID to summarize.'
        },
        terminalId: {
          type: 'string',
          description: 'Terminal ID to summarize.'
        },
        breakdown: {
          type: 'string',
          description: 'Optional comma-separated breakdown dimensions: adapter, provider, model, sourceConfidence, role.'
        },
        limit: {
          type: 'number',
          description: 'For terminal scope, maximum usage records to return. Default: 20'
        },
        format: {
          type: 'string',
          enum: ['summary', 'json'],
          description: 'Return a human summary or raw JSON. Default: summary'
        }
      }
    }
  },
  {
    name: 'get_memory_bundle',
    description: 'Get a consolidated memory bundle (brief, key decisions, findings) for a run, root, or task.',
    inputSchema: {
      type: 'object',
      properties: {
        scopeId: {
          type: 'string',
          description: 'The ID of the run, root session, or task.'
        },
        scopeType: {
          type: 'string',
          enum: ['run', 'root', 'task'],
          description: 'The type of scope for the memory bundle. Default: task',
          default: 'task'
        },
        recentRunsLimit: {
          type: 'integer',
          description: 'Number of recent runs to include in the bundle (max 10). Default: 3',
          default: 3,
          minimum: 1,
          maximum: 10
        },
        includeRawPointers: {
          type: 'boolean',
          description: 'Whether to include raw pointers to findings, artifacts, etc. Default: true',
          default: true
        }
      },
      required: ['scopeId']
    }
  },
  {
    name: 'get_message_window',
    description: 'Get durable message history for a terminal, root session, or trace. Exactly one selector is required.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: {
          type: 'string',
          description: 'Filter by terminal ID.'
        },
        rootSessionId: {
          type: 'string',
          description: 'Filter by root session ID.'
        },
        traceId: {
          type: 'string',
          description: 'Filter by trace ID.'
        },
        afterId: {
          type: 'integer',
          description: 'Return messages after this ID (exclusive cursor for pagination).'
        },
        limit: {
          type: 'integer',
          description: 'Maximum messages to return (max 500). Default: 100',
          default: 100,
          minimum: 1,
          maximum: 500
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'system', 'tool'],
          description: 'Filter by message role.'
        }
      }
    }
  },
  {
    name: 'create_room',
    description: 'Create a persistent group-chat room backed by direct-session participants.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional room title.'
        },
        roomId: {
          type: 'string',
          description: 'Optional explicit room ID.'
        },
        workDir: {
          type: 'string',
          description: 'Default working directory for room participants.'
        },
        participants: {
          type: 'array',
          description: 'Room participants to persist.',
          items: {
            type: 'object',
            properties: {
              adapter: { type: 'string' },
              displayName: { type: 'string' },
              model: { type: 'string' },
              systemPrompt: { type: 'string' },
              workDir: { type: 'string' },
              providerSessionId: { type: 'string' }
            },
            required: ['adapter']
          }
        }
      },
      required: ['participants']
    }
  },
  {
    name: 'list_rooms',
    description: 'List persisted rooms with compact participant and turn summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum rooms to return (max 100). Default: 20'
        },
        status: {
          type: 'string',
          description: 'Optional room status filter.'
        }
      }
    }
  },
  {
    name: 'send_room_message',
    description: 'Send one persistent room turn. By default the message is broadcast to all active participants; mentions targets only the named participants.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: {
          type: 'string',
          description: 'Target room ID.'
        },
        content: {
          type: 'string',
          description: 'Message content to send.'
        },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional participant IDs to target.'
        },
        requestId: {
          type: 'string',
          description: 'Optional idempotency key for this room turn.'
        }
      },
      required: ['roomId', 'content']
    }
  },
  {
    name: 'get_room',
    description: 'Get room metadata, participants, and latest turn state.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: {
          type: 'string',
          description: 'Room ID to inspect.'
        }
      },
      required: ['roomId']
    }
  },
  {
    name: 'get_room_messages',
    description: 'Get durable room transcript messages.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: {
          type: 'string',
          description: 'Room ID to inspect.'
        },
        afterId: {
          type: 'integer',
          description: 'Return room messages after this message ID (exclusive).'
        },
        limit: {
          type: 'integer',
          description: 'Maximum room messages to return (max 500). Default: 100'
        },
        artifactMode: {
          type: 'string',
          enum: ['exclude', 'include', 'only'],
          description: 'Control whether discussion artifact rows are hidden, included, or returned exclusively.'
        }
      },
      required: ['roomId']
    }
  },
  {
    name: 'discuss_room',
    description: 'Run a bounded discussion across selected room participants. By default the room gets a compact summary; curated transcript writeback is opt-in.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: {
          type: 'string',
          description: 'Room ID to use.'
        },
        message: {
          type: 'string',
          description: 'Primary discussion question or task.'
        },
        participantIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of room participant IDs to include.'
        },
        requestId: {
          type: 'string',
          description: 'Optional idempotency key for this discussion turn.'
        },
        rounds: {
          type: 'array',
          description: 'Optional custom discussion rounds.'
        },
        judge: {
          type: ['object', 'null'],
          description: 'Optional final judge config. Pass null to skip judge synthesis.'
        },
        writebackMode: {
          type: 'string',
          enum: ['summary', 'curated_transcript'],
          description: 'Control whether only a compact summary or curated transcript artifacts are written back into the room.'
        }
      },
      required: ['roomId', 'message']
    }
  },
  // Shared Memory Tools
  {
    name: 'share_finding',
    description: `Share a finding (bug, security issue, suggestion) with other agents working on the same task.
Use this to communicate discoveries that other agents should know about.
Findings persist across agent sessions and are automatically injected into future handoffs.`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier (shared across agents working on the same task)'
        },
        agentId: {
          type: 'string',
          description: 'Optional identifier for the agent making this finding (e.g., terminal ID or agent name)'
        },
        type: {
          type: 'string',
          enum: ['bug', 'security', 'performance', 'suggestion', 'info'],
          description: 'Type of finding'
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description: 'Severity level of the finding'
        },
        content: {
          type: 'string',
          description: 'The finding description - be specific and actionable'
        },
        file: {
          type: 'string',
          description: 'File path where the finding is located (optional)'
        },
        line: {
          type: 'number',
          description: 'Line number where the finding is located (optional)'
        }
      },
      required: ['taskId', 'type', 'content']
    }
  },
  {
    name: 'get_shared_findings',
    description: 'Get findings shared by other agents for a task. Use this to see what other agents have discovered.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier'
        },
        type: {
          type: 'string',
          enum: ['bug', 'security', 'performance', 'suggestion', 'info'],
          description: 'Filter by finding type (optional)'
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description: 'Filter by severity (optional)'
        }
      },
      required: ['taskId']
    }
  },
  {
    name: 'store_artifact',
    description: `Store a code artifact (code, file, output, plan) for other agents to reference.
Use this to share work products that other agents might need.`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier'
        },
        agentId: {
          type: 'string',
          description: 'Optional identifier for the agent storing this artifact'
        },
        key: {
          type: 'string',
          description: 'Unique key for this artifact (e.g., "implementation-plan", "test-results")'
        },
        content: {
          type: 'string',
          description: 'The artifact content'
        },
        type: {
          type: 'string',
          enum: ['code', 'file', 'output', 'plan'],
          description: 'Type of artifact'
        }
      },
      required: ['taskId', 'key', 'content', 'type']
    }
  },
  // Skills System Tools
  {
    name: 'list_skills',
    description: `List available skills. Skills are reusable workflows for domain-specific tasks.

Skills are discovered from three locations (in priority order):
1. Project skills: .cliagents/skills/
2. Personal skills: ~/.cliagents/skills/
3. Core skills: bundled with cliagents

Each skill includes metadata about compatible adapters and tags for discovery.`,
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Filter by tag (e.g., "debugging", "workflow", "orchestration")'
        },
        adapter: {
          type: 'string',
          description: 'Filter by compatible adapter (e.g., "codex-cli", "gemini-cli")'
        }
      }
    }
  },
  {
    name: 'invoke_skill',
    description: `Invoke a skill to get structured guidance for a task. Returns skill content that you should follow.

Skills provide domain-specific workflows and best practices. When you invoke a skill, follow the returned instructions to complete your task.

Example skills:
- test-driven-development: RED-GREEN-REFACTOR cycle
- debugging: Systematic root-cause analysis
- code-review: Multi-perspective review workflow
- multi-agent-workflow: Orchestrate across multiple agents`,
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to invoke'
        },
        message: {
          type: 'string',
          description: 'Task context or description to pass to the skill'
        }
      },
      required: ['skill']
    }
  },
  {
    name: 'get_skill',
    description: 'Get full skill content and metadata without invoking. Use this to preview a skill before using it.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to retrieve'
        }
      },
      required: ['skill']
    }
  }
];

// Tool handlers
async function handleDelegateTask(args) {
  const {
    message,
    // New API: role + adapter
    role,
    adapter,
    systemPrompt,
    model,
    sessionLabel,
    preferReuse,
    forceFreshSession,
    // Legacy API: profile
    profile,
    // Common options
    wait = false,
    timeout = 'standard',
    workingDirectory
  } = args;

  // Require either role (new API) or profile (legacy API)
  if (!role && !profile) {
    throw new Error('Either role or profile is required');
  }

  // Resolve timeout value
  let timeoutSeconds;
  if (typeof timeout === 'number') {
    timeoutSeconds = timeout;
  } else if (TIMEOUTS[timeout]) {
    timeoutSeconds = TIMEOUTS[timeout];
  } else {
    timeoutSeconds = parseInt(timeout, 10) || TIMEOUTS.standard;
  }

  // Determine the profile identifier for display
  let profileDisplay;

  if (role) {
    profileDisplay = adapter ? `${role}_${adapter}` : role;
  } else {
    profileDisplay = profile;
  }

  const rootContext = getAttachedRootContext();
  if (!rootContext && REQUIRE_ROOT_ATTACH) {
    throw new Error(buildRootAttachRequiredMessage('delegate_task'));
  }

  const routeRequest = buildRouteRequest({
    message,
    role,
    adapter,
    profile,
    systemPrompt,
    workingDirectory,
    model,
    sessionLabel,
    preferReuse,
    forceFreshSession,
    controlPlaneContext: rootContext ? {
      rootSessionId: rootContext.rootSessionId,
      parentSessionId: rootContext.rootSessionId,
      sessionKind: deriveDelegatedSessionKind(role),
      originClient: rootContext.originClient,
      externalSessionRef: rootContext.externalSessionRef,
      lineageDepth: 1,
      sessionMetadata: {
        ...rootContext.sessionMetadata,
        toolName: 'delegate_task'
      }
    } : null
  });

  const routeRes = await callCliagents('POST', '/orchestration/route', routeRequest);

  maybeThrowRootAttachError(routeRes, 'delegate_task');
  if (routeRes.status !== 200) {
    throw new Error(`Routing failed: ${JSON.stringify(routeRes.data)}`);
  }

  const { terminalId, adapter: usedAdapter, taskType, profile: routedProfile } = routeRes.data;

  if (wait) {
    const syncWaitMs = Math.max(
      0,
      Math.min(
        timeoutSeconds > 0 ? timeoutSeconds * 1000 : Number.POSITIVE_INFINITY,
        MCP_SYNC_WAIT_MS
      )
    );
    const waitResult = await waitForTerminalCompletion(terminalId, syncWaitMs);

    if (waitResult.state === 'completed') {
      return {
        content: [{
          type: 'text',
          text: `## ${profileDisplay} (${usedAdapter}) Response\n\n**Terminal ID:** ${terminalId}\n**Status:** completed\n\n${waitResult.output || 'No output captured'}`
        }]
      };
    }

    if (waitResult.state === 'error') {
      return {
        content: [{
          type: 'text',
          text: `## ${profileDisplay} (${usedAdapter}) Task Failed\n\n**Terminal ID:** ${terminalId}\n**Status:** ${waitResult.lastStatus}\n\n${waitResult.output || 'No output captured'}`
        }]
      };
    }

    if (waitResult.state === 'blocked') {
      return {
        content: [{
          type: 'text',
          text: `## ${profileDisplay} (${usedAdapter}) Waiting\n\n**Terminal ID:** ${terminalId}\n**Status:** ${waitResult.lastStatus}\n\nThe delegated task is blocked on an interactive prompt. Use \`check_task_status({ terminalId: "${terminalId}" })\` for the blocker details or \`check_tasks_status({ terminalIds: ["${terminalId}"] })\` if you are monitoring several tasks.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `## ${profileDisplay} (${usedAdapter}) Still Running\n\n**Terminal ID:** ${terminalId}\n**Status:** ${waitResult.lastStatus}\n\nThe task exceeded the MCP synchronous wait window (${Math.round(syncWaitMs / 1000)}s) but is still running. Continue with \`check_task_status({ terminalId: "${terminalId}" })\`, or use \`check_tasks_status\` / \`wait_for_tasks\` if you are coordinating several terminals.`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Task Delegated: ASYNC\n\n**Terminal ID:** ${terminalId}\n**Profile:** ${routedProfile || profileDisplay}\n**Adapter:** ${usedAdapter}\n**Task Type:** ${taskType}\n\nThe task is running asynchronously. Use \`check_task_status({ terminalId: "${terminalId}" })\` for a single task, \`check_tasks_status({ terminalIds: ["${terminalId}"] })\` for grouped monitoring, or \`get_terminal_output({ terminalId: "${terminalId}" })\` to inspect partial output.`
    }]
  };
}

async function handleReplyToTerminal(args) {
  const { terminalId, message } = args;
  if (!terminalId) {
    throw new Error('terminalId is required');
  }
  if (!message) {
    throw new Error('message is required');
  }

  const res = await callCliagents('POST', `/orchestration/terminals/${encodeURIComponent(terminalId)}/input`, {
    message
  });

  if (res.status === 403 && res.data?.error?.code === 'root_read_only') {
    const error = new Error(res.data?.error?.message || `Root for terminal ${terminalId} is read-only`);
    error.code = 'root_read_only';
    error.data = res.data;
    throw error;
  }
  if (res.status !== 200) {
    throw new Error(`Failed to send input: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: `## Terminal Updated\n\n**Terminal ID:** ${terminalId}\n**Status:** input sent\n\nThe follow-up message was delivered to the existing terminal. Continue with \`check_task_status({ terminalId: "${terminalId}" })\` or \`get_terminal_output({ terminalId: "${terminalId}" })\` to monitor the same session.`
    }]
  };
}

function resolveWorkflowStepModel(step, model, modelsByAdapter) {
  return modelsByAdapter?.[step.adapter] || model || null;
}

async function handleRunWorkflow(args) {
  const {
    workflow,
    message,
    model,
    modelsByAdapter,
    workingDirectory,
    preferReuse,
    forceFreshSession,
    wait = false,
    timeout = 'complex'
  } = args;

  // Resolve timeout
  let timeoutSeconds = TIMEOUTS[timeout] || TIMEOUTS.complex;
  const httpTimeout = (timeoutSeconds + 60) * 1000;
  const rootContext = getAttachedRootContext();
  if (!rootContext && REQUIRE_ROOT_ATTACH) {
    throw new Error(buildRootAttachRequiredMessage('run_workflow'));
  }

  if (wait) {
    // Synchronous mode - wait for full completion (may timeout for long workflows)
    const res = await callCliagents('POST', `/orchestration/workflows/${workflow}`, {
      message,
      model,
      modelsByAdapter,
      workingDirectory,
      rootSessionId: rootContext?.rootSessionId,
      parentSessionId: rootContext?.rootSessionId,
      sessionKind: 'workflow',
      originClient: rootContext?.originClient,
      externalSessionRef: rootContext?.externalSessionRef,
      lineageDepth: rootContext ? 1 : undefined,
      sessionMetadata: rootContext ? {
        ...rootContext.sessionMetadata,
        toolName: 'run_workflow'
      } : undefined,
      preferReuse,
      forceFreshSession
    }, httpTimeout);

    maybeThrowRootAttachError(res, 'run_workflow');
    if (res.status !== 200) {
      throw new Error(`Workflow failed: ${JSON.stringify(res.data)}`);
    }

    const results = res.data.results || [];
    const formattedResults = results.map(r =>
      `### ${r.profile} (${r.type})\n${r.output || 'No output'}`
    ).join('\n\n---\n\n');

    return {
      content: [{
        type: 'text',
        text: `## Workflow: ${workflow}\n\nStatus: ${res.data.status}\n\n${formattedResults}`
      }]
    };
  }

  // Async mode (default) - start workflow and return immediately
  // First, start each workflow step as separate delegated tasks
  const workflowSteps = {
    'code-review': [
      { role: 'review', adapter: 'qwen-cli' },
      { role: 'review-security', adapter: 'gemini-cli' },
      { role: 'review-performance', adapter: 'codex-cli' }
    ],
    'feature': [
      { role: 'plan', adapter: 'qwen-cli' },
      { role: 'implement', adapter: 'codex-cli' },
      { role: 'test', adapter: 'codex-cli' }
    ],
    'bugfix': [
      { role: 'research', adapter: 'gemini-cli' },
      { role: 'fix', adapter: 'codex-cli' },
      { role: 'test', adapter: 'codex-cli' }
    ],
    'research': [
      { role: 'research', adapter: 'gemini-cli' },
      { role: 'document', adapter: 'qwen-cli' }
    ]
  };

  const steps = workflowSteps[workflow];
  if (!steps) {
    throw new Error(`Unknown workflow: ${workflow}. Use wait=true for full-cycle workflow.`);
  }

  // Start all steps in parallel (async)
  const terminalIds = [];
  for (const step of steps) {
    const routeRes = await callCliagents('POST', '/orchestration/route', {
      message,
      forceRole: step.role,
      forceAdapter: step.adapter,
      model: resolveWorkflowStepModel(step, model, modelsByAdapter),
      workingDirectory,
      rootSessionId: rootContext?.rootSessionId,
      parentSessionId: rootContext?.rootSessionId,
      sessionKind: 'workflow',
      originClient: rootContext?.originClient,
      externalSessionRef: rootContext?.externalSessionRef,
      lineageDepth: rootContext ? 1 : undefined,
      sessionMetadata: rootContext ? {
        ...rootContext.sessionMetadata,
        toolName: 'run_workflow'
      } : undefined,
      preferReuse,
      forceFreshSession
    });

    maybeThrowRootAttachError(routeRes, 'run_workflow');
    if (routeRes.status === 200) {
      terminalIds.push({
        role: step.role,
        adapter: step.adapter,
        terminalId: routeRes.data.terminalId
      });
    }
  }

  return {
    content: [{
      type: 'text',
      text: `## Workflow Started: ${workflow}\n\n**Mode:** Async (use check_tasks_status or wait_for_tasks to monitor grouped steps)\n\n**Steps launched:**\n${terminalIds.map(t => `- ${t.role} (${t.adapter}): \`${t.terminalId}\``).join('\n')}\n\nUse \`check_tasks_status({ terminalIds: [...] })\` for grouped progress or \`wait_for_tasks({ terminalIds: [...] })\` to wait for a bounded completion window.`
    }]
  };
}

async function handleListAgents() {
  // Fetch roles and adapters (new v3 API)
  const [rolesRes, adaptersRes] = await Promise.all([
    callCliagents('GET', '/orchestration/roles'),
    callCliagents('GET', '/orchestration/adapters')
  ]);

  let output = '# Available Agent Configurations\n\n';

  // Format roles
  if (rolesRes.status === 200 && rolesRes.data.roles) {
    const roles = rolesRes.data.roles;
    output += '## Roles (WHAT to do)\n\n';
    output += Object.entries(roles)
      .map(([name, config]) =>
        `- **${name}** → default: ${config.defaultAdapter}\n  ${config.description || ''}`
      ).join('\n');
    output += '\n\n';
  }

  // Format adapters
  if (adaptersRes.status === 200 && adaptersRes.data.adapters) {
    const adapters = adaptersRes.data.adapters;
    output += '## Adapters (WHO does it)\n\n';
    output += Object.entries(adapters)
      .map(([name, config]) =>
        `- **${name}**: ${config.description || ''}\n  Capabilities: ${(config.capabilities || []).join(', ')}`
      ).join('\n');
    output += '\n\n';
  }

  output += '## Usage\n\n';
  output += 'Use role with default adapter:\n';
  output += '```json\n{ "role": "implement", "message": "..." }\n```\n\n';
  output += 'Override adapter:\n';
  output += '```json\n{ "role": "implement", "adapter": "gemini-cli", "message": "..." }\n```\n\n';
  output += 'Use `list_models` to inspect exact model catalogs for a chosen adapter.';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

async function handleListModels(args = {}) {
  const adapterFilter = String(args?.adapter || '').trim() || null;
  const res = await callCliagents('GET', '/orchestration/adapters');

  if (res.status !== 200) {
    throw new Error(`Failed to list adapters: ${JSON.stringify(res.data)}`);
  }

  const adapters = res.data?.adapters || {};
  const adapterNames = Object.keys(adapters).sort();

  if (adapterNames.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No adapter model catalogs found.'
      }]
    };
  }

  if (adapterFilter) {
    const adapterEntry = adapters[adapterFilter];
    if (!adapterEntry) {
      throw new Error(`Unknown adapter: ${adapterFilter}`);
    }

    const models = Array.isArray(adapterEntry.models) ? adapterEntry.models : [];
    const runtimeProviders = Array.isArray(adapterEntry.runtimeProviders) ? adapterEntry.runtimeProviders : [];
    const providerLine = runtimeProviders.length > 0
      ? `runtime_providers: ${runtimeProviders.map((provider) => provider?.name || provider?.id || String(provider)).join(', ')}`
      : null;

    const lines = models.length > 0
      ? models.map((model) => {
          const id = model?.id || 'unknown';
          const name = model?.name && model.name !== id ? ` (${model.name})` : '';
          const description = model?.description ? ` - ${model.description}` : '';
          return `- ${id}${name}${description}`;
        })
      : ['- none reported'];

    return {
      content: [{
        type: 'text',
        text: [
          `## Models: ${adapterFilter}`,
          '',
          providerLine,
          ...lines
        ].filter(Boolean).join('\n')
      }]
    };
  }

  const summaryLines = adapterNames.map((name) => {
    const models = Array.isArray(adapters[name]?.models) ? adapters[name].models : [];
    const examples = models.slice(0, 3).map((model) => model?.id || 'unknown').filter(Boolean);
    const runtimeProviders = Array.isArray(adapters[name]?.runtimeProviders) ? adapters[name].runtimeProviders : [];
    const providerNames = runtimeProviders
      .map((provider) => provider?.name || provider?.id || String(provider))
      .filter(Boolean);
    return [
      `- ${name}: ${models.length} models`,
      examples.length > 0 ? `  examples: ${examples.join(', ')}` : null,
      providerNames.length > 0 ? `  runtime_providers: ${providerNames.join(', ')}` : null
    ].filter(Boolean).join('\n');
  });

  return {
    content: [{
      type: 'text',
      text: [
        '## Adapter Models',
        '',
        summaryLines.join('\n\n'),
        '',
        'Use `list_models` with an adapter to inspect the full catalog for one provider surface.'
      ].join('\n')
    }]
  };
}

async function handleRecommendModel(args = {}) {
  const adapter = String(args?.adapter || '').trim();
  if (!adapter) {
    throw new Error('adapter is required');
  }

  const body = {
    adapter,
    role: args?.role || null,
    taskType: args?.taskType || null,
    message: args?.message || null
  };

  const res = await callCliagents('POST', '/orchestration/model-routing/recommend', body);
  if (res.status !== 200) {
    throw new Error(`Failed to recommend model: ${JSON.stringify(res.data)}`);
  }

  const recommendation = res.data || {};
  const selectedLine = recommendation.selectedModel
    ? `selected_model: ${recommendation.selectedModel}`
    : 'selected_model: none';
  const providerLine = recommendation.selectedProvider
    ? `selected_provider: ${recommendation.selectedProvider}`
    : null;
  const familyLine = recommendation.selectedFamily
    ? `selected_family: ${recommendation.selectedFamily}`
    : null;
  const orderLine = Array.isArray(recommendation.familyOrder) && recommendation.familyOrder.length > 0
    ? `family_order: ${recommendation.familyOrder.join(', ')}`
    : null;
  const candidates = Array.isArray(recommendation.candidates)
    ? recommendation.candidates.filter((candidate) => candidate.available).slice(0, 8)
    : [];
  const candidateLines = candidates.length > 0
    ? candidates.map((candidate) => `- ${candidate.model} [${candidate.family} via ${candidate.provider}]`).join('\n')
    : '- none';

  return {
    content: [{
      type: 'text',
      text: [
        `## Model Recommendation: ${adapter}`,
        '',
        recommendation.role ? `role: ${recommendation.role}` : null,
        recommendation.taskType ? `task_type: ${recommendation.taskType}` : null,
        selectedLine,
        providerLine,
        familyLine,
        recommendation.strategy ? `strategy: ${recommendation.strategy}` : null,
        orderLine,
        recommendation.summary ? `summary: ${recommendation.summary}` : null,
        '',
        'Available ranked matches:',
        candidateLines
      ].filter(Boolean).join('\n')
    }]
  };
}


function truncateText(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function formatRunRow(run) {
  return [
    `- ${run.id}`,
    `  kind: ${run.kind}`,
    `  status: ${run.status}`,
    `  decision: ${run.decisionSource || 'n/a'}`,
    `  started: ${run.startedAt ? new Date(run.startedAt).toISOString() : 'n/a'}`,
    run.inputSummary ? `  summary: ${truncateText(run.inputSummary, 220)}` : null
  ].filter(Boolean).join('\n');
}

function formatDiscussionDetail(detail) {
  const outputs = detail.outputs || [];
  const participants = detail.participants || [];
  const roundSummaries = outputs
    .filter((output) => output.outputKind === 'participant_final' && output.metadata?.roundName && !output.participantId)
    .map((output) => {
      const meta = output.metadata || {};
      return [
        `### Round ${meta.roundIndex + 1}: ${meta.roundName}`,
        `Responses: ${meta.successCount || 0}/${meta.responseCount || 0}`,
        storedEntryText(output)
      ].join('\n');
    });

  const participantLines = participants.map((participant) => {
    const state = participant.status || 'queued';
    const failure = participant.failureClass ? ` (${participant.failureClass})` : '';
    return `- ${participant.participantName || participant.participantRole} [${participant.adapter}] -> ${state}${failure}`;
  });

  return [
    `## Run Detail: ${detail.run.id}`,
    '',
    `**Kind:** ${detail.run.kind}`,
    `**Status:** ${detail.run.status}`,
    `**Current Step:** ${detail.run.currentStep || 'n/a'}`,
    `**Decision Source:** ${detail.run.decisionSource || 'n/a'}`,
    detail.run.decisionSummary ? `**Decision Summary:** ${truncateText(detail.run.decisionSummary, 500)}` : null,
    '',
    '### Participants',
    participantLines.join('\n') || '- none',
    roundSummaries.length ? '' : null,
    roundSummaries.length ? '### Discussion Rounds' : null,
    roundSummaries.length ? roundSummaries.join('\n\n') : null,
    detail.run.metadata ? '' : null,
    detail.run.metadata ? '### Metadata' : null,
    detail.run.metadata ? JSON.stringify(detail.run.metadata, null, 2) : null
  ].filter(Boolean).join('\n');
}

function storedEntryText(entry) {
  return entry?.fullText || entry?.previewText || '';
}

function formatRunDetail(detail) {
  if (detail?.run?.kind === 'discussion') {
    return formatDiscussionDetail(detail);
  }

  const participants = (detail.participants || []).map((participant) => {
    const failure = participant.failureClass ? ` (${participant.failureClass})` : '';
    return `- ${participant.participantName || participant.participantRole} [${participant.adapter}] -> ${participant.status}${failure}`;
  });

  return [
    `## Run Detail: ${detail.run.id}`,
    '',
    `**Kind:** ${detail.run.kind}`,
    `**Status:** ${detail.run.status}`,
    `**Current Step:** ${detail.run.currentStep || 'n/a'}`,
    `**Decision Source:** ${detail.run.decisionSource || 'n/a'}`,
    detail.run.decisionSummary ? `**Decision Summary:** ${truncateText(detail.run.decisionSummary, 500)}` : null,
    '',
    '### Participants',
    participants.join('\n') || '- none',
    '',
    `Inputs: ${(detail.inputs || []).length}`,
    `Outputs: ${(detail.outputs || []).length}`,
    `Steps: ${(detail.steps || []).length}`,
    `Tool Events: ${(detail.toolEvents || []).length}`
  ].filter(Boolean).join('\n');
}

async function handleRunDiscussion(args) {
  const {
    message,
    context,
    participants,
    rounds,
    judge,
    timeout = 'complex',
    workingDirectory
  } = args || {};

  if (!message) {
    throw new Error('message is required');
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('participants array is required');
  }

  let timeoutSeconds;
  if (typeof timeout === 'number') {
    timeoutSeconds = timeout;
  } else if (TIMEOUTS[timeout]) {
    timeoutSeconds = TIMEOUTS[timeout];
  } else {
    timeoutSeconds = parseInt(timeout, 10) || TIMEOUTS.complex;
  }
  const discussionTimeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;

  const rootContext = getAttachedRootContext();
  if (!rootContext && REQUIRE_ROOT_ATTACH) {
    throw new Error(buildRootAttachRequiredMessage('run_discussion'));
  }
  const res = await callCliagents('POST', '/orchestration/discussion', {
    message,
    context,
    participants,
    rounds,
    judge,
    timeout: discussionTimeoutMs,
    workingDirectory,
    rootSessionId: rootContext?.rootSessionId,
    parentSessionId: rootContext?.rootSessionId,
    originClient: rootContext?.originClient,
    externalSessionRef: rootContext?.externalSessionRef,
    sessionMetadata: rootContext ? {
      ...rootContext.sessionMetadata,
      toolName: 'run_discussion'
    } : undefined
  }, (timeoutSeconds + 60) * 1000);

  maybeThrowRootAttachError(res, 'run_discussion');
  if (res.status !== 200) {
    throw new Error(`Discussion failed: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  const roundLines = (data.rounds || []).map((round, index) => {
    const responses = Array.isArray(round.responses) ? round.responses : [];
    const successCount = responses.filter((entry) => entry.success).length;
    return `- Round ${index + 1} (${round.name || `round-${index + 1}`}): ${successCount}/${responses.length} succeeded`;
  }).join('\n');
  const participantLines = (data.participants || []).map((participant) => {
    const failure = participant.failureClass ? ` (${participant.failureClass})` : '';
    return `- ${participant.name || participant.adapter} [${participant.adapter}] -> ${participant.success ? 'success' : `failed${failure}`}`;
  }).join('\n');
  const judgeText = data.judge
    ? `
### Judge
- ${data.judge.name || data.judge.adapter} [${data.judge.adapter}] -> ${data.judge.success ? truncateText(data.judge.output, 700) : `failed (${data.judge.failureClass || 'unknown'}): ${data.judge.error || 'no error details'}`}`
    : '';

  return {
    content: [{
      type: 'text',
      text: [
        '## Discussion Completed',
        '',
        `**Run ID:** ${data.runId || 'n/a'}`,
        `**Discussion ID:** ${data.discussionId || 'n/a'}`,
        `**Participants:** ${(data.participants || []).length}`,
        `**Rounds:** ${(data.rounds || []).length}`,
        '',
        '### Participant Status',
        participantLines || '- none',
        roundLines ? '' : null,
        roundLines ? '### Round Summary' : null,
        roundLines || null,
        judgeText,
        '',
        data.runId ? `Use \`get_run_detail({ runId: "${data.runId}" })\` for the persisted run record.` : null
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleGetRunDetail(args) {
  const { runId, format = 'summary' } = args || {};

  if (!runId) {
    throw new Error('runId is required');
  }

  const res = await callCliagents('GET', `/orchestration/runs/${runId}`);
  if (res.status === 404) {
    return {
      content: [{
        type: 'text',
        text: `Run ${runId} not found.`
      }]
    };
  }
  if (res.status !== 200) {
    throw new Error(`Failed to get run detail: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: format === 'json'
        ? JSON.stringify(res.data, null, 2)
        : formatRunDetail(res.data)
    }]
  };
}

async function handleListRuns(args) {
  const { kind, status, adapter, limit = 20, offset = 0, format = 'summary' } = args || {};
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (status) params.set('status', status);
  if (adapter) params.set('adapter', adapter);
  params.set('limit', String(limit || 20));
  params.set('offset', String(offset || 0));

  const res = await callCliagents('GET', `/orchestration/runs?${params.toString()}`);
  if (res.status !== 200) {
    throw new Error(`Failed to list runs: ${JSON.stringify(res.data)}`);
  }

  if (format === 'json') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(res.data, null, 2)
      }]
    };
  }

  const runs = Array.isArray(res.data?.runs) ? res.data.runs : [];
  const pagination = res.data?.pagination || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Persisted Runs',
        '',
        `Returned: ${pagination.returned || runs.length}`,
        `Total: ${pagination.total || runs.length}`,
        '',
        runs.length ? runs.map(formatRunRow).join('\n\n') : 'No runs matched the current filters.'
      ].join('\n')
    }]
  };
}

async function handleGetTerminalOutput(args) {
  const { terminalId } = args;
  const params = new URLSearchParams();
  if (args?.mode) {
    params.set('mode', args.mode);
  }
  if (args?.format) {
    params.set('format', args.format);
  }

  const res = await callCliagents(
    'GET',
    `/orchestration/terminals/${encodeURIComponent(terminalId)}/output${params.toString() ? `?${params.toString()}` : ''}`
  );

  if (res.status !== 200) {
    throw new Error(`Failed to get output: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: res.data?.output || 'No output available'
    }]
  };
}

function formatTaskSnapshot(snapshot) {
  if (snapshot.state === 'missing') {
    return `- ${snapshot.terminalId}: missing`;
  }

  const profile = snapshot.agentProfile || 'unknown';
  const adapter = snapshot.adapter || 'unknown';
  const retryLine = snapshot.retryAfterMs == null
    ? null
    : snapshot.retryAfterMs === 0
      ? '  retry_after_ms: 0 (blocked; waiting for human input)'
      : `  retry_after_ms: ${snapshot.retryAfterMs}`;
  const outputLine = snapshot.output ? `  output: ${truncateText(snapshot.output, 400)}` : null;

  return [
    `- ${snapshot.terminalId}: ${snapshot.status.toUpperCase()} [${profile} / ${adapter}]`,
    retryLine,
    outputLine
  ].filter(Boolean).join('\n');
}

async function handleCheckTaskStatus(args) {
  const { terminalId } = args;
  const snapshot = await fetchTerminalSnapshot(terminalId);

  if (snapshot.state === 'missing') {
    return {
      content: [{
        type: 'text',
        text: `Terminal ${terminalId} not found. It may have been cleaned up after completion.`
      }]
    };
  }

  if (snapshot.state === 'completed') {
    return {
      content: [{
        type: 'text',
        text: `## Task Status: COMPLETED

**Profile:** ${snapshot.agentProfile}
**Adapter:** ${snapshot.adapter}

### Output:
${snapshot.output}`
      }]
    };
  }

  if (snapshot.state === 'error') {
    return {
      content: [{
        type: 'text',
        text: `## Task Status: FAILED

**Profile:** ${snapshot.agentProfile}
**Adapter:** ${snapshot.adapter}

### Output:
${snapshot.output}`
      }]
    };
  }

  if (snapshot.state === 'blocked') {
    return {
      content: [{
        type: 'text',
        text: `## Task Status: ${snapshot.status.toUpperCase()}

**Profile:** ${snapshot.agentProfile}
**Adapter:** ${snapshot.adapter}
**retry_after_ms:** 0

The task is blocked on an interactive prompt.

### Output:
${snapshot.output}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Task Status: ${snapshot.status.toUpperCase()}

**Profile:** ${snapshot.agentProfile}
**Adapter:** ${snapshot.adapter}
**retry_after_ms:** ${snapshot.retryAfterMs}

Task is still running. Prefer \`check_tasks_status({ terminalIds: ["${terminalId}"] })\` for grouped polling or wait ${Math.ceil((snapshot.retryAfterMs || MCP_STATUS_RETRY_AFTER_MS) / 1000)}s before checking again.`
    }]
  };
}

async function handleCheckTasksStatus(args) {
  const { terminalIds, includeOutput = false } = args || {};

  if (!Array.isArray(terminalIds) || terminalIds.length === 0) {
    throw new Error('terminalIds array is required');
  }

  const snapshots = await fetchTaskSnapshots(terminalIds, { includeOutput });
  const counts = {
    completed: snapshots.filter((snapshot) => snapshot.state === 'completed').length,
    failed: snapshots.filter((snapshot) => snapshot.state === 'error').length,
    blocked: snapshots.filter((snapshot) => snapshot.state === 'blocked').length,
    running: snapshots.filter((snapshot) => snapshot.state === 'running').length,
    missing: snapshots.filter((snapshot) => snapshot.state === 'missing').length
  };
  const nextRetryAfterMs = counts.running > 0 ? MCP_STATUS_RETRY_AFTER_MS : null;

  return {
    content: [{
      type: 'text',
      text: [
        '## Batch Task Status',
        '',
        `Tasks: ${snapshots.length}`,
        `Completed: ${counts.completed}`,
        `Failed: ${counts.failed}`,
        `Blocked: ${counts.blocked}`,
        `Running: ${counts.running}`,
        `Missing: ${counts.missing}`,
        nextRetryAfterMs == null ? null : `retry_after_ms: ${nextRetryAfterMs}`,
        '',
        snapshots.map(formatTaskSnapshot).join('\n\n')
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleWaitForTasks(args) {
  const { terminalIds, timeoutMs = MCP_SYNC_WAIT_MS, includeOutput = true } = args || {};

  if (!Array.isArray(terminalIds) || terminalIds.length === 0) {
    throw new Error('terminalIds array is required');
  }

  const result = await waitForTasks(terminalIds, { timeoutMs, includeOutput });
  const header = result.timedOut ? '## Wait Result: TIMEOUT' : '## Wait Result: SETTLED';

  return {
    content: [{
      type: 'text',
      text: [
        header,
        '',
        `Tasks: ${result.tasks.length}`,
        `Completed: ${result.counts.completed}`,
        `Failed: ${result.counts.failed}`,
        `Blocked: ${result.counts.blocked}`,
        `Running: ${result.counts.running}`,
        `Missing: ${result.counts.missing}`,
        result.retryAfterMs == null ? null : `retry_after_ms: ${result.retryAfterMs}`,
        '',
        result.tasks.map(formatTaskSnapshot).join('\n\n')
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleWatchTasks(args) {
  const { terminalIds, timeoutMs = MCP_SYNC_WAIT_MS, includeOutput = true } = args || {};

  if (!Array.isArray(terminalIds) || terminalIds.length === 0) {
    throw new Error('terminalIds array is required');
  }

  const result = await watchTasks(terminalIds, { timeoutMs, includeOutput });
  const headerByState = {
    already_settled: '## Watch Result: ALREADY_SETTLED',
    settled: '## Watch Result: SETTLED',
    changed: '## Watch Result: CHANGED',
    timeout: '## Watch Result: TIMEOUT'
  };

  return {
    content: [{
      type: 'text',
      text: [
        headerByState[result.state] || '## Watch Result',
        '',
        `Tasks: ${result.tasks.length}`,
        `Changed: ${result.changedCount}`,
        result.changedCount > 0 ? `Changed terminalIds: ${result.changed.join(', ')}` : null,
        result.retryAfterMs == null ? null : `retry_after_ms: ${result.retryAfterMs}`,
        '',
        result.tasks.map(formatTaskSnapshot).join('\n\n')
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleListRootSessions(args) {
  const limit = Number.isFinite(args?.limit) ? args.limit : 20;
  const res = await callCliagents('GET', `/orchestration/root-sessions?limit=${encodeURIComponent(limit)}`);

  if (res.status !== 200) {
    throw new Error(`Failed to list root sessions: ${JSON.stringify(res.data)}`);
  }

  const roots = Array.isArray(res.data?.roots) ? res.data.roots : [];
  if (roots.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No root sessions found.'
      }]
    };
  }

  const lines = roots.map((root) => {
    const attentionSuffix = root.attention?.requiresAttention
      ? ` attention=${root.attention.reasons.map((reason) => reason.code).join(',') || 'yes'}`
      : '';
    const modeSuffix = root.rootMode ? ` mode=${root.rootMode}` : '';
    const interactiveSuffix = root.interactiveTerminalId ? ` interactive=${root.interactiveTerminalId}` : '';
    const activitySuffix = root.activitySummary ? ` summary="${truncateText(root.activitySummary, 100)}"` : '';
    return `- ${root.rootSessionId} status=${root.status} events=${root.eventCount}${modeSuffix}${interactiveSuffix}${attentionSuffix}${activitySuffix}`;
  });

  return {
    content: [{
      type: 'text',
      text: `## Root Sessions\n\n${lines.join('\n')}`
    }]
  };
}

async function attachRootSessionInternal(args, options = {}) {
  const existing = getImplicitRootContext();
  const workspaceRoot = inferWorkspaceRoot();
  const sessionScope = args?.sessionScope || existing?.sessionScope || inferMcpSessionScope();
  const existingAttachMode = String(existing?.sessionMetadata?.attachMode || '').trim().toLowerCase();
  const preserveExistingExternalRef = existing?.externalSessionRef && !existingAttachMode.startsWith('implicit');
  const requestedExternalSessionRef = args?.externalSessionRef
    || (preserveExistingExternalRef ? existing.externalSessionRef : null)
    || null;
  const inferredClientName = inferClientNameFromSessionRef(requestedExternalSessionRef);
  const clientName = args?.clientName
    || inferredClientName
    || existing?.clientName
    || inferMcpClientName();
  const externalSessionRef = requestedExternalSessionRef
    || buildStickyExternalSessionRef(clientName, workspaceRoot, sessionScope);
  const sessionMetadata = {
    ...(!existingAttachMode.startsWith('implicit') ? (existing?.sessionMetadata || {}) : {}),
    ...(args?.sessionMetadata && typeof args.sessionMetadata === 'object' ? args.sessionMetadata : {})
  };
  sessionMetadata.clientName = clientName;
  sessionMetadata.clientSessionRef = externalSessionRef;
  sessionMetadata.externalSessionRef = externalSessionRef;
  sessionMetadata.workspaceRoot = workspaceRoot;
  sessionMetadata.mcpSessionScope = sessionScope;
  sessionMetadata.attachMode = 'explicit-mcp-attach';
  sessionMetadata.rootIdentitySource = args?.externalSessionRef ? 'explicit-external-session-ref' : 'mcp-session-scope';
  sessionMetadata.mcpProcessPid = process.pid;
  const originClient = normalizeOriginClient(clientName, existing?.originClient || 'mcp');

  const res = await callCliagents('POST', '/orchestration/root-sessions/attach', {
    originClient,
    externalSessionRef,
    sessionMetadata
  });

  if (res.status !== 200) {
    throw new Error(`Failed to attach root session: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  const mergedResponseMetadata = {
    ...sessionMetadata,
    ...(data.sessionMetadata && typeof data.sessionMetadata === 'object' ? data.sessionMetadata : {})
  };
  const attachedContext = setImplicitRootContext({
    clientName: data.clientName || clientName,
    rootSessionId: data.rootSessionId,
    externalSessionRef: data.externalSessionRef || externalSessionRef,
    sessionScope,
    originClient: normalizeOriginClient(data.clientName || clientName, data.originClient || originClient),
    sessionMetadata: mergedResponseMetadata
  });

  const action = options.action || 'attached';
  const heading = options.heading || 'Root Session Attached';
  const ensured = action === 'ensured';
  const resultLines = [
    `## ${heading}`,
    '',
    `root_session_id: ${attachedContext?.rootSessionId || data.rootSessionId}`,
    `origin_client: ${attachedContext?.originClient || data.originClient || 'mcp'}`,
    `client_name: ${attachedContext?.clientName || clientName}`,
    `external_session_ref: ${attachedContext?.externalSessionRef || externalSessionRef}`,
    `action: ${action}`,
    `attached: ${data.attachedRoot ? 'yes' : 'no'}`,
    `reused: ${data.reusedAttachedRoot ? 'yes' : 'no'}`
  ];
  if (ensured) {
    resultLines.push(
      'next_action: delegate_task, run_workflow, or run_discussion under this cliagents root session'
    );
  }

  return {
    attachedContext,
    data,
    result: {
      content: [{
        type: 'text',
        text: resultLines.join('\n')
      }]
    }
  };
}

async function handleEnsureRootSession(args) {
  const { result } = await attachRootSessionInternal(args, {
    action: 'ensured',
    heading: 'cliagents Root Session Ensured'
  });
  return result;
}

async function handleAttachRootSession(args) {
  const { result } = await attachRootSessionInternal(args, {
    action: 'attached',
    heading: 'Root Session Attached'
  });
  return result;
}

async function handleResetRootSession() {
  const previous = cachedMcpRootContext || loadPersistedRootContext();
  clearPersistedRootContext();

  return {
    content: [{
      type: 'text',
      text: [
        '## Root Session Reset',
        '',
        previous?.rootSessionId ? `previous_root_session_id: ${previous.rootSessionId}` : 'previous_root_session_id: none',
        previous?.externalSessionRef ? `previous_external_session_ref: ${previous.externalSessionRef}` : 'previous_external_session_ref: none',
        'next_action: call ensure_root_session to establish a fresh sticky cliagents root session'
      ].join('\n')
    }]
  };
}

async function handleLaunchRootSession(args) {
  const launchOptions = {
    adapter: args?.adapter || 'codex-cli',
    workDir: args?.workDir || args?.workingDirectory || process.cwd(),
    model: args?.model || null,
    modelExplicit: Object.prototype.hasOwnProperty.call(args || {}, 'model'),
    profile: args?.profile || 'guarded-root',
    profileExplicit: Object.prototype.hasOwnProperty.call(args || {}, 'profile'),
    permissionMode: args?.permissionMode || null,
    permissionModeExplicit: Object.prototype.hasOwnProperty.call(args || {}, 'permissionMode'),
    systemPrompt: args?.systemPrompt || null,
    externalSessionRef: args?.externalSessionRef || null,
    allowedTools: Array.isArray(args?.allowedTools) ? args.allowedTools.filter(Boolean) : [],
    forceNewRoot: args?.forceNewRoot === true,
    resumeRootSessionId: args?.resumeRootSessionId || null,
    resumeLatest: args?.resumeLatest === true,
    recoverRootSessionId: args?.recoverRootSessionId || null,
    recoverLatest: args?.recoverLatest === true,
    resumeMode: args?.resumeMode || null,
    providerSessionId: args?.providerSessionId || null,
    sourceRootSessionId: args?.sourceRootSessionId || null,
    detach: true
  };

  const hasResumeFlag = Boolean(launchOptions.resumeRootSessionId || launchOptions.resumeLatest);
  const hasRecoverFlag = Boolean(launchOptions.recoverRootSessionId || launchOptions.recoverLatest);
  const hasExplicitResumeMode = Boolean(launchOptions.resumeMode);
  if (launchOptions.forceNewRoot && (hasResumeFlag || hasRecoverFlag)) {
    throw new Error('Cannot combine forceNewRoot with resume or recover options');
  }
  if (launchOptions.externalSessionRef && (hasResumeFlag || hasRecoverFlag)) {
    throw new Error('Cannot combine externalSessionRef with resume or recover options');
  }
  if (hasResumeFlag && hasRecoverFlag) {
    throw new Error('Cannot combine resume and recover options in the same launch_root_session call');
  }
  if (hasExplicitResumeMode && (hasResumeFlag || hasRecoverFlag || launchOptions.forceNewRoot)) {
    throw new Error('Cannot combine resumeMode with resume/recover selectors or forceNewRoot');
  }

  if (launchOptions.resumeMode === 'exact' || launchOptions.resumeMode === 'context' || launchOptions.resumeMode === 'new') {
    if (launchOptions.resumeMode === 'exact' && !launchOptions.providerSessionId) {
      throw new Error('providerSessionId is required when resumeMode=exact');
    }
    const res = await callCliagents('POST', '/orchestration/root-sessions/launch', {
      adapter: launchOptions.adapter,
      workDir: launchOptions.workDir,
      model: launchOptions.model || null,
      permissionMode: launchOptions.permissionMode || null,
      profile: launchOptions.profile,
      systemPrompt: launchOptions.systemPrompt || null,
      externalSessionRef: launchOptions.externalSessionRef || null,
      allowedTools: launchOptions.allowedTools,
      resumeMode: launchOptions.resumeMode,
      providerSessionId: launchOptions.providerSessionId || null,
      sourceRootSessionId: launchOptions.sourceRootSessionId || null
    });
    if (res.status !== 200) {
      throw new Error(`Failed to launch root session: ${JSON.stringify(res.data)}`);
    }
    const data = res.data || {};
    return {
      content: [{
        type: 'text',
        text: [
          launchOptions.resumeMode === 'exact'
            ? '## Managed Root Exact Resumed'
            : (launchOptions.resumeMode === 'context' ? '## Managed Root Resumed with Context' : '## Managed Root Launched'),
          '',
          `adapter: ${data.adapter || launchOptions.adapter}`,
          `root_session_id: ${data.rootSessionId || 'n/a'}`,
          `terminal_id: ${data.terminalId || 'n/a'}`,
          `session_name: ${data.sessionName || 'n/a'}`,
          launchOptions.resumeMode === 'exact' ? `provider_session_id: ${launchOptions.providerSessionId}` : null,
          launchOptions.sourceRootSessionId ? `source_root_session_id: ${launchOptions.sourceRootSessionId}` : null,
          `external_session_ref: ${data.externalSessionRef || launchOptions.externalSessionRef || 'n/a'}`,
          `console_url: ${data.consoleUrl || 'n/a'}`,
          data.attachCommand ? `attach_command: ${data.attachCommand}` : null
        ].filter(Boolean).join('\n')
      }]
    };
  }

  const launchTarget = await resolveManagedRootLaunchTarget(launchOptions, {
    interactive: false
  });

  if (launchTarget.action === 'resume') {
    const candidate = launchTarget.candidate;
    return {
      content: [{
        type: 'text',
        text: [
          '## Managed Root Resumed',
          '',
          `adapter: ${candidate.adapter}`,
          `root_session_id: ${candidate.rootSessionId}`,
          `terminal_id: ${candidate.terminalId || 'n/a'}`,
          `session_name: ${candidate.sessionName || 'n/a'}`,
          `status: ${candidate.status}`,
          `workdir: ${candidate.workDir || 'n/a'}`,
          `external_session_ref: ${candidate.externalSessionRef || 'n/a'}`,
          `console_url: ${candidate.consoleUrl || 'n/a'}`,
          candidate.attachCommand ? `attach_command: ${candidate.attachCommand}` : null
        ].filter(Boolean).join('\n')
      }]
    };
  }

  if (launchTarget.action === 'recover') {
    const previousCandidate = launchTarget.candidate;
    const recoveryOptions = buildManagedRootRecoveryLaunchOptions(launchOptions, previousCandidate);
    const result = await launchManagedRootSession(recoveryOptions);

    return {
      content: [{
        type: 'text',
        text: [
          '## Managed Root Recovered',
          '',
          `adapter: ${result.adapter}`,
          `previous_root_session_id: ${previousCandidate.rootSessionId}`,
          `root_session_id: ${result.rootSessionId}`,
          `terminal_id: ${result.terminalId}`,
          `session_name: ${result.sessionName}`,
          `profile: ${recoveryOptions.profile}`,
          `recovery_reason: ${previousCandidate.recoveryReason || 'stale-root'}`,
          `external_session_ref: ${result.externalSessionRef || previousCandidate.externalSessionRef || 'n/a'}`,
          `provider_resume_session_id: ${recoveryOptions.sessionMetadata?.providerResumeSessionId || 'latest'}`,
          `console_url: ${result.consoleUrl || 'n/a'}`,
          result.attachCommand ? `attach_command: ${result.attachCommand}` : null
        ].filter(Boolean).join('\n')
      }]
    };
  }

  if (launchTarget.action === 'context') {
    const previousCandidate = launchTarget.candidate;
    const contextOptions = await buildManagedRootContextLaunchOptions(launchOptions, previousCandidate);
    const result = await launchManagedRootSession(contextOptions);

    return {
      content: [{
        type: 'text',
        text: [
          '## Managed Root Resumed with Context',
          '',
          `adapter: ${result.adapter}`,
          `previous_root_session_id: ${previousCandidate.rootSessionId}`,
          `root_session_id: ${result.rootSessionId}`,
          `terminal_id: ${result.terminalId}`,
          `session_name: ${result.sessionName}`,
          `profile: ${contextOptions.profile}`,
          'resume_mode: context',
          `context_reason: ${contextOptions.sessionMetadata?.modelSwitch ? 'model-switch' : (previousCandidate.recoveryReason || 'stale-root')}`,
          `external_session_ref: ${result.externalSessionRef || previousCandidate.externalSessionRef || 'n/a'}`,
          `console_url: ${result.consoleUrl || 'n/a'}`,
          result.attachCommand ? `attach_command: ${result.attachCommand}` : null
        ].filter(Boolean).join('\n')
      }]
    };
  }

  const result = await launchManagedRootSession(launchOptions);
  return {
    content: [{
      type: 'text',
      text: [
        '## Managed Root Launched',
        '',
        `adapter: ${result.adapter}`,
        `root_session_id: ${result.rootSessionId}`,
        `terminal_id: ${result.terminalId}`,
        `session_name: ${result.sessionName}`,
        `profile: ${launchOptions.profile}`,
        `external_session_ref: ${result.externalSessionRef || 'n/a'}`,
        `console_url: ${result.consoleUrl || 'n/a'}`,
        result.attachCommand ? `attach_command: ${result.attachCommand}` : null
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleAdoptRootSession(args) {
  const res = await callCliagents('POST', '/orchestration/root-sessions/adopt', {
    adapter: args?.adapter || 'codex-cli',
    tmuxTarget: args?.tmuxTarget || null,
    sessionName: args?.sessionName || null,
    windowName: args?.windowName || null,
    workDir: args?.workDir || args?.workingDirectory || null,
    model: args?.model || null,
    externalSessionRef: args?.externalSessionRef || null,
    rootSessionId: args?.rootSessionId || null
  });

  if (res.status !== 200) {
    throw new Error(`Failed to adopt root session: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Root Session Adopted',
        '',
        `adapter: ${data.adapter || args?.adapter || 'codex-cli'}`,
        `root_session_id: ${data.rootSessionId || 'n/a'}`,
        `terminal_id: ${data.terminalId || 'n/a'}`,
        `tmux_target: ${data.tmuxTarget || args?.tmuxTarget || [args?.sessionName, args?.windowName].filter(Boolean).join(':') || 'n/a'}`,
        `external_session_ref: ${data.externalSessionRef || args?.externalSessionRef || 'n/a'}`,
        `console_url: ${data.consoleUrl || 'n/a'}`,
        data.attachCommand ? `attach_command: ${data.attachCommand}` : null
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleListProviderSessions(args) {
  const adapter = args?.adapter || 'codex-cli';
  const params = new URLSearchParams();
  params.set('adapter', adapter);
  if (Number.isFinite(args?.limit)) {
    params.set('limit', String(args.limit));
  }
  if (args?.includeArchived === true) {
    params.set('includeArchived', '1');
  }

  const res = await callCliagents('GET', `/orchestration/provider-sessions?${params.toString()}`);
  if (res.status !== 200) {
    throw new Error(`Failed to list provider sessions: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  if (!data.supported) {
    return {
      content: [{
        type: 'text',
        text: `Provider-session discovery is not supported for ${adapter}.`
      }]
    };
  }
  if (sessions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No provider-local sessions found for ${adapter}.`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: [
        `## Provider Sessions (${adapter})`,
        '',
        sessions.map((session) => (
          `- ${session.providerSessionId} title="${truncateText(session.title || session.preview || 'session', 80)}"${session.updatedAt ? ` updated=${session.updatedAt}` : ''}${session.cwd ? ` cwd=${session.cwd}` : ''}${session.resumeCapability ? ` resume=${session.resumeCapability}` : ''}`
        )).join('\n')
      ].join('\n')
    }]
  };
}

async function handleImportProviderSession(args) {
  const res = await callCliagents('POST', '/orchestration/provider-sessions/import', {
    adapter: args?.adapter || 'codex-cli',
    providerSessionId: args?.providerSessionId,
    externalSessionRef: args?.externalSessionRef || null,
    rootSessionId: args?.rootSessionId || null
  });
  if (res.status !== 200) {
    throw new Error(`Failed to import provider session: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Provider Session Imported',
        '',
        `adapter: ${data.adapter || args?.adapter || 'codex-cli'}`,
        `provider_session_id: ${data.providerSessionId || args?.providerSessionId || 'n/a'}`,
        `root_session_id: ${data.rootSessionId || 'n/a'}`,
        `reused: ${data.reusedImportedRoot ? 'yes' : 'no'}`,
        `external_session_ref: ${data.externalSessionRef || 'n/a'}`,
        data.descriptor?.title ? `title: ${data.descriptor.title}` : null
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleCreateRoom(args) {
  const res = await callCliagents('POST', '/orchestration/rooms', {
    roomId: args?.roomId || null,
    title: args?.title || null,
    workDir: args?.workDir || null,
    participants: Array.isArray(args?.participants) ? args.participants : []
  });
  if (res.status !== 200) {
    throw new Error(`Failed to create room: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Room Created',
        '',
        `room_id: ${data.room?.id || 'n/a'}`,
        `root_session_id: ${data.room?.rootSessionId || 'n/a'}`,
        data.room?.title ? `title: ${data.room.title}` : null,
        `participants: ${Array.isArray(data.participants) ? data.participants.length : 0}`
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleListRooms(args) {
  const params = new URLSearchParams();
  if (Number.isFinite(args?.limit)) {
    params.set('limit', String(args.limit));
  }
  if (args?.status) {
    params.set('status', String(args.status));
  }
  const qs = params.toString();
  const res = await callCliagents('GET', `/orchestration/rooms${qs ? `?${qs}` : ''}`);
  if (res.status !== 200) {
    throw new Error(`Failed to list rooms: ${JSON.stringify(res.data)}`);
  }

  const rooms = Array.isArray(res.data?.rooms) ? res.data.rooms : [];
  return {
    content: [{
      type: 'text',
      text: [
        '## Rooms',
        '',
        `returned: ${rooms.length}`,
        '',
        rooms.map((entry) => {
          const room = entry.room || {};
          return [
            `${room.id || 'n/a'}${room.title ? ` (${room.title})` : ''}`,
            `participants=${entry.participantCount || 0}`,
            `messages=${entry.messageCount || 0}`,
            `latest_turn=${entry.latestTurn?.status || 'n/a'}`
          ].join(' • ');
        }).join('\n')
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleSendRoomMessage(args) {
  const res = await callCliagents('POST', `/orchestration/rooms/${encodeURIComponent(args?.roomId || '')}/messages`, {
    content: args?.content,
    mentions: Array.isArray(args?.mentions) ? args.mentions : [],
    requestId: args?.requestId || null
  });
  if (res.status !== 200) {
    throw new Error(`Failed to send room message: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Room Turn Completed',
        '',
        `room_id: ${data.roomId || args?.roomId || 'n/a'}`,
        `turn_id: ${data.turn?.id || 'n/a'}`,
        `status: ${data.turn?.status || 'unknown'}`,
        `participant_results: ${Array.isArray(data.participantResults) ? data.participantResults.length : 0}`
      ].join('\n')
    }]
  };
}

async function handleGetRoom(args) {
  const res = await callCliagents('GET', `/orchestration/rooms/${encodeURIComponent(args?.roomId || '')}`);
  if (res.status !== 200) {
    throw new Error(`Failed to get room: ${JSON.stringify(res.data)}`);
  }
  const data = res.data || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Room',
        '',
        `room_id: ${data.room?.id || 'n/a'}`,
        `root_session_id: ${data.room?.rootSessionId || 'n/a'}`,
        data.room?.title ? `title: ${data.room.title}` : null,
        `participants: ${Array.isArray(data.participants) ? data.participants.length : 0}`,
        data.latestTurn?.id ? `latest_turn_id: ${data.latestTurn.id}` : null,
        data.latestTurn?.status ? `latest_turn_status: ${data.latestTurn.status}` : null
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleGetRoomMessages(args) {
  const params = new URLSearchParams();
  if (Number.isInteger(args?.afterId)) {
    params.set('after_id', String(args.afterId));
  }
  if (Number.isFinite(args?.limit)) {
    params.set('limit', String(args.limit));
  }
  if (args?.artifactMode) {
    params.set('artifact_mode', String(args.artifactMode));
  }
  const qs = params.toString();
  const res = await callCliagents('GET', `/orchestration/rooms/${encodeURIComponent(args?.roomId || '')}/messages${qs ? `?${qs}` : ''}`);
  if (res.status !== 200) {
    throw new Error(`Failed to get room messages: ${JSON.stringify(res.data)}`);
  }
  const data = res.data || {};
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return {
    content: [{
      type: 'text',
      text: [
        '## Room Messages',
        '',
        `room_id: ${data.room?.id || args?.roomId || 'n/a'}`,
        `returned: ${messages.length}`,
        '',
        messages.map((message) => `${message.id}. ${message.role}${message.participantId ? `(${message.participantId})` : ''}: ${truncateText(message.content, 160)}`).join('\n')
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleDiscussRoom(args) {
  const res = await callCliagents('POST', `/orchestration/rooms/${encodeURIComponent(args?.roomId || '')}/discuss`, {
    message: args?.message,
    participantIds: Array.isArray(args?.participantIds) ? args.participantIds : [],
    requestId: args?.requestId || null,
    rounds: Array.isArray(args?.rounds) ? args.rounds : undefined,
    judge: Object.prototype.hasOwnProperty.call(args || {}, 'judge') ? args.judge : null,
    writebackMode: args?.writebackMode || null
  });
  if (res.status !== 200) {
    throw new Error(`Failed to discuss room: ${JSON.stringify(res.data)}`);
  }

  const data = res.data || {};
  return {
    content: [{
      type: 'text',
      text: [
        '## Room Discussion Completed',
        '',
        `room_id: ${data.roomId || args?.roomId || 'n/a'}`,
        `turn_id: ${data.turn?.id || 'n/a'}`,
        `status: ${data.turn?.status || 'unknown'}`,
        `run_id: ${data.runId || 'n/a'}`,
        `discussion_id: ${data.discussionId || 'n/a'}`,
        `writeback_mode: ${data.turn?.metadata?.writebackMode || args?.writebackMode || 'summary'}`
      ].join('\n')
    }]
  };
}

async function handleGetRootSessionStatus(args) {
  const rootContext = getAttachedRootContext();
  const rootSessionId = args?.rootSessionId || rootContext?.rootSessionId;
  if (!rootSessionId) {
    throw new Error('rootSessionId is required when no implicit MCP root session exists');
  }

  const eventLimit = Number.isFinite(args?.eventLimit) ? args.eventLimit : 120;
  const terminalLimit = Number.isFinite(args?.terminalLimit) ? args.terminalLimit : 50;
  const format = args?.format || 'summary';

  const res = await callCliagents(
    'GET',
    `/orchestration/root-sessions/${encodeURIComponent(rootSessionId)}?eventLimit=${encodeURIComponent(eventLimit)}&terminalLimit=${encodeURIComponent(terminalLimit)}`
  );

  if (res.status === 404) {
    throw new Error(`Root session not found: ${rootSessionId}`);
  }
  if (res.status !== 200) {
    throw new Error(`Failed to get root session status: ${JSON.stringify(res.data)}`);
  }

  if (format === 'json') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(res.data, null, 2)
      }]
    };
  }

  const snapshot = res.data;
  const attentionReasons = snapshot.attention?.reasons || [];
  const sessionLines = (snapshot.sessions || []).map((session) => {
    const adapter = session.adapter ? ` [${session.adapter}]` : '';
    const kind = session.sessionKind ? ` kind=${session.sessionKind}` : '';
    const profile = session.agentProfile ? ` profile=${session.agentProfile}` : '';
    return `- ${session.sessionId} status=${session.status}${adapter}${kind}${profile}`;
  });

  return {
    content: [{
      type: 'text',
      text: [
        `## Root Session: ${snapshot.rootSessionId}`,
        '',
        `status: ${snapshot.status}`,
        `root_mode: ${snapshot.rootMode || 'n/a'}`,
        `interactive_terminal_id: ${snapshot.interactiveTerminalId || 'n/a'}`,
        `sessions: ${snapshot.counts?.sessions || 0}`,
        `running: ${snapshot.counts?.running || 0}`,
        `blocked: ${snapshot.counts?.blocked || 0}`,
        `stale: ${snapshot.counts?.stale || 0}`,
        `reuse_events: ${snapshot.counts?.reuseEvents || 0}`,
        `reused_sessions: ${snapshot.counts?.reusedSessions || 0}`,
        snapshot.activitySummary ? `activity_summary: ${truncateText(snapshot.activitySummary, 220)}` : null,
        snapshot.activityExcerpt ? `activity_excerpt: ${truncateText(snapshot.activityExcerpt, 220)}` : null,
        snapshot.activitySource ? `activity_source: ${snapshot.activitySource}` : null,
        snapshot.latestConclusion?.summary ? `latest_conclusion: ${snapshot.latestConclusion.summary}` : null,
        attentionReasons.length > 0 ? `attention: ${attentionReasons.map((reason) => reason.code).join(', ')}` : 'attention: none',
        '',
        'Sessions:',
        sessionLines.join('\n')
      ].filter(Boolean).join('\n')
    }]
  };
}

async function handleListChildSessions(args) {
  const rootContext = getAttachedRootContext();
  const rootSessionId = args?.rootSessionId || rootContext?.rootSessionId;
  if (!rootSessionId) {
    throw new Error('rootSessionId is required when no implicit MCP root session exists');
  }

  const limit = Number.isFinite(args?.limit) ? args.limit : 50;
  let childSessions = null;
  const childRouteRes = await callCliagents(
    'GET',
    `/orchestration/root-sessions/${encodeURIComponent(rootSessionId)}/children?limit=${encodeURIComponent(limit)}`
  );

  if (childRouteRes.status === 200) {
    childSessions = Array.isArray(childRouteRes.data?.children)
      ? childRouteRes.data.children
      : [];
  } else if (childRouteRes.status === 404 && childRouteRes.data?.error?.code === 'root_session_not_found') {
    throw new Error(`Root session not found: ${rootSessionId}`);
  } else if (childRouteRes.status === 404) {
    const res = await callCliagents(
      'GET',
      `/orchestration/root-sessions/${encodeURIComponent(rootSessionId)}?terminalLimit=${encodeURIComponent(limit)}&eventLimit=0`
    );

    if (res.status === 404) {
      throw new Error(`Root session not found: ${rootSessionId}`);
    }
    if (res.status !== 200) {
      throw new Error(`Failed to list child sessions: ${JSON.stringify(res.data)}`);
    }

    childSessions = (res.data?.sessions || [])
      .filter((session) => session.sessionId !== rootSessionId)
      .map((session) => ({
        terminalId: session.terminalId || session.sessionId,
        sessionKind: session.sessionKind || null,
        sessionLabel: session.sessionLabel || null,
        adapter: session.adapter || null,
        role: session.role || null,
        agentProfile: session.agentProfile || null,
        status: session.status || null,
        lastActive: session.lastActive || null,
        providerThreadRefPresent: Boolean(session.providerThreadRef)
      }));
  } else {
    throw new Error(`Failed to list child sessions: ${JSON.stringify(childRouteRes.data)}`);
  }

  if (childSessions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No child sessions found for root ${rootSessionId}.`
      }]
    };
  }

  const sessionLines = childSessions.map((session) => {
    const adapter = session.adapter ? ` [${session.adapter}]` : '';
    const kind = session.sessionKind ? ` kind=${session.sessionKind}` : '';
    const label = session.sessionLabel ? ` label=${session.sessionLabel}` : '';
    const profile = session.agentProfile ? ` profile=${session.agentProfile}` : '';
    const role = session.role ? ` role=${session.role}` : '';
    const providerThread = session.providerThreadRefPresent ? ' providerThread=present' : '';
    const lastActive = session.lastActive ? ` lastActive=${session.lastActive}` : '';
    return `- ${session.terminalId} status=${session.status}${adapter}${kind}${label}${profile}${role}${providerThread}${lastActive}`;
  });

  return {
    content: [{
      type: 'text',
      text: [
        `## Child Sessions for Root: ${rootSessionId}`,
        '',
        `Total children: ${childSessions.length}`,
        '',
        sessionLines.join('\n')
      ].join('\n')
    }]
  };
}

async function handleGetUsageSummary(args) {
  const breakdown = String(args?.breakdown || '').trim();
  const format = args?.format || 'summary';
  let res;
  let scopeLabel = null;

  if (args?.rootSessionId) {
    scopeLabel = `root ${args.rootSessionId}`;
    res = await callCliagents(
      'GET',
      `/orchestration/usage/roots/${encodeURIComponent(args.rootSessionId)}${breakdown ? `?breakdown=${encodeURIComponent(breakdown)}` : ''}`
    );
  } else if (args?.runId) {
    scopeLabel = `run ${args.runId}`;
    res = await callCliagents(
      'GET',
      `/orchestration/usage/runs/${encodeURIComponent(args.runId)}${breakdown ? `?breakdown=${encodeURIComponent(breakdown)}` : ''}`
    );
  } else if (args?.terminalId) {
    scopeLabel = `terminal ${args.terminalId}`;
    const params = new URLSearchParams();
    if (breakdown) {
      params.set('breakdown', breakdown);
    }
    if (Number.isFinite(args?.limit)) {
      params.set('limit', String(args.limit));
    }
    res = await callCliagents(
      'GET',
      `/orchestration/usage/terminals/${encodeURIComponent(args.terminalId)}${params.toString() ? `?${params.toString()}` : ''}`
    );
  } else {
    throw new Error('One of rootSessionId, runId, or terminalId is required');
  }

  if (res.status !== 200) {
    throw new Error(`Failed to get usage summary for ${scopeLabel}: ${JSON.stringify(res.data)}`);
  }

  if (format === 'json') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(res.data, null, 2)
      }]
    };
  }

  const summary = res.data?.summary || {};
  const breakdowns = res.data?.breakdowns || {};
  const attribution = res.data?.attribution || null;
  const formatShare = (value) => {
    const numeric = Number(value || 0);
    return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '0.0%';
  };
  const breakdownLines = Object.entries(breakdowns).flatMap(([key, rows]) => {
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }
    return [
      '',
      `${key}:`,
      ...rows.slice(0, 5).map((entry) => {
        const parts = [`- ${entry.key}: total_tokens=${entry.totalTokens}`];
        if (entry.inputTokens || entry.outputTokens) {
          parts.push(`input_tokens=${entry.inputTokens || 0}`);
          parts.push(`output_tokens=${entry.outputTokens || 0}`);
        }
        if (entry.costUsd) {
          parts.push(`cost_usd=${entry.costUsd}`);
        }
        return parts.join(' ');
      })
    ];
  });
  const recordLines = Array.isArray(res.data?.records) && res.data.records.length > 0
    ? [
        '',
        'recent_records:',
        ...res.data.records.slice(0, 5).map((record) => (
          `- ${record.terminal_id || record.terminalId}: role=${record.effective_role || record.effectiveRole || 'unknown'} model=${record.model || 'n/a'} total_tokens=${record.total_tokens || record.totalTokens || 0} confidence=${record.source_confidence || record.sourceConfidence || 'unknown'}`
        ))
      ]
    : [];
  const attributionLines = attribution
    ? [
        '',
        'attribution:',
        `- execution_tokens: ${attribution.executionTokens || 0}`,
        `- planning_tokens: ${attribution.planningTokens || 0}`,
        `- judge_tokens: ${attribution.judgeTokens || 0}`,
        `- supervision_tokens: ${attribution.supervisionTokens || 0}`,
        `- broker_overhead_tokens: ${attribution.brokerOverheadTokens || 0}`,
        `- broker_overhead_share: ${formatShare(attribution.brokerOverheadShare || 0)}`,
        `- execution_share: ${formatShare(attribution.executionShare || 0)}`
      ]
    : [];

  const secondaryLines = [];
  if (summary.costUsd) {
    secondaryLines.push(`cost_usd: ${summary.costUsd}`);
  }
  if (summary.durationMs) {
    secondaryLines.push(`duration_ms: ${summary.durationMs}`);
  }

  return {
    content: [{
      type: 'text',
      text: [
        `## Usage Summary: ${scopeLabel}`,
        '',
        `records: ${summary.recordCount || 0}`,
        `total_tokens: ${summary.totalTokens || 0}`,
        `input_tokens: ${summary.inputTokens || 0}`,
        `output_tokens: ${summary.outputTokens || 0}`,
        `reasoning_tokens: ${summary.reasoningTokens || 0}`,
        `cached_input_tokens: ${summary.cachedInputTokens || 0}`,
        ...attributionLines,
        ...breakdownLines,
        ...(secondaryLines.length ? ['', 'secondary:', ...secondaryLines] : []),
        ...recordLines
      ].join('\n')
    }]
  };
}

async function handleGetMemoryBundle(args) {
  const { scopeId, scopeType = 'task', recentRunsLimit = 3, includeRawPointers = true } = args;
  if (!scopeId) {
    throw new Error('scopeId is required');
  }

  const params = new URLSearchParams();
  params.set('scope_type', scopeType);
  params.set('recent_runs_limit', String(recentRunsLimit));
  params.set('include_raw_pointers', String(includeRawPointers));

  const res = await callWithRetry(
    'GET',
    `/orchestration/memory/bundle/${encodeURIComponent(scopeId)}?${params.toString()}`
  );

  if (res.status !== 200) {
    throw new Error(`Failed to get memory bundle: ${JSON.stringify(res.data)}`);
  }

  const bundle = res.data;
  let text = `## Memory Bundle: ${bundle.scopeType} ${bundle.scopeId}\n\n`;
  text += `**Brief:** ${bundle.brief || 'n/a'}\n\n`;

  if (bundle.keyDecisions?.length > 0) {
    text += `### Key Decisions\n${bundle.keyDecisions.map(d => `- ${d}`).join('\n')}\n\n`;
  }

  if (bundle.pendingItems?.length > 0) {
    text += `### Pending Items\n${bundle.pendingItems.map(i => `- ${i}`).join('\n')}\n\n`;
  }

  if (bundle.findings?.length > 0) {
    text += `### Top Findings\n${bundle.findings.map(f => `- [${f.severity}/${f.type}] ${f.content}`).join('\n')}\n\n`;
  }

  if (bundle.recentRuns?.length > 0) {
    text += `### Recent Runs\n`;
    for (const run of bundle.recentRuns) {
      text += `- **${run.runId}** (${run.kind}): ${run.status} - ${run.brief || 'no brief'}\n`;
    }
    text += '\n';
  }

  if (bundle.isStale) {
    text += `*Note: This bundle is marked as STALE and may need a refresh.*\n\n`;
  }

  if (bundle.rawPointers) {
    text += `### Raw Pointers\n\`\`\`json\n${JSON.stringify(bundle.rawPointers, null, 2)}\n\`\`\`\n`;
  }

  return {
    content: [{
      type: 'text',
      text
    }]
  };
}

async function handleGetMessageWindow(args) {
  const { terminalId, rootSessionId, traceId, afterId, limit = 100, role } = args;

  const selectors = [terminalId, rootSessionId, traceId].filter(Boolean);
  if (selectors.length !== 1) {
    throw new Error('Exactly one of terminalId, rootSessionId, or traceId is required');
  }

  const params = new URLSearchParams();
  if (terminalId) params.set('terminal_id', terminalId);
  if (rootSessionId) params.set('root_session_id', rootSessionId);
  if (traceId) params.set('trace_id', traceId);
  if (afterId) params.set('after_id', String(afterId));
  if (limit) params.set('limit', String(limit));
  if (role) params.set('role', role);

  const res = await callWithRetry('GET', `/orchestration/memory/messages?${params.toString()}`);

  if (res.status !== 200) {
    throw new Error(`Failed to get messages: ${JSON.stringify(res.data)}`);
  }

  const { messages, pagination } = res.data;

  if (messages.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No messages found for the given criteria.'
      }]
    };
  }

  let text = `## Message History\n`;
  text += `Count: ${messages.length} / Total: ${pagination.total}\n\n`;

  for (const msg of messages) {
    const timestamp = msg.createdAt || msg.created_at;
    const time = timestamp ? new Date(timestamp).toISOString().split('T')[1].split('.')[0] : 'unknown';
    text += `### [${msg.id}] ${msg.role.toUpperCase()} @ ${time}\n`;
    text += `${msg.content}\n\n`;
    if (msg.metadata && Object.keys(msg.metadata).length > 0) {
      text += `*Metadata: ${JSON.stringify(msg.metadata)}*\n\n`;
    }
    text += `---\n\n`;
  }

  if (pagination.hasMore || pagination.has_more) {
    const lastId = pagination.nextAfterId || messages[messages.length - 1].id;
    text += `*More messages available. Use afterId=${lastId} to fetch next page.*`;
  }

  return {
    content: [{
      type: 'text',
      text
    }]
  };
}

// Shared Memory Handlers
async function handleShareFinding(args) {
  const { taskId, agentId, type, severity, content, file, line } = args;

  // Use retry wrapper for reliability
  const res = await callWithRetry('POST', '/orchestration/memory/findings', {
    taskId,
    agentId: agentId || 'mcp-client',
    content,
    type,
    severity,
    metadata: { file, line }
  });

  if (res.status !== 200) {
    throw new Error(`Failed to store finding: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: `Finding stored successfully.\n**ID:** ${res.data.id}\n**Task:** ${taskId}\n**Type:** ${type}\n**Severity:** ${severity || 'info'}`
    }]
  };
}

async function handleGetSharedFindings(args) {
  const { taskId, type, severity } = args;

  let path = `/orchestration/memory/findings/${taskId}`;
  const params = [];
  if (type) params.push(`type=${type}`);
  if (severity) params.push(`severity=${severity}`);
  if (params.length > 0) path += `?${params.join('&')}`;

  // Use retry wrapper for reliability
  const res = await callWithRetry('GET', path);

  if (res.status !== 200) {
    throw new Error(`Failed to get findings: ${JSON.stringify(res.data)}`);
  }

  const findings = res.data.findings || [];

  if (findings.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No findings found for task: ${taskId}`
      }]
    };
  }

  const formatted = findings.map(f => {
    const meta = f.metadata || {};
    const location = meta.file ? `\n  Location: ${meta.file}${meta.line ? `:${meta.line}` : ''}` : '';
    return `- **[${f.severity || 'info'}/${f.type}]** ${f.content}${location}\n  From: ${f.agent_profile || f.agent_id}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `## Findings for Task: ${taskId}\n\n${formatted}`
    }]
  };
}

async function handleStoreArtifact(args) {
  const { taskId, agentId, key, content, type } = args;

  // Use retry wrapper for reliability
  const res = await callWithRetry('POST', '/orchestration/memory/artifacts', {
    taskId,
    key,
    content,
    type,
    agentId: agentId || 'mcp-client'
  });

  if (res.status !== 200) {
    throw new Error(`Failed to store artifact: ${JSON.stringify(res.data)}`);
  }

  return {
    content: [{
      type: 'text',
      text: `Artifact stored successfully.\n**Key:** ${key}\n**Type:** ${type}\n**Task:** ${taskId}`
    }]
  };
}

// Skills System Handlers
async function handleListSkills(args) {
  const { tag, adapter } = args || {};
  const skillsService = getSkillsService();

  const skills = skillsService.listSkills({ tag, adapter });

  if (skills.length === 0) {
    let message = 'No skills found.';
    if (tag) message += ` No skills match tag "${tag}".`;
    if (adapter) message += ` No skills compatible with adapter "${adapter}".`;
    return {
      content: [{
        type: 'text',
        text: message
      }]
    };
  }

  // Group by source for display
  const bySource = { project: [], personal: [], core: [] };
  for (const skill of skills) {
    bySource[skill.source].push(skill);
  }

  let output = '# Available Skills\n\n';

  for (const [source, sourceSkills] of Object.entries(bySource)) {
    if (sourceSkills.length === 0) continue;

    output += `## ${source.charAt(0).toUpperCase() + source.slice(1)} Skills\n\n`;
    for (const skill of sourceSkills) {
      output += `### ${skill.name}\n`;
      output += `${skill.description || 'No description'}\n`;
      if (skill.tags.length > 0) {
        output += `Tags: ${skill.tags.join(', ')}\n`;
      }
      if (skill.adapters.length > 0) {
        output += `Adapters: ${skill.adapters.join(', ')}\n`;
      }
      output += '\n';
    }
  }

  output += `\n---\nTotal: ${skills.length} skills`;
  if (tag) output += ` (filtered by tag: ${tag})`;
  if (adapter) output += ` (filtered by adapter: ${adapter})`;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

async function handleInvokeSkill(args) {
  const { skill, message } = args;
  const skillsService = getSkillsService();

  const result = await skillsService.invokeSkill(skill, { message });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Error invoking skill: ${result.error}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: result.prompt
    }]
  };
}

async function handleGetSkill(args) {
  const { skill } = args;
  const skillsService = getSkillsService();

  const skillData = skillsService.loadSkill(skill);

  if (!skillData) {
    return {
      content: [{
        type: 'text',
        text: `Skill not found: ${skill}`
      }]
    };
  }

  let output = `# Skill: ${skillData.name}\n\n`;
  output += `**Description:** ${skillData.description || 'No description'}\n`;
  output += `**Source:** ${skillData.source}\n`;
  if (skillData.tags.length > 0) {
    output += `**Tags:** ${skillData.tags.join(', ')}\n`;
  }
  if (skillData.adapters.length > 0) {
    output += `**Compatible Adapters:** ${skillData.adapters.join(', ')}\n`;
  }
  output += `\n---\n\n`;
  output += skillData.content;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

// MCP request handler
async function handleRequest(request) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        if (isNotification) {
          return null;
        }
        return sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'cliagents',
            version: '1.0.0'
          }
        });

      case 'notifications/initialized':
        return null;

      case 'tools/list':
        if (isNotification) {
          return null;
        }
        return sendResponse(id, { tools: TOOLS });

      case 'tools/call':
        if (isNotification) {
          return null;
        }
        const { name, arguments: args } = params;
        let result;

        switch (name) {
          case 'delegate_task':
            result = await handleDelegateTask(args);
            break;
          case 'reply_to_terminal':
            result = await handleReplyToTerminal(args);
            break;
          case 'run_workflow':
            result = await handleRunWorkflow(args);
            break;
          case 'run_discussion':
            result = await handleRunDiscussion(args);
            break;
          case 'get_run_detail':
            result = await handleGetRunDetail(args);
            break;
          case 'list_runs':
            result = await handleListRuns(args);
            break;
          case 'list_agents':
            result = await handleListAgents();
            break;
          case 'list_models':
            result = await handleListModels(args);
            break;
          case 'recommend_model':
            result = await handleRecommendModel(args);
            break;
          case 'get_terminal_output':
            result = await handleGetTerminalOutput(args);
            break;
          case 'check_task_status':
            result = await handleCheckTaskStatus(args);
            break;
          case 'check_tasks_status':
            result = await handleCheckTasksStatus(args);
            break;
          case 'wait_for_tasks':
            result = await handleWaitForTasks(args);
            break;
          case 'watch_tasks':
            result = await handleWatchTasks(args);
            break;
          case 'ensure_root_session':
            result = await handleEnsureRootSession(args);
            break;
          case 'attach_root_session':
            result = await handleAttachRootSession(args);
            break;
          case 'reset_root_session':
            result = await handleResetRootSession(args);
            break;
          case 'launch_root_session':
            result = await handleLaunchRootSession(args);
            break;
          case 'list_provider_sessions':
            result = await handleListProviderSessions(args);
            break;
          case 'import_provider_session':
            result = await handleImportProviderSession(args);
            break;
          case 'adopt_root_session':
            result = await handleAdoptRootSession(args);
            break;
          case 'list_root_sessions':
            result = await handleListRootSessions(args);
            break;
          case 'get_root_session_status':
            result = await handleGetRootSessionStatus(args);
            break;
          case 'list_child_sessions':
            result = await handleListChildSessions(args);
            break;
          case 'get_usage_summary':
            result = await handleGetUsageSummary(args);
            break;
          case 'get_memory_bundle':
            result = await handleGetMemoryBundle(args);
            break;
          case 'get_message_window':
            result = await handleGetMessageWindow(args);
            break;
          case 'create_room':
            result = await handleCreateRoom(args);
            break;
          case 'list_rooms':
            result = await handleListRooms(args);
            break;
          case 'send_room_message':
            result = await handleSendRoomMessage(args);
            break;
          case 'get_room':
            result = await handleGetRoom(args);
            break;
          case 'get_room_messages':
            result = await handleGetRoomMessages(args);
            break;
          case 'discuss_room':
            result = await handleDiscussRoom(args);
            break;
          // Shared Memory Tools
          case 'share_finding':
            result = await handleShareFinding(args);
            break;
          case 'get_shared_findings':
            result = await handleGetSharedFindings(args);
            break;
          case 'store_artifact':
            result = await handleStoreArtifact(args);
            break;
          // Skills System Tools
          case 'list_skills':
            result = await handleListSkills(args);
            break;
          case 'invoke_skill':
            result = await handleInvokeSkill(args);
            break;
          case 'get_skill':
            result = await handleGetSkill(args);
            break;
          default:
            if (isNotification) {
              return null;
            }
            return sendError(id, -32601, `Unknown tool: ${name}`);
        }

        return sendResponse(id, result);

      default:
        if (isNotification) {
          return null;
        }
        return sendError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (error) {
    if (isNotification) {
      return null;
    }
    return sendError(id, -32000, error.message);
  }
}

if (require.main === module) {
  // Main: Read JSON-RPC from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      await handleRequest(request);
    } catch (error) {
      // Ignore parse errors for non-JSON lines
    }
  });

  // Handle shutdown gracefully
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

module.exports = {
  TOOLS,
  TIMEOUTS,
  buildRouteRequest,
  callCliagents,
  callWithRetry,
  handleEnsureRootSession,
  handleAttachRootSession,
  handleLaunchRootSession,
  handleAdoptRootSession,
  handleCheckTaskStatus,
  handleCheckTasksStatus,
  handleDelegateTask,
  handleReplyToTerminal,
  handleGetTerminalOutput,
  handleGetRootSessionStatus,
  handleListChildSessions,
  handleGetUsageSummary,
  handleListModels,
  handleRecommendModel,
  handleListProviderSessions,
  handleImportProviderSession,
  handleCreateRoom,
  handleListRooms,
  handleSendRoomMessage,
  handleGetRoom,
  handleGetRoomMessages,
  handleDiscussRoom,
  handleGetRunDetail,
  handleListRootSessions,
  handleListRuns,
  handleGetMemoryBundle,
  handleGetMessageWindow,
  handleResetRootSession,
  handleRequest,
  clearPersistedRootContext,
  setImplicitRootContext,
  handleRunDiscussion,
  handleRunWorkflow,
  handleWatchTasks,
  handleWaitForTasks,
  watchTasks,
  waitForTasks,
  waitForTerminalCompletion
};
