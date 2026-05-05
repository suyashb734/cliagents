#!/usr/bin/env node

'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4001';
const DEFAULT_ALLOWED_START_POLICIES = [
  'start-now',
  'start-before-implementation',
  'immediate'
];
const DEFAULT_POLICY_SEQUENCE = [
  'start-before-implementation',
  'after-phase0-contract',
  'after-phase1-contract-or-integration',
  'after-phase0-contract-and-db-helpers',
  'after-phase3-api',
  'after-integration'
];
const STALLED_EXIT_CODE = 4;

function printUsage(output = console.log) {
  output(`Usage:
  node scripts/task-supervisor-harness.js --task-id <task-id> [options]

Options:
  --task-id <id>                 Task to supervise. Positional task id is also accepted.
  --base-url <url>               cliagents HTTP base URL. Defaults to CLIAGENTS_BASE_URL or ${DEFAULT_BASE_URL}.
  --api-key <key>                Optional API key for x-api-key and bearer auth.
  --root-session-id <id>         Root session used when starting assignments.
  --parent-session-id <id>       Parent session id. Defaults to root session id.
  --external-session-ref <ref>   External session ref for launched children.
  --origin-client <name>         Origin client metadata. Defaults to task-supervisor-harness.
  --concurrency <n>              Maximum running assignments. Defaults to 2.
  --max-starts <n>               Maximum assignments to start per pass.
  --poll-ms <n>                  Loop polling interval. Defaults to 30000.
  --max-iterations <n>           Stop after this many loop iterations.
  --allow-start-policy <policy>  Start only matching metadata.startPolicy values. Repeatable or comma-separated.
  --auto                         Select the next unfinished policy stage automatically and keep looping.
  --policy-sequence <policies>   Ordered policy gates for --auto. Repeatable or comma-separated.
  --all-policies                 Disable startPolicy gating.
  --allow-phase <phase>          Start only matching metadata.phase values. Repeatable or comma-separated.
  --adapter <adapter>            Start only queued assignments for this adapter.
  --role <role>                  Start only queued assignments for this role.
  --start                        Actually launch eligible assignments. Without this, dry-run only.
  --loop                         Keep polling until all assignments settle or a failure stops the loop.
  --once                         Run one pass. This is the default.
  --continue-on-failure          Keep looping even when assignments have failed.
  --continue-on-stalled          Keep looping when queued work cannot be safely started.
  --stop-on-blocked              Return non-zero when any assignment is blocked.
  --ignore-manual-hold           Allow assignments with metadata.manualHold or hold/manual policies.
  --prefer-reuse                 Ask the broker to prefer reusable child sessions.
  --force-fresh-session          Ask the broker to force a fresh child session.
  --json                         Emit one JSON summary per pass.
  --help                         Show this help.

Safe default:
  The harness is dry-run and one-pass unless --start and --loop are provided.`);
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitList(item));
  }
  return normalizeText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptionValue(args, index, flag) {
  const current = args[index];
  const equalsIndex = current.indexOf('=');
  if (equalsIndex !== -1) {
    return { value: current.slice(equalsIndex + 1), nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(rawArgs = []) {
  const options = {
    taskId: null,
    baseUrl: normalizeText(process.env.CLIAGENTS_BASE_URL || process.env.CLI_AGENTS_BASE_URL || DEFAULT_BASE_URL),
    apiKey: normalizeText(process.env.CLIAGENTS_API_KEY || process.env.CLI_AGENTS_API_KEY || ''),
    rootSessionId: null,
    parentSessionId: null,
    externalSessionRef: null,
    originClient: 'task-supervisor-harness',
    sessionLabel: null,
    systemPrompt: null,
    concurrency: 2,
    maxStarts: null,
    pollMs: 30_000,
    maxIterations: null,
    allowedStartPolicies: null,
    auto: false,
    policySequence: [],
    allowAllPolicies: false,
    allowedPhases: [],
    adapter: null,
    role: null,
    start: false,
    loop: false,
    once: true,
    continueOnFailure: false,
    continueOnStalled: false,
    stopOnBlocked: false,
    ignoreManualHold: false,
    preferReuse: undefined,
    forceFreshSession: undefined,
    json: false,
    help: false
  };
  const explicitPolicies = [];
  const positional = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--') {
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (flag) {
      case '--help':
      case '--h':
        options.help = true;
        break;
      case '--task-id': {
        const read = readOptionValue(rawArgs, index, flag);
        options.taskId = read.value;
        index = read.nextIndex;
        break;
      }
      case '--base-url': {
        const read = readOptionValue(rawArgs, index, flag);
        options.baseUrl = read.value;
        index = read.nextIndex;
        break;
      }
      case '--api-key': {
        const read = readOptionValue(rawArgs, index, flag);
        options.apiKey = read.value;
        index = read.nextIndex;
        break;
      }
      case '--root-session-id': {
        const read = readOptionValue(rawArgs, index, flag);
        options.rootSessionId = read.value;
        index = read.nextIndex;
        break;
      }
      case '--parent-session-id': {
        const read = readOptionValue(rawArgs, index, flag);
        options.parentSessionId = read.value;
        index = read.nextIndex;
        break;
      }
      case '--external-session-ref': {
        const read = readOptionValue(rawArgs, index, flag);
        options.externalSessionRef = read.value;
        index = read.nextIndex;
        break;
      }
      case '--origin-client': {
        const read = readOptionValue(rawArgs, index, flag);
        options.originClient = read.value;
        index = read.nextIndex;
        break;
      }
      case '--session-label': {
        const read = readOptionValue(rawArgs, index, flag);
        options.sessionLabel = read.value;
        index = read.nextIndex;
        break;
      }
      case '--system-prompt': {
        const read = readOptionValue(rawArgs, index, flag);
        options.systemPrompt = read.value;
        index = read.nextIndex;
        break;
      }
      case '--concurrency': {
        const read = readOptionValue(rawArgs, index, flag);
        options.concurrency = parsePositiveInteger(read.value, flag);
        index = read.nextIndex;
        break;
      }
      case '--max-starts': {
        const read = readOptionValue(rawArgs, index, flag);
        options.maxStarts = parsePositiveInteger(read.value, flag);
        index = read.nextIndex;
        break;
      }
      case '--poll-ms': {
        const read = readOptionValue(rawArgs, index, flag);
        options.pollMs = parsePositiveInteger(read.value, flag);
        index = read.nextIndex;
        break;
      }
      case '--max-iterations': {
        const read = readOptionValue(rawArgs, index, flag);
        options.maxIterations = parsePositiveInteger(read.value, flag);
        index = read.nextIndex;
        break;
      }
      case '--allow-start-policy': {
        const read = readOptionValue(rawArgs, index, flag);
        explicitPolicies.push(...splitList(read.value));
        index = read.nextIndex;
        break;
      }
      case '--auto':
        options.auto = true;
        options.loop = true;
        options.once = false;
        break;
      case '--policy-sequence': {
        const read = readOptionValue(rawArgs, index, flag);
        options.policySequence.push(...splitList(read.value));
        index = read.nextIndex;
        break;
      }
      case '--all-policies':
        options.allowAllPolicies = true;
        break;
      case '--allow-phase': {
        const read = readOptionValue(rawArgs, index, flag);
        options.allowedPhases.push(...splitList(read.value));
        index = read.nextIndex;
        break;
      }
      case '--adapter': {
        const read = readOptionValue(rawArgs, index, flag);
        options.adapter = read.value;
        index = read.nextIndex;
        break;
      }
      case '--role': {
        const read = readOptionValue(rawArgs, index, flag);
        options.role = read.value;
        index = read.nextIndex;
        break;
      }
      case '--start':
        options.start = true;
        break;
      case '--dry-run':
        options.start = false;
        break;
      case '--loop':
        options.loop = true;
        options.once = false;
        break;
      case '--once':
        options.once = true;
        options.loop = false;
        break;
      case '--continue-on-failure':
        options.continueOnFailure = true;
        break;
      case '--continue-on-stalled':
        options.continueOnStalled = true;
        break;
      case '--stop-on-blocked':
        options.stopOnBlocked = true;
        break;
      case '--ignore-manual-hold':
        options.ignoreManualHold = true;
        break;
      case '--prefer-reuse':
        options.preferReuse = true;
        break;
      case '--no-prefer-reuse':
        options.preferReuse = false;
        break;
      case '--force-fresh-session':
        options.forceFreshSession = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.taskId && positional.length > 0) {
    options.taskId = positional.shift();
  }
  if (positional.length > 0) {
    throw new Error(`Unexpected positional arguments: ${positional.join(', ')}`);
  }

  options.taskId = normalizeText(options.taskId);
  options.baseUrl = normalizeText(options.baseUrl).replace(/\/+$/, '') || DEFAULT_BASE_URL;
  options.apiKey = normalizeText(options.apiKey) || null;
  options.rootSessionId = normalizeText(options.rootSessionId) || null;
  options.parentSessionId = normalizeText(options.parentSessionId) || null;
  options.externalSessionRef = normalizeText(options.externalSessionRef) || null;
  options.originClient = normalizeText(options.originClient) || 'task-supervisor-harness';
  options.sessionLabel = normalizeText(options.sessionLabel) || null;
  options.systemPrompt = normalizeText(options.systemPrompt) || null;
  options.allowedStartPolicies = explicitPolicies.length > 0
    ? explicitPolicies.map(normalizeKey)
    : [...DEFAULT_ALLOWED_START_POLICIES];
  options.policySequence = options.policySequence.map(normalizeKey);
  options.allowedPhases = options.allowedPhases.map(normalizeKey);
  options.adapter = normalizeKey(options.adapter) || null;
  options.role = normalizeKey(options.role) || null;

  if (!options.help && !options.taskId) {
    throw new Error('task id is required');
  }

  return options;
}

function getAssignmentMetadata(assignment = {}) {
  if (assignment.metadata && typeof assignment.metadata === 'object' && !Array.isArray(assignment.metadata)) {
    return assignment.metadata;
  }
  if (typeof assignment.metadata === 'string') {
    try {
      const parsed = JSON.parse(assignment.metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function getNestedMetadataValue(metadata, key) {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  if (metadata[key] !== undefined) {
    return metadata[key];
  }
  if (metadata.supervisor && typeof metadata.supervisor === 'object') {
    return metadata.supervisor[key];
  }
  return undefined;
}

function getStartPolicy(metadata) {
  return normalizeKey(
    getNestedMetadataValue(metadata, 'startPolicy')
    || getNestedMetadataValue(metadata, 'start_policy')
    || 'start-now'
  );
}

function getAssignmentPhase(metadata) {
  const phase = getNestedMetadataValue(metadata, 'phase')
    ?? getNestedMetadataValue(metadata, 'startPhase')
    ?? getNestedMetadataValue(metadata, 'start_phase');
  return phase == null ? null : normalizeKey(phase);
}

function getDependencyIds(metadata) {
  const raw = getNestedMetadataValue(metadata, 'dependsOn')
    ?? getNestedMetadataValue(metadata, 'depends_on')
    ?? getNestedMetadataValue(metadata, 'afterAssignments')
    ?? [];
  return splitList(raw);
}

function normalizeAssignmentStatus(status) {
  const normalized = normalizeKey(status);
  if (!normalized) {
    return 'queued';
  }
  if (normalized === 'processing') {
    return 'running';
  }
  if (normalized === 'waiting_permission' || normalized === 'waiting_user_answer' || normalized === 'blocked') {
    return 'blocked';
  }
  if (normalized === 'idle' || normalized === 'completed') {
    return 'completed';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'failed';
  }
  if (normalized === 'superseded' || normalized === 'cancelled' || normalized === 'canceled') {
    return normalized === 'canceled' ? 'cancelled' : normalized;
  }
  return normalized;
}

function getAssignmentStatus(assignment = {}) {
  return normalizeAssignmentStatus(assignment.status || assignment.effectiveStatus || assignment.storedStatus || 'queued');
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'superseded' || status === 'abandoned';
}

function isPolicySatisfiedStatus(status) {
  return status === 'completed' || status === 'cancelled' || status === 'superseded';
}

function getPolicySequence(options = {}) {
  if (options.policySequence?.length > 0) {
    return options.policySequence;
  }
  if (options.auto) {
    return [...DEFAULT_POLICY_SEQUENCE];
  }
  return options.allowedStartPolicies || [];
}

function resolveActivePolicy(options, assignments = []) {
  if (!options.auto) {
    return {
      activePolicy: null,
      allowedStartPolicies: options.allowedStartPolicies,
      autoDone: false,
      stalledReason: null,
      policySequence: options.allowedStartPolicies || []
    };
  }

  const policySequence = getPolicySequence(options);
  const knownPolicies = new Set(policySequence);
  for (const policy of policySequence) {
    const matching = assignments.filter((assignment) => getStartPolicy(getAssignmentMetadata(assignment)) === policy);
    if (matching.length === 0) {
      continue;
    }
    if (matching.every((assignment) => isPolicySatisfiedStatus(getAssignmentStatus(assignment)))) {
      continue;
    }
    return {
      activePolicy: policy,
      allowedStartPolicies: [policy],
      autoDone: false,
      stalledReason: null,
      policySequence
    };
  }

  const unfinished = assignments.filter((assignment) => !isTerminalStatus(getAssignmentStatus(assignment)));
  const unknownUnfinishedPolicies = [...new Set(
    unfinished
      .map((assignment) => getStartPolicy(getAssignmentMetadata(assignment)))
      .filter((policy) => !knownPolicies.has(policy))
  )];

  return {
    activePolicy: null,
    allowedStartPolicies: [],
    autoDone: unfinished.length === 0,
    stalledReason: unknownUnfinishedPolicies.length > 0
      ? `unfinished-policy:${unknownUnfinishedPolicies.join(',')}`
      : null,
    policySequence
  };
}

function summarizeAssignments(assignments = []) {
  const counts = {
    queued: 0,
    running: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    other: 0
  };

  for (const assignment of assignments) {
    const status = getAssignmentStatus(assignment);
    if (counts[status] === undefined) {
      counts.other += 1;
    } else {
      counts[status] += 1;
    }
  }

  return counts;
}

function isAssignmentEligible(assignment, assignments, options) {
  const status = getAssignmentStatus(assignment);
  const metadata = getAssignmentMetadata(assignment);
  const startPolicy = getStartPolicy(metadata);
  const phase = getAssignmentPhase(metadata);
  const assignmentAdapter = normalizeKey(assignment.adapter);
  const assignmentRole = normalizeKey(assignment.role);

  if (status !== 'queued' || assignment.terminalId) {
    return { eligible: false, reason: `status:${status}`, startPolicy, phase };
  }
  if (!options.ignoreManualHold) {
    const manualHold = Boolean(
      getNestedMetadataValue(metadata, 'manualHold')
      || getNestedMetadataValue(metadata, 'manual_hold')
      || getNestedMetadataValue(metadata, 'hold')
    );
    if (manualHold || startPolicy === 'manual' || startPolicy === 'hold') {
      return { eligible: false, reason: 'manual-hold', startPolicy, phase };
    }
  }
  if (!options.allowAllPolicies && !options.allowedStartPolicies.includes(startPolicy)) {
    return { eligible: false, reason: `policy:${startPolicy}`, startPolicy, phase };
  }
  if (options.allowedPhases.length > 0 && (!phase || !options.allowedPhases.includes(phase))) {
    return { eligible: false, reason: `phase:${phase || 'none'}`, startPolicy, phase };
  }
  if (options.adapter && assignmentAdapter !== options.adapter) {
    return { eligible: false, reason: `adapter:${assignment.adapter || 'none'}`, startPolicy, phase };
  }
  if (options.role && assignmentRole !== options.role) {
    return { eligible: false, reason: `role:${assignment.role || 'none'}`, startPolicy, phase };
  }

  const dependencies = getDependencyIds(metadata);
  if (dependencies.length > 0) {
    const byId = new Map(assignments.map((candidate) => [candidate.id, candidate]));
    const unsatisfied = dependencies.filter((dependencyId) => getAssignmentStatus(byId.get(dependencyId)) !== 'completed');
    if (unsatisfied.length > 0) {
      return { eligible: false, reason: `depends:${unsatisfied.join(',')}`, startPolicy, phase };
    }
  }

  return { eligible: true, reason: 'eligible', startPolicy, phase };
}

async function callJson(options, method, route, body, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is not available; use Node 20+');
  }
  const headers = {
    accept: 'application/json'
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.apiKey) {
    headers.authorization = `Bearer ${options.apiKey}`;
    headers['x-api-key'] = options.apiKey;
  }

  const response = await fetchImpl(`${options.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    throw new Error(`${method} ${route} failed: ${message}`);
  }
  return data;
}

function writeHumanSummary(output, result, options) {
  if (options.json) {
    output(JSON.stringify(result));
    return;
  }

  const counts = result.counts;
  output(
    `[supervisor] task=${result.taskId} status=${result.taskStatus || 'unknown'} `
    + `queued=${counts.queued} running=${counts.running} blocked=${counts.blocked} `
    + `failed=${counts.failed} completed=${counts.completed}`
  );

  if (result.eligible.length > 0) {
    output(`[supervisor] eligible=${result.eligible.map((item) => item.id).join(', ')}`);
  } else if (counts.queued > 0) {
    const reasons = {};
    for (const skipped of result.skipped) {
      reasons[skipped.reason] = (reasons[skipped.reason] || 0) + 1;
    }
    output(`[supervisor] queued assignments are gated: ${Object.entries(reasons).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'}`);
  }

  if (result.toStart.length > 0 && !options.start) {
    output(`[supervisor] dry-run: would start ${result.toStart.map((item) => item.id).join(', ')}`);
  }
  if (result.started.length > 0) {
    output(`[supervisor] started=${result.started.map((item) => `${item.assignmentId}:${item.terminalId || 'unknown-terminal'}`).join(', ')}`);
  }
  if (result.auto?.enabled) {
    output(
      `[supervisor] auto active_policy=${result.auto.activePolicy || 'none'} `
      + `auto_done=${result.auto.done ? 'yes' : 'no'}`
      + `${result.stalledReason ? ` stalled=${result.stalledReason}` : ''}`
    );
  }
}

async function startAssignment(options, taskPayload, assignment, eligibility, deps = {}) {
  const rootSessionId = normalizeText(options.rootSessionId || taskPayload?.task?.rootSessionId || taskPayload?.rootSessionId) || null;
  if (!rootSessionId) {
    throw new Error(`Cannot start assignment ${assignment.id}: --root-session-id is required when the task has no rootSessionId`);
  }

  const body = {
    rootSessionId,
    parentSessionId: options.parentSessionId || rootSessionId,
    originClient: options.originClient,
    externalSessionRef: options.externalSessionRef || `task-supervisor:${options.taskId}`,
    sessionLabel: options.sessionLabel,
    systemPrompt: options.systemPrompt,
    sessionMetadata: {
      supervisorHarness: true,
      supervisorTaskId: options.taskId,
      supervisorAssignmentId: assignment.id,
      startPolicy: eligibility.startPolicy || null,
      phase: eligibility.phase || null
    }
  };
  if (options.preferReuse !== undefined) {
    body.preferReuse = options.preferReuse;
  }
  if (options.forceFreshSession !== undefined) {
    body.forceFreshSession = options.forceFreshSession;
  }

  const result = await callJson(
    options,
    'POST',
    `/orchestration/tasks/${encodeURIComponent(options.taskId)}/assignments/${encodeURIComponent(assignment.id)}/start`,
    body,
    deps
  );

  return {
    assignmentId: assignment.id,
    terminalId: result?.assignment?.terminalId || result?.route?.terminalId || null,
    route: result?.route || null
  };
}

async function runOnce(options, deps = {}) {
  const output = deps.output || console.log;
  const taskPayload = await callJson(
    options,
    'GET',
    `/orchestration/tasks/${encodeURIComponent(options.taskId)}`,
    undefined,
    deps
  );
  const assignmentsPayload = await callJson(
    options,
    'GET',
    `/orchestration/tasks/${encodeURIComponent(options.taskId)}/assignments?limit=500`,
    undefined,
    deps
  );
  const assignments = Array.isArray(assignmentsPayload?.assignments) ? assignmentsPayload.assignments : [];
  const counts = summarizeAssignments(assignments);
  const policyResolution = resolveActivePolicy(options, assignments);
  const eligibilityOptions = {
    ...options,
    allowedStartPolicies: policyResolution.allowedStartPolicies,
    allowAllPolicies: options.auto ? false : options.allowAllPolicies
  };
  const classified = assignments.map((assignment) => ({
    assignment,
    ...isAssignmentEligible(assignment, assignments, eligibilityOptions)
  }));
  const eligible = classified.filter((item) => item.eligible);
  const skipped = classified.filter((item) => !item.eligible && getAssignmentStatus(item.assignment) === 'queued');
  const capacity = Math.max(0, options.concurrency - counts.running);
  const startLimit = Math.min(capacity, options.maxStarts || capacity);
  const toStart = eligible.slice(0, startLimit);
  const started = [];

  if (options.start) {
    for (const item of toStart) {
      started.push(await startAssignment(options, taskPayload, item.assignment, item, deps));
    }
  }

  const allAssignmentsSettled = assignments.length === 0
    || assignments.every((assignment) => isTerminalStatus(getAssignmentStatus(assignment)));
  const failed = counts.failed > 0;
  const blocked = counts.blocked > 0;
  const stalledReason = policyResolution.stalledReason
    || (options.auto && !policyResolution.autoDone && counts.running === 0 && counts.blocked === 0 && counts.failed === 0 && eligible.length === 0 && counts.queued > 0
      ? 'no-eligible-queued-work'
      : null);
  const exitCode = failed && !options.continueOnFailure
    ? 2
    : (blocked && options.stopOnBlocked ? 3 : (stalledReason && !options.continueOnStalled ? STALLED_EXIT_CODE : 0));

  const result = {
    taskId: options.taskId,
    taskStatus: taskPayload?.status || null,
    counts,
    capacity,
    eligible: eligible.map((item) => ({
      id: item.assignment.id,
      startPolicy: item.startPolicy,
      phase: item.phase
    })),
    skipped: skipped.map((item) => ({
      id: item.assignment.id,
      reason: item.reason,
      startPolicy: item.startPolicy,
      phase: item.phase
    })),
    toStart: toStart.map((item) => ({
      id: item.assignment.id,
      startPolicy: item.startPolicy,
      phase: item.phase
    })),
    started,
    dryRun: !options.start,
    done: allAssignmentsSettled || policyResolution.autoDone || exitCode !== 0,
    exitCode,
    stalledReason,
    auto: {
      enabled: options.auto,
      activePolicy: policyResolution.activePolicy,
      policySequence: policyResolution.policySequence,
      done: policyResolution.autoDone
    }
  };

  writeHumanSummary(output, result, options);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(options, deps = {}) {
  let iteration = 0;
  let lastResult = null;

  do {
    iteration += 1;
    lastResult = await runOnce(options, deps);
    if (options.once || !options.loop || lastResult.done) {
      return lastResult.exitCode;
    }
    if (options.maxIterations && iteration >= options.maxIterations) {
      return lastResult.exitCode;
    }
    await (deps.sleep || sleep)(options.pollMs);
  } while (true);
}

async function main(rawArgs = process.argv.slice(2), deps = {}) {
  try {
    const options = parseArgs(rawArgs);
    if (options.help) {
      printUsage(deps.output || console.log);
      return 0;
    }
    return await runLoop(options, deps);
  } catch (error) {
    const outputError = deps.outputError || console.error;
    outputError(`[supervisor] ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  });
}

module.exports = {
  DEFAULT_ALLOWED_START_POLICIES,
  DEFAULT_POLICY_SEQUENCE,
  STALLED_EXIT_CODE,
  parseArgs,
  getAssignmentMetadata,
  getDependencyIds,
  getStartPolicy,
  getAssignmentPhase,
  getAssignmentStatus,
  getPolicySequence,
  resolveActivePolicy,
  isAssignmentEligible,
  summarizeAssignments,
  runOnce,
  runLoop,
  main
};
