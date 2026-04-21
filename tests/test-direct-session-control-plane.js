#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOrchestrationRouter } = require('../src/server/orchestration-router');
const { OrchestrationDB } = require('../src/database/db');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', createOrchestrationRouter(context));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function stopApp(serverHandle) {
  await new Promise((resolve, reject) => {
    serverHandle.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function request(baseUrl, method, route, body) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

function createDirectSessionManager() {
  const sessions = new Map();
  let counter = 0;

  return {
    async createSession(options = {}) {
      const sessionId = options.sessionId || `direct-${++counter}`;
      sessions.set(sessionId, options);
      return { sessionId };
    },
    async send(sessionId, message) {
      const options = sessions.get(sessionId) || {};
      const wantsJson = /return only valid json|return json only/i.test(String(message || ''));
      if (wantsJson) {
        return {
          result: JSON.stringify({
            verdict: 'approve',
            summary: `${options.adapter || 'agent'} review completed`,
            blockers: [],
            risks: [],
            testGaps: []
          }),
          metadata: { adapter: options.adapter || 'unknown' }
        };
      }

      return {
        result: `${options.adapter || 'agent'} completed: ${String(message || '').slice(0, 120)}`,
        metadata: { adapter: options.adapter || 'unknown' }
      };
    },
    async terminateSession(sessionId) {
      sessions.delete(sessionId);
    }
  };
}

function listEventTypes(events) {
  return events.map((event) => event.event_type);
}

async function run() {
  const previousGraph = process.env.SESSION_GRAPH_WRITES_ENABLED;
  const previousEvents = process.env.SESSION_EVENTS_ENABLED;
  const previousLedger = process.env.RUN_LEDGER_ENABLED;
  const previousReads = process.env.RUN_LEDGER_READS_ENABLED;
  process.env.SESSION_GRAPH_WRITES_ENABLED = '1';
  process.env.SESSION_EVENTS_ENABLED = '1';
  process.env.RUN_LEDGER_ENABLED = '1';
  process.env.RUN_LEDGER_READS_ENABLED = '1';

  const rootDir = makeTempDir('cliagents-direct-session-control-plane-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const apiSessionManager = createDirectSessionManager();
  const sessionManager = {
    async createTerminal() {
      throw new Error('not used');
    },
    async sendInput() {
      throw new Error('not used');
    }
  };

  let serverHandle = null;

  try {
    serverHandle = await startApp({ sessionManager, apiSessionManager, db });

    const discussionRoot = '11111111111111111111111111111111';
    const discussionRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/discussion', {
      message: 'Debate async-first delegation.',
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      rounds: [
        { name: 'position', transcriptMode: 'none', instructions: 'State one recommendation.' },
        { name: 'rebuttal', transcriptMode: 'previous', instructions: 'Challenge one point and converge.' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      rootSessionId: discussionRoot,
      parentSessionId: discussionRoot,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'opencode', toolName: 'run_discussion' }
    });

    assert.strictEqual(discussionRes.status, 200);
    assert(discussionRes.data.discussionId, 'discussion should return a discussionId');

    const discussionEventsRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/session-events?discussionId=${encodeURIComponent(discussionRes.data.discussionId)}`
    );
    assert.strictEqual(discussionEventsRes.status, 200);
    assert(discussionEventsRes.data.events.length >= 8, 'discussion should persist multiple session events');
    assert(discussionEventsRes.data.events.every((event) => event.root_session_id === discussionRoot));
    assert(listEventTypes(discussionEventsRes.data.events).includes('discussion_started'));
    assert(listEventTypes(discussionEventsRes.data.events).includes('discussion_round_started'));
    assert(listEventTypes(discussionEventsRes.data.events).includes('discussion_round_completed'));
    assert(listEventTypes(discussionEventsRes.data.events).includes('delegation_started'));
    assert(listEventTypes(discussionEventsRes.data.events).includes('delegation_completed'));
    assert(listEventTypes(discussionEventsRes.data.events).includes('judge_completed'));
    assert(listEventTypes(discussionEventsRes.data.events).includes('consensus_recorded'));

    const discussionRootRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/root-sessions/${encodeURIComponent(discussionRoot)}?eventLimit=200&terminalLimit=50`
    );
    assert.strictEqual(discussionRootRes.status, 200);
    assert.strictEqual(discussionRootRes.data.rootSessionId, discussionRoot);
    assert.strictEqual(discussionRootRes.data.rootSession.originClient, 'mcp');
    assert.strictEqual(discussionRootRes.data.status, 'completed');

    const reviewRoot = '22222222222222222222222222222222';
    const reviewRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/plan-review', {
      plan: '1. Inspect the failing route. 2. Patch the handler. 3. Add tests.',
      reviewers: [
        { name: 'codex-reviewer', adapter: 'codex-cli' },
        { name: 'qwen-reviewer', adapter: 'qwen-cli' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      rootSessionId: reviewRoot,
      parentSessionId: reviewRoot,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'opencode', toolName: 'plan_review' }
    });

    assert.strictEqual(reviewRes.status, 200);
    assert(reviewRes.data.runId, 'plan-review should return a runId');

    const reviewEventsRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/session-events?runId=${encodeURIComponent(reviewRes.data.runId)}`
    );
    assert.strictEqual(reviewEventsRes.status, 200);
    assert(reviewEventsRes.data.events.length >= 6, 'review should persist control-plane events');
    assert(reviewEventsRes.data.events.every((event) => event.root_session_id === reviewRoot));
    assert(listEventTypes(reviewEventsRes.data.events).includes('delegation_started'));
    assert(listEventTypes(reviewEventsRes.data.events).includes('delegation_completed'));
    assert(listEventTypes(reviewEventsRes.data.events).includes('judge_completed'));
    assert(listEventTypes(reviewEventsRes.data.events).includes('consensus_recorded'));

    const reviewRootRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/root-sessions/${encodeURIComponent(reviewRoot)}?eventLimit=200&terminalLimit=50`
    );
    assert.strictEqual(reviewRootRes.status, 200);
    assert.strictEqual(reviewRootRes.data.rootSessionId, reviewRoot);
    assert.strictEqual(reviewRootRes.data.rootSession.originClient, 'mcp');

    const consensusRoot = '44444444444444444444444444444444';
    const consensusRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/consensus', {
      message: 'Decide whether grouped polling is better than single-terminal polling.',
      participants: [
        { name: 'codex', adapter: 'codex-cli' },
        { name: 'qwen', adapter: 'qwen-cli' }
      ],
      judge: { name: 'judge', adapter: 'codex-cli' },
      rootSessionId: consensusRoot,
      parentSessionId: consensusRoot,
      originClient: 'mcp',
      sessionMetadata: { clientName: 'opencode', toolName: 'consensus' }
    });

    assert.strictEqual(consensusRes.status, 200);
    assert(consensusRes.data.runId, 'consensus should return a runId');

    const consensusEventsRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/session-events?runId=${encodeURIComponent(consensusRes.data.runId)}`
    );
    assert.strictEqual(consensusEventsRes.status, 200);
    assert(consensusEventsRes.data.events.every((event) => event.root_session_id === consensusRoot));
    assert(listEventTypes(consensusEventsRes.data.events).includes('delegation_started'));
    assert(listEventTypes(consensusEventsRes.data.events).includes('delegation_completed'));
    assert(listEventTypes(consensusEventsRes.data.events).includes('judge_completed'));
    assert(listEventTypes(consensusEventsRes.data.events).includes('consensus_recorded'));

    const rootListRes = await request(serverHandle.baseUrl, 'GET', '/orchestration/root-sessions?limit=20');
    assert.strictEqual(rootListRes.status, 200);
    const rootIds = new Set((rootListRes.data.roots || []).map((entry) => entry.rootSessionId));
    assert(rootIds.has(discussionRoot));
    assert(rootIds.has(reviewRoot));
    assert(rootIds.has(consensusRoot));

    const recentEventsRes = await request(serverHandle.baseUrl, 'GET', '/orchestration/session-events?limit=50');
    assert.strictEqual(recentEventsRes.status, 200);
    assert(recentEventsRes.data.events.length >= reviewEventsRes.data.events.length, 'unfiltered session-events should return recent history');

    console.log('✅ Direct discussion and review routes persist session control-plane events');
  } finally {
    if (serverHandle) {
      await stopApp(serverHandle.server);
    }
    db.close();

    if (previousGraph === undefined) {
      delete process.env.SESSION_GRAPH_WRITES_ENABLED;
    } else {
      process.env.SESSION_GRAPH_WRITES_ENABLED = previousGraph;
    }
    if (previousEvents === undefined) {
      delete process.env.SESSION_EVENTS_ENABLED;
    } else {
      process.env.SESSION_EVENTS_ENABLED = previousEvents;
    }
    if (previousLedger === undefined) {
      delete process.env.RUN_LEDGER_ENABLED;
    } else {
      process.env.RUN_LEDGER_ENABLED = previousLedger;
    }
    if (previousReads === undefined) {
      delete process.env.RUN_LEDGER_READS_ENABLED;
    } else {
      process.env.RUN_LEDGER_READS_ENABLED = previousReads;
    }
  }
}

run().then(() => {
  console.log('\nDirect session control-plane tests passed');
}).catch((error) => {
  console.error('\nDirect session control-plane tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
