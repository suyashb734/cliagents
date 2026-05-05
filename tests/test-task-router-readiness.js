#!/usr/bin/env node

'use strict';

const assert = require('assert');

const { TaskRouter } = require('../src/orchestration/task-router');

function createFakeSessionManager() {
  return {
    createCalls: [],
    async createTerminal(options = {}) {
      this.createCalls.push(options);
      return { terminalId: 'term-ready', reused: false, reuseReason: null };
    },
    async sendInput() {}
  };
}

function createFakeApiSessionManager() {
  return {
    getAdapter(name) {
      if (name !== 'claude-code') {
        return null;
      }
      return {
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
          return [{ id: 'default' }];
        },
        getProviderSummary() {
          return [];
        },
        getContract() {
          return {};
        }
      };
    }
  };
}

function createReadinessService(childSessionSupport) {
  return {
    async getAdapterReadiness(adapter) {
      return {
        adapter,
        effective: {
          available: true,
          authenticated: true,
          ephemeralReady: childSessionSupport.ephemeralReady,
          collaboratorReady: childSessionSupport.collaboratorReady,
          continuityMode: childSessionSupport.continuityMode || 'stateless',
          reason: childSessionSupport.reason || null,
          verified: true,
          source: 'live'
        },
        childSessionSupport
      };
    }
  };
}

async function assertRejectsMessage(promise, expected) {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    assert(
      String(error.message || '').includes(expected),
      `Expected "${expected}" in "${error.message}"`
    );
  }
  assert.strictEqual(rejected, true, 'Expected promise to reject');
}

async function run() {
  const apiSessionManager = createFakeApiSessionManager();
  const adapterAuthInspector = () => ({ authenticated: true, reason: null });

  const notReadyManager = createFakeSessionManager();
  const notReadyRouter = new TaskRouter(notReadyManager, {
    apiSessionManager,
    adapterAuthInspector,
    adapterReadinessService: createReadinessService({
      ephemeralReady: false,
      collaboratorReady: false,
      continuityMode: 'stateless',
      reason: 'live test failed'
    })
  });

  await assertRejectsMessage(
    notReadyRouter.routeTask('Review this patch.', {
      forceRole: 'review',
      forceAdapter: 'claude-code'
    }),
    'not child-session ready'
  );
  assert.strictEqual(notReadyManager.createCalls.length, 0, 'not-ready adapters should fail before terminal creation');

  const partialManager = createFakeSessionManager();
  const partialRouter = new TaskRouter(partialManager, {
    apiSessionManager,
    adapterAuthInspector,
    adapterReadinessService: createReadinessService({
      ephemeralReady: true,
      collaboratorReady: false,
      continuityMode: 'stateless',
      reason: 'continuity not verified'
    })
  });

  await assertRejectsMessage(
    partialRouter.routeTask('Continue as a collaborator.', {
      forceRole: 'review',
      forceAdapter: 'claude-code',
      sessionKind: 'collaborator'
    }),
    'not collaborator-ready'
  );
  assert.strictEqual(partialManager.createCalls.length, 0, 'non-collaborator-ready adapters should fail before terminal creation');

  const readyManager = createFakeSessionManager();
  const readyRouter = new TaskRouter(readyManager, {
    apiSessionManager,
    adapterAuthInspector,
    adapterReadinessService: createReadinessService({
      ephemeralReady: true,
      collaboratorReady: true,
      continuityMode: 'provider_resume'
    })
  });

  const result = await readyRouter.routeTask('Review this patch.', {
    forceRole: 'review',
    forceAdapter: 'claude-code'
  });
  assert.strictEqual(result.terminalId, 'term-ready');
  assert.strictEqual(readyManager.createCalls.length, 1);
  assert.strictEqual(result.runtimeChildSessionSupport.collaboratorReady, true);

  console.log('✅ TaskRouter gates routing with effective adapter readiness');
}

run().catch((error) => {
  console.error('\nTask router readiness tests failed:', error);
  process.exit(1);
});
