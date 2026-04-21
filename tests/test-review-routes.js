/**
 * Unit tests for /orchestration/plan-review and /orchestration/pr-review routes.
 *
 * Run:
 *   node tests/test-review-routes.js
 */

const assert = require('assert');
const express = require('express');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');

function createMockSessionManager(sendImpl) {
  const createCalls = [];
  const sendCalls = [];
  const terminateCalls = [];

  return {
    createCalls,
    sendCalls,
    terminateCalls,
    async createSession(options) {
      createCalls.push(options);
      return { sessionId: options.sessionId };
    },
    async send(sessionId, message, options) {
      const createOptions = createCalls.find((entry) => entry.sessionId === sessionId);
      sendCalls.push({ sessionId, message, options, createOptions });
      return sendImpl({ sessionId, message, options, createOptions, sendCalls });
    },
    async terminateSession(sessionId) {
      terminateCalls.push(sessionId);
    }
  };
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

async function request(baseUrl, path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

async function testValidationResponses() {
  const failSessionManager = {
    async createSession() {
      throw new Error('should not be called');
    },
    async send() {
      throw new Error('should not be called');
    },
    async terminateSession() {}
  };

  const { server, baseUrl } = await startApp({
    sessionManager: failSessionManager,
    apiSessionManager: failSessionManager
  });

  try {
    const planRes = await request(baseUrl, '/orchestration/plan-review', {});
    assert.strictEqual(planRes.status, 400);
    assert.strictEqual(planRes.data.error.code, 'missing_parameter');
    assert.strictEqual(planRes.data.error.param, 'plan');

    const prRes = await request(baseUrl, '/orchestration/pr-review', {});
    assert.strictEqual(prRes.status, 400);
    assert.strictEqual(prRes.data.error.code, 'missing_parameter');
    assert.strictEqual(prRes.data.error.param, 'summary|diff');
  } finally {
    await stopApp(server);
  }
}

async function testPlanRouteUsesApiSessionManager() {
  const apiManager = createMockSessionManager(({ message, createOptions }) => {
    if (message.includes('You are the final judge for a plan-review workflow.')) {
      return {
        result: JSON.stringify({
          verdict: 'approve',
          summary: 'Approved by judge.',
          blockers: [],
          risks: [],
          testGaps: []
        })
      };
    }

    if (createOptions.adapter === 'codex-cli') {
      return {
        result: JSON.stringify({
          verdict: 'revise',
          summary: 'Add migration tests.',
          blockers: [],
          risks: [],
          testGaps: ['Missing migration test']
        })
      };
    }

    return {
      result: JSON.stringify({
        verdict: 'approve',
        summary: 'No extra risks.',
        blockers: [],
        risks: [],
        testGaps: []
      })
    };
  });

  const fallbackSessionManager = {
    async createSession() {
      throw new Error('fallback session manager should not be used when apiSessionManager exists');
    },
    async send() {
      throw new Error('fallback session manager should not be used when apiSessionManager exists');
    },
    async terminateSession() {}
  };

  const { server, baseUrl } = await startApp({
    sessionManager: fallbackSessionManager,
    apiSessionManager: apiManager
  });

  try {
    const res = await request(baseUrl, '/orchestration/plan-review', {
      plan: 'Implement review endpoints and tests.',
      context: 'service-level change',
      timeout: 25,
      workingDirectory: '/tmp/plan-route'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.protocol, 'plan-review');
    assert.strictEqual(res.data.decision.verdict, 'approve');
    assert.strictEqual(res.data.decision.source, 'judge');
    assert.strictEqual(apiManager.createCalls.length, 3);
  } finally {
    await stopApp(server);
  }
}

async function testPrRouteWithReviewerAggregation() {
  const apiManager = createMockSessionManager(({ createOptions }) => {
    if (createOptions.adapter === 'codex-cli') {
      return {
        result: JSON.stringify({
          verdict: 'reject',
          summary: 'Found a blocker in diff.',
          blockers: [{ id: 'B1', severity: 'high', issue: 'Unsafe null access', evidence: 'Line 41', fix: 'Guard null before access' }],
          risks: [],
          testGaps: []
        })
      };
    }
    return {
      result: JSON.stringify({
        verdict: 'approve',
        summary: 'No security findings.',
        blockers: [],
        risks: [],
        testGaps: []
      })
    };
  });

  const { server, baseUrl } = await startApp({
    sessionManager: apiManager,
    apiSessionManager: apiManager
  });

  try {
    const res = await request(baseUrl, '/orchestration/pr-review', {
      summary: 'Update null handling in parser.',
      diff: 'diff --git a/file b/file ...',
      judge: false
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.protocol, 'pr-review');
    assert.strictEqual(res.data.judge, null);
    assert.strictEqual(res.data.decision.source, 'aggregated-reviewers');
    assert.strictEqual(res.data.decision.verdict, 'reject');
    assert.strictEqual(apiManager.createCalls.length, 2);
  } finally {
    await stopApp(server);
  }
}

async function run() {
  console.log('Running review route tests...');

  await testValidationResponses();
  console.log('  ✓ validation errors');

  await testPlanRouteUsesApiSessionManager();
  console.log('  ✓ plan-review success path');

  await testPrRouteWithReviewerAggregation();
  console.log('  ✓ pr-review success path');

  console.log('All review route tests passed.');
}

run().catch((error) => {
  console.error('Review route tests failed:', error);
  process.exit(1);
});
