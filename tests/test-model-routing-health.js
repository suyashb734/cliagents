#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ModelRoutingService } = require('../src/services/model-routing');
const { PersistentSessionManager } = require('../src/tmux/session-manager');

function makeTempDir(prefix) {
  const baseDir = path.join(os.homedir(), '.cliagents-test-tmp');
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

class FakeTmuxClient {
  getHistory() {
    return '';
  }
}

function testModelHealthFallbackAndRecovery() {
  const service = new ModelRoutingService();
  service.resetModelHealth();

  const availableModels = [
    { id: 'openrouter/qwen/qwen3.6-plus' },
    { id: 'opencode-go/glm-5.1' }
  ];

  const baseline = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels
  });
  assert.strictEqual(baseline.selectedModel, 'openrouter/qwen/qwen3.6-plus');
  assert.strictEqual(baseline.selectedFamily, 'qwen');

  service.recordModelFailure({
    adapter: 'opencode-cli',
    model: 'openrouter/qwen/qwen3.6-plus',
    failureClass: 'timeout',
    reason: 'Timed out waiting for completion.'
  });

  const degraded = service.getModelHealth({
    adapter: 'opencode-cli',
    model: 'openrouter/qwen/qwen3.6-plus'
  });
  assert.strictEqual(degraded.degraded, true);
  assert.strictEqual(degraded.failureClass, 'timeout');

  const fallback = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels
  });
  assert.strictEqual(fallback.selectedModel, 'opencode-go/glm-5.1');
  assert.strictEqual(fallback.selectedFamily, 'glm');
  assert.strictEqual(fallback.strategy, 'config-ranked-health-fallback');

  service.recordModelSuccess({
    adapter: 'opencode-cli',
    model: 'openrouter/qwen/qwen3.6-plus'
  });

  const recovered = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels
  });
  assert.strictEqual(recovered.selectedModel, 'openrouter/qwen/qwen3.6-plus');
  assert.strictEqual(recovered.selectedFamily, 'qwen');
}

function testAllCandidatesDegradedFallsBackLastResort() {
  const service = new ModelRoutingService();
  service.resetModelHealth();
  service.recordModelFailure({
    adapter: 'opencode-cli',
    model: 'opencode-go/qwen3.6-plus',
    failureClass: 'timeout',
    reason: 'Timed out waiting for completion.'
  });

  const result = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels: [
      { id: 'opencode-go/qwen3.6-plus' }
    ]
  });

  assert.strictEqual(result.selectedModel, 'opencode-go/qwen3.6-plus');
  assert.strictEqual(result.strategy, 'config-ranked-all-degraded');
}

async function testSessionManagerTimeoutMarksModelDegraded() {
  const tempDir = makeTempDir('cliagents-model-health-');
  const service = new ModelRoutingService();
  service.resetModelHealth();

  const manager = new PersistentSessionManager({
    tmuxClient: new FakeTmuxClient(),
    logDir: path.join(tempDir, 'logs'),
    workDir: tempDir,
    modelRoutingService: service
  });

  manager.terminals.set('term-timeout', {
    terminalId: 'term-timeout',
    adapter: 'opencode-cli',
    model: 'opencode-go/qwen3.6-plus',
    sessionKind: 'subagent',
    role: 'worker',
    sessionName: 'cliagents-test',
    windowName: 'worker-window'
  });

  manager.waitForStatus = async () => {
    const error = new Error("Timeout waiting for status 'completed' after 10ms");
    error.code = 'terminal_timeout';
    error.terminalId = 'term-timeout';
    throw error;
  };

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

  try {
    await assert.rejects(
      manager.waitForCompletion('term-timeout', 10),
      (error) => error?.code === 'terminal_timeout'
    );
  } finally {
    global.setTimeout = realSetTimeout;
  }

  const health = service.getModelHealth({
    adapter: 'opencode-cli',
    model: 'opencode-go/qwen3.6-plus'
  });
  assert.strictEqual(health.degraded, true);
  assert.strictEqual(health.failureClass, 'timeout');
}

async function run() {
  testModelHealthFallbackAndRecovery();
  testAllCandidatesDegradedFallsBackLastResort();
  await testSessionManagerTimeoutMarksModelDegraded();
  console.log('✅ Model health routing degrades failing lanes and recovers after success');
}

run().catch((error) => {
  console.error('Model health routing tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
