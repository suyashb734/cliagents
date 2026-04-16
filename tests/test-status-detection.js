/**
 * Tests for Status Detection
 *
 * Tests the CLI status detection for each adapter.
 * Run with: node tests/test-status-detection.js
 */

const assert = require('assert');

// Import status detectors
const BaseDetector = require('../src/status-detectors/base');
const GeminiCliDetector = require('../src/status-detectors/gemini-cli');
const CodexCliDetector = require('../src/status-detectors/codex-cli');
const QwenCliDetector = require('../src/status-detectors/qwen-cli');
const OpencodeCliDetector = require('../src/status-detectors/opencode-cli');
const ClaudeCodeDetector = require('../src/status-detectors/claude-code');
const { createDetector, hasDetector, getSupportedAdapters } = require('../src/status-detectors/factory');
const { TerminalStatus } = require('../src/models/terminal-status');

// Test: Gemini CLI status detection
async function testGeminiCliDetection() {
  console.log('\n📝 Test: Gemini CLI status detection');

  const detector = new GeminiCliDetector();

  // Test IDLE detection - gemini> prompt
  const idleOutput = `
Gemini CLI
gemini> `;
  assert.strictEqual(detector.detectStatus(idleOutput), TerminalStatus.IDLE,
    'Should detect IDLE from gemini> prompt');

  // Test PROCESSING detection - spinner or Thinking
  const processingOutput = `
gemini> Write code
⠋ Thinking...`;
  assert.strictEqual(detector.detectStatus(processingOutput), TerminalStatus.PROCESSING,
    'Should detect PROCESSING from spinner');

  // Test COMPLETED detection
  const completedOutput = `
gemini> Write code
Here is the code:
function test() {}
---`;
  assert.strictEqual(detector.detectStatus(completedOutput), TerminalStatus.COMPLETED,
    'Should detect COMPLETED from --- marker');

  // Test ERROR detection
  const errorOutput = `
gemini> Something
Error: API error`;
  assert.strictEqual(detector.detectStatus(errorOutput), TerminalStatus.ERROR,
    'Should detect ERROR from error message');

  console.log('  ✅ Gemini CLI detection works correctly');
}

// Test: Codex CLI status detection
async function testCodexCliDetection() {
  console.log('\n📝 Test: Codex CLI status detection');

  const detector = new CodexCliDetector();

  // Test IDLE detection - codex> prompt
  const idleOutput = `
Codex CLI
codex> `;
  assert.strictEqual(detector.detectStatus(idleOutput), TerminalStatus.IDLE,
    'Should detect IDLE from codex> prompt');

  // Test PROCESSING detection
  const processingOutput = `
codex> Write something
• Working...`;
  assert.strictEqual(detector.detectStatus(processingOutput), TerminalStatus.PROCESSING,
    'Should detect PROCESSING from Working indicator');

  // Test COMPLETED detection
  const completedOutput = `
codex> Write something
Done.
─ Worked for 1.2s`;
  assert.strictEqual(detector.detectStatus(completedOutput), TerminalStatus.COMPLETED,
    'Should detect COMPLETED from Worked for indicator');

  const interruptedOutput = `
■ Conversation interrupted - tell the model what to do differently.
Something went wrong? Hit /feedback to report the issue.
To continue this session, run codex resume 019d94a6-2cd8-7742-8e4e-123456789abc`;
  assert.strictEqual(detector.detectStatus(interruptedOutput), TerminalStatus.ERROR,
    'Should detect ERROR from conversation interrupted banner');
  const interruption = detector.extractInterruption(interruptedOutput);
  assert(interruption, 'Should extract interruption metadata');
  assert.strictEqual(interruption.code, 'conversation_interrupted');
  assert.strictEqual(
    interruption.resumeCommand,
    'codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'
  );

  console.log('  ✅ Codex CLI detection works correctly');
}

// Test: Qwen CLI status detection
async function testQwenCliDetection() {
  console.log('\n📝 Test: Qwen CLI status detection');

  const detector = new QwenCliDetector();

  const idleOutput = `
Qwen CLI
qwen> `;
  assert.strictEqual(detector.detectStatus(idleOutput), TerminalStatus.IDLE,
    'Should detect IDLE from > prompt');

  const processingOutput = `
> Review this code
Thinking...
Working on it`;
  assert.strictEqual(detector.detectStatus(processingOutput), TerminalStatus.PROCESSING,
    'Should detect PROCESSING from thinking indicator');

  const completedOutput = `
{"type":"result","status":"completed","response":"Here is the review summary."}`;
  assert.strictEqual(detector.detectStatus(completedOutput), TerminalStatus.COMPLETED,
    'Should detect COMPLETED from final response text');

  console.log('  ✅ Qwen CLI detection works correctly');
}

async function testOpencodeCliDetection() {
  console.log('\n📝 Test: OpenCode CLI status detection');

  const detector = new OpencodeCliDetector();

  const idleOutput = '\nOpenCode CLI\nOPENCODE_READY_FOR_ORCHESTRATION';
  assert.strictEqual(detector.detectStatus(idleOutput), TerminalStatus.IDLE,
    'Should detect IDLE from orchestration ready marker');

  const processingOutput = '\n{"type":"step_start","sessionID":"ses_123"}\n{"type":"text","sessionID":"ses_123","part":{"text":"Thinking"}}';
  assert.strictEqual(detector.detectStatus(processingOutput), TerminalStatus.PROCESSING,
    'Should detect PROCESSING from JSON step events');

  const completedOutput = '\n{"type":"step_finish","sessionID":"ses_123","part":{"reason":"stop"}}';
  assert.strictEqual(detector.detectStatus(completedOutput), TerminalStatus.COMPLETED,
    'Should detect COMPLETED from step_finish event');

  console.log('  ✅ OpenCode CLI detection works correctly');
}

async function testClaudeCodeDetection() {
  console.log('\n📝 Test: Claude Code status detection');

  const detector = new ClaudeCodeDetector();

  const idleOutput = '\n❯ Try "review the latest change"';
  assert.strictEqual(detector.detectStatus(idleOutput), TerminalStatus.IDLE,
    'Should detect IDLE from Claude prompt');

  const processingOutput = '\n✶ Thinking...\n';
  assert.strictEqual(detector.detectStatus(processingOutput), TerminalStatus.PROCESSING,
    'Should detect PROCESSING from Claude spinner output');

  const completedOutput = '\n⏺ Review complete\n';
  assert.strictEqual(detector.detectStatus(completedOutput), TerminalStatus.COMPLETED,
    'Should detect COMPLETED from Claude response markers');

  console.log('  ✅ Claude Code detection works correctly');
}

// Test: Factory creates correct detector
async function testDetectorFactory() {
  console.log('\n📝 Test: Detector factory');

  // Test createDetector function
  assert(createDetector('gemini-cli') instanceof GeminiCliDetector,
    'Should create GeminiCliDetector for gemini-cli');

  assert(createDetector('codex-cli') instanceof CodexCliDetector,
    'Should create CodexCliDetector for codex-cli');

  assert(createDetector('qwen-cli') instanceof QwenCliDetector,
    'Should create QwenCliDetector for qwen-cli');

  assert(createDetector('opencode-cli') instanceof OpencodeCliDetector,
    'Should create OpencodeCliDetector for opencode-cli');

  assert(createDetector('claude-code') instanceof ClaudeCodeDetector,
    'Should create ClaudeCodeDetector for claude-code');

  // Test hasDetector function
  assert(hasDetector('gemini-cli'), 'Should have detector for gemini-cli');
  assert(hasDetector('codex-cli'), 'Should have detector for codex-cli');
  assert(hasDetector('qwen-cli'), 'Should have detector for qwen-cli');
  assert(hasDetector('opencode-cli'), 'Should have detector for opencode-cli');
  assert(hasDetector('claude-code'), 'claude-code should be in the managed-root detector surface');
  assert(!hasDetector('unknown-adapter'), 'Should not have detector for unknown');

  // Test getSupportedAdapters
  const supported = getSupportedAdapters();
  assert(supported.includes('gemini-cli'), 'gemini-cli should be supported');
  assert(supported.includes('codex-cli'), 'codex-cli should be supported');
  assert(supported.includes('qwen-cli'), 'qwen-cli should be supported');
  assert(supported.includes('opencode-cli'), 'opencode-cli should be supported');
  assert(supported.includes('claude-code'), 'claude-code should be in the managed-root supported list');

  console.log('  ✅ Factory creates correct detectors');
}

// Test: Base detector defaults to idle
async function testBaseDetectorDefaults() {
  console.log('\n📝 Test: Base detector defaults');

  const detector = new BaseDetector();

  // Base class with no patterns should default to IDLE
  const result = detector.detectStatus('some random output');
  assert.strictEqual(result, TerminalStatus.IDLE,
    'Base detector should default to IDLE');

  console.log('  ✅ Base detector defaults correctly');
}

// Test: TerminalStatus enum values
async function testTerminalStatusEnum() {
  console.log('\n📝 Test: TerminalStatus enum values');

  assert.strictEqual(TerminalStatus.IDLE, 'idle', 'IDLE should be "idle"');
  assert.strictEqual(TerminalStatus.PROCESSING, 'processing', 'PROCESSING should be "processing"');
  assert.strictEqual(TerminalStatus.COMPLETED, 'completed', 'COMPLETED should be "completed"');
  assert.strictEqual(TerminalStatus.WAITING_PERMISSION, 'waiting_permission', 'WAITING_PERMISSION should be "waiting_permission"');
  assert.strictEqual(TerminalStatus.WAITING_USER_ANSWER, 'waiting_user_answer', 'WAITING_USER_ANSWER should be "waiting_user_answer"');
  assert.strictEqual(TerminalStatus.ERROR, 'error', 'ERROR should be "error"');

  console.log('  ✅ TerminalStatus enum values correct');
}

// Run all tests
async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('       Status Detection Tests');
  console.log('═══════════════════════════════════════════');

  let passed = 0;
  let failed = 0;

  const tests = [
    testGeminiCliDetection,
    testCodexCliDetection,
    testQwenCliDetection,
    testOpencodeCliDetection,
    testClaudeCodeDetection,
    testDetectorFactory,
    testBaseDetectorDefaults,
    testTerminalStatusEnum,
  ];

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.log(`  ❌ FAILED: ${error.message}`);
      if (error.stack) {
        console.log(`     ${error.stack.split('\n')[1]}`);
      }
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
