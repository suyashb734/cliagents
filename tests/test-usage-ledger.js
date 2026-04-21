#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', createOrchestrationRouter({
    adapterAuthInspector() {
      return {
        authenticated: true,
        reason: 'test default override'
      };
    },
    ...context
  }));

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

async function request(baseUrl, route) {
  const response = await fetch(baseUrl + route);
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

async function run() {
  const rootDir = makeTempDir('cliagents-usage-ledger-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  let appHandle = null;

  try {
    db.registerTerminal(
      'usage-root-main',
      'cliagents-usage-root',
      '0',
      'codex-cli',
      'main_codex-cli',
      'main',
      rootDir,
      path.join(rootDir, 'usage-root.log'),
      {
        rootSessionId: 'root-usage-1',
        sessionKind: 'main',
        originClient: 'codex'
      }
    );
    db.registerTerminal(
      'usage-child-1',
      'cliagents-usage-root',
      '1',
      'opencode-cli',
      'implement_opencode-cli',
      'worker',
      rootDir,
      path.join(rootDir, 'usage-child.log'),
      {
        rootSessionId: 'root-usage-1',
        parentSessionId: 'root-usage-1',
        sessionKind: 'subagent',
        originClient: 'codex'
      }
    );

    db.addMessage('usage-root-main', 'user', 'Plan the work.', {
      metadata: {
        inputTokens: 999,
        outputTokens: 999
      }
    });
    db.addMessage('usage-root-main', 'assistant', 'Planned the work.', {
      metadata: {
        adapter: 'codex-cli',
        provider: 'openai',
        model: 'o4-mini',
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 10,
        reasoningTokens: 5,
        totalTokens: 170,
        costUsd: 0.42,
        durationMs: 3210,
        sourceConfidence: 'provider_reported',
        runId: 'run-usage-1'
      }
    });
    db.addMessage('usage-child-1', 'assistant', 'Implemented the first slice.', {
      metadata: {
        adapter: 'opencode-cli',
        provider: 'openrouter',
        model: 'openrouter/qwen/qwen3.6-plus',
        inputTokens: 80,
        outputTokens: 60,
        totalTokens: 140,
        durationMs: 2800,
        sourceConfidence: 'estimated',
        runId: 'run-usage-1',
        participantId: 'implementer'
      }
    });

    const rootRecords = db.listUsageRecords({ rootSessionId: 'root-usage-1' });
    assert.strictEqual(rootRecords.length, 2, 'Only assistant messages with usage metadata should emit usage records');
    const rootSummary = db.summarizeUsage({ rootSessionId: 'root-usage-1' });
    assert.strictEqual(rootSummary.inputTokens, 200);
    assert.strictEqual(rootSummary.outputTokens, 105);
    assert.strictEqual(rootSummary.totalTokens, 310);
    assert.strictEqual(rootSummary.cachedInputTokens, 10);
    assert.strictEqual(rootSummary.reasoningTokens, 5);
    assert.strictEqual(rootSummary.recordCount, 2);

    db.deleteTerminal('usage-root-main');
    db.deleteTerminal('usage-child-1');
    const persistedAfterDelete = db.listUsageRecords({ rootSessionId: 'root-usage-1' });
    assert.strictEqual(persistedAfterDelete.length, 2, 'Usage records should survive terminal deletion');

    appHandle = await startApp({
      sessionManager: {
        async createTerminal() {
          throw new Error('not used');
        },
        async sendInput() {
          throw new Error('not used');
        }
      },
      apiSessionManager: {
        getAdapterNames() {
          return [];
        },
        getAdapter() {
          return null;
        }
      },
      db
    });

    const rootUsageRes = await request(
      appHandle.baseUrl,
      '/orchestration/usage/roots/root-usage-1?breakdown=model,provider'
    );
    assert.strictEqual(rootUsageRes.status, 200);
    assert.strictEqual(rootUsageRes.data.summary.totalTokens, 310);
    assert.strictEqual(rootUsageRes.data.summary.costUsd, 0.42);
    assert(rootUsageRes.data.breakdowns.model.some((entry) => entry.key === 'o4-mini'));
    assert(rootUsageRes.data.breakdowns.provider.some((entry) => entry.key === 'openrouter'));

    const runUsageRes = await request(
      appHandle.baseUrl,
      '/orchestration/usage/runs/run-usage-1?breakdown=adapter'
    );
    assert.strictEqual(runUsageRes.status, 200);
    assert.strictEqual(runUsageRes.data.summary.recordCount, 2);
    assert(runUsageRes.data.breakdowns.adapter.some((entry) => entry.key === 'codex-cli'));
    assert(runUsageRes.data.breakdowns.adapter.some((entry) => entry.key === 'opencode-cli'));

    const terminalUsageRes = await request(
      appHandle.baseUrl,
      '/orchestration/usage/terminals/usage-child-1?breakdown=model'
    );
    assert.strictEqual(terminalUsageRes.status, 200);
    assert.strictEqual(terminalUsageRes.data.records.length, 1);
    assert.strictEqual(terminalUsageRes.data.records[0].participant_id, 'implementer');
    assert.strictEqual(terminalUsageRes.data.summary.totalTokens, 140);
    assert.strictEqual(terminalUsageRes.data.breakdowns.model[0].key, 'openrouter/qwen/qwen3.6-plus');

    console.log('✅ Usage ledger records assistant usage, aggregates by root/run/terminal, and survives terminal deletion');
  } finally {
    if (appHandle) {
      await stopApp(appHandle.server);
    }
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('\nUsage ledger tests passed');
}).catch((error) => {
  console.error('\nUsage ledger tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
