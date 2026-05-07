/**
 * Tests for TmuxClient
 *
 * Tests the tmux wrapper including security validations.
 * Run with: node tests/test-tmux-client.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Import the TmuxClient
const TmuxClient = require('../src/tmux/client');

let client;
let testSessionName;
const TEST_PREFIX = 'test-';

async function setup() {
  console.log('\n🔧 Setting up TmuxClient tests...');
  client = new TmuxClient({
    logDir: path.join(process.cwd(), 'logs', 'test')
  });
  testSessionName = `${TEST_PREFIX}${Date.now()}`;
}

async function cleanup() {
  console.log('\n🧹 Cleaning up...');
  // Kill any test sessions
  try {
    const sessions = client.listSessions(TEST_PREFIX);
    for (const session of sessions) {
      client.killSession(session.name);
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

// Test: Name validation rejects dangerous input
async function testNameValidation() {
  console.log('\n📝 Test: Name validation rejects dangerous input');

  const dangerousNames = [
    'test; rm -rf /',
    'test$(whoami)',
    'test`id`',
    'test|cat /etc/passwd',
    'test\necho pwned',
    '../../../etc/passwd',
    'test"injection',
    "test'injection",
  ];

  for (const name of dangerousNames) {
    try {
      client._validateName(name, 'session');
      assert.fail(`Should have rejected: ${name}`);
    } catch (error) {
      assert(error.message.includes('Invalid'), `Wrong error for: ${name}`);
    }
  }

  console.log('  ✅ All dangerous names rejected');
}

// Test: Name validation accepts safe input
async function testNameValidationSafe() {
  console.log('\n📝 Test: Name validation accepts safe input');

  const safeNames = [
    'test-session',
    'my_session_123',
    'ClaudeCode-abc123',
    'session-2024',
  ];

  for (const name of safeNames) {
    try {
      client._validateName(name, 'session');
    } catch (error) {
      assert.fail(`Should have accepted: ${name}`);
    }
  }

  console.log('  ✅ All safe names accepted');
}

// Test: sendKeys writes single-line input through literal tmux mode
async function testSendKeysLiteralMode() {
  console.log('\n📝 Test: sendKeys uses tmux literal mode for single-line input');

  const stubClient = Object.create(TmuxClient.prototype);
  const calls = [];
  stubClient.logDir = path.join(process.cwd(), 'logs', 'test');
  stubClient._exec = (args) => {
    calls.push(args);
    return '';
  };

  stubClient.sendKeys('test-session', 'test-window', 'line1; $(whoami)', false);

  assert.deepStrictEqual(calls, [[
    'send-keys',
    '-t',
    'test-session:test-window',
    '-l',
    'line1; $(whoami)'
  ]]);

  console.log('  ✅ sendKeys writes single-line input via literal mode');
}

// Test: sendKeys writes newline-containing input through bracketed paste buffer
async function testSendKeysMultilinePasteBuffer() {
  console.log('\n📝 Test: sendKeys uses tmux paste-buffer for multiline input');

  const stubClient = Object.create(TmuxClient.prototype);
  const calls = [];
  stubClient.logDir = path.join(process.cwd(), 'logs', 'test');
  fs.mkdirSync(stubClient.logDir, { recursive: true });
  stubClient._exec = (args) => {
    calls.push(args);
    return '';
  };

  stubClient.sendKeys('test-session', 'test-window', 'line1\nline2; $(whoami)', false);

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0][0], 'load-buffer');
  assert.strictEqual(calls[0][1], '-b');
  assert(calls[0][2].startsWith('cli-'), `Expected generated buffer name, got ${calls[0][2]}`);
  assert(calls[0][3].includes('.tmux-input-'), `Expected temp input path, got ${calls[0][3]}`);
  assert.deepStrictEqual(calls[1], [
    'paste-buffer',
    '-t',
    'test-session:test-window',
    '-b',
    calls[0][2],
    '-d',
    '-p'
  ]);

  console.log('  ✅ sendKeys writes multiline input via bracketed paste buffer');
}

// Test: Shell escaping for single quotes
async function testShellEscaping() {
  console.log('\n📝 Test: Shell escaping for single quotes');

  const testCases = [
    { input: 'simple', expected: 'simple' },
    { input: "it's a test", expected: "it'\\''s a test" },
    { input: "multiple'quotes'here", expected: "multiple'\\''quotes'\\''here" },
  ];

  for (const tc of testCases) {
    const escaped = client._escapeForShell(tc.input);
    assert.strictEqual(escaped, tc.expected,
      `Escaping "${tc.input}" should be "${tc.expected}", got: "${escaped}"`);
  }

  console.log('  ✅ Shell escaping works correctly');
}

// Test: Session creation and destruction (if tmux available)
async function testSessionLifecycle() {
  console.log('\n📝 Test: Session creation and destruction');

  const windowName = 'test-window';
  const terminalId = 'abcd1234';

  // Create session
  client.createSession(testSessionName, windowName, terminalId);
  assert(client.sessionExists(testSessionName), 'Session should exist after creation');

  // List sessions
  const sessions = client.listSessions(TEST_PREFIX);
  assert(sessions.some(s => s.name === testSessionName), 'Session should be in list');

  // Kill session
  client.killSession(testSessionName);
  assert(!client.sessionExists(testSessionName), 'Session should not exist after kill');

  console.log('  ✅ Session lifecycle works correctly');
}

// Test: Session creation can clear inherited environment variables
async function testSessionEnvironmentRemoval() {
  console.log('\n📝 Test: Session creation clears inherited env vars when requested');

  const sessionName = `${TEST_PREFIX}${Date.now()}-env`;
  const windowName = 'env-window';
  const terminalId = 'env12345';

  process.env.NO_COLOR = '1';
  process.env.CI = 'true';

  client.createSession(sessionName, windowName, terminalId, {
    env: {
      NO_COLOR: null,
      CI: null
    }
  });

  const envOutput = client._exec(['show-environment', '-t', sessionName], {
    silent: true
  });

  assert(!envOutput.includes('NO_COLOR='), `Expected NO_COLOR to be removed, got: ${envOutput}`);
  assert(!envOutput.includes('CI='), `Expected CI to be removed, got: ${envOutput}`);

  client.killSession(sessionName);
  console.log('  ✅ Session environment removal works correctly');
}

// Test: tmux capability bootstrap enables RGB-friendly terminal features
async function testPreferredServerOptionsBootstrap() {
  console.log('\n📝 Test: tmux capability bootstrap enables preferred server options');

  const stubClient = Object.create(TmuxClient.prototype);
  stubClient.socketPath = `/tmp/cliagents-test-${Date.now()}.sock`;

  const currentValues = {
    'default-terminal': '',
    'terminal-features': '',
    'terminal-overrides': ''
  };
  const executed = [];

  stubClient._exec = (args, options = {}) => {
    executed.push(args.join(' '));
    if (args[0] === 'show-options' && args[1] === '-gv') {
      return currentValues[args[2]] || '';
    }
    if (args[0] === 'set-option') {
      return '';
    }
    if (options.ignoreErrors) {
      return '';
    }
    throw new Error(`Unexpected tmux call: ${args.join(' ')}`);
  };

  stubClient._ensurePreferredServerOptions();

  assert(executed.some((entry) => entry.includes('set-option -g default-terminal tmux-256color')),
    'Expected default-terminal bootstrap');
  assert(executed.some((entry) => entry.includes('set-option -ag terminal-features')),
    'Expected terminal-features RGB bootstrap');
  assert(executed.some((entry) => entry.includes('set-option -ag terminal-overrides ,*:Tc')),
    'Expected terminal-overrides Tc bootstrap');
  assert(executed.some((entry) => entry.includes('set-option -g focus-events on')),
    'Expected focus-events bootstrap');
  assert(executed.some((entry) => entry.includes('set-option -g extended-keys on')),
    'Expected extended-keys bootstrap');
  assert(executed.some((entry) => entry.includes('set-option -g assume-paste-time 10')),
    'Expected assume-paste-time bootstrap');

  console.log('  ✅ tmux capability bootstrap requests RGB-friendly options');
}

async function testInlineBootstrapOnFirstSessionCreate() {
  console.log('\n📝 Test: first session creation bootstraps tmux options inline');

  const stubClient = Object.create(TmuxClient.prototype);
  stubClient.socketPath = `/tmp/cliagents-inline-${Date.now()}.sock`;
  stubClient.logDir = path.join(process.cwd(), 'logs', 'test');
  stubClient._validateName = () => {};
  stubClient.sessionExists = () => false;
  stubClient._ensurePreferredServerOptions = () => false;

  const executed = [];
  stubClient._exec = (args) => {
    executed.push(args);
    return '';
  };

  stubClient.createSession('inline-session', 'main', 'term-inline', {
    workingDir: process.cwd()
  });

  const initialCommand = executed[0].join(' ');
  assert(initialCommand.includes('set-option -g default-terminal tmux-256color ;'),
    'Expected inline default-terminal bootstrap before first new-session');
  assert(initialCommand.includes('set-option -ag terminal-features'),
    'Expected inline terminal-features bootstrap before first new-session');
  assert(initialCommand.includes('set-option -ag terminal-overrides ,*:Tc'),
    'Expected inline terminal-overrides bootstrap before first new-session');
  assert(initialCommand.includes('set-option -g focus-events on ;'),
    'Expected inline focus-events bootstrap before first new-session');
  assert(initialCommand.includes('set-option -g extended-keys on ;'),
    'Expected inline extended-keys bootstrap before first new-session');
  assert(initialCommand.includes('set-option -g assume-paste-time 10 ; new-session -d -s inline-session -n main'),
    'Expected inline assume-paste-time bootstrap immediately before new-session');

  console.log('  ✅ first-session bootstrap is applied inline');
}

async function testRespawnPaneCommand() {
  console.log('\n📝 Test: respawnPane replaces pane process with the requested command');

  const stubClient = Object.create(TmuxClient.prototype);
  stubClient._validateName = () => {};

  const executed = [];
  stubClient._exec = (args) => {
    executed.push(args);
    return '';
  };

  stubClient.respawnPane('respawn-session', 'main', 'exec codex --dangerously-bypass-approvals-and-sandbox', {
    workingDir: '/tmp/cliagents'
  });

  assert.deepStrictEqual(executed[0], [
    'respawn-pane',
    '-k',
    '-t',
    'respawn-session:main',
    '-c',
    '/tmp/cliagents',
    'exec codex --dangerously-bypass-approvals-and-sandbox'
  ]);

  console.log('  ✅ respawnPane builds the expected tmux command');
}

async function testSetSessionStatusVisible() {
  console.log('\n📝 Test: setSessionStatusVisible toggles tmux session status');

  const stubClient = Object.create(TmuxClient.prototype);
  stubClient._validateName = () => {};

  const executed = [];
  stubClient._exec = (args) => {
    executed.push(args);
    return '';
  };

  stubClient.setSessionStatusVisible('status-session', false);
  stubClient.setSessionStatusVisible('status-session', true);

  assert.deepStrictEqual(executed[0], [
    'set-option',
    '-t',
    'status-session',
    'status',
    'off'
  ]);
  assert.deepStrictEqual(executed[1], [
    'set-option',
    '-t',
    'status-session',
    'status',
    'on'
  ]);

  console.log('  ✅ setSessionStatusVisible builds the expected tmux commands');
}

// Test: Dangerous session name rejected at creation
async function testDangerousSessionCreation() {
  console.log('\n📝 Test: Dangerous session name rejected at creation');

  try {
    client.createSession('test; rm -rf /', 'window', 'abc123');
    assert.fail('Should have rejected dangerous session name');
  } catch (error) {
    assert(error.message.includes('Invalid'), 'Should throw validation error');
  }

  console.log('  ✅ Dangerous session name rejected');
}

// ─── Regression tests: noisy missing-session error suppression ───────────────

// Test: _isMissingTargetError correctly classifies tmux errors
async function testIsMissingTargetError() {
  console.log('\n📝 Test: _isMissingTargetError classifies missing-target errors');

  const missingErrors = [
    new Error("tmux command failed (exit code 1): can't find session: cliagents-abc123"),
    new Error("tmux command failed (exit code 1): no such session"),
    new Error("tmux command failed (exit code 1): can't find window: main"),
    new Error("tmux command failed (exit code 1): no such window"),
    new Error("tmux command failed (exit code 1): can't find target: session:window"),
    new Error("tmux command failed (exit code 1): session not found"),
    new Error("tmux command failed (exit code 1): window not found"),
  ];

  const unexpectedErrors = [
    new Error('permission denied'),
    new Error('tmux server not running'),
    new Error('protocol error'),
    new Error(''),
  ];

  for (const error of missingErrors) {
    assert(
      client._isMissingTargetError(error),
      `Should classify as missing target: "${error.message}"`
    );
  }

  for (const error of unexpectedErrors) {
    assert(
      !client._isMissingTargetError(error),
      `Should NOT classify as missing target: "${error.message}"`
    );
  }

  console.log('  ✅ _isMissingTargetError classifies errors correctly');
}

// Test: getHistory does NOT call console.error when the session/window is gone
async function testGetHistoryNoSpamOnMissingSession() {
  console.log('\n📝 Test: getHistory silences missing-session/window errors');

  const stub = Object.create(TmuxClient.prototype);
  stub.defaultHistoryLimit = 2000;
  stub._exec = () => {
    throw new Error("tmux command failed (exit code 1): can't find session: cliagents-gone");
  };

  const captured = [];
  const origError = console.error;
  console.error = (...args) => captured.push(args);
  try {
    const result = stub.getHistory('cliagents-gone', 'main');
    assert.strictEqual(result, '', 'Should return empty string for missing session');
    assert.strictEqual(captured.length, 0, 'Should NOT call console.error for missing session');
  } finally {
    console.error = origError;
  }

  console.log('  ✅ getHistory does not spam console.error for missing sessions');
}

// Test: getHistory DOES call console.error for unexpected tmux failures
async function testGetHistoryLogsUnexpectedErrors() {
  console.log('\n📝 Test: getHistory logs unexpected tmux errors');

  const stub = Object.create(TmuxClient.prototype);
  stub.defaultHistoryLimit = 2000;
  stub._exec = () => {
    throw new Error('protocol error');
  };

  const captured = [];
  const origError = console.error;
  console.error = (...args) => captured.push(args);
  try {
    const result = stub.getHistory('session', 'window');
    assert.strictEqual(result, '', 'Should return empty string on unexpected error');
    assert.strictEqual(captured.length, 1, 'Should call console.error exactly once for unexpected error');
    const logLine = captured[0].join(' ');
    assert(logLine.includes('protocol error'), `Error message should appear in log, got: ${logLine}`);
  } finally {
    console.error = origError;
  }

  console.log('  ✅ getHistory logs unexpected tmux errors');
}

// Test: getVisibleContent does NOT call console.error when the window is gone
async function testGetVisibleContentNoSpamOnMissingSession() {
  console.log('\n📝 Test: getVisibleContent silences missing-session/window errors');

  const stub = Object.create(TmuxClient.prototype);
  stub._exec = () => {
    throw new Error("tmux command failed (exit code 1): can't find window: main");
  };

  const captured = [];
  const origError = console.error;
  console.error = (...args) => captured.push(args);
  try {
    const result = stub.getVisibleContent('cliagents-gone', 'main');
    assert.strictEqual(result, '', 'Should return empty string for missing window');
    assert.strictEqual(captured.length, 0, 'Should NOT call console.error for missing window');
  } finally {
    console.error = origError;
  }

  console.log('  ✅ getVisibleContent does not spam console.error for missing sessions');
}

// Test: getVisibleContent DOES call console.error for unexpected tmux failures
async function testGetVisibleContentLogsUnexpectedErrors() {
  console.log('\n📝 Test: getVisibleContent logs unexpected tmux errors');

  const stub = Object.create(TmuxClient.prototype);
  stub._exec = () => {
    throw new Error('tmux server crashed');
  };

  const captured = [];
  const origError = console.error;
  console.error = (...args) => captured.push(args);
  try {
    const result = stub.getVisibleContent('session', 'window');
    assert.strictEqual(result, '', 'Should return empty string on unexpected error');
    assert.strictEqual(captured.length, 1, 'Should call console.error exactly once for unexpected error');
    const logLine = captured[0].join(' ');
    assert(logLine.includes('tmux server crashed'), `Error message should appear in log, got: ${logLine}`);
  } finally {
    console.error = origError;
  }

  console.log('  ✅ getVisibleContent logs unexpected tmux errors');
}

// ─────────────────────────────────────────────────────────────────────────────

// Run all tests
async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('       TmuxClient Tests');
  console.log('═══════════════════════════════════════════');

  let passed = 0;
  let failed = 0;

  const tests = [
    testNameValidation,
    testNameValidationSafe,
    testSendKeysLiteralMode,
    testSendKeysMultilinePasteBuffer,
    testShellEscaping,
    testSessionLifecycle,
    testSessionEnvironmentRemoval,
    testPreferredServerOptionsBootstrap,
    testInlineBootstrapOnFirstSessionCreate,
    testRespawnPaneCommand,
    testSetSessionStatusVisible,
    testDangerousSessionCreation,
    testIsMissingTargetError,
    testGetHistoryNoSpamOnMissingSession,
    testGetHistoryLogsUnexpectedErrors,
    testGetVisibleContentNoSpamOnMissingSession,
    testGetVisibleContentLogsUnexpectedErrors,
  ];

  await setup();

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.log(`  ❌ FAILED: ${error.message}`);
      failed++;
    }
  }

  await cleanup();

  console.log('\n═══════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
