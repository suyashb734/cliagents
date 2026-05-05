#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SESSION_GRAPH_WRITES_ENABLED = '1';
process.env.SESSION_EVENTS_ENABLED = '1';
process.env.CLIAGENTS_REQUIRE_ROOT_ATTACH = '1';

const { startTestServer, stopTestServer } = require('./helpers/server-harness');
const { ACTIVE_BROKER_ADAPTERS } = require('../src/adapters/active-surface');
const { isAdapterAuthenticated } = require('../src/utils/adapter-auth');
const { extractOutput } = require('../src/utils/output-extractor');

const RESULTS = [];
const DEFAULT_READINESS_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_SKIP_PATTERNS = [
  'not authenticated',
  'authentication failed',
  'please log in',
  'please login',
  'login required',
  'api key',
  'quota',
  'usage limit',
  'rate limit',
  'resourceexhausted',
  'capacity on this model',
  'no active provider',
  'no active subscription',
  'billing',
  'request timed out',
  'status: 504',
  'timed out',
  'automated queries',
  'google help',
  'cloudcode-pa.googleapis.com',
  "we're sorry..."
];

let testServer = null;
let baseUrl = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTempWorkDir(prefix) {
  const parent = path.join(os.homedir(), '.cliagents-test-tmp', 'child-adapter-reliability');
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, `${prefix}-`));
}

function short(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isSkippableProviderFailure(message = '') {
  const text = String(message).toLowerCase();
  return PROVIDER_SKIP_PATTERNS.some((pattern) => text.includes(pattern));
}

function classifyReasonCode(message = '') {
  const text = String(message || '').toLowerCase();
  if (text.includes('not installed') || text.includes('not registered') || text.includes('binary') || text.includes('command not found')) {
    return 'binary_not_found';
  }
  if (text.includes('not authenticated') || text.includes('authentication failed') || text.includes('please log in') || text.includes('please login') || text.includes('login required') || text.includes('api key')) {
    return 'auth_failed';
  }
  if (text.includes('quota') || text.includes('usage limit') || text.includes('resourceexhausted') || text.includes('capacity on this model')) {
    return 'quota_exceeded';
  }
  if (text.includes('rate limit')) {
    return 'rate_limited';
  }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('status: 504')) {
    return 'timeout';
  }
  return 'unknown';
}

async function request(method, route, body = null, timeoutMs = 180000) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}

  return { status: response.status, data };
}

async function getAdapterMap() {
  const { status, data } = await request('GET', '/adapters', null, 30000);
  assert.strictEqual(status, 200, `Expected /adapters 200, got ${status}`);
  return new Map((data.adapters || []).map((adapter) => [adapter.name, adapter]));
}

async function ensureAdapterReady(adapterName) {
  const adapters = await getAdapterMap();
  const adapter = adapters.get(adapterName);
  if (!adapter) {
    throw new Error(`SKIP: adapter ${adapterName} not registered`);
  }
  if (!adapter.available) {
    throw new Error(`SKIP: adapter ${adapterName} not installed`);
  }
  const auth = isAdapterAuthenticated(adapterName);
  if (!auth.authenticated) {
    throw new Error(`SKIP: ${auth.reason}`);
  }
  return { adapter, auth };
}

async function attachRootSession(externalSessionRef, workspaceRoot) {
  const { status, data } = await request('POST', '/orchestration/root-sessions/attach', {
    originClient: 'codex',
    externalSessionRef,
    sessionMetadata: {
      clientName: 'codex-cli',
      workspaceRoot,
      purpose: 'child-adapter-reliability-live'
    }
  }, 60000);

  if (status !== 200) {
    throw new Error(`attach root failed: ${status} ${JSON.stringify(data)}`);
  }

  return data.rootSessionId;
}

async function routeChildTask({ adapterName, workDir, rootSessionId, marker, collaboratorReady = false }) {
  const sessionLabel = collaboratorReady ? `reliability-${adapterName}` : null;
  const { status, data } = await request('POST', '/orchestration/route', {
    forceRole: 'research',
    forceAdapter: adapterName,
    message: `Remember the session marker ${marker}. Reply with READY and include the marker.`,
    workingDirectory: workDir,
    rootSessionId,
    parentSessionId: rootSessionId,
    originClient: 'codex',
    externalSessionRef: `codex:child-reliability:${adapterName}`,
    sessionKind: collaboratorReady ? 'collaborator' : 'subagent',
    sessionMetadata: {
      clientName: 'codex-cli',
      workspaceRoot: workDir,
      purpose: 'child-adapter-reliability-live',
      sessionLabel: sessionLabel || `reliability-${adapterName}`,
      ...(collaboratorReady ? { collaborator: true } : {})
    },
    sessionLabel,
    preferReuse: false,
    forceFreshSession: true
  }, 180000);

  if (status !== 200) {
    const message = data?.error?.message || JSON.stringify(data);
    if (isSkippableProviderFailure(message)) {
      throw new Error(`SKIP: ${message}`);
    }
    throw new Error(`route launch failed: ${status} ${message}`);
  }

  return data;
}

async function fetchTerminal(terminalId) {
  const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}`, null, 30000);
  if (status !== 200) {
    throw new Error(`terminal fetch failed: ${status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function fetchMessages(terminalId) {
  const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}/messages`, null, 30000);
  if (status !== 200) {
    throw new Error(`messages fetch failed: ${status} ${JSON.stringify(data)}`);
  }
  return data.messages || [];
}

async function fetchExtractedOutput(terminalId, adapterName) {
  const { status, data } = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=800`, null, 30000);
  if (status !== 200) {
    throw new Error(`output fetch failed: ${status} ${JSON.stringify(data)}`);
  }
  const raw = String(data.output || '');
  const extracted = String(extractOutput(raw, adapterName) || raw).trim();
  return { raw, extracted };
}

async function waitForSettledOutput(terminalId, adapterName, timeoutMs = 240000) {
  const started = Date.now();
  let sawProcessing = false;

  while (Date.now() - started < timeoutMs) {
    const terminal = await fetchTerminal(terminalId);
    const status = String(terminal.status || '').toLowerCase();

    if (['processing', 'queued', 'running', 'pending', 'partial'].includes(status)) {
      sawProcessing = true;
    }

    if (['waiting_permission', 'waiting_user_answer', 'blocked'].includes(status)) {
      const output = await fetchExtractedOutput(terminalId, adapterName);
      return { terminal, settled: 'blocked', output };
    }

    if (['error', 'failed', 'cancelled', 'abandoned', 'destroyed'].includes(status)) {
      const output = await fetchExtractedOutput(terminalId, adapterName);
      const failureText = output.extracted || output.raw || status;
      if (isSkippableProviderFailure(failureText)) {
        throw new Error(`SKIP: ${failureText}`);
      }
      return { terminal, settled: 'failed', output };
    }

    if (status === 'completed' || (status === 'idle' && sawProcessing)) {
      const output = await fetchExtractedOutput(terminalId, adapterName);
      return { terminal, settled: 'completed', output };
    }

    await sleep(1500);
  }

  throw new Error(`timed out waiting for terminal ${terminalId} to settle`);
}

async function fetchRootSnapshot(rootSessionId) {
  const { status, data } = await request('GET', `/orchestration/root-sessions/${rootSessionId}?eventLimit=200&terminalLimit=100`, null, 30000);
  if (status !== 200) {
    throw new Error(`root snapshot fetch failed: ${status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendFollowup(terminalId, message) {
  const { status, data } = await request('POST', `/orchestration/terminals/${terminalId}/input`, { message }, 180000);
  if (status !== 200) {
    const errorMessage = data?.error?.message || JSON.stringify(data);
    if (isSkippableProviderFailure(errorMessage)) {
      throw new Error(`SKIP: ${errorMessage}`);
    }
    throw new Error(`follow-up input failed: ${status} ${errorMessage}`);
  }
  return data;
}

async function destroyTerminal(terminalId) {
  await request('DELETE', `/orchestration/terminals/${terminalId}`, null, 30000);
}

function summarizeOverall(checks) {
  const requiredForReady = [
    'route_launch',
    'root_attachment',
    'workdir_metadata',
    'first_output',
    'message_persistence',
    'followup_input',
    'session_continuity'
  ];

  if (requiredForReady.every((key) => checks[key] === true)) {
    return 'ready';
  }

  if (
    checks.route_launch === true
    && checks.first_output === true
    && checks.followup_input === true
  ) {
    return 'partial';
  }

  return 'not-ready';
}

async function runAdapterCheck(adapterName) {
  const checks = {
    available: false,
    authenticated: false,
    route_launch: false,
    root_attachment: false,
    workdir_metadata: false,
    first_output: false,
    message_persistence: false,
    followup_input: false,
    session_continuity: false
  };

  const details = [];
  const workDir = makeTempWorkDir(`child-${adapterName.replace(/[^a-z0-9]+/gi, '-')}-`);
  const marker = `${adapterName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CHILD_MARKER`;
  const externalSessionRef = `codex:child-matrix:${adapterName}:${Date.now()}`;
  let terminalId = null;

  try {
    const readiness = await ensureAdapterReady(adapterName);
    checks.available = true;
    checks.authenticated = true;
    details.push(`models=${Array.isArray(readiness.adapter.models) ? readiness.adapter.models.length : 0}`);
    const collaboratorReady = readiness.adapter.childSessionSupport?.collaboratorReady === true;
    details.push(`mode=${collaboratorReady ? 'collaborator' : 'subagent'}`);

    const rootSessionId = await attachRootSession(externalSessionRef, workDir);
    details.push(`root=${rootSessionId.slice(0, 8)}`);

    const routed = await routeChildTask({ adapterName, workDir, rootSessionId, marker, collaboratorReady });
    terminalId = routed.terminalId;
    checks.route_launch = Boolean(terminalId);
    details.push(`profile=${routed.profile}`);

    const terminal = await fetchTerminal(terminalId);
    checks.workdir_metadata = terminal.workDir === workDir;
    if (!checks.workdir_metadata) {
      details.push(`workdir-mismatch=${terminal.workDir || 'missing'}`);
    }

    const initialSnapshot = await fetchRootSnapshot(rootSessionId);
    const childSession = (initialSnapshot.sessions || []).find((session) => session?.terminalId === terminalId);
    checks.root_attachment = Boolean(
      childSession
      && childSession.sessionId !== rootSessionId
      && childSession.parentSessionId === rootSessionId
    );

    const firstTurn = await waitForSettledOutput(terminalId, adapterName);
    if (firstTurn.settled === 'completed' && firstTurn.output.extracted) {
      checks.first_output = true;
    } else {
      details.push(`first-turn=${firstTurn.settled}`);
    }

    const messagesAfterFirstTurn = await fetchMessages(terminalId);
    checks.message_persistence = messagesAfterFirstTurn.some((message) => (
      message.role === 'user'
      && String(message.content || '').includes(marker)
    ));

    await sendFollowup(
      terminalId,
      'What is the session marker for this conversation? Reply with the marker only.'
    );
    checks.followup_input = true;

    const secondTurn = await waitForSettledOutput(terminalId, adapterName);
    const secondOutput = secondTurn.output.extracted || secondTurn.output.raw;
    checks.session_continuity = secondTurn.settled === 'completed'
      && String(secondOutput).toUpperCase().includes(marker);
    if (!checks.session_continuity) {
      details.push(`second-output=${short(secondOutput, 120) || secondTurn.settled}`);
    }

    const messagesAfterSecondTurn = await fetchMessages(terminalId);
    const userMessages = messagesAfterSecondTurn.filter((message) => message.role === 'user');
    if (userMessages.length < 2) {
      checks.message_persistence = false;
      details.push(`user-messages=${userMessages.length}`);
    }

    const overall = summarizeOverall(checks);
    const reason = details.join(' | ') || null;
    return {
      adapter: adapterName,
      overall,
      checks,
      details,
      available: checks.available,
      authenticated: checks.authenticated,
      ephemeralReady: overall === 'ready' || overall === 'partial',
      collaboratorReady: overall === 'ready',
      continuityMode: overall === 'ready' ? 'provider_resume' : 'stateless',
      reasonCode: overall === 'ready' ? null : overall === 'partial' ? 'live_test_partial' : classifyReasonCode(reason || secondOutput),
      reason,
      source: 'live',
      verifiedAt: Date.now(),
      staleAfterMs: DEFAULT_READINESS_TTL_MS,
      firstOutput: short(firstTurn.output.extracted || firstTurn.output.raw, 160),
      secondOutput: short(secondOutput, 160)
    };
  } finally {
    if (terminalId) {
      await destroyTerminal(terminalId);
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function recordResult(adapterName, fn) {
  try {
    const result = await fn();
    RESULTS.push({ adapter: adapterName, status: 'ok', ...result });
    console.log(`  ✅ ${adapterName}: ${result.overall}`);
  } catch (error) {
    const message = String(error.message || error);
    if (message.startsWith('SKIP:')) {
      RESULTS.push({
        adapter: adapterName,
        status: 'skipped',
        overall: 'skipped',
        checks: {},
        details: [message.slice('SKIP:'.length).trim()],
        available: message.includes('not installed') || message.includes('not registered') ? false : null,
        authenticated: classifyReasonCode(message) === 'auth_failed' ? false : null,
        ephemeralReady: false,
        collaboratorReady: false,
        continuityMode: 'stateless',
        reasonCode: classifyReasonCode(message),
        reason: message.slice('SKIP:'.length).trim(),
        source: 'live',
        verifiedAt: Date.now(),
        staleAfterMs: DEFAULT_READINESS_TTL_MS
      });
      console.log(`  ⏭️  ${adapterName}: ${message.slice('SKIP:'.length).trim()}`);
      return;
    }

    RESULTS.push({
      adapter: adapterName,
      status: 'failed',
      overall: 'not-ready',
      checks: {},
      details: [message],
      available: null,
      authenticated: null,
      ephemeralReady: false,
      collaboratorReady: false,
      continuityMode: 'stateless',
      reasonCode: classifyReasonCode(message) === 'unknown' ? 'live_test_failed' : classifyReasonCode(message),
      reason: message,
      source: 'live',
      verifiedAt: Date.now(),
      staleAfterMs: DEFAULT_READINESS_TTL_MS
    });
    console.log(`  ❌ ${adapterName}: ${message}`);
  }
}

function buildReadinessPayload() {
  return {
    results: RESULTS.map((result) => ({
      adapter: result.adapter,
      available: result.available,
      authenticated: result.authenticated,
      ephemeralReady: result.ephemeralReady,
      collaboratorReady: result.collaboratorReady,
      continuityMode: result.continuityMode,
      overall: result.overall,
      reasonCode: result.reasonCode,
      reason: result.reason || (result.details || []).join(' | ') || null,
      checks: result.checks || {},
      details: result.details || [],
      source: 'live',
      verifiedAt: result.verifiedAt || Date.now(),
      staleAfterMs: result.staleAfterMs || DEFAULT_READINESS_TTL_MS
    }))
  };
}

async function maybePostReadinessResults() {
  if (process.env.CLIAGENTS_POST_READINESS_RESULTS !== '1') {
    return;
  }
  try {
    const { status, data } = await request('POST', '/orchestration/adapters/readiness', buildReadinessPayload(), 30000);
    if (status !== 200) {
      console.warn(`\n⚠️  Failed to record readiness results: ${status} ${JSON.stringify(data)}`);
      return;
    }
    console.log(`\nRecorded readiness results: accepted=${data.accepted || 0}, rejected=${data.rejected || 0}`);
  } catch (error) {
    console.warn(`\n⚠️  Failed to record readiness results: ${error.message}`);
  }
}

function maybePrintJsonResults() {
  if (process.env.CLIAGENTS_READINESS_JSON !== '1') {
    return;
  }
  console.log('\nReadiness JSON\n');
  console.log(JSON.stringify(buildReadinessPayload(), null, 2));
}

function printSummary() {
  console.log('\nChild Adapter Reliability Matrix\n');
  console.log('Adapter        Status      Overall     Notes');
  console.log('------------- ------------ ---------- ---------------------------------------------');
  for (const result of RESULTS) {
    const adapter = result.adapter.padEnd(13);
    const status = String(result.status || '').padEnd(12);
    const overall = String(result.overall || '').padEnd(10);
    const notes = short((result.details || []).join(' | '), 90);
    console.log(`${adapter} ${status} ${overall} ${notes}`);
  }

  console.log('\nDetailed checks:\n');
  for (const result of RESULTS) {
    console.log(`- ${result.adapter}: ${result.overall}`);
    if (result.status === 'ok') {
      const checkParts = Object.entries(result.checks)
        .map(([key, value]) => `${key}=${value ? 'yes' : 'no'}`);
      console.log(`  checks: ${checkParts.join(', ')}`);
      if (result.firstOutput) {
        console.log(`  first_output: ${result.firstOutput}`);
      }
      if (result.secondOutput) {
        console.log(`  second_output: ${result.secondOutput}`);
      }
    }
    if (result.details?.length) {
      console.log(`  notes: ${result.details.join(' | ')}`);
    }
  }
}

async function main() {
  console.log('Live child adapter reliability check\n');

  testServer = await startTestServer();
  baseUrl = testServer.baseUrl;
  console.log(`baseUrl: ${baseUrl}\n`);

  try {
    for (const adapterName of ACTIVE_BROKER_ADAPTERS) {
      await recordResult(adapterName, async () => runAdapterCheck(adapterName));
    }
    printSummary();
    maybePrintJsonResults();
    await maybePostReadinessResults();
  } finally {
    await stopTestServer(testServer);
  }

  const hardFailures = RESULTS.filter((result) => result.status === 'failed');
  if (hardFailures.length > 0) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message || String(error));
  if (testServer) {
    await stopTestServer(testServer);
  }
  process.exit(1);
});
