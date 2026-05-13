#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startTestServer, stopTestServer } = require('../tests/helpers/server-harness');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts', 'deterministic-smoke');
const BASE_COMMAND = 'npm run smoke:deterministic';
const DETERMINISTIC_SEED = 'smoke-seed-v1';
const BUG_PLACEHOLDER_IDENTIFIER = 'BUG-UNFILED';

function parseArgs(argv) {
  const options = {
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    scenarioIds: null,
    autoFileBugs: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }

    if (token === '--scenario' && argv[index + 1]) {
      options.scenarioIds = String(argv[index + 1]).split(',').map((entry) => entry.trim()).filter(Boolean);
      index += 1;
      continue;
    }

    if (token.startsWith('--scenario=')) {
      options.scenarioIds = token.slice('--scenario='.length).split(',').map((entry) => entry.trim()).filter(Boolean);
      continue;
    }

    if (token === '--artifacts-dir' && argv[index + 1]) {
      options.artifactsDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token.startsWith('--artifacts-dir=')) {
      options.artifactsDir = path.resolve(token.slice('--artifacts-dir='.length));
      continue;
    }

    if (token === '--auto-file-bugs') {
      options.autoFileBugs = true;
      continue;
    }

    if (token === '--no-auto-file-bugs') {
      options.autoFileBugs = false;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printHelp() {
  console.log(`
Deterministic smoke suite for delegated task lifecycle + core route health checks.

Usage:
  ${BASE_COMMAND}
  ${BASE_COMMAND} -- --scenario route-health
  ${BASE_COMMAND} -- --scenario delegate-success,delegate-retry
  ${BASE_COMMAND} -- --artifacts-dir ./artifacts/deterministic-smoke
  ${BASE_COMMAND} -- --no-auto-file-bugs
`.trim());
}

function loadMcpModule(envOverrides = {}) {
  const modulePath = require.resolve('../src/mcp/cliagents-mcp-server');
  delete require.cache[modulePath];

  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const mod = require('../src/mcp/cliagents-mcp-server');

  return {
    mod,
    restore() {
      delete require.cache[modulePath];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

function createMcpContext(baseUrl) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-smoke-mcp-state-'));
  const loaded = loadMcpModule({
    CLIAGENTS_URL: baseUrl,
    CLIAGENTS_MCP_POLL_MS: '10',
    CLIAGENTS_MCP_SYNC_WAIT_MS: '120',
    CLIAGENTS_CLIENT_NAME: 'deterministic-smoke-suite',
    CLIAGENTS_MCP_SESSION_SCOPE: 'session-deterministic-smoke',
    CLIAGENTS_MCP_STATE_DIR: stateDir,
    CLIAGENTS_REQUIRE_ROOT_ATTACH: '',
    CLIAGENTS_ROOT_SESSION_ID: '',
    CLIAGENTS_CLIENT_SESSION_REF: '',
    SESSION_GRAPH_WRITES_ENABLED: '1'
  });

  return {
    ...loaded,
    stateDir,
    cleanup() {
      loaded.restore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

async function startFakeOrchestrationServer() {
  const state = {
    routeQueue: [],
    scenariosByTerminal: {},
    statusPolls: new Map(),
    routeBodies: [],
    lastRouteBody: null,
    lastTerminalInput: null
  };

  const server = http.createServer(async (req, res) => {
    const writeJson = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    const readBody = async () => {
      let data = '';
      for await (const chunk of req) {
        data += chunk;
      }
      return data ? JSON.parse(data) : {};
    };

    if (req.method === 'POST' && req.url === '/orchestration/route') {
      const body = await readBody();
      state.lastRouteBody = body;
      state.routeBodies.push(body);

      const routeScenario = state.routeQueue.shift();
      if (!routeScenario) {
        return writeJson(500, { error: { code: 'missing_route_scenario', message: 'No queued fake route scenario' } });
      }

      if (routeScenario.routeStatus && routeScenario.routeStatus !== 200) {
        return writeJson(routeScenario.routeStatus, routeScenario.routeError || { error: { code: 'route_error', message: 'synthetic route failure' } });
      }

      const routeResponse = routeScenario.routeResponse;
      if (!routeResponse || !routeResponse.terminalId) {
        return writeJson(500, { error: { code: 'invalid_route_response', message: 'routeResponse.terminalId is required' } });
      }

      state.scenariosByTerminal[routeResponse.terminalId] = routeScenario;
      return writeJson(200, routeResponse);
    }

    const outputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/output$/);
    if (req.method === 'GET' && outputMatch) {
      const terminalId = outputMatch[1];
      const scenario = state.scenariosByTerminal[terminalId];
      if (!scenario) {
        return writeJson(404, { error: { code: 'terminal_not_found', message: 'Unknown terminal' } });
      }
      return writeJson(200, { output: scenario.output || '' });
    }

    const inputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/input$/);
    if (req.method === 'POST' && inputMatch) {
      const body = await readBody();
      state.lastTerminalInput = {
        terminalId: inputMatch[1],
        body
      };
      return writeJson(200, { terminalId: inputMatch[1], status: 'processing', accepted: true });
    }

    const statusMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) {
      const terminalId = statusMatch[1];
      const scenario = state.scenariosByTerminal[terminalId];
      if (!scenario) {
        return writeJson(404, { error: { code: 'terminal_not_found', message: 'Unknown terminal' } });
      }

      const statuses = Array.isArray(scenario.statuses) && scenario.statuses.length > 0
        ? scenario.statuses
        : ['processing'];
      const currentPollCount = state.statusPolls.get(terminalId) || 0;
      state.statusPolls.set(terminalId, currentPollCount + 1);
      const status = statuses[Math.min(currentPollCount, statuses.length - 1)];

      if (status === 404) {
        return writeJson(404, { error: { code: 'terminal_not_found', message: 'Synthetic missing terminal' } });
      }

      return writeJson(200, {
        terminalId,
        status,
        adapter: scenario.routeResponse.adapter,
        agentProfile: scenario.routeResponse.profile
      });
    }

    return writeJson(404, { error: { code: 'unhandled_route', message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    queueRouteScenario(scenario) {
      state.routeQueue.push(scenario);
    },
    resetRouteCapture() {
      state.routeBodies = [];
      state.lastRouteBody = null;
    },
    clearTerminalState() {
      state.scenariosByTerminal = {};
      state.statusPolls = new Map();
      state.lastTerminalInput = null;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function extractToolText(result) {
  return String(result?.content?.[0]?.text || '');
}

async function runRouteHealthScenario() {
  const testServer = await startTestServer();
  try {
    const routes = [
      '/health',
      '/orchestration/roles',
      '/orchestration/adapters'
    ];
    const checks = [];

    for (const route of routes) {
      const response = await fetch(`${testServer.baseUrl}${route}`, {
        method: 'GET',
        signal: AbortSignal.timeout(30000)
      });
      const raw = await response.text();
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {}

      assert.strictEqual(response.status, 200, `${route} expected 200, got ${response.status}`);

      if (route === '/health') {
        assert.strictEqual(data.status, 'ok', '/health should report status=ok');
      }
      if (route === '/orchestration/roles') {
        assert(data && typeof data.roles === 'object', '/orchestration/roles should include roles object');
      }
      if (route === '/orchestration/adapters') {
        assert(data && typeof data.adapters === 'object', '/orchestration/adapters should include adapters object');
      }

      checks.push({
        route,
        status: response.status
      });
    }

    return {
      checks
    };
  } finally {
    await stopTestServer(testServer);
  }
}

async function runDelegateSuccessScenario(context) {
  context.fakeServer.clearTerminalState();
  context.fakeServer.queueRouteScenario({
    routeResponse: {
      terminalId: 'term-success',
      adapter: 'codex-cli',
      taskType: 'review',
      profile: 'review_codex-cli'
    },
    statuses: ['processing', 'completed'],
    output: 'Deterministic success output\n__CLIAGENTS_RUN_EXIT__smoke_success__0\n'
  });

  const delegated = await context.mcp.mod.handleDelegateTask({
    role: 'review',
    adapter: 'codex-cli',
    message: 'Smoke success path',
    wait: true,
    timeout: 'simple'
  });
  const delegatedText = extractToolText(delegated);
  assert(delegatedText.includes('**Status:** completed'), 'Expected delegated success output to be completed');

  const statusResult = await context.mcp.mod.handleCheckTaskStatus({ terminalId: 'term-success' });
  const statusText = extractToolText(statusResult);
  assert(statusText.includes('Task Status: COMPLETED'), 'Expected check_task_status to report COMPLETED');

  return {
    terminalId: 'term-success',
    summary: delegatedText.split('\n').slice(0, 5).join('\n')
  };
}

async function runDelegateFailureScenario(context) {
  context.fakeServer.clearTerminalState();
  context.fakeServer.queueRouteScenario({
    routeResponse: {
      terminalId: 'term-failure',
      adapter: 'codex-cli',
      taskType: 'implement',
      profile: 'implement_codex-cli'
    },
    statuses: ['processing', 'error'],
    output: 'Deterministic failure output\n__CLIAGENTS_RUN_EXIT__smoke_failure__1\n'
  });

  const delegated = await context.mcp.mod.handleDelegateTask({
    role: 'implement',
    adapter: 'codex-cli',
    message: 'Smoke failure path',
    wait: true,
    timeout: 'simple'
  });
  const delegatedText = extractToolText(delegated);
  assert(delegatedText.includes('Task Failed'), 'Expected delegated failure output to include Task Failed');

  const statusResult = await context.mcp.mod.handleCheckTaskStatus({ terminalId: 'term-failure' });
  const statusText = extractToolText(statusResult);
  assert(statusText.includes('Task Status: FAILED'), 'Expected check_task_status to report FAILED');

  return {
    terminalId: 'term-failure',
    summary: delegatedText.split('\n').slice(0, 5).join('\n')
  };
}

async function runDelegateTimeoutScenario(context) {
  context.fakeServer.clearTerminalState();
  context.fakeServer.queueRouteScenario({
    routeResponse: {
      terminalId: 'term-timeout',
      adapter: 'qwen-cli',
      taskType: 'research',
      profile: 'research_qwen-cli'
    },
    statuses: new Array(120).fill('processing'),
    output: ''
  });

  const delegated = await context.mcp.mod.handleDelegateTask({
    role: 'research',
    adapter: 'qwen-cli',
    message: 'Smoke timeout path',
    wait: true,
    timeout: 'complex'
  });
  const delegatedText = extractToolText(delegated);
  assert(delegatedText.includes('Still Running'), 'Expected timeout scenario to report Still Running');
  assert(delegatedText.includes('term-timeout'), 'Expected timeout scenario to keep terminal id in response');

  return {
    terminalId: 'term-timeout',
    summary: delegatedText.split('\n').slice(0, 5).join('\n')
  };
}

async function runDelegateRetryScenario(context) {
  context.fakeServer.clearTerminalState();

  context.fakeServer.queueRouteScenario({
    routeStatus: 500,
    routeError: {
      error: {
        code: 'route_error',
        message: 'Synthetic first-attempt failure for retry scenario'
      }
    }
  });

  let firstFailure = null;
  try {
    await context.mcp.mod.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      message: 'Smoke retry first attempt',
      wait: false
    });
  } catch (error) {
    firstFailure = String(error?.message || error);
  }

  assert(firstFailure && firstFailure.includes('Routing failed'), 'Expected retry scenario first attempt to fail routing');

  context.fakeServer.queueRouteScenario({
    routeResponse: {
      terminalId: 'term-retry',
      adapter: 'codex-cli',
      taskType: 'review',
      profile: 'review_codex-cli'
    },
    statuses: ['processing', 'completed'],
    output: 'Deterministic retry recovered\n__CLIAGENTS_RUN_EXIT__smoke_retry__0\n'
  });

  const delegated = await context.mcp.mod.handleDelegateTask({
    role: 'review',
    adapter: 'codex-cli',
    message: 'Smoke retry second attempt',
    wait: true,
    timeout: 'simple'
  });
  const delegatedText = extractToolText(delegated);
  assert(delegatedText.includes('**Status:** completed'), 'Expected retry scenario second attempt to complete');

  return {
    terminalId: 'term-retry',
    attempts: 2,
    firstAttemptError: firstFailure
  };
}

async function runMissingRootReplyScenario(context) {
  context.fakeServer.clearTerminalState();
  const marker = 'KD86_MISSING_ROOT_REPLY_MARKER';
  let caught = null;

  try {
    await context.mcp.mod.handleReplyToTerminal({
      terminalId: 'term-missing-root-reply',
      message: marker
    });
  } catch (error) {
    caught = error;
  }

  assert(caught, 'Expected rootless reply_to_terminal to fail closed');
  const errorMessage = String(caught?.message || caught);
  assert(errorMessage.includes('terminal_input_forbidden'), `Expected terminal_input_forbidden, got: ${errorMessage}`);
  assert.strictEqual(context.fakeServer.state.lastTerminalInput, null, 'Rootless reply marker must not reach terminal input route');

  return {
    marker,
    delivered: false,
    error: errorMessage
  };
}

function getIssueIdentifierFromWakePayload() {
  const payloadRaw = process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if (!payloadRaw) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadRaw);
    const identifier = payload?.issue?.identifier;
    return typeof identifier === 'string' && identifier.trim() ? identifier.trim() : null;
  } catch {
    return null;
  }
}

function deriveCompanyPrefix() {
  const wakeIdentifier = getIssueIdentifierFromWakePayload();
  if (wakeIdentifier && wakeIdentifier.includes('-')) {
    return wakeIdentifier.split('-')[0];
  }
  return null;
}

function safeIdentifierSuffix(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function getDefaultAutoFileBugs() {
  if (process.env.DETERMINISTIC_SMOKE_AUTO_FILE_BUGS === '1') {
    return true;
  }
  if (process.env.DETERMINISTIC_SMOKE_AUTO_FILE_BUGS === '0') {
    return false;
  }
  return Boolean(
    process.env.PAPERCLIP_API_URL
      && process.env.PAPERCLIP_API_KEY
      && process.env.PAPERCLIP_COMPANY_ID
      && process.env.PAPERCLIP_TASK_ID
  );
}

async function maybeFileBugIssue(scenarioResult, suiteMetadata) {
  if (scenarioResult.status !== 'failed') {
    return null;
  }

  const autoFileBugs = suiteMetadata.autoFileBugs;
  const companyPrefix = suiteMetadata.companyPrefix;
  const fallbackIdentifier = `${BUG_PLACEHOLDER_IDENTIFIER}-${safeIdentifierSuffix(scenarioResult.id)}`.toUpperCase();

  if (!autoFileBugs) {
    return {
      identifier: fallbackIdentifier,
      link: null,
      autoFiled: false,
      note: 'Auto-filing disabled'
    };
  }

  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  if (!apiUrl || !apiKey || !companyId) {
    return {
      identifier: fallbackIdentifier,
      link: null,
      autoFiled: false,
      note: 'Paperclip credentials unavailable'
    };
  }

  const body = {
    title: `[Smoke Failure] ${scenarioResult.id} failed`,
    description: [
      'Automated deterministic smoke suite failure.',
      '',
      `Scenario: \`${scenarioResult.id}\``,
      `Runtime: ${scenarioResult.runtimeMs}ms`,
      `Repro command: \`${scenarioResult.reproCommand}\``,
      '',
      'Failure details:',
      '```',
      String(scenarioResult.error || 'No error details captured'),
      '```'
    ].join('\n'),
    priority: 'high',
    status: 'todo',
    parentId: process.env.PAPERCLIP_TASK_ID || undefined
  };

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (process.env.PAPERCLIP_RUN_ID) {
    headers['X-Paperclip-Run-Id'] = process.env.PAPERCLIP_RUN_ID;
  }

  try {
    const response = await fetch(`${apiUrl}/api/companies/${companyId}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const raw = await response.text();
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {}

    if (!response.ok || !data || !data.identifier) {
      return {
        identifier: fallbackIdentifier,
        link: null,
        autoFiled: false,
        note: `Auto-file request failed (${response.status})`
      };
    }

    return {
      identifier: data.identifier,
      link: companyPrefix ? `/${companyPrefix}/issues/${data.identifier}` : null,
      autoFiled: true
    };
  } catch (error) {
    return {
      identifier: fallbackIdentifier,
      link: null,
      autoFiled: false,
      note: `Auto-file error: ${String(error?.message || error)}`
    };
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatHistoryStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function relativeToRepo(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath) || '.';
}

function renderBugCell(bugIssue) {
  if (!bugIssue) {
    return '-';
  }
  if (bugIssue.link) {
    return `[${bugIssue.identifier}](${bugIssue.link})`;
  }
  return `\`${bugIssue.identifier}\``;
}

function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Deterministic Smoke Suite Report');
  lines.push('');
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Seed: \`${report.seed}\``);
  lines.push(`- Command: \`${report.command}\``);
  lines.push(`- Overall status: **${report.overallStatus.toUpperCase()}**`);
  lines.push(`- Runtime: ${report.runtimeMs}ms`);
  lines.push('');
  lines.push('## Scenario Results');
  lines.push('');
  lines.push('| Scenario | Status | Runtime (ms) | Repro Command | Bug Issue |');
  lines.push('|---|---|---:|---|---|');
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.id} | ${scenario.status.toUpperCase()} | ${scenario.runtimeMs} | \`${scenario.reproCommand}\` | ${renderBugCell(scenario.bugIssue)} |`
    );
  }
  lines.push('');
  lines.push('## Scenario Details');
  lines.push('');
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id}`);
    lines.push(`- Status: ${scenario.status.toUpperCase()}`);
    lines.push(`- Started: ${scenario.startedAt}`);
    lines.push(`- Ended: ${scenario.endedAt}`);
    lines.push(`- Runtime: ${scenario.runtimeMs}ms`);
    lines.push(`- Repro command: \`${scenario.reproCommand}\``);
    if (scenario.bugIssue) {
      lines.push(`- Bug issue: ${renderBugCell(scenario.bugIssue)}`);
      if (scenario.bugIssue.note) {
        lines.push(`- Bug note: ${scenario.bugIssue.note}`);
      }
    }
    if (scenario.error) {
      lines.push('- Error:');
      lines.push('```');
      lines.push(String(scenario.error));
      lines.push('```');
    }
    if (scenario.details) {
      lines.push('- Details:');
      lines.push('```json');
      lines.push(JSON.stringify(scenario.details, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function runScenario(definition, context) {
  const startedAt = new Date();
  const startedMs = Date.now();

  try {
    const details = await definition.runner(context);
    return {
      id: definition.id,
      title: definition.title,
      status: 'passed',
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      runtimeMs: Date.now() - startedMs,
      reproCommand: `${BASE_COMMAND} -- --scenario ${definition.id}`,
      details
    };
  } catch (error) {
    return {
      id: definition.id,
      title: definition.title,
      status: 'failed',
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      runtimeMs: Date.now() - startedMs,
      reproCommand: `${BASE_COMMAND} -- --scenario ${definition.id}`,
      error: String(error?.stack || error?.message || error)
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarioDefinitions = [
    {
      id: 'route-health',
      title: 'Core route health checks',
      runner: runRouteHealthScenario
    },
    {
      id: 'delegate-success',
      title: 'Delegated lifecycle success path',
      runner: runDelegateSuccessScenario
    },
    {
      id: 'delegate-failure',
      title: 'Delegated lifecycle failure path',
      runner: runDelegateFailureScenario
    },
    {
      id: 'delegate-timeout',
      title: 'Delegated lifecycle timeout path',
      runner: runDelegateTimeoutScenario
    },
    {
      id: 'delegate-retry',
      title: 'Delegated lifecycle retry path',
      runner: runDelegateRetryScenario
    },
    {
      id: 'missing-root-reply',
      title: 'Rootless reply_to_terminal fails closed',
      runner: runMissingRootReplyScenario
    }
  ];

  const selectedScenarioIds = options.scenarioIds || scenarioDefinitions.map((scenario) => scenario.id);
  const selectedSet = new Set(selectedScenarioIds);
  const unknownScenarios = selectedScenarioIds.filter((scenarioId) => !scenarioDefinitions.some((entry) => entry.id === scenarioId));
  if (unknownScenarios.length > 0) {
    throw new Error(`Unknown scenario(s): ${unknownScenarios.join(', ')}`);
  }

  const activeDefinitions = scenarioDefinitions.filter((scenario) => selectedSet.has(scenario.id));
  const suiteStartedAt = new Date();
  const suiteStartMs = Date.now();

  const fakeServer = await startFakeOrchestrationServer();
  const mcp = createMcpContext(fakeServer.baseUrl);
  const context = { fakeServer, mcp };

  const suiteMetadata = {
    autoFileBugs: options.autoFileBugs == null ? getDefaultAutoFileBugs() : options.autoFileBugs,
    companyPrefix: deriveCompanyPrefix()
  };

  const scenarioResults = [];
  try {
    for (const definition of activeDefinitions) {
      process.stdout.write(`\n[smoke] Running scenario: ${definition.id}\n`);
      const result = await runScenario(definition, context);
      result.bugIssue = await maybeFileBugIssue(result, suiteMetadata);
      scenarioResults.push(result);
      process.stdout.write(`[smoke] ${definition.id}: ${result.status.toUpperCase()} (${result.runtimeMs}ms)\n`);
    }
  } finally {
    mcp.cleanup();
    await fakeServer.close();
  }

  const failedCount = scenarioResults.filter((entry) => entry.status === 'failed').length;
  const passedCount = scenarioResults.filter((entry) => entry.status === 'passed').length;

  const report = {
    suite: 'deterministic-smoke-suite',
    generatedAt: new Date().toISOString(),
    seed: DETERMINISTIC_SEED,
    command: BASE_COMMAND,
    scenarioOrder: activeDefinitions.map((scenario) => scenario.id),
    overallStatus: failedCount === 0 ? 'passed' : 'failed',
    startedAt: suiteStartedAt.toISOString(),
    endedAt: new Date().toISOString(),
    runtimeMs: Date.now() - suiteStartMs,
    totals: {
      scenarios: scenarioResults.length,
      passed: passedCount,
      failed: failedCount
    },
    scenarios: scenarioResults
  };

  ensureDirectory(options.artifactsDir);
  ensureDirectory(path.join(options.artifactsDir, 'history'));
  const historyStamp = formatHistoryStamp(new Date(report.generatedAt));

  const latestJsonPath = path.join(options.artifactsDir, 'latest.json');
  const latestMarkdownPath = path.join(options.artifactsDir, 'latest.md');
  const historyJsonPath = path.join(options.artifactsDir, 'history', `${historyStamp}.json`);
  const historyMarkdownPath = path.join(options.artifactsDir, 'history', `${historyStamp}.md`);

  const reportJson = JSON.stringify(report, null, 2);
  const reportMarkdown = renderMarkdownReport(report);

  fs.writeFileSync(latestJsonPath, reportJson, 'utf8');
  fs.writeFileSync(latestMarkdownPath, reportMarkdown, 'utf8');
  fs.writeFileSync(historyJsonPath, reportJson, 'utf8');
  fs.writeFileSync(historyMarkdownPath, reportMarkdown, 'utf8');

  process.stdout.write('\n[smoke] Deterministic smoke suite complete\n');
  process.stdout.write(`[smoke] Overall status: ${report.overallStatus.toUpperCase()}\n`);
  process.stdout.write(`[smoke] Passed: ${passedCount}, Failed: ${failedCount}\n`);
  process.stdout.write(`[smoke] JSON report: ${relativeToRepo(latestJsonPath)}\n`);
  process.stdout.write(`[smoke] Markdown report: ${relativeToRepo(latestMarkdownPath)}\n`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[smoke] Fatal error');
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
