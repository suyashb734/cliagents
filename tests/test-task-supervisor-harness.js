#!/usr/bin/env node

'use strict';

const assert = require('assert');

const {
  parseArgs,
  isAssignmentEligible,
  runOnce,
  main
} = require('../scripts/task-supervisor-harness');

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(data);
    }
  };
}

function createFakeFetch({ taskPayload, assignments, startResponse }) {
  const calls = [];
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url);
    const body = request.body ? JSON.parse(request.body) : null;
    calls.push({
      method: request.method || 'GET',
      path: parsed.pathname,
      search: parsed.search,
      body,
      headers: request.headers || {}
    });

    if (request.method === 'GET' && parsed.pathname === '/orchestration/tasks/task-1') {
      return jsonResponse(200, taskPayload);
    }
    if (request.method === 'GET' && parsed.pathname === '/orchestration/tasks/task-1/assignments') {
      return jsonResponse(200, { task: taskPayload, assignments });
    }
    if (request.method === 'POST' && parsed.pathname.startsWith('/orchestration/tasks/task-1/assignments/')) {
      const assignmentId = decodeURIComponent(parsed.pathname.split('/')[5]);
      return jsonResponse(200, {
        assignment: {
          id: assignmentId,
          terminalId: `term-${assignmentId}`
        },
        route: {
          terminalId: `term-${assignmentId}`
        },
        ...(typeof startResponse === 'function' ? startResponse(assignmentId, body) : startResponse || {})
      });
    }

    return jsonResponse(404, { error: { message: `unexpected route ${request.method} ${parsed.pathname}` } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createTaskPayload(overrides = {}) {
  return {
    task: {
      id: 'task-1',
      title: 'Harness test task',
      rootSessionId: 'root-from-task',
      ...overrides.task
    },
    status: overrides.status || 'running'
  };
}

function captureOutput() {
  const lines = [];
  return {
    lines,
    output(line) {
      lines.push(String(line));
    }
  };
}

async function assertParseDefaults() {
  const parsed = parseArgs(['task-1']);
  assert.strictEqual(parsed.taskId, 'task-1');
  assert.strictEqual(parsed.start, false);
  assert.strictEqual(parsed.once, true);
  assert.strictEqual(parsed.loop, false);
  assert.deepStrictEqual(parsed.allowedStartPolicies, [
    'start-now',
    'start-before-implementation',
    'immediate'
  ]);

  const explicit = parseArgs([
    '--task-id',
    'task-1',
    '--allow-start-policy',
    'after-phase0-contract,manual',
    '--all-policies',
    '--loop',
    '--concurrency=3'
  ]);
  assert.strictEqual(explicit.allowAllPolicies, true);
  assert.deepStrictEqual(explicit.allowedStartPolicies, ['after-phase0-contract', 'manual']);
  assert.strictEqual(explicit.loop, true);
  assert.strictEqual(explicit.once, false);
  assert.strictEqual(explicit.concurrency, 3);

  assert.strictEqual(parseArgs(['--', '--task-id', 'task-1']).taskId, 'task-1');

  console.log('✅ task supervisor parses safe defaults and explicit gates');
}

async function assertEligibilityRules() {
  const assignments = [
    { id: 'a1', status: 'completed' },
    { id: 'a2', status: 'queued', metadata: { dependsOn: ['a1'], startPolicy: 'start-now' } },
    { id: 'a3', status: 'queued', metadata: { dependsOn: ['missing'], startPolicy: 'start-now' } },
    { id: 'a4', status: 'queued', metadata: { manualHold: true } }
  ];
  const options = parseArgs(['task-1']);

  assert.strictEqual(isAssignmentEligible(assignments[1], assignments, options).eligible, true);
  assert.strictEqual(isAssignmentEligible(assignments[2], assignments, options).eligible, false);
  assert.strictEqual(isAssignmentEligible(assignments[2], assignments, options).reason, 'depends:missing');
  assert.strictEqual(isAssignmentEligible(assignments[3], assignments, options).eligible, false);
  assert.strictEqual(isAssignmentEligible(assignments[3], assignments, options).reason, 'manual-hold');

  console.log('✅ task supervisor respects dependency and manual-hold gates');
}

async function assertDryRunDoesNotPostStart() {
  const assignments = [
    { id: 'a1', role: 'review', status: 'queued', metadata: { startPolicy: 'start-before-implementation' } },
    { id: 'a2', role: 'implement', status: 'queued', metadata: { startPolicy: 'after-phase0-contract' } },
    { id: 'a3', role: 'review', status: 'running', terminalId: 'term-running' }
  ];
  const fetchImpl = createFakeFetch({
    taskPayload: createTaskPayload(),
    assignments
  });
  const output = captureOutput();
  const result = await runOnce(parseArgs([
    '--task-id',
    'task-1',
    '--base-url',
    'http://fake.local',
    '--root-session-id',
    'root-1',
    '--concurrency',
    '2'
  ]), { fetchImpl, output: output.output });

  assert.strictEqual(result.dryRun, true);
  assert.deepStrictEqual(result.toStart.map((item) => item.id), ['a1']);
  assert.strictEqual(fetchImpl.calls.filter((call) => call.method === 'POST').length, 0);
  assert(output.lines.some((line) => line.includes('dry-run: would start a1')));

  console.log('✅ task supervisor dry-run reports eligible starts without launching');
}

async function assertStartPostsRootContextAndRespectsConcurrency() {
  const assignments = [
    { id: 'a1', role: 'review', status: 'queued', metadata: { startPolicy: 'start-before-implementation', phase: 0 } },
    { id: 'a2', role: 'review', status: 'queued', metadata: { startPolicy: 'start-before-implementation', phase: 0 } }
  ];
  const fetchImpl = createFakeFetch({
    taskPayload: createTaskPayload({ task: { rootSessionId: null } }),
    assignments
  });
  const output = captureOutput();
  const result = await runOnce(parseArgs([
    '--task-id',
    'task-1',
    '--base-url',
    'http://fake.local',
    '--root-session-id',
    'root-1',
    '--parent-session-id',
    'parent-1',
    '--external-session-ref',
    'supervisor-ref',
    '--origin-client',
    'test-harness',
    '--concurrency',
    '1',
    '--start'
  ]), { fetchImpl, output: output.output });

  const postCalls = fetchImpl.calls.filter((call) => call.method === 'POST');
  assert.strictEqual(postCalls.length, 1);
  assert.strictEqual(postCalls[0].path, '/orchestration/tasks/task-1/assignments/a1/start');
  assert.strictEqual(postCalls[0].body.rootSessionId, 'root-1');
  assert.strictEqual(postCalls[0].body.parentSessionId, 'parent-1');
  assert.strictEqual(postCalls[0].body.externalSessionRef, 'supervisor-ref');
  assert.strictEqual(postCalls[0].body.originClient, 'test-harness');
  assert.strictEqual(postCalls[0].body.sessionMetadata.supervisorAssignmentId, 'a1');
  assert.strictEqual(postCalls[0].body.sessionMetadata.startPolicy, 'start-before-implementation');
  assert.strictEqual(postCalls[0].body.sessionMetadata.phase, '0');
  assert.deepStrictEqual(result.started.map((item) => item.assignmentId), ['a1']);

  console.log('✅ task supervisor starts within concurrency and passes broker root context');
}

async function assertPhaseGate() {
  const assignments = [
    { id: 'a1', role: 'review', status: 'queued', metadata: { startPolicy: 'start-now', phase: 0 } },
    { id: 'a2', role: 'implement', status: 'queued', metadata: { startPolicy: 'start-now', phase: 1 } }
  ];
  const fetchImpl = createFakeFetch({
    taskPayload: createTaskPayload(),
    assignments
  });
  const output = captureOutput();
  const result = await runOnce(parseArgs([
    '--task-id',
    'task-1',
    '--base-url',
    'http://fake.local',
    '--allow-phase',
    '1',
    '--concurrency',
    '5'
  ]), { fetchImpl, output: output.output });

  assert.deepStrictEqual(result.toStart.map((item) => item.id), ['a2']);
  assert(result.skipped.some((item) => item.id === 'a1' && item.reason === 'phase:0'));

  console.log('✅ task supervisor applies phase gates');
}

async function assertStartRequiresRootContext() {
  const assignments = [
    { id: 'a1', role: 'review', status: 'queued', metadata: { startPolicy: 'start-now' } }
  ];
  const fetchImpl = createFakeFetch({
    taskPayload: createTaskPayload({ task: { rootSessionId: null } }),
    assignments
  });
  const output = captureOutput();
  const errorOutput = captureOutput();
  const code = await main([
    '--task-id',
    'task-1',
    '--base-url',
    'http://fake.local',
    '--start'
  ], {
    fetchImpl,
    output: output.output,
    outputError: errorOutput.output
  });

  assert.strictEqual(code, 1);
  assert(errorOutput.lines.some((line) => line.includes('--root-session-id is required')));

  console.log('✅ task supervisor refuses to start without attached root context');
}

async function mainTest() {
  await assertParseDefaults();
  await assertEligibilityRules();
  await assertDryRunDoesNotPostStart();
  await assertStartPostsRootContextAndRespectsConcurrency();
  await assertPhaseGate();
  await assertStartRequiresRootContext();
}

mainTest().catch((error) => {
  console.error('Task supervisor harness tests failed:', error);
  process.exit(1);
});
