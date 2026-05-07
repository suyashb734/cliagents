#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentServer = require('../src/server');
const { extractOutput } = require('../src/utils/output-extractor');

const DEFAULT_ADAPTERS = ['codex-cli', 'gemini-cli'];
const DEFAULT_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 1500;
const REQUIRED_SUCCESSFUL_ADAPTERS = 2;

const RETRY_POLICY = {
  terminal_busy: { maxRetries: 1, delayMs: 1000 },
  binary_not_found: { maxRetries: 0, delayMs: 0 },
  auth_failed: { maxRetries: 0, delayMs: 0 },
  root_attach_required: { maxRetries: 0, delayMs: 0 },
  rate_limited: { maxRetries: 2, delayMs: 15000 },
  timeout: { maxRetries: 2, delayMs: 5000 },
  process_exit: { maxRetries: 1, delayMs: 3000 },
  permission_required: { maxRetries: 0, delayMs: 0 },
  unknown: { maxRetries: 1, delayMs: 2000 }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseArgs(argv) {
  const options = {
    adapters: [...DEFAULT_ADAPTERS],
    baseUrl: null,
    apiKey: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    workDir: process.cwd(),
    json: false,
    quiet: false,
    requireSuccessfulAdapters: REQUIRED_SUCCESSFUL_ADAPTERS
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--adapters') {
      const value = argv[i + 1] || '';
      i += 1;
      const adapters = value.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (adapters.length === 0) {
        throw new Error('--adapters requires a comma-separated list');
      }
      options.adapters = adapters;
      continue;
    }
    if (arg === '--base-url') {
      options.baseUrl = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--api-key') {
      options.apiKey = String(argv[i + 1] || '').trim() || null;
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const parsed = Number(argv[i + 1]);
      i += 1;
      if (!Number.isFinite(parsed) || parsed < 10000) {
        throw new Error('--timeout-ms must be a number >= 10000');
      }
      options.timeoutMs = Math.floor(parsed);
      continue;
    }
    if (arg === '--work-dir') {
      options.workDir = path.resolve(String(argv[i + 1] || process.cwd()));
      i += 1;
      continue;
    }
    if (arg === '--require-successful-adapters') {
      const parsed = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--require-successful-adapters must be an integer >= 1');
      }
      options.requireSuccessfulAdapters = parsed;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--quiet') {
      options.quiet = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Track A launch smoke test\n\nUsage:\n  node scripts/track-a-launch-smoke.js [options]\n\nOptions:\n  --adapters <list>                    Comma-separated adapters to validate (default: codex-cli,gemini-cli)\n  --base-url <url>                     Reuse an existing cliagents server instead of starting a local one\n  --api-key <key>                      API key for hosted/secured server requests\n  --timeout-ms <ms>                    Max time per flow attempt (default: ${DEFAULT_TIMEOUT_MS})\n  --work-dir <path>                    Working directory passed to orchestration route (default: current directory)\n  --require-successful-adapters <n>    Minimum adapters that must pass both flows (default: ${REQUIRED_SUCCESSFUL_ADAPTERS})\n  --json                               Print machine-readable JSON summary\n  --quiet                              Reduce per-step logs\n  --help, -h                           Show this help\n`);
}

function logLine(enabled, message) {
  if (enabled) {
    console.log(message);
  }
}

function buildHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function request(baseUrl, method, route, body, options = {}) {
  const url = `${baseUrl}${route}`;
  const response = await fetch(url, {
    method,
    headers: buildHeaders(options.apiKey),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}

  return { status: response.status, data };
}

function classifyFailure(message = '', attentionCode = '') {
  const code = String(attentionCode || '').trim().toLowerCase();
  if (code.includes('auth')) return 'auth_failed';
  if (code.includes('rate') || code.includes('quota')) return 'rate_limited';
  if (code.includes('timeout')) return 'timeout';
  if (code.includes('busy')) return 'terminal_busy';
  if (code.includes('permission') || code.includes('approval')) return 'permission_required';

  const text = String(message || '').toLowerCase();

  if (
    text.includes('terminal_busy')
    || text.includes('terminal is busy')
    || text.includes(' is busy')
    || text.includes('currently processing')
  ) {
    return 'terminal_busy';
  }

  if (
    text.includes('root session is required')
    || text.includes('ensure_root_session')
    || text.includes('attach_root_session')
  ) {
    return 'root_attach_required';
  }

  if (
    text.includes('command not found')
    || text.includes('not installed')
    || text.includes('adapter not available')
    || text.includes('binary')
  ) {
    return 'binary_not_found';
  }

  if (
    text.includes('not authenticated')
    || text.includes('authentication failed')
    || text.includes('please login')
    || text.includes('please log in')
    || text.includes('api key')
    || text.includes('unauthorized')
    || text.includes('forbidden')
  ) {
    return 'auth_failed';
  }

  if (
    text.includes('rate limit')
    || text.includes('quota')
    || text.includes('capacity on this model')
    || text.includes('usage limit')
    || text.includes('resourceexhausted')
  ) {
    return 'rate_limited';
  }

  if (
    text.includes('timed out')
    || text.includes('timeout')
    || text.includes('status: 504')
    || text.includes('deadline exceeded')
  ) {
    return 'timeout';
  }

  if (
    text.includes('exited with code')
    || text.includes('process exited')
    || text.includes('terminal entered an error state')
  ) {
    return 'process_exit';
  }

  if (
    text.includes('waiting for permission')
    || text.includes('approval required')
    || text.includes('blocked waiting for')
  ) {
    return 'permission_required';
  }

  return 'unknown';
}

function getRetryPolicy(failureClass) {
  return RETRY_POLICY[failureClass] || RETRY_POLICY.unknown;
}

async function getTerminalOutput(baseUrl, terminalId, adapter, options) {
  const outputRes = await request(
    baseUrl,
    'GET',
    `/orchestration/terminals/${encodeURIComponent(terminalId)}/output?lines=900`,
    null,
    { apiKey: options.apiKey, timeoutMs: 30000 }
  );

  if (outputRes.status !== 200) {
    return { raw: '', extracted: '' };
  }

  const raw = String(outputRes.data?.output || '');
  const extracted = String(extractOutput(raw, adapter) || raw).trim();
  return { raw, extracted };
}

async function waitForTerminalSettled(baseUrl, terminalId, adapter, options) {
  const startedAt = Date.now();
  let sawProcessing = false;

  while (Date.now() - startedAt < options.timeoutMs) {
    const statusRes = await request(
      baseUrl,
      'GET',
      `/orchestration/terminals/${encodeURIComponent(terminalId)}`,
      null,
      { apiKey: options.apiKey, timeoutMs: 30000 }
    );

    if (statusRes.status !== 200) {
      return {
        settled: 'failed',
        failureClass: classifyFailure(`terminal lookup failed with status ${statusRes.status}`),
        error: `terminal lookup failed with status ${statusRes.status}`,
        terminal: null,
        output: { raw: '', extracted: '' }
      };
    }

    const terminal = statusRes.data || {};
    const status = String(terminal.status || '').toLowerCase();

    if (['processing', 'queued', 'running', 'pending', 'partial'].includes(status)) {
      sawProcessing = true;
    }

    if (['waiting_permission', 'waiting_user_answer', 'blocked'].includes(status)) {
      const output = await getTerminalOutput(baseUrl, terminalId, adapter, options);
      const failureMessage = terminal.attention?.message || output.extracted || output.raw || status;
      return {
        settled: 'blocked',
        failureClass: classifyFailure(failureMessage, terminal.attention?.code),
        error: failureMessage,
        terminal,
        output
      };
    }

    if (status === 'error' || status === 'failed') {
      const output = await getTerminalOutput(baseUrl, terminalId, adapter, options);
      const failureMessage = terminal.attention?.message || output.extracted || output.raw || status;
      return {
        settled: 'failed',
        failureClass: classifyFailure(failureMessage, terminal.attention?.code),
        error: failureMessage,
        terminal,
        output
      };
    }

    if (status === 'completed' || (status === 'idle' && sawProcessing)) {
      const output = await getTerminalOutput(baseUrl, terminalId, adapter, options);
      return {
        settled: 'completed',
        failureClass: null,
        error: null,
        terminal,
        output
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return {
    settled: 'failed',
    failureClass: 'timeout',
    error: `timed out after ${options.timeoutMs}ms waiting for ${terminalId}`,
    terminal: null,
    output: { raw: '', extracted: '' }
  };
}

async function destroyTerminal(baseUrl, terminalId, options) {
  try {
    await request(
      baseUrl,
      'DELETE',
      `/orchestration/terminals/${encodeURIComponent(terminalId)}`,
      null,
      { apiKey: options.apiKey, timeoutMs: 30000 }
    );
  } catch {
    // best-effort cleanup
  }
}

function buildFlowPrompt(role, marker) {
  if (role === 'implement') {
    return [
      'Track-A launch smoke test.',
      'Reply in plain text with exactly one line containing this token:',
      `IMPLEMENT_OK::${marker}`,
      'No extra markdown.'
    ].join('\n');
  }

  return [
    'Track-A launch smoke test.',
    'Review the snippet and provide one concise risk statement.',
    'Snippet:',
    '--- a/auth.js',
    '+++ b/auth.js',
    '@@',
    '-if (!user) return;',
    '+if (!user) throw new Error("missing user");',
    'Include this token exactly in your response:',
    `REVIEW_OK::${marker}`
  ].join('\n');
}

function expectedTokenForRole(role, marker) {
  return role === 'implement'
    ? `IMPLEMENT_OK::${marker}`
    : `REVIEW_OK::${marker}`;
}

async function runFlowAttempt(baseUrl, adapter, role, marker, options) {
  const prompt = buildFlowPrompt(role, marker);
  const routeBody = {
    forceRole: role,
    forceAdapter: adapter,
    message: prompt,
    workingDirectory: options.workDir,
    preferReuse: false,
    forceFreshSession: true
  };
  if (options.rootSessionId) {
    routeBody.rootSessionId = options.rootSessionId;
    routeBody.parentSessionId = options.rootSessionId;
    routeBody.sessionKind = 'subagent';
    routeBody.originClient = 'codex';
    routeBody.externalSessionRef = options.externalSessionRef || null;
    routeBody.sessionMetadata = {
      purpose: 'track-a-launch-smoke',
      workspaceRoot: options.workDir
    };
  }

  const routeRes = await request(baseUrl, 'POST', '/orchestration/route', routeBody, {
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs
  });

  if (routeRes.status !== 200 || !routeRes.data?.terminalId) {
    const message = routeRes.data?.error?.message || JSON.stringify(routeRes.data);
    return {
      ok: false,
      failureClass: classifyFailure(message),
      error: `route failed (${routeRes.status}): ${message}`,
      terminalId: null,
      settled: null,
      output: { raw: '', extracted: '' }
    };
  }

  const terminalId = routeRes.data.terminalId;
  const settled = await waitForTerminalSettled(baseUrl, terminalId, adapter, options);

  await destroyTerminal(baseUrl, terminalId, options);

  if (settled.settled !== 'completed') {
    return {
      ok: false,
      failureClass: settled.failureClass || 'unknown',
      error: settled.error || `terminal settled as ${settled.settled}`,
      terminalId,
      settled: settled.settled,
      output: settled.output
    };
  }

  const expectedToken = expectedTokenForRole(role, marker).toLowerCase();
  const normalized = String(settled.output.extracted || settled.output.raw || '').toLowerCase();

  if (!normalized.includes(expectedToken)) {
    return {
      ok: false,
      failureClass: 'unknown',
      error: `missing expected token ${expectedToken}`,
      terminalId,
      settled: settled.settled,
      output: settled.output
    };
  }

  return {
    ok: true,
    failureClass: null,
    error: null,
    terminalId,
    settled: settled.settled,
    output: settled.output
  };
}

async function runFlowWithRetries(baseUrl, adapter, role, options) {
  const marker = `${adapter.replace(/[^a-z0-9]+/gi, '-').toUpperCase()}-${role.toUpperCase()}-${Date.now()}`;
  let attempt = 0;
  const startedAt = Date.now();
  let lastResult = null;

  while (true) {
    attempt += 1;
    lastResult = await runFlowAttempt(baseUrl, adapter, role, marker, options);
    if (lastResult.ok) {
      return {
        ok: true,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        failureClass: null,
        error: null,
        marker,
        outputPreview: String(lastResult.output.extracted || '').slice(0, 280)
      };
    }

    const failureClass = lastResult.failureClass || classifyFailure(lastResult.error || '');
    const policy = getRetryPolicy(failureClass);

    if (attempt > policy.maxRetries + 1) {
      return {
        ok: false,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        failureClass,
        error: lastResult.error,
        marker,
        outputPreview: String(lastResult.output?.extracted || lastResult.output?.raw || '').slice(0, 280)
      };
    }

    if (policy.delayMs > 0) {
      await sleep(policy.delayMs);
    }
  }
}

async function startLocalServer(workDir) {
  const tempDataDir = createTempDir('cliagents-smoke-data-');
  const tempLogDir = createTempDir('cliagents-smoke-logs-');
  const tempTmuxDir = createTempDir('cliagents-smoke-tmux-');
  const tmuxSocketPath = path.join(tempTmuxDir, 'broker.sock');

  const server = new AgentServer({
    host: '127.0.0.1',
    port: 0,
    cleanupOrphans: false,
    orchestration: {
      dataDir: tempDataDir,
      logDir: tempLogDir,
      tmuxSocketPath,
      workDir,
      destroyTerminalsOnStop: true
    }
  });

  await server.start();
  const address = server.server?.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanupPaths: [tempDataDir, tempLogDir, tempTmuxDir]
  };
}

async function stopLocalServer(serverHandle) {
  if (!serverHandle) {
    return;
  }

  try {
    await serverHandle.server.stop();
  } finally {
    for (const entry of serverHandle.cleanupPaths || []) {
      try {
        fs.rmSync(entry, { recursive: true, force: true });
      } catch {}
    }
  }
}

async function fetchAdapterAvailability(baseUrl, options) {
  const adaptersRes = await request(baseUrl, 'GET', '/adapters', null, {
    apiKey: options.apiKey,
    timeoutMs: 30000
  });

  if (adaptersRes.status !== 200) {
    throw new Error(`GET /adapters failed with status ${adaptersRes.status}`);
  }

  const map = new Map();
  for (const adapter of adaptersRes.data?.adapters || []) {
    map.set(String(adapter.name), adapter);
  }
  return map;
}

async function ensureRootSession(baseUrl, options) {
  const externalSessionRef = options.externalSessionRef || `track-a-launch-smoke:${Date.now()}`;
  const attachRes = await request(baseUrl, 'POST', '/orchestration/root-sessions/attach', {
    originClient: 'codex',
    externalSessionRef,
    sessionMetadata: {
      clientName: 'codex-cli',
      workspaceRoot: options.workDir,
      purpose: 'track-a-launch-smoke'
    }
  }, {
    apiKey: options.apiKey,
    timeoutMs: 60000
  });

  if (attachRes.status !== 200 || !attachRes.data?.rootSessionId) {
    const message = attachRes.data?.error?.message || JSON.stringify(attachRes.data);
    throw new Error(`root attach failed (${attachRes.status}): ${message}`);
  }

  return {
    rootSessionId: attachRes.data.rootSessionId,
    externalSessionRef
  };
}

async function runSmoke(options) {
  const startedAt = new Date().toISOString();
  let localServer = null;
  let baseUrl = options.baseUrl;

  if (!baseUrl) {
    localServer = await startLocalServer(options.workDir);
    baseUrl = localServer.baseUrl;
  }

  const adapterMap = await fetchAdapterAvailability(baseUrl, options);
  const root = await ensureRootSession(baseUrl, options);

  const summary = {
    startedAt,
    finishedAt: null,
    mode: options.baseUrl ? 'hosted' : 'local',
    baseUrl,
    rootSessionId: root.rootSessionId,
    workDir: options.workDir,
    adaptersRequested: options.adapters,
    adapters: []
  };

  try {
    for (const adapterName of options.adapters) {
      const adapterInfo = adapterMap.get(adapterName);
      if (!adapterInfo) {
        summary.adapters.push({
          adapter: adapterName,
          status: 'failed',
          reason: 'adapter_not_registered',
          implement: null,
          review: null
        });
        continue;
      }
      if (!adapterInfo.available) {
        summary.adapters.push({
          adapter: adapterName,
          status: 'failed',
          reason: 'adapter_not_available',
          implement: null,
          review: null
        });
        continue;
      }

      logLine(!options.quiet, `[smoke] ${adapterName}: starting implement flow`);
      const implement = await runFlowWithRetries(baseUrl, adapterName, 'implement', {
        ...options,
        rootSessionId: root.rootSessionId,
        externalSessionRef: root.externalSessionRef
      });

      logLine(!options.quiet, `[smoke] ${adapterName}: starting review flow`);
      const review = await runFlowWithRetries(baseUrl, adapterName, 'review', {
        ...options,
        rootSessionId: root.rootSessionId,
        externalSessionRef: root.externalSessionRef
      });

      const passed = implement.ok && review.ok;
      summary.adapters.push({
        adapter: adapterName,
        status: passed ? 'passed' : 'failed',
        reason: passed
          ? null
          : `implement=${implement.failureClass || 'ok'} review=${review.failureClass || 'ok'}`,
        implement,
        review
      });
    }
  } finally {
    if (localServer) {
      await stopLocalServer(localServer);
    }
  }

  summary.finishedAt = new Date().toISOString();

  const passedAdapters = summary.adapters.filter((entry) => entry.status === 'passed').length;
  summary.passedAdapters = passedAdapters;
  summary.requiredSuccessfulAdapters = options.requireSuccessfulAdapters;
  summary.success = passedAdapters >= options.requireSuccessfulAdapters;

  return summary;
}

function printHumanSummary(summary) {
  console.log('\nTrack A Launch Smoke Summary');
  console.log(`mode: ${summary.mode}`);
  console.log(`baseUrl: ${summary.baseUrl}`);
  console.log(`workDir: ${summary.workDir}`);

  for (const adapter of summary.adapters) {
    console.log(`\n- ${adapter.adapter}: ${adapter.status}`);
    if (adapter.reason) {
      console.log(`  reason: ${adapter.reason}`);
    }
    if (adapter.implement) {
      console.log(`  implement: ${adapter.implement.ok ? 'pass' : 'fail'} (attempts=${adapter.implement.attempts}, failure=${adapter.implement.failureClass || 'none'})`);
    }
    if (adapter.review) {
      console.log(`  review: ${adapter.review.ok ? 'pass' : 'fail'} (attempts=${adapter.review.attempts}, failure=${adapter.review.failureClass || 'none'})`);
    }
  }

  console.log(`\npassedAdapters=${summary.passedAdapters} required=${summary.requiredSuccessfulAdapters}`);
  console.log(`overall=${summary.success ? 'PASS' : 'FAIL'}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runSmoke(options);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary);
  }

  process.exit(summary.success ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Track A launch smoke failed: ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  classifyFailure,
  getRetryPolicy,
  parseArgs
};
