/**
 * Tests for TmuxClient
 *
 * Tests the tmux wrapper including security validations.
 * Run with: node tests/test-tmux-client.js
 */

const assert = require('assert');
const path = require('path');

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

// Test: Key escaping
// Note: _escapeKeys escapes for double-quoted shell strings passed to tmux send-keys -l.
// It does NOT need to escape shell metacharacters like ; | & because:
// 1. The text is wrapped in double quotes when passed to tmux
// 2. send-keys -l sends text literally to the PTY (not to shell for execution)
// 3. The text becomes input to the CLI application, not shell commands
async function testKeyEscaping() {
  console.log('\n📝 Test: Key escaping handles double-quote context');

  const testCases = [
    // Basic text passes through
    { input: 'hello world', shouldContain: 'hello world' },
    // Shell metacharacters pass through (safe with -l flag + double quotes)
    { input: 'test; ls', shouldContain: 'test; ls' },
    { input: 'test | cat', shouldContain: 'test | cat' },
    // Characters that break double-quoted strings MUST be escaped
    { input: 'test$(whoami)', shouldContain: '\\$' },
    { input: 'test`id`', shouldContain: '\\`' },
    { input: 'test"quote', shouldContain: '\\"' },
    { input: 'test\\backslash', shouldContain: '\\\\' },
    { input: 'test!history', shouldContain: '\\!' },
  ];

  for (const tc of testCases) {
    const escaped = client._escapeKeys(tc.input);
    assert(escaped.includes(tc.shouldContain),
      `Escaping "${tc.input}" should contain "${tc.shouldContain}", got: "${escaped}"`);
  }

  console.log('  ✅ Key escaping works correctly');
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

  console.log('  ✅ tmux capability bootstrap requests RGB-friendly options');
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
    testKeyEscaping,
    testShellEscaping,
    testSessionLifecycle,
    testSessionEnvironmentRemoval,
    testPreferredServerOptionsBootstrap,
    testDangerousSessionCreation,
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
