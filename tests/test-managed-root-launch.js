#!/usr/bin/env node

'use strict';

const assert = require('assert');
const {
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  buildManagedRootExternalSessionRef,
  buildManagedRootBootstrapPrompt,
  composeManagedRootSystemPrompt
} = require('../src/orchestration/managed-root-launch');

function run() {
  assert.strictEqual(normalizeManagedRootAdapter('codex'), 'codex-cli');
  assert.strictEqual(normalizeManagedRootAdapter('claude'), 'claude-code');
  assert.strictEqual(normalizeManagedRootAdapter('claude-code'), 'claude-code');
  assert.throws(
    () => normalizeManagedRootAdapter('unknown-root'),
    /Unsupported managed root adapter/
  );

  assert.strictEqual(inferManagedRootOriginClient('codex'), 'codex');
  assert.strictEqual(inferManagedRootOriginClient('claude-code'), 'claude');
  assert.strictEqual(inferManagedRootOriginClient('opencode-cli'), 'opencode');

  assert.strictEqual(
    buildManagedRootExternalSessionRef('codex', 'codex:thread:abc'),
    'codex:thread:abc'
  );
  const generated = buildManagedRootExternalSessionRef('claude');
  assert(generated.startsWith('claude:managed:'), `Unexpected generated session ref: ${generated}`);

  const bootstrap = buildManagedRootBootstrapPrompt();
  assert(bootstrap.includes('list_agents'));
  assert(bootstrap.includes('list_models'));
  assert(bootstrap.includes('recommend_model'));
  assert(bootstrap.includes('Do not launch another root'));
  assert(bootstrap.includes('reply_to_terminal'));
  assert(bootstrap.includes('list_child_sessions'));
  assert(bootstrap.includes('get_root_session_status'));
  assert(bootstrap.includes('delegate_task'));
  assert(bootstrap.includes('terminalId'));
  assert(bootstrap.includes('sessionLabel'));
  assert(bootstrap.includes('reuse hint'));
  assert(bootstrap.toLowerCase().includes('enumerat'));

  const composed = composeManagedRootSystemPrompt('Return concise answers.', {
    profile: 'planning-root'
  });
  assert(composed.includes('planning'));
  assert(composed.includes('Return concise answers.'));

  console.log('✅ Managed root launch helpers normalize adapters and root identity correctly');
}

try {
  run();
} catch (error) {
  console.error('Managed root launch tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
