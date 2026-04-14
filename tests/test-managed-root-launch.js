#!/usr/bin/env node

'use strict';

const assert = require('assert');
const {
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  buildManagedRootExternalSessionRef
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

  console.log('✅ Managed root launch helpers normalize adapters and root identity correctly');
}

try {
  run();
} catch (error) {
  console.error('Managed root launch tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
