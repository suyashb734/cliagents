#!/usr/bin/env node

'use strict';

const assert = require('assert');

process.env.CLIAGENTS_ROUTE_RETRY_DELAY_MAX_MS = '25';

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

function createRetrySessionManager() {
  return {
    createCalls: [],
    sendCalls: [],
    destroyCalls: [],
    async createTerminal(options = {}) {
      this.createCalls.push(options);
      const index = this.createCalls.length;
      return {
        terminalId: `term-retry-${index}`,
        reused: false,
        reuseReason: null
      };
    },
    async sendInput(terminalId, message) {
      this.sendCalls.push({ terminalId, message });
      if (this.sendCalls.length === 1) {
        const error = new Error(`Terminal ${terminalId} is busy (processing).`);
        error.code = 'terminal_busy';
        error.statusCode = 409;
        error.retryAfterMs = 2000;
        throw error;
      }
    },
    async destroyTerminal(terminalId) {
      this.destroyCalls.push(terminalId);
      return true;
    }
  };
}

function createNonBusyConflictSessionManager() {
  return {
    createCalls: [],
    sendCalls: [],
    async createTerminal(options = {}) {
      this.createCalls.push(options);
      return { terminalId: 'term-conflict-1', reused: false, reuseReason: null };
    },
    async sendInput(terminalId, message) {
      this.sendCalls.push({ terminalId, message });
      const error = new Error('Root session binding conflict.');
      error.code = 'root_binding_conflict';
      error.statusCode = 409;
      error.retryAfterMs = 1;
      throw error;
    }
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
      sessionKind: 'collaborator',
      sessionLabel: 'security-review-partner'
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

  const retryManager = createRetrySessionManager();
  const retryRouter = new TaskRouter(retryManager, {
    apiSessionManager,
    adapterAuthInspector,
    adapterReadinessService: createReadinessService({
      ephemeralReady: true,
      collaboratorReady: true,
      continuityMode: 'provider_resume'
    })
  });

  const retryStart = Date.now();
  const retried = await retryRouter.routeTask('Review this patch with transient terminal contention.', {
    forceRole: 'review',
    forceAdapter: 'claude-code',
    preferReuse: true
  });
  const retryElapsed = Date.now() - retryStart;
  assert.strictEqual(retried.terminalId, 'term-retry-2');
  assert.strictEqual(retried.routeAttempts, 2);
  assert.strictEqual(retried.routeRetried, true);
  assert.strictEqual(retried.routeRetryReason, 'terminal_busy');
  assert.strictEqual(retryManager.createCalls.length, 2, 'retry path should create a second terminal');
  assert.strictEqual(retryManager.sendCalls.length, 2, 'retry path should retry sendInput once');
  assert.deepStrictEqual(retryManager.destroyCalls, ['term-retry-1'], 'failed first attempt terminal should be cleaned up');
  assert.strictEqual(retryManager.createCalls[0].preferReuse, true);
  assert.strictEqual(retryManager.createCalls[1].preferReuse, false);
  assert.strictEqual(retryManager.createCalls[1].forceFreshSession, true);
  assert(retryElapsed < 500, `Retry delay should be capped; observed ${retryElapsed}ms`);

  const conflictManager = createNonBusyConflictSessionManager();
  const conflictRouter = new TaskRouter(conflictManager, {
    apiSessionManager,
    adapterAuthInspector,
    adapterReadinessService: createReadinessService({
      ephemeralReady: true,
      collaboratorReady: true,
      continuityMode: 'provider_resume'
    })
  });

  await assert.rejects(
    () => conflictRouter.routeTask('Review this patch with a non-busy conflict.', {
      forceRole: 'review',
      forceAdapter: 'claude-code',
      preferReuse: true
    }),
    /Root session binding conflict/
  );
  assert.strictEqual(conflictManager.createCalls.length, 1, 'non-busy conflicts should not retry routing');
  assert.strictEqual(conflictManager.sendCalls.length, 1, 'non-busy conflicts should surface immediately');

  console.log('✅ TaskRouter gates routing with effective adapter readiness');
}

run().catch((error) => {
  console.error('\nTask router readiness tests failed:', error);
  process.exit(1);
});
