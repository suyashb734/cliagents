#!/usr/bin/env node

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const TEST_FILES = [
  'test-adapter-contract.js',
  'test-adapter-auth.js',
  'test-adapter-conformance-runtime.js',
  'test-cli-commands.js',
  'test-managed-root-launch.js',
  'test-managed-root-recovery.js',
  'test-gemini-model-fallback.js',
  'test-qwen-cli.js',
  'test-opencode-cli.js',
  'test-status-detection.js',
  'test-handoff-init-prompts.js',
  'test-db-migrations.js',
  'test-usage-ledger.js',
  'test-run-ledger-schema.js',
  'test-session-control-plane-schema.js',
  'test-session-control-plane-runtime.js',
  'test-direct-session-control-plane.js',
  'test-session-manager-recovery.js',
  'test-server-orphan-prune.js',
  'test-session-reuse.js',
  'test-task-router-session-reuse.js',
  'test-root-session-monitor.js',
  'test-run-ledger-service.js',
  'test-run-ledger-partial-runs.js',
  'test-discussion-replay-routes.js',
  'test-discussion-runner.js',
  'test-provider-sessions-and-rooms.js',
  'test-room-continuity.js',
  'test-review-protocols.js',
  'test-workflow-time-budgets.js',
  'test-persistence-v1-slice-b.js',
  'test-review-routes.js',
  'test-run-ledger-routes.js',
  'test-run-ledger-ui.js',
  'test-ask-route-options.js',
  'test-gemini-resume-resilience.js',
  'test-console-ui.js',
  'test-openai-compat.js',
  'test-mcp-delegate-task.js',
  'test-mcp-batch-status.js',
  'test-mcp-usage-summary.js',
  'test-mcp-run-ledger-tools.js',
  'test-mcp-root-session-tools.js',
  'test-orchestration-introspection-routes.js',
  'test-runtime-consistency.js',
  'test-tmux-client.js'
];

async function runTest(testFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, testFile)], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env
    });

    child.on('exit', (code, signal) => {
      resolve({
        testFile,
        code: typeof code === 'number' ? code : 1,
        signal: signal || null
      });
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('   Focused Broker Surface Test Suite');
  console.log('═══════════════════════════════════════════');

  const failures = [];

  for (const testFile of TEST_FILES) {
    console.log(`\n▶ Running ${testFile}`);
    const result = await runTest(testFile);
    if (result.code !== 0) {
      failures.push(result);
      console.log(`✗ ${testFile} failed with exit code ${result.code}${result.signal ? ` (signal: ${result.signal})` : ''}`);
    } else {
      console.log(`✓ ${testFile} passed`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  if (failures.length > 0) {
    console.log(`Results: ${TEST_FILES.length - failures.length} passed, ${failures.length} failed`);
    failures.forEach((failure) => {
      console.log(`- ${failure.testFile}: exit ${failure.code}${failure.signal ? `, signal ${failure.signal}` : ''}`);
    });
    console.log('═══════════════════════════════════════════');
    process.exit(1);
  }

  console.log(`Results: ${TEST_FILES.length} passed, 0 failed`);
  console.log('═══════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Focused suite failed:', error);
  process.exit(1);
});
