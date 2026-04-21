/**
 * Status Detection Regression Tests
 *
 * Tests to prevent regression of status detection bugs.
 * These patterns were identified during debugging sessions.
 */

const assert = require('assert');
const path = require('path');

// Import status detectors
const GeminiCliDetector = require('../src/status-detectors/gemini-cli');
const CodexCliDetector = require('../src/status-detectors/codex-cli');
const ClaudeCodeDetector = require('../src/status-detectors/claude-code');
const { TerminalStatus } = require('../src/models/terminal-status');

// ═══════════════════════════════════════════════════════════════════
// Gemini CLI Regression Tests
// ═══════════════════════════════════════════════════════════════════

async function testGeminiWhimsicalSpinners() {
  console.log('\n📝 Test: Gemini whimsical spinner patterns → PROCESSING');

  const detector = new GeminiCliDetector();

  // These are actual spinner messages from Gemini CLI
  const spinnerOutputs = [
    '⠋ I\'m Feeling Lucky (esc to cancel, 0s)',
    '⠧ Finishing the Kessel Run in less than 12 parsecs... (esc to cancel, 5s)',
    '⠹ Formulating a Concise Summary (esc to cancel, 13s)',
    '⠸ Rickrolling my boss... (esc to cancel, 0s)',
    '⠼ Generating quantum flux capacitor... (esc to cancel, 2s)'
  ];

  for (const output of spinnerOutputs) {
    const status = detector.detectStatus(output);
    assert.strictEqual(
      status,
      TerminalStatus.PROCESSING,
      `"${output.slice(0, 30)}..." should be PROCESSING, got ${status}`
    );
  }

  console.log('  ✅ All whimsical spinners detected as PROCESSING');
}

async function testGeminiIdleNotDuringProcessing() {
  console.log('\n📝 Test: Gemini "Type your message" during processing → PROCESSING');

  const detector = new GeminiCliDetector();

  // When processing, both spinner AND prompt box may be visible
  // The spinner should take priority
  const outputWithBoth = `
⠋ I'm Feeling Lucky (esc to cancel, 0s)

 1 GEMINI.md file                                 YOLO mode (ctrl + y to toggle)
╭──────────────────────────────────────────────────────────────────────────────╮
│ *   Type your message or @path/to/file                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
`;

  const status = detector.detectStatus(outputWithBoth);
  assert.strictEqual(
    status,
    TerminalStatus.PROCESSING,
    `Spinner + prompt should be PROCESSING, got ${status}`
  );

  console.log('  ✅ Spinner takes priority over prompt box');
}

async function testGeminiActualIdle() {
  console.log('\n📝 Test: Gemini actual idle state → IDLE');

  const detector = new GeminiCliDetector();

  // When truly idle, no spinner present
  const idleOutput = `
✦ Ready. I have parsed the file structure and am ready to assist.

 1 GEMINI.md file                                 YOLO mode (ctrl + y to toggle)
╭──────────────────────────────────────────────────────────────────────────────╮
│ *   Type your message or @path/to/file                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
 ~/Documents/project                            no              Auto (Gemini 3)
`;

  const status = detector.detectStatus(idleOutput);
  assert.strictEqual(
    status,
    TerminalStatus.IDLE,
    `No spinner + prompt should be IDLE, got ${status}`
  );

  console.log('  ✅ Actual idle state detected correctly');
}

// ═══════════════════════════════════════════════════════════════════
// Codex CLI Regression Tests
// ═══════════════════════════════════════════════════════════════════

async function testCodexSpinnerPatterns() {
  console.log('\n📝 Test: Codex spinner patterns → PROCESSING');

  const detector = new CodexCliDetector();

  const spinnerOutputs = [
    '⠋ Working on your request...',
    '⠙ Analyzing code...',
    '● Reading files...',
    '• Working on implementation'
  ];

  for (const output of spinnerOutputs) {
    const status = detector.detectStatus(output);
    assert.strictEqual(
      status,
      TerminalStatus.PROCESSING,
      `"${output}" should be PROCESSING, got ${status}`
    );
  }

  console.log('  ✅ All Codex spinner patterns detected as PROCESSING');
}

async function testCodexIdleState() {
  console.log('\n📝 Test: Codex idle state → IDLE');

  const detector = new CodexCliDetector();

  const idleOutput = `
› Improve documentation in @filename

  100% context left · ? for shortcuts
`;

  const status = detector.detectStatus(idleOutput);
  assert.strictEqual(
    status,
    TerminalStatus.IDLE,
    `Codex prompt should be IDLE, got ${status}`
  );

  console.log('  ✅ Codex idle state detected correctly');
}

// ═══════════════════════════════════════════════════════════════════
// Error False Positive Tests
// ═══════════════════════════════════════════════════════════════════

async function testErrorNotFalsePositive() {
  console.log('\n📝 Test: Code containing "error" words → NOT ERROR');

  const geminiDetector = new GeminiCliDetector();
  const codexDetector = new CodexCliDetector();
  const claudeDetector = new ClaudeCodeDetector();

  // Code that contains error-like words but isn't an actual error
  const codeWithErrorWords = `
// Read the code file
const errorHandler = require('./error-handler');

class APIError extends Error {
  constructor(message) {
    super(message);
  }
}

// Handle authentication errors
if (response.status === 401) {
  throw new AuthenticationError('Invalid token');
}
`;

  // These should NOT be detected as ERROR
  for (const [name, detector] of [
    ['Gemini', geminiDetector],
    ['Codex', codexDetector],
    ['Claude', claudeDetector]
  ]) {
    const status = detector.detectStatus(codeWithErrorWords);
    assert.notStrictEqual(
      status,
      TerminalStatus.ERROR,
      `${name}: Code with error words should not trigger ERROR, got ${status}`
    );
  }

  console.log('  ✅ Error-like code content does not trigger false ERROR');
}

async function testActualErrorDetection() {
  console.log('\n📝 Test: Actual CLI errors → ERROR');

  const geminiDetector = new GeminiCliDetector();

  // Actual error messages from CLIs
  // NOTE: Error patterns require start-of-line to avoid false positives from code content
  // [error] without colon is ambiguous (could be code), so we require colon or specific format
  const errorOutputs = [
    'Error: Connection refused',
    'ERROR: Invalid API key',
    '[error]: Failed to connect to server',  // Note: colon after bracket
    'APIError: Rate limit exceeded'
  ];

  for (const output of errorOutputs) {
    const status = geminiDetector.detectStatus(output);
    assert.strictEqual(
      status,
      TerminalStatus.ERROR,
      `"${output}" should be ERROR, got ${status}`
    );
  }

  console.log('  ✅ Actual errors detected correctly');
}

// ═══════════════════════════════════════════════════════════════════
// Claude Code Tests
// ═══════════════════════════════════════════════════════════════════

async function testClaudeSpinnerPatterns() {
  console.log('\n📝 Test: Claude spinner patterns → PROCESSING');

  const detector = new ClaudeCodeDetector();

  const spinnerOutputs = [
    '✶ Thinking...',
    '✢ Processing request...',
    '⏳ Working on it...'
  ];

  for (const output of spinnerOutputs) {
    const status = detector.detectStatus(output);
    assert.strictEqual(
      status,
      TerminalStatus.PROCESSING,
      `"${output}" should be PROCESSING, got ${status}`
    );
  }

  console.log('  ✅ Claude spinner patterns detected as PROCESSING');
}

async function testClaudeIdleState() {
  console.log('\n📝 Test: Claude idle state → IDLE');

  const detector = new ClaudeCodeDetector();

  const idleOutput = `
⏺ Task completed successfully.

>
`;

  const status = detector.detectStatus(idleOutput);
  // Either IDLE or COMPLETED is acceptable here
  assert(
    status === TerminalStatus.IDLE || status === TerminalStatus.COMPLETED,
    `Claude prompt should be IDLE or COMPLETED, got ${status}`
  );

  console.log('  ✅ Claude idle state detected correctly');
}

// ═══════════════════════════════════════════════════════════════════
// Test Runner
// ═══════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('       Status Detection Regression Tests');
  console.log('═══════════════════════════════════════════');

  let passed = 0, failed = 0;

  const tests = [
    // Gemini
    testGeminiWhimsicalSpinners,
    testGeminiIdleNotDuringProcessing,
    testGeminiActualIdle,
    // Codex
    testCodexSpinnerPatterns,
    testCodexIdleState,
    // Error detection
    testErrorNotFalsePositive,
    testActualErrorDetection,
    // Claude
    testClaudeSpinnerPatterns,
    testClaudeIdleState
  ];

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.log(`  ❌ FAILED: ${error.message}`);
      failed++;
    }
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
