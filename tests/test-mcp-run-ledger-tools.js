#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function loadMcpModule(envOverrides = {}) {
  const modulePath = require.resolve('../src/mcp/cliagents-mcp-server');
  delete require.cache[modulePath];

  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
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

async function startFakeCliagentsServer() {
  const state = {
    lastDiscussionBody: null,
    discussionResponse: null,
    runsListResponse: null,
    runDetailResponse: null
  };

  const server = http.createServer(async (req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const readBody = async () => {
      let data = '';
      for await (const chunk of req) {
        data += chunk;
      }
      return data ? JSON.parse(data) : {};
    };

    if (req.method === 'POST' && req.url === '/orchestration/discussion') {
      state.lastDiscussionBody = await readBody();
      return writeJson(200, state.discussionResponse);
    }

    if (req.method === 'GET' && (req.url === '/orchestration/runs' || req.url.startsWith('/orchestration/runs?'))) {
      return writeJson(200, state.runsListResponse);
    }

    const detailMatch = req.url.match(/^\/orchestration\/runs\/([^/?]+)$/);
    if (req.method === 'GET' && detailMatch) {
      if (!state.runDetailResponse) {
        return writeJson(404, { error: { message: 'not found' } });
      }
      return writeJson(200, state.runDetailResponse);
    }

    return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function makeDiscussionDetail(runId = 'run-discussion-1') {
  return {
    run: {
      id: runId,
      kind: 'discussion',
      status: 'completed',
      currentStep: 'judge',
      decisionSource: 'judge',
      decisionSummary: 'Prefer async-first MCP delegation.',
      metadata: {
        discussionId: 'discussion-1'
      }
    },
    participants: [
      {
        id: 'p-codex',
        participantName: 'codex',
        participantRole: 'participant',
        adapter: 'codex-cli',
        status: 'completed'
      },
      {
        id: 'p-qwen',
        participantName: 'qwen',
        participantRole: 'participant',
        adapter: 'qwen-cli',
        status: 'completed'
      },
      {
        id: 'p-judge',
        participantName: 'judge',
        participantRole: 'judge',
        adapter: 'codex-cli',
        status: 'completed'
      }
    ],
    inputs: [],
    outputs: [
      {
        id: 'round-1',
        outputKind: 'participant_final',
        participantId: null,
        previewText: 'codex: async-first\\nqwen: async-first',
        metadata: {
          roundIndex: 0,
          roundName: 'position',
          successCount: 2,
          responseCount: 2
        }
      },
      {
        id: 'judge-out',
        outputKind: 'judge_final',
        participantId: 'p-judge',
        previewText: 'Use async-first delegation and poll for completion.',
        metadata: {}
      }
    ],
    steps: [],
    toolEvents: []
  };
}

async function run() {
  const fakeServer = await startFakeCliagentsServer();
  const { mod, restore } = loadMcpModule({
    CLIAGENTS_URL: fakeServer.baseUrl,
    CLIAGENTS_MCP_POLL_MS: '10',
    CLIAGENTS_MCP_SYNC_WAIT_MS: '80',
    CLIAGENTS_CLIENT_NAME: 'codex',
    CLIAGENTS_ROOT_SESSION_ID: 'attached-root-1',
    CLIAGENTS_CLIENT_SESSION_REF: 'codex:thread-run-ledger'
  });

  try {
    fakeServer.state.discussionResponse = {
      runId: 'run-discussion-1',
      discussionId: 'discussion-1',
      participants: [
        { name: 'codex', adapter: 'codex-cli', success: true },
        { name: 'qwen', adapter: 'qwen-cli', success: true }
      ],
      rounds: [
        {
          name: 'position',
          responses: [
            { success: true, adapter: 'codex-cli' },
            { success: true, adapter: 'qwen-cli' }
          ]
        },
        {
          name: 'reply',
          responses: [
            { success: true, adapter: 'codex-cli' },
            { success: true, adapter: 'qwen-cli' }
          ]
        }
      ],
      judge: {
        name: 'judge',
        adapter: 'codex-cli',
        success: true,
        output: 'Prefer async-first delegation.'
      }
    };

    const discussion = await mod.handleRunDiscussion({
      message: 'Debate async-first MCP delegation.',
      context: 'Keep it focused on orchestration semantics.',
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      rounds: [
        { name: 'position', instructions: 'Take a position.', transcriptMode: 'none' },
        { name: 'reply', instructions: 'Reply once.', transcriptMode: 'previous' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      timeout: 'complex',
      workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents'
    });

    const discussionText = discussion.content[0].text;
    assert(discussionText.includes('Discussion Completed'));
    assert(discussionText.includes('run-discussion-1'));
    assert(discussionText.includes('Round Summary'));
    assert(discussionText.includes('judge [codex-cli]'));
    assert.strictEqual(fakeServer.state.lastDiscussionBody.timeout, mod.TIMEOUTS.complex * 1000);
    assert.strictEqual(fakeServer.state.lastDiscussionBody.workingDirectory, '/Users/mojave/Documents/AI-projects/cliagents');

    const detachedDiscussionStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-mcp-detached-discussion-'));
    const detachedDiscussion = loadMcpModule({
      CLIAGENTS_URL: fakeServer.baseUrl,
      CLIAGENTS_MCP_POLL_MS: '10',
      CLIAGENTS_MCP_SYNC_WAIT_MS: '80',
      CLIAGENTS_CLIENT_NAME: 'codex',
      CLIAGENTS_MCP_SESSION_SCOPE: 'session-detached-discussion',
      CLIAGENTS_MCP_STATE_DIR: detachedDiscussionStateDir,
      CLIAGENTS_ROOT_SESSION_ID: '',
      CLIAGENTS_CLIENT_SESSION_REF: '',
      CLIAGENTS_REQUIRE_ROOT_ATTACH: ''
    });
    try {
      fakeServer.state.lastDiscussionBody = null;
      const detachedResult = await detachedDiscussion.mod.handleRunDiscussion({
        message: 'Debate detached discussion semantics.',
        participants: [
          { name: 'codex', adapter: 'codex-cli' },
          { name: 'qwen', adapter: 'qwen-cli' }
        ],
        timeout: 'simple'
      });
      assert(detachedResult.content[0].text.includes('Discussion Completed'));
      assert.strictEqual(fakeServer.state.lastDiscussionBody.rootSessionId, undefined);
      assert.strictEqual(fakeServer.state.lastDiscussionBody.parentSessionId, undefined);
      assert.strictEqual(fakeServer.state.lastDiscussionBody.originClient, undefined);
      assert.strictEqual(fakeServer.state.lastDiscussionBody.externalSessionRef, undefined);
      assert.strictEqual(fakeServer.state.lastDiscussionBody.sessionMetadata, undefined);
    } finally {
      detachedDiscussion.restore();
      fs.rmSync(detachedDiscussionStateDir, { recursive: true, force: true });
    }

    const strictDiscussionStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-mcp-strict-discussion-'));
    const strictDiscussion = loadMcpModule({
      CLIAGENTS_URL: fakeServer.baseUrl,
      CLIAGENTS_MCP_POLL_MS: '10',
      CLIAGENTS_MCP_SYNC_WAIT_MS: '80',
      CLIAGENTS_CLIENT_NAME: 'codex',
      CLIAGENTS_MCP_SESSION_SCOPE: 'session-strict-discussion',
      CLIAGENTS_MCP_STATE_DIR: strictDiscussionStateDir,
      CLIAGENTS_ROOT_SESSION_ID: '',
      CLIAGENTS_CLIENT_SESSION_REF: '',
      CLIAGENTS_REQUIRE_ROOT_ATTACH: '1'
    });
    try {
      await assert.rejects(
        () => strictDiscussion.mod.handleRunDiscussion({
          message: 'This discussion should require an attached root.',
          participants: [
            { name: 'codex', adapter: 'codex-cli' }
          ]
        }),
        (error) => {
          assert(error.message.includes('cliagents root session'));
          assert(error.message.includes('ensure_root_session'));
          return true;
        }
      );
    } finally {
      strictDiscussion.restore();
      fs.rmSync(strictDiscussionStateDir, { recursive: true, force: true });
    }

    fakeServer.state.runDetailResponse = makeDiscussionDetail();

    const summaryDetail = await mod.handleGetRunDetail({
      runId: 'run-discussion-1'
    });
    const summaryText = summaryDetail.content[0].text;
    assert(summaryText.includes('Run Detail: run-discussion-1'));
    assert(summaryText.includes('Discussion Rounds'));
    assert(summaryText.includes('Round 1: position'));

    const jsonDetail = await mod.handleGetRunDetail({
      runId: 'run-discussion-1',
      format: 'json'
    });
    const parsedDetail = JSON.parse(jsonDetail.content[0].text);
    assert.strictEqual(parsedDetail.run.id, 'run-discussion-1');
    assert.strictEqual(parsedDetail.run.kind, 'discussion');

    fakeServer.state.runsListResponse = {
      runs: [
        {
          id: 'run-discussion-1',
          kind: 'discussion',
          status: 'completed',
          decisionSource: 'judge',
          startedAt: 1712832000000,
          inputSummary: 'Debate async-first MCP delegation.'
        },
        {
          id: 'run-consensus-1',
          kind: 'consensus',
          status: 'completed',
          decisionSource: 'judge',
          startedAt: 1712832600000,
          inputSummary: 'Reach a final recommendation.'
        }
      ],
      pagination: {
        total: 2,
        returned: 2,
        offset: 0,
        limit: 20,
        hasMore: false
      }
    };

    const runsSummary = await mod.handleListRuns({
      kind: 'discussion',
      adapter: 'codex-cli',
      limit: 20,
      offset: 0
    });
    const runsText = runsSummary.content[0].text;
    assert(runsText.includes('Persisted Runs'));
    assert(runsText.includes('run-discussion-1'));
    assert(runsText.includes('kind: discussion'));

    const runsJson = await mod.handleListRuns({
      format: 'json'
    });
    const parsedRuns = JSON.parse(runsJson.content[0].text);
    assert.strictEqual(parsedRuns.pagination.total, 2);
    assert.strictEqual(parsedRuns.runs[0].id, 'run-discussion-1');

    console.log('✅ MCP discussion and run-ledger tools expose discussion execution and persisted run lookup');
    console.log('\nMCP run-ledger tool tests passed');
  } finally {
    restore();
    await fakeServer.close();
  }
}

run().catch((error) => {
  console.error('\nMCP run-ledger tool tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
