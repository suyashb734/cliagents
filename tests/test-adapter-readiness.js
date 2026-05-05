#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { AdapterReadinessService } = require('../src/orchestration/adapter-readiness');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeApiSessionManager() {
  return {
    getAdapterNames() {
      return ['claude-code'];
    },
    getAdapter(name) {
      if (name !== 'claude-code') {
        return null;
      }
      return {
        name,
        async isAvailable() {
          return true;
        },
        getCapabilities() {
          return {
            supportsMultiTurn: true,
            supportsResume: true,
            supportsFilesystemWrite: true
          };
        },
        getAvailableModels() {
          return [{ id: 'default', name: 'Default' }];
        },
        getProviderSummary() {
          return [];
        },
        getContract() {
          return { executionMode: 'direct-session' };
        }
      };
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
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopApp(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function request(baseUrl, method, route, body = null) {
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

async function runServiceAssertions() {
  const rootDir = makeTempDir('cliagents-adapter-readiness-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const apiSessionManager = createFakeApiSessionManager();
  const adapterAuthInspector = () => ({ authenticated: true, reason: null });

  try {
    const columns = db.db.prepare('PRAGMA table_info(adapter_readiness_reports)').all().map((row) => row.name);
    assert(columns.includes('adapter'), 'adapter_readiness_reports should exist');
    assert(columns.includes('checks'), 'checks JSON text column should exist');

    const first = db.upsertAdapterReadinessReport({
      adapter: 'claude-code',
      overall: 'ready',
      ephemeralReady: true,
      collaboratorReady: true,
      checks: { route_launch: true },
      details: ['first'],
      createdAt: 100,
      updatedAt: 100,
      verifiedAt: 100
    });
    const second = db.upsertAdapterReadinessReport({
      adapter: 'claude-code',
      overall: 'not-ready',
      ephemeralReady: false,
      collaboratorReady: false,
      reasonCode: 'live_test_failed',
      details: ['second'],
      updatedAt: 200,
      verifiedAt: 200
    });
    assert.strictEqual(first.createdAt, 100);
    assert.strictEqual(second.createdAt, 100, 'upsert should preserve createdAt');
    assert.strictEqual(second.updatedAt, 200);

    const service = new AdapterReadinessService({
      db,
      apiSessionManager,
      adapterAuthInspector,
      defaultTtlMs: 1000
    });
    const notReady = await service.getAdapterReadiness('claude-code', { now: 250 });
    assert.strictEqual(notReady.effective.ephemeralReady, false);
    assert.strictEqual(notReady.effective.verified, true);
    assert.strictEqual(notReady.effective.source, 'live');

    db.upsertAdapterReadinessReport({
      adapter: 'claude-code',
      overall: 'not-ready',
      ephemeralReady: false,
      collaboratorReady: false,
      verifiedAt: 1,
      staleAfterMs: 10
    });
    const stale = await service.getAdapterReadiness('claude-code', { now: 1000 });
    assert.strictEqual(stale.effective.ephemeralReady, true, 'stale live reports should fall back to runtime readiness');
    assert.strictEqual(stale.effective.verified, false);

    const failingDbService = new AdapterReadinessService({
      db: {
        getAdapterReadinessReport() {
          throw new Error('db locked');
        }
      },
      apiSessionManager,
      adapterAuthInspector
    });
    const fallback = await failingDbService.getAdapterReadiness('claude-code');
    assert.strictEqual(fallback.effective.ephemeralReady, true);
    assert.strictEqual(fallback.warnings[0].code, 'readiness_store_unavailable');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runRouteAssertions() {
  const rootDir = makeTempDir('cliagents-adapter-readiness-routes-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const serverHandle = await startApp({
    db,
    apiSessionManager: createFakeApiSessionManager(),
    adapterAuthInspector: () => ({ authenticated: true, reason: null }),
    sessionManager: {}
  });

  try {
    const listRes = await request(serverHandle.baseUrl, 'GET', '/orchestration/adapters/readiness');
    assert.strictEqual(listRes.status, 200);
    assert(listRes.data.adapters['claude-code'], 'bulk readiness route should not be captured by :adapter route');

    const getRes = await request(serverHandle.baseUrl, 'GET', '/orchestration/adapters/claude-code/readiness');
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.data.adapter, 'claude-code');

    const postRes = await request(serverHandle.baseUrl, 'POST', '/orchestration/adapters/readiness', {
      results: [
        {
          adapter: 'claude-code',
          overall: 'partial',
          ephemeralReady: true,
          collaboratorReady: false,
          reasonCode: 'live_test_partial',
          checks: { route_launch: true, first_output: true, followup_input: true },
          details: ['partial continuity']
        },
        {
          adapter: 'unknown-adapter',
          overall: 'ready'
        }
      ]
    });
    assert.strictEqual(postRes.status, 200);
    assert.strictEqual(postRes.data.accepted, 1);
    assert.strictEqual(postRes.data.rejected, 1);

    const adaptersRes = await request(serverHandle.baseUrl, 'GET', '/orchestration/adapters');
    assert.strictEqual(adaptersRes.status, 200);
    assert(adaptersRes.data.adapters['claude-code'].adapterReadiness);
    assert(adaptersRes.data.adapters['claude-code'].childSessionSupport);
  } finally {
    await stopApp(serverHandle.server);
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function run() {
  await runServiceAssertions();
  await runRouteAssertions();
  console.log('✅ Adapter readiness service and routes work');
}

run().catch((error) => {
  console.error('\nAdapter readiness tests failed:', error);
  process.exit(1);
});
