#!/usr/bin/env node

'use strict';

const assert = require('assert');

const {
  RUNTIME_HOSTS,
  RUNTIME_FIDELITY,
  SESSION_CONTROL_MODES,
  normalizeRuntimeHost,
  normalizeRuntimeFidelity,
  normalizeSessionControlMode,
  normalizeRuntimeCapabilities,
  resolveRuntimeHostMetadata,
  serializeRuntimeCapabilities
} = require('../src/runtime/host-model');

function assertSortedEqual(actual, expected, label) {
  assert.deepStrictEqual([...actual].sort(), [...expected].sort(), label);
}

function run() {
  assert.strictEqual(normalizeRuntimeHost('TMUX'), RUNTIME_HOSTS.TMUX);
  assert.strictEqual(normalizeRuntimeHost(' direct_pty '), RUNTIME_HOSTS.DIRECT_PTY);
  assert.strictEqual(normalizeRuntimeHost('invalid-host'), RUNTIME_HOSTS.TMUX);
  assert.strictEqual(normalizeRuntimeHost('invalid-host', RUNTIME_HOSTS.ADOPTED), RUNTIME_HOSTS.ADOPTED);

  assert.strictEqual(normalizeRuntimeFidelity('MANAGED'), RUNTIME_FIDELITY.MANAGED);
  assert.strictEqual(normalizeRuntimeFidelity(' adopted-partial '), RUNTIME_FIDELITY.ADOPTED_PARTIAL);
  assert.strictEqual(normalizeRuntimeFidelity('invalid-fidelity'), RUNTIME_FIDELITY.MANAGED);
  assert.strictEqual(normalizeSessionControlMode('OBSERVER'), SESSION_CONTROL_MODES.OBSERVER);
  assert.strictEqual(normalizeSessionControlMode(' exclusive '), SESSION_CONTROL_MODES.EXCLUSIVE);
  assert.strictEqual(normalizeSessionControlMode('bad-mode'), SESSION_CONTROL_MODES.OPERATOR);

  assertSortedEqual(
    normalizeRuntimeCapabilities(null, RUNTIME_HOSTS.TMUX),
    ['approve_permission', 'detach', 'kill', 'multi_viewer', 'read_output', 'resize', 'send_input', 'stream_events'],
    'tmux default capabilities'
  );
  assertSortedEqual(
    normalizeRuntimeCapabilities(null, RUNTIME_HOSTS.ADOPTED),
    ['inspect_history', 'stream_events'],
    'adopted default capabilities'
  );
  assertSortedEqual(
    normalizeRuntimeCapabilities('["send_input","send_input"," read_output ",""]', RUNTIME_HOSTS.ADOPTED),
    ['read_output', 'send_input'],
    'explicit capabilities are normalized and de-duplicated'
  );
  assertSortedEqual(
    normalizeRuntimeCapabilities('not json', RUNTIME_HOSTS.DIRECT_PTY),
    ['approve_permission', 'read_output', 'resize', 'send_input', 'stream_events'],
    'invalid capability JSON falls back by host'
  );

  const tmuxMetadata = resolveRuntimeHostMetadata({
    terminalId: 'term-1',
    sessionName: 'cliagents-root',
    windowName: '0'
  });
  assert.strictEqual(tmuxMetadata.runtimeHost, RUNTIME_HOSTS.TMUX);
  assert.strictEqual(tmuxMetadata.runtimeId, 'cliagents-root:0');
  assert.strictEqual(tmuxMetadata.runtimeFidelity, RUNTIME_FIDELITY.MANAGED);
  assert(tmuxMetadata.runtimeCapabilities.includes('send_input'));
  assert.deepStrictEqual(tmuxMetadata.runtime, {
    host: RUNTIME_HOSTS.TMUX,
    id: 'cliagents-root:0',
    capabilities: tmuxMetadata.runtimeCapabilities,
    fidelity: RUNTIME_FIDELITY.MANAGED
  });

  const adoptedMetadata = resolveRuntimeHostMetadata({
    terminal_id: 'imported-root',
    adopted_at: '2026-05-06T10:00:00.000Z',
    session_metadata: JSON.stringify({
      runtimeHost: RUNTIME_HOSTS.ADOPTED,
      runtimeCapabilities: ['inspect_history', 'stream_events']
    })
  });
  assert.strictEqual(adoptedMetadata.runtimeHost, RUNTIME_HOSTS.ADOPTED);
  assert.strictEqual(adoptedMetadata.runtimeId, 'imported-root');
  assert.strictEqual(adoptedMetadata.runtimeFidelity, RUNTIME_FIDELITY.ADOPTED_PARTIAL);
  assertSortedEqual(
    adoptedMetadata.runtimeCapabilities,
    ['inspect_history', 'stream_events'],
    'metadata JSON can supply adopted capabilities'
  );

  const overrideMetadata = resolveRuntimeHostMetadata(
    {
      runtime_host: RUNTIME_HOSTS.TMUX,
      runtime_id: 'old-runtime',
      runtime_fidelity: RUNTIME_FIDELITY.MANAGED,
      runtime_capabilities: JSON.stringify(['send_input'])
    },
    {
      runtimeHost: RUNTIME_HOSTS.CONTAINER,
      runtimeId: 'container-1',
      runtimeFidelity: RUNTIME_FIDELITY.NATIVE_VISIBLE,
      runtimeCapabilities: ['stream_events', 'kill']
    }
  );
  assert.strictEqual(overrideMetadata.runtimeHost, RUNTIME_HOSTS.CONTAINER);
  assert.strictEqual(overrideMetadata.runtimeId, 'container-1');
  assert.strictEqual(overrideMetadata.runtimeFidelity, RUNTIME_FIDELITY.NATIVE_VISIBLE);
  assertSortedEqual(overrideMetadata.runtimeCapabilities, ['kill', 'stream_events'], 'overrides win');

  assert.strictEqual(
    serializeRuntimeCapabilities(['send_input', 'send_input', 'read_output'], RUNTIME_HOSTS.TMUX),
    '["read_output","send_input"]'
  );

  console.log('✅ Runtime host model normalizes hosts, fidelity, session control, capabilities, metadata, and overrides');
}

try {
  run();
} catch (error) {
  console.error('\nRuntime host model tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
