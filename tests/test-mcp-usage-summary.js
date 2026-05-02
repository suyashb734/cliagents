#!/usr/bin/env node

'use strict';

const assert = require('assert');
const http = require('http');

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
  const server = http.createServer((req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url.startsWith('/orchestration/usage/runs/run-usage-v2')) {
      return writeJson(200, {
        runId: 'run-usage-v2',
        scope: 'runId',
        summary: {
          recordCount: 4,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 150,
          costUsd: 0.12,
          durationMs: 0
        },
        attribution: {
          executionTokens: 90,
          planningTokens: 20,
          judgeTokens: 40,
          supervisionTokens: 0,
          unknownRoleTokens: 0,
          brokerOverheadTokens: 60,
          brokerOverheadShare: 0.4,
          executionShare: 0.6,
          roleBreakdown: [
            { key: 'participant', totalTokens: 90, costUsd: 0.05 },
            { key: 'plan', totalTokens: 20, costUsd: 0.02 },
            { key: 'judge', totalTokens: 40, costUsd: 0.05 }
          ]
        },
        breakdowns: {
          role: [
            { key: 'participant', totalTokens: 90, costUsd: 0.05 },
            { key: 'judge', totalTokens: 40, costUsd: 0.05 },
            { key: 'plan', totalTokens: 20, costUsd: 0.02 }
          ],
          model: [
            { key: 'o4-mini', totalTokens: 90, costUsd: 0.05 },
            { key: 'claude-sonnet-4', totalTokens: 60, costUsd: 0.07 }
          ]
        }
      });
    }

    return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function run() {
  const fakeServer = await startFakeCliagentsServer();
  const { mod, restore } = loadMcpModule({
    CLIAGENTS_URL: fakeServer.baseUrl,
    CLIAGENTS_CLIENT_NAME: 'codex'
  });

  try {
    const result = await mod.handleGetUsageSummary({
      runId: 'run-usage-v2',
      breakdown: 'role,model'
    });

    const text = result.content[0].text;
    assert(text.includes('## Usage Summary: run run-usage-v2'));
    assert(text.includes('total_tokens: 150'));
    assert(text.includes('execution_tokens: 90'));
    assert(text.includes('planning_tokens: 20'));
    assert(text.includes('judge_tokens: 40'));
    assert(text.includes('broker_overhead_tokens: 60'));
    assert(text.includes('broker_overhead_share: 40.0%'));
    assert(text.includes('execution_share: 60.0%'));
    assert(text.includes('role:'));
    assert(text.includes('participant: total_tokens=90'));
    assert(text.includes('secondary:'));
    assert(text.includes('cost_usd: 0.12'));

    const jsonResult = await mod.handleGetUsageSummary({
      runId: 'run-usage-v2',
      breakdown: 'role',
      format: 'json'
    });
    const payload = JSON.parse(jsonResult.content[0].text);
    assert.strictEqual(payload.attribution.executionTokens, 90);
    assert(payload.breakdowns.role.some((entry) => entry.key === 'judge'));

    console.log('✅ MCP usage summary includes role attribution');
  } finally {
    restore();
    await fakeServer.close();
  }
}

run().then(() => {
  console.log('\nMCP usage summary tests passed');
}).catch((error) => {
  console.error('\nMCP usage summary tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
