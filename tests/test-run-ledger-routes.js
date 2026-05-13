#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startTestServer, stopTestServer } = require('./helpers/server-harness');
const { RunLedgerService } = require('../src/orchestration/run-ledger');
const { isAdapterAuthenticated } = require('../src/utils/adapter-auth');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isSkippableProviderFailure(message = '') {
  const text = String(message).toLowerCase();
  return [
    'not authenticated',
    'authentication failed',
    'invalid access token',
    'token expired',
    'please log in',
    'login required',
    'api key',
    'quota',
    'usage limit',
    'rate limit',
    'resourceexhausted',
    'no active subscription',
    'billing',
    'request timed out',
    'cli not available',
    'adapter cli is not available',
    'adapter not installed',
    'oauth was discontinued upstream',
    'switch to api key or coding plan',
    'status: 504'
  ].some((pattern) => text.includes(pattern));
}

async function request(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000)
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}

  return { status: response.status, data };
}

async function ensureRouteAdaptersAvailable(baseUrl, adapterNames) {
  const adaptersResponse = await request(baseUrl, 'GET', '/adapters');
  if (adaptersResponse.status !== 200) {
    throw new Error(`Adapter catalog failed: ${adaptersResponse.status}`);
  }

  const adapters = new Map((adaptersResponse.data.adapters || []).map((adapter) => [adapter.name, adapter]));
  for (const adapterName of adapterNames) {
    const adapter = adapters.get(adapterName);
    if (!adapter) {
      throw new Error(`SKIP: ${adapterName} adapter not registered`);
    }
    if (!adapter.available) {
      throw new Error(`SKIP: ${adapterName} adapter not installed`);
    }

    const auth = isAdapterAuthenticated(adapterName);
    if (!auth.authenticated) {
      throw new Error(`SKIP: ${auth.reason}`);
    }
  }
}

async function run() {
  const previousWriteFlag = process.env.RUN_LEDGER_ENABLED;
  const previousReadFlag = process.env.RUN_LEDGER_READS_ENABLED;
  process.env.RUN_LEDGER_ENABLED = '1';
  process.env.RUN_LEDGER_READS_ENABLED = '1';

  const orchestrationDataDir = makeTempDir('cliagents-run-ledger-routes-data-');
  const orchestrationLogDir = makeTempDir('cliagents-run-ledger-routes-logs-');
  let testServer = null;

  try {
    testServer = await startTestServer({
      orchestration: {
        dataDir: orchestrationDataDir,
        logDir: orchestrationLogDir,
        workDir: '/Users/mojave/Documents/AI-projects/cliagents'
      }
    });

    const ledger = new RunLedgerService(testServer.server.orchestration.db);
    await ensureRouteAdaptersAvailable(testServer.baseUrl, ['codex-cli', 'qwen-cli']);

    const consensusResponse = await request(testServer.baseUrl, 'POST', '/orchestration/consensus', {
      message: 'What is 3 + 3? Reply with just the number.',
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      timeout: 120000,
      workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents'
    });

    if (consensusResponse.status !== 200) {
      const message = consensusResponse.data?.error?.message || consensusResponse.data?.error || JSON.stringify(consensusResponse.data);
      if (isSkippableProviderFailure(message)) {
        throw new Error(`SKIP: ${message}`);
      }
      throw new Error(`Consensus route failed: ${consensusResponse.status} ${message}`);
    }

    assert(consensusResponse.data.runId, 'Consensus response should include runId when ledger is enabled');
    const consensusDetail = ledger.getRunDetail(consensusResponse.data.runId);
    assert(consensusDetail, 'Consensus run should be queryable from the ledger');
    assert.strictEqual(consensusDetail.run.kind, 'consensus');
    assert(consensusDetail.participants.length >= 2, 'Consensus run should register participants');
    assert(consensusDetail.inputs.length >= 3, 'Consensus run should persist original and participant prompts');
    assert(consensusDetail.outputs.length >= 2, 'Consensus run should persist participant outputs');

    const listedRunsResponse = await request(testServer.baseUrl, 'GET', '/orchestration/runs?kind=consensus&adapter=codex-cli&limit=10&offset=0');
    assert.strictEqual(listedRunsResponse.status, 200, 'Run list API should succeed when reads are enabled');
    assert(Array.isArray(listedRunsResponse.data.runs), 'Run list API should return a runs array');
    assert(listedRunsResponse.data.runs.some((run) => run.id === consensusResponse.data.runId), 'Run list API should include the consensus run');
    assert.strictEqual(listedRunsResponse.data.pagination.limit, 10);

    const consensusApiDetail = await request(testServer.baseUrl, 'GET', '/orchestration/runs/' + consensusResponse.data.runId);
    assert.strictEqual(consensusApiDetail.status, 200, 'Run detail API should succeed for existing run');
    assert.strictEqual(consensusApiDetail.data.run.id, consensusResponse.data.runId);
    assert.strictEqual(consensusApiDetail.data.run.kind, 'consensus');
    assert(consensusApiDetail.data.inputs.some((input) => input.inputKind === 'run_message'), 'Run detail API should expose the original run message');
    assert(consensusApiDetail.data.outputs.length >= 2, 'Run detail API should expose persisted outputs');

    const discussionResponse = await request(testServer.baseUrl, 'POST', '/orchestration/discussion', {
      message: 'Decide whether cliagents should prefer async-first MCP delegation for long-running tasks.',
      context: 'Keep the discussion compact and focused on orchestration behavior.',
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      rounds: [
        {
          name: 'position',
          instructions: 'State one recommendation and one risk. End with POS_DONE.',
          transcriptMode: 'none'
        },
        {
          name: 'reply',
          instructions: 'React to the prior round, state agree or disagree, and propose one compromise. End with REPLY_DONE.',
          transcriptMode: 'previous'
        }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      timeout: 120000,
      workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents'
    });

    if (discussionResponse.status !== 200) {
      const message = discussionResponse.data?.error?.message || discussionResponse.data?.error || JSON.stringify(discussionResponse.data);
      if (isSkippableProviderFailure(message)) {
        throw new Error(`SKIP: ${message}`);
      }
      throw new Error(`Discussion route failed: ${discussionResponse.status} ${message}`);
    }

    assert(discussionResponse.data.runId, 'Discussion response should include runId when ledger is enabled');
    assert(Array.isArray(discussionResponse.data.rounds), 'Discussion response should include rounds');
    assert(discussionResponse.data.rounds.length >= 1, 'Discussion response should expose at least one executed round');
    assert(discussionResponse.data.rounds.length <= 2, 'Discussion response should not exceed the configured round count');

    const discussionDetail = ledger.getRunDetail(discussionResponse.data.runId);
    assert(discussionDetail, 'Discussion run should be queryable from the ledger');
    assert.strictEqual(discussionDetail.run.kind, 'discussion');
    assert(discussionDetail.inputs.some((input) => input.inputKind === 'participant_prompt'), 'Discussion run should persist participant prompts');
    assert(discussionDetail.outputs.some((output) => output.outputKind === 'participant_final'), 'Discussion run should persist round outputs');
    assert(discussionDetail.participants.some((participant) => participant.participantRole === 'judge'), 'Discussion run should register the judge');
    assert(
      ['completed', 'partial'].includes(discussionDetail.run.status),
      `Discussion run should finish as completed or partial, got ${discussionDetail.run.status}`
    );
    if (discussionDetail.run.status === 'partial') {
      assert(
        discussionDetail.participants.some((participant) => participant.status === 'failed'),
        'Partial discussion runs should record the degraded participant state'
      );
    }

    const planReviewResponse = await request(testServer.baseUrl, 'POST', '/orchestration/plan-review', {
      plan: '1. Read the file.\n2. Fix the bug.\n3. Add tests.',
      context: 'Focus on correctness and missing validation.',
      reviewers: [
        { name: 'codex-reviewer', adapter: 'codex-cli' },
        { name: 'qwen-reviewer', adapter: 'qwen-cli' }
      ],
      judge: { name: 'codex-judge', adapter: 'codex-cli' },
      timeout: 120000,
      workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents'
    });

    if (planReviewResponse.status !== 200) {
      const message = planReviewResponse.data?.error?.message || planReviewResponse.data?.error || JSON.stringify(planReviewResponse.data);
      if (isSkippableProviderFailure(message)) {
        throw new Error(`SKIP: ${message}`);
      }
      throw new Error(`Plan-review route failed: ${planReviewResponse.status} ${message}`);
    }

    assert(planReviewResponse.data.runId, 'Plan-review response should include runId when ledger is enabled');
    const reviewDetail = ledger.getRunDetail(planReviewResponse.data.runId);
    assert(reviewDetail, 'Plan-review run should be queryable from the ledger');
    assert.strictEqual(reviewDetail.run.kind, 'plan-review');
    assert(reviewDetail.participants.length >= 2, 'Plan-review should register reviewers and judge');
    assert(reviewDetail.inputs.length >= 4, 'Plan-review should persist original, reviewer, and judge prompts');
    assert(reviewDetail.outputs.length >= 2, 'Plan-review should persist reviewer/judge outputs');
    assert(
      ['completed', 'partial'].includes(reviewDetail.run.status),
      `Plan-review should finish as completed or partial, got ${reviewDetail.run.status}`
    );
    if (reviewDetail.run.status === 'partial') {
      assert(
        reviewDetail.participants.some((participant) => participant.status === 'failed'),
        'Partial plan-review runs should record the degraded participant state'
      );
    }

    const reviewApiDetail = await request(testServer.baseUrl, 'GET', '/orchestration/runs/' + planReviewResponse.data.runId);
    assert.strictEqual(reviewApiDetail.status, 200, 'Plan-review detail API should succeed for existing run');
    assert.strictEqual(reviewApiDetail.data.run.kind, 'plan-review');
    assert(reviewApiDetail.data.inputs.some((input) => input.inputKind === 'judge_prompt'), 'Plan-review detail API should expose the judge prompt');
    assert(reviewApiDetail.data.participants.length >= 2, 'Plan-review detail API should expose participants');

    console.log('✅ Ledger-enabled orchestration routes emit runIds and persist run details');
  } finally {
    if (testServer) {
      await stopTestServer(testServer);
    }

    if (previousWriteFlag === undefined) {
      delete process.env.RUN_LEDGER_ENABLED;
    } else {
      process.env.RUN_LEDGER_ENABLED = previousWriteFlag;
    }

    if (previousReadFlag === undefined) {
      delete process.env.RUN_LEDGER_READS_ENABLED;
    } else {
      process.env.RUN_LEDGER_READS_ENABLED = previousReadFlag;
    }
  }
}

run().then(() => {
  console.log('\nRun-ledger route tests passed');
  process.exit(0);
}).catch((error) => {
  if (String(error.message).startsWith('SKIP:')) {
    console.log(`\nRun-ledger route tests skipped: ${error.message.slice(5).trim()}`);
    process.exit(0);
  }

  console.error('\nRun-ledger route tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
