#!/usr/bin/env node
/**
 * Interceptor Tests
 *
 * Tests for the permission interceptor system including:
 * - Prompt parsing for each CLI adapter
 * - Permission checking integration
 * - Response handling
 */

// Test utilities
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const results = { passed: 0, failed: 0, tests: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    if (error.message?.startsWith('SKIP:')) {
      results.tests.push({ name, status: 'skipped', reason: error.message });
      console.log(`  ⏭️  ${name} (skipped)`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'failed', error: error.message });
      console.log(`  ❌ ${name}: ${error.message}`);
    }
  }
}

// ============================================
// TEST SUITES
// ============================================

async function testPromptParsers() {
  console.log('\n📋 Prompt Parsers Tests');

  const { ClaudeCodePromptParser, GeminiPromptParser, CodexPromptParser, getParser } = require('../src/interceptor/prompt-parsers');
  const { TerminalStatus } = require('../src/models/terminal-status');

  await test('Load prompt parsers module', async () => {
    assert(ClaudeCodePromptParser, 'ClaudeCodePromptParser should exist');
    assert(GeminiPromptParser, 'GeminiPromptParser should exist');
    assert(CodexPromptParser, 'CodexPromptParser should exist');
    assert(getParser, 'getParser should exist');
  });

  await test('Get parser for each adapter', async () => {
    assert(getParser('claude-code') instanceof ClaudeCodePromptParser, 'Should get Claude parser');
    assert(getParser('gemini-cli') instanceof GeminiPromptParser, 'Should get Gemini parser');
    assert(getParser('codex-cli') instanceof CodexPromptParser, 'Should get Codex parser');
  });

  await test('Claude parser - bash command', async () => {
    const parser = new ClaudeCodePromptParser();
    const output = 'Run bash command? ls -la';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse bash command');
    assert(result.toolName === 'Bash', 'Tool should be Bash');
    assert(result.args.command === 'ls -la', 'Command should be extracted');
  });

  await test('Claude parser - file write', async () => {
    const parser = new ClaudeCodePromptParser();
    const output = 'Write to /path/to/file.js?';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse write prompt');
    assert(result.toolName === 'Write', 'Tool should be Write');
    assert(result.args.file_path === '/path/to/file.js', 'Path should be extracted');
  });

  await test('Claude parser - requires WAITING_PERMISSION status', async () => {
    const parser = new ClaudeCodePromptParser();
    const output = 'Run bash command? ls -la';
    const result = parser.parse(output, TerminalStatus.PROCESSING);
    assert(result === null, 'Should not parse when not waiting for permission');
  });

  await test('Gemini parser - bash execution', async () => {
    const parser = new GeminiPromptParser();
    const output = 'Allow bash execution: rm -rf /tmp ? (y/n)';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse bash execution');
    assert(result.toolName === 'Bash', 'Tool should be Bash');
    assert(result.args.command === 'rm -rf /tmp', 'Command should be extracted');
  });

  await test('Gemini parser - file write', async () => {
    const parser = new GeminiPromptParser();
    const output = 'Allow write to /path/to/file.js ? (y/n)';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse write prompt');
    assert(result.toolName === 'Write', 'Tool should be Write');
    assert(result.args.file_path === '/path/to/file.js', 'Path should be extracted');
  });

  await test('Gemini parser - file read', async () => {
    const parser = new GeminiPromptParser();
    const output = 'Allow read from /etc/passwd ? (y/n)';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse read prompt');
    assert(result.toolName === 'Read', 'Tool should be Read');
    assert(result.args.file_path === '/etc/passwd', 'Path should be extracted');
  });

  await test('Codex parser - file edit', async () => {
    const parser = new CodexPromptParser();
    const output = 'Approve file edit: src/index.js ? (y/n)';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse file edit');
    assert(result.toolName === 'Edit', 'Tool should be Edit');
    assert(result.args.file_path === 'src/index.js', 'Path should be extracted');
  });

  await test('Codex parser - run command', async () => {
    const parser = new CodexPromptParser();
    const output = 'Run command: npm install lodash ? (y/n)';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse run command');
    assert(result.toolName === 'Bash', 'Tool should be Bash');
    assert(result.args.command === 'npm install lodash', 'Command should be extracted');
  });

  await test('Codex parser - sandbox execution', async () => {
    const parser = new CodexPromptParser();
    const output = 'Confirm sandbox execution ? (y/n)';
    const result = parser.parse(output, TerminalStatus.WAITING_PERMISSION);
    assert(result !== null, 'Should parse sandbox execution');
    assert(result.toolName === 'Sandbox', 'Tool should be Sandbox');
  });
}

async function testPermissionInterceptorUnit() {
  console.log('\n📋 Permission Interceptor Unit Tests');

  const { PermissionInterceptor, DEFAULT_CONFIG } = require('../src/interceptor');
  const { PermissionManager } = require('../src/permissions');

  await test('Load interceptor module', async () => {
    assert(PermissionInterceptor, 'PermissionInterceptor should exist');
    assert(DEFAULT_CONFIG, 'DEFAULT_CONFIG should exist');
  });

  await test('Default configuration values', async () => {
    assert(DEFAULT_CONFIG.pollIntervalIdle === 1000, 'Default idle poll should be 1000ms');
    assert(DEFAULT_CONFIG.pollIntervalActive === 200, 'Default active poll should be 200ms');
    assert(DEFAULT_CONFIG.pollIntervalWaiting === 100, 'Default waiting poll should be 100ms');
  });

  await test('Constructor requires sessionManager', async () => {
    const pm = new PermissionManager();
    try {
      new PermissionInterceptor({ permissionManager: pm });
      assert(false, 'Should throw without sessionManager');
    } catch (e) {
      assert(e.message.includes('sessionManager'), 'Error should mention sessionManager');
    }
  });

  await test('Constructor requires permissionManager', async () => {
    const mockSessionManager = { getTerminal: () => null };
    try {
      new PermissionInterceptor({ sessionManager: mockSessionManager });
      assert(false, 'Should throw without permissionManager');
    } catch (e) {
      assert(e.message.includes('permissionManager'), 'Error should mention permissionManager');
    }
  });

  await test('Statistics tracking', async () => {
    const mockSessionManager = { getTerminal: () => ({ adapter: 'claude-code' }) };
    const pm = new PermissionManager();
    const interceptor = new PermissionInterceptor({ sessionManager: mockSessionManager, permissionManager: pm });

    const stats = interceptor.getStats();
    assert(stats.promptsDetected === 0, 'Initial prompts detected should be 0');
    assert(stats.promptsAllowed === 0, 'Initial prompts allowed should be 0');
    assert(stats.promptsDenied === 0, 'Initial prompts denied should be 0');
    assert(stats.activeInterceptors === 0, 'Initial active interceptors should be 0');
  });

  await test('Reset statistics', async () => {
    const mockSessionManager = { getTerminal: () => ({ adapter: 'claude-code' }) };
    const pm = new PermissionManager();
    const interceptor = new PermissionInterceptor({ sessionManager: mockSessionManager, permissionManager: pm });

    // Manually increment stats for test
    interceptor.stats.promptsDetected = 5;
    interceptor.stats.promptsAllowed = 3;
    interceptor.stats.promptsDenied = 2;

    interceptor.resetStats();
    const stats = interceptor.getStats();
    assert(stats.promptsDetected === 0, 'Should reset prompts detected');
    assert(stats.promptsAllowed === 0, 'Should reset prompts allowed');
    assert(stats.promptsDenied === 0, 'Should reset prompts denied');
  });

  await test('Prompt hash is stable for object key order', async () => {
    const mockSessionManager = { getTerminal: () => ({ adapter: 'claude-code' }) };
    const pm = new PermissionManager();
    const interceptor = new PermissionInterceptor({ sessionManager: mockSessionManager, permissionManager: pm });

    const first = interceptor._hashPrompt({
      toolName: 'Bash',
      args: { command: 'ls', description: 'list files' }
    });
    const second = interceptor._hashPrompt({
      toolName: 'Bash',
      args: { description: 'list files', command: 'ls' }
    });

    assert(first === second, 'Equivalent prompt args should hash identically');
  });
}

async function testPermissionManagerFromProfile() {
  console.log('\n📋 PermissionManager.fromProfile Tests');

  const { PermissionManager } = require('../src/permissions');

  await test('Create from profile with allowedTools', async () => {
    const profile = { allowedTools: ['Read', 'Grep', 'Glob'] };
    const pm = PermissionManager.fromProfile(profile, '/test/dir');

    assert(pm.allowedTools.includes('Read'), 'Should include Read');
    assert(pm.allowedTools.includes('Grep'), 'Should include Grep');
    assert(pm.allowedPaths.includes('/test/dir'), 'Should include work dir in allowed paths');
  });

  await test('Create from profile with deniedTools', async () => {
    const profile = { deniedTools: ['Bash', 'Write'] };
    const pm = PermissionManager.fromProfile(profile, '/test/dir');

    assert(pm.deniedTools.includes('Bash'), 'Should include Bash in denied');
    assert(pm.deniedTools.includes('Write'), 'Should include Write in denied');
  });

  await test('Create from profile with both allow and deny', async () => {
    const profile = {
      allowedTools: ['Read', 'Write', 'Edit'],
      deniedTools: ['Bash']
    };
    const pm = PermissionManager.fromProfile(profile, '/project');

    // Verify read is allowed
    let result = await pm.checkPermission('Read', { file_path: '/project/file.txt' });
    assert(result.allowed === true, 'Read should be allowed');

    // Verify bash is denied (even though not in allowedTools, deniedTools takes precedence)
    result = await pm.checkPermission('Bash', {});
    assert(result.allowed === false, 'Bash should be denied');
  });

  await test('Create from profile without workDir uses cwd', async () => {
    const profile = { allowedTools: ['Read'] };
    const pm = PermissionManager.fromProfile(profile, null);

    assert(pm.allowedPaths.includes(process.cwd()), 'Should use cwd when workDir is null');
  });
}

async function testIntegration() {
  console.log('\n📋 Integration Tests (Mock)');

  const { PermissionInterceptor } = require('../src/interceptor');
  const { PermissionManager } = require('../src/permissions');
  const { TerminalStatus } = require('../src/models/terminal-status');

  await test('handlePrompt delegates to PermissionManager', async () => {
    const pm = new PermissionManager({ deniedTools: ['Bash'] });
    const mockSessionManager = { getTerminal: () => ({ adapter: 'claude-code' }) };
    const interceptor = new PermissionInterceptor({ sessionManager: mockSessionManager, permissionManager: pm });

    // Test allowed tool
    let result = await interceptor.handlePrompt('test-terminal', {
      toolName: 'Read',
      args: {},
      rawPrompt: 'test',
      adapter: 'claude-code'
    });
    assert(result.allowed === true, 'Read should be allowed');

    // Test denied tool
    result = await interceptor.handlePrompt('test-terminal', {
      toolName: 'Bash',
      args: {},
      rawPrompt: 'test',
      adapter: 'claude-code'
    });
    assert(result.allowed === false, 'Bash should be denied');
  });

  await test('handlePrompt returns deny on error (fail-safe)', async () => {
    const pm = new PermissionManager();
    // Mock checkPermission to throw
    pm.checkPermission = async () => { throw new Error('Test error'); };

    const mockSessionManager = { getTerminal: () => ({ adapter: 'claude-code' }) };
    const interceptor = new PermissionInterceptor({ sessionManager: mockSessionManager, permissionManager: pm });

    const result = await interceptor.handlePrompt('test-terminal', {
      toolName: 'Read',
      args: {},
      rawPrompt: 'test',
      adapter: 'claude-code'
    });

    assert(result.allowed === false, 'Should deny on error');
    assert(result.reason.includes('Error'), 'Should include error in reason');
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('🧪 Interceptor Tests');
  console.log('');

  await testPromptParsers();
  await testPermissionInterceptorUnit();
  await testPermissionManagerFromProfile();
  await testIntegration();

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results');
  console.log(`   ✅ Passed: ${results.passed}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log('='.repeat(50));

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
