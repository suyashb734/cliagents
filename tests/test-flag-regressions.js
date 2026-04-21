/**
 * Regression Tests for CLI Flags and Session Manager Behaviors
 *
 * Run: node tests/test-flag-regressions.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { CLI_COMMANDS } = require('../src/tmux/session-manager');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
  }
}

console.log('\n📋 Flag Regression Tests\n');

const sourcePath = path.join(__dirname, '..', 'src', 'tmux', 'session-manager.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// =============================================================================
// CLI flag regressions
// =============================================================================

console.log('--- CLI Flags ---');

test('Codex uses --ask-for-approval (not --approval-mode)', () => {
  // Regression: Codex must use --ask-for-approval NOT --approval-mode (fixed Jan 2026)
  const cmd = CLI_COMMANDS['codex-cli']({});
  assert(cmd.includes('--ask-for-approval'),
    `Expected --ask-for-approval, got: ${cmd}`);
  assert(!cmd.includes('--approval-mode'),
    `Should NOT use --approval-mode, got: ${cmd}`);
});

test('Gemini does not pass prompt as argument', () => {
  // Regression: Gemini must NOT pass prompt as command argument (causes exit)
  const cmd = CLI_COMMANDS['gemini-cli']({ systemPrompt: 'do not include' });
  assert(!cmd.includes('do not include'),
    `Should NOT include prompt arguments, got: ${cmd}`);
});

test('Gemini does not include -i flag', () => {
  // Regression: Gemini -i flag is for images, NOT interactive mode
  const cmd = CLI_COMMANDS['gemini-cli']({});
  assert(!/(^|\s)-i(\s|$)/.test(cmd),
    `Should NOT include -i flag, got: ${cmd}`);
});

// =============================================================================
// Session manager source regressions
// =============================================================================

console.log('\n--- Session Manager Source ---');

test('Session manager does not use "cd && command" pattern', () => {
  // Regression: Session manager must NOT use "cd && command" pattern
  // Check for template literal usage: `cd "${...}" && ${...}`
  // This is the actual problematic pattern, not comments explaining it
  const cdAndCodePattern = /`cd\s+["$][^`]*&&\s*\$\{/;
  assert(!cdAndCodePattern.test(source),
    'Found "cd && command" code pattern in session-manager source');
});

test('Session manager waits for shell initialization via setTimeout delay', () => {
  // Regression: Must wait for shell initialization (check source has setTimeout with delay)
  const setTimeoutWithDelay = /setTimeout\s*\(\s*[^,]+,\s*\d+\s*\)/;
  assert(setTimeoutWithDelay.test(source),
    'Expected setTimeout with numeric delay in session-manager source');
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
