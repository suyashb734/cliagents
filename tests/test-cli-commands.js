/**
 * Unit tests for supported CLI command construction.
 *
 * Run: node tests/test-cli-commands.js
 */

const assert = require('assert');
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

console.log('\n📋 Supported CLI Command Construction Tests\n');

console.log('--- Gemini CLI ---');

test('Gemini interactive command uses yolo by default', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ model: 'gemini-2.5-pro' });

  assert(cmd.startsWith('gemini'), `Expected to start with "gemini", got: ${cmd}`);
  assert(cmd.includes('--approval-mode yolo'), `Expected yolo approval mode, got: ${cmd}`);
  assert(cmd.includes('-m gemini-2.5-pro'), `Expected model flag, got: ${cmd}`);
});

test('Gemini orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "GEMINI_READY_FOR_ORCHESTRATION"');
});

console.log('\n--- Codex CLI ---');

test('Codex interactive command bypasses approvals by default', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ model: 'o4-mini' });

  assert(cmd.startsWith('CI=true codex'), `Expected CI=true codex prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
  assert(cmd.includes('--model o4-mini'), `Expected model flag, got: ${cmd}`);
});

test('Codex orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "CODEX_READY_FOR_ORCHESTRATION"');
});

console.log('\n--- Qwen CLI ---');

test('Qwen interactive command uses yolo by default', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ model: 'qwen3-coder' });

  assert(cmd.startsWith('qwen'), `Expected to start with "qwen", got: ${cmd}`);
  assert(cmd.includes('-y'), `Expected -y flag, got: ${cmd}`);
  assert(cmd.includes('-m qwen3-coder'), `Expected model flag, got: ${cmd}`);
});

test('Qwen orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "QWEN_READY_FOR_ORCHESTRATION"');
});

console.log('\n--- OpenCode CLI ---');

test('OpenCode interactive command supports model selection', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ model: 'openai/gpt-5' });

  assert(cmd.startsWith('opencode'), `Expected to start with "opencode", got: ${cmd}`);
  assert(cmd.includes('--model openai/gpt-5'), `Expected model flag, got: ${cmd}`);
});

test('OpenCode orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "OPENCODE_READY_FOR_ORCHESTRATION"');
});

console.log('\n--- Claude Code ---');

test('Claude interactive command respects explicit default permission mode', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    permissionMode: 'default',
    model: 'claude-sonnet-4-5-20250514'
  });

  assert(cmd.startsWith('claude'), `Expected to start with "claude", got: ${cmd}`);
  assert(cmd.includes('--permission-mode default'), `Expected default permission mode, got: ${cmd}`);
  assert(cmd.includes('--output-format stream-json'), `Expected stream-json output, got: ${cmd}`);
  assert(cmd.includes('--model claude-sonnet-4-5-20250514'), `Expected model flag, got: ${cmd}`);
});

test('Claude interactive command omits allowedTools when the list is empty', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    permissionMode: 'default',
    allowedTools: []
  });

  assert(!cmd.includes('--allowedTools'), `Did not expect empty allowedTools flag, got: ${cmd}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
