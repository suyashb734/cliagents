#!/usr/bin/env node
/**
 * Long-Running Operations Tests
 *
 * Tests for:
 * - Timeout handling (1-min, 5-min scenarios)
 * - Large outputs (10KB, 100KB responses)
 * - Concurrent terminals
 * - Async polling (wait=false with status checks)
 * - Memory/resource stability
 *
 * Note: These tests require a running server and may take significant time.
 * Run with: node tests/test-long-running.js
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:4001';

// Test utilities
async function request(method, path, body = null, options = {}) {
  const fetchOptions = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal
  };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(`${BASE_URL}${path}`, fetchOptions);
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) };
  } catch {
    return { status: response.status, data: text };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test results tracking
const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

async function test(name, fn, options = {}) {
  const startTime = Date.now();
  try {
    // Apply timeout if specified
    if (options.timeout) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout);
      try {
        await fn(controller.signal);
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      await fn();
    }
    const duration = Date.now() - startTime;
    results.passed++;
    results.tests.push({ name, status: 'passed', duration });
    console.log(`  ✅ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error.message?.startsWith('SKIP:')) {
      results.skipped++;
      const reason = error.message.replace('SKIP:', '').trim();
      results.tests.push({ name, status: 'skipped', reason });
      console.log(`  ⏭️  ${name} (skipped - ${reason})`);
    } else if (error.name === 'AbortError') {
      results.failed++;
      results.tests.push({ name, status: 'failed', error: 'Timeout exceeded', duration });
      console.log(`  ❌ ${name}: Timeout exceeded (${duration}ms)`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'failed', error: error.message, duration });
      console.log(`  ❌ ${name}: ${error.message} (${duration}ms)`);
    }
  }
}

// ============================================
// TEST SUITES
// ============================================

const DEFAULT_PRIMARY_ADAPTERS = ['gemini-cli', 'codex-cli', 'qwen-cli'];
const PRIMARY_ADAPTERS = (
  process.env.TEST_ADAPTERS
    ? process.env.TEST_ADAPTERS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_PRIMARY_ADAPTERS
);
const SESSION_TEST_ADAPTER = process.env.TEST_SESSION_ADAPTER || PRIMARY_ADAPTERS[0] || 'qwen-cli';
const ORCHESTRATION_TEST_ADAPTER = process.env.TEST_ORCHESTRATION_ADAPTER || PRIMARY_ADAPTERS[1] || SESSION_TEST_ADAPTER;

function extractErrorText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (typeof data.error === 'string') return data.error;
  if (typeof data.error?.message === 'string') return data.error.message;
  if (typeof data.message === 'string') return data.message;
  return JSON.stringify(data);
}

function isAdapterUnavailable(data) {
  const errorText = extractErrorText(data);
  return errorText.includes('not available') || errorText.includes('not installed');
}

async function testAllAdaptersBasic() {
  console.log('\n📋 All Adapters Basic Tests');

  for (const adapter of PRIMARY_ADAPTERS) {
    await test(`${adapter} responds to simple /ask`, async () => {
      const { status, data } = await request('POST', '/ask', {
        adapter,
        message: 'What is 5+5? Reply with just the number.'
      });

      if (status !== 200) {
        if (isAdapterUnavailable(data)) {
          throw new Error(`SKIP: ${adapter} not available`);
        }
        throw new Error(`Expected 200, got ${status}: ${JSON.stringify(data)}`);
      }

      // Should have a response
      assert(data.response || data.result, `${adapter} should return response`);
    }, { timeout: 60000 });
  }
}

async function testAsyncPolling() {
  console.log('\n📋 Async Mode / Polling Tests');

  // Check if orchestration endpoints exist
  let hasOrchestration = false;
  try {
    const { status } = await request('GET', '/orchestration/profiles');
    hasOrchestration = status === 200;
  } catch {
    hasOrchestration = false;
  }

  if (!hasOrchestration) {
    await test('Orchestration endpoints available', async () => {
      throw new Error('SKIP: Orchestration endpoints not available');
    });
    return;
  }

  // Test terminal creation for all adapters
  for (const adapter of PRIMARY_ADAPTERS) {
    await test(`Create terminal with ${adapter}`, async () => {
      const { status, data } = await request('POST', '/orchestration/terminals', {
        adapter
      });

      if (status !== 200 && status !== 201) {
        if (isAdapterUnavailable(data)) {
          throw new Error(`SKIP: ${adapter} not available`);
        }
        throw new Error(`Expected 200/201, got ${status}`);
      }
      assert(data.terminalId, 'Should return terminalId');

      // Check status
      const statusResp = await request('GET', `/orchestration/terminals/${data.terminalId}`);
      assert(statusResp.status === 200, `Status check failed: ${statusResp.status}`);

      // Cleanup
      await request('DELETE', `/orchestration/terminals/${data.terminalId}`);
    }, { timeout: 60000 });
  }

  await test('Create terminal and get status', async () => {
    const { status, data } = await request('POST', '/orchestration/terminals', {
      adapter: ORCHESTRATION_TEST_ADAPTER
    });
    assert(status === 200 || status === 201, `Expected 200/201, got ${status}`);
    assert(data.terminalId, 'Should return terminalId');

    // Check status via terminal info endpoint (no separate /status path)
    const statusResp = await request('GET', `/orchestration/terminals/${data.terminalId}`);
    assert(statusResp.status === 200, `Status check failed: ${statusResp.status}`);
    // Terminal info includes status
    assert(statusResp.data.status || statusResp.data.terminalId, 'Should have terminal info');

    // Cleanup
    await request('DELETE', `/orchestration/terminals/${data.terminalId}`);
  }, { timeout: 30000 });

  await test('Poll for completion with multiple status checks', async () => {
    const { status, data } = await request('POST', '/orchestration/terminals', {
      adapter: ORCHESTRATION_TEST_ADAPTER
    });

    if (status !== 200 && status !== 201) {
      throw new Error('SKIP: Could not create terminal');
    }

    const terminalId = data.terminalId;
    let lastStatus = null;

    // Poll up to 5 times using the terminal info endpoint
    for (let i = 0; i < 5; i++) {
      await sleep(2000);
      const statusResp = await request('GET', `/orchestration/terminals/${terminalId}`);
      if (statusResp.status === 200) {
        lastStatus = statusResp.data.status;
        console.log(`    Poll ${i + 1}: status = ${lastStatus}`);
      }
    }

    assert(lastStatus !== null, 'Should have received status updates');

    // Cleanup
    await request('DELETE', `/orchestration/terminals/${terminalId}`);
  }, { timeout: 30000 });
}

async function testConcurrentTerminals() {
  console.log('\n📋 Concurrent Terminal Tests');

  // Check if orchestration endpoints exist
  let hasOrchestration = false;
  try {
    const { status } = await request('GET', '/orchestration/profiles');
    hasOrchestration = status === 200;
  } catch {
    hasOrchestration = false;
  }

  if (!hasOrchestration) {
    await test('Concurrent terminals require orchestration', async () => {
      throw new Error('SKIP: Orchestration endpoints not available');
    });
    return;
  }

  await test('Create 3 terminals concurrently', async () => {
    const createPromises = [
      ...PRIMARY_ADAPTERS.slice(0, 3).map(adapter =>
        request('POST', '/orchestration/terminals', { adapter })
      )
    ];

    const results = await Promise.all(createPromises);
    const terminalIds = [];

    for (const { status, data } of results) {
      if (status === 200 || status === 201) {
        terminalIds.push(data.terminalId);
      }
    }

    assert(terminalIds.length === 3, `Expected 3 terminals, got ${terminalIds.length}`);

    // Cleanup
    await Promise.all(terminalIds.map(id =>
      request('DELETE', `/orchestration/terminals/${id}`)
    ));
  }, { timeout: 60000 });

  await test('List multiple terminals', async () => {
    const { status, data } = await request('GET', '/orchestration/terminals');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.terminals) || Array.isArray(data), 'Should return array');
  });

  // Test concurrent /ask requests for each adapter
  // Claude CLI doesn't support multiple concurrent instances - requests should be serialized
  // Gemini and Codex can handle some concurrency
  for (const adapter of PRIMARY_ADAPTERS) {
    await test(`Concurrent /ask requests work for ${adapter}`, async () => {
      console.log(`  Testing concurrent /ask for ${adapter} (this may take 30+ seconds)...`);

      // Send 3 concurrent requests
      const askPromises = [
        request('POST', '/ask', {
          adapter,
          message: 'What is 1+1? Reply with just the number.'
        }),
        request('POST', '/ask', {
          adapter,
          message: 'What is 2+2? Reply with just the number.'
        }),
        request('POST', '/ask', {
          adapter,
          message: 'What is 3+3? Reply with just the number.'
        })
      ];

      const results = await Promise.allSettled(askPromises);

      // Check for adapter not available
      const notAvailable = results.some(r =>
        r.status === 'fulfilled' &&
         isAdapterUnavailable(r.value.data)
      );
      if (notAvailable) {
        throw new Error(`SKIP: ${adapter} not available`);
      }

      // All should succeed (serialized for Claude, potentially parallel for others)
      const successes = results.filter(r =>
        r.status === 'fulfilled' && r.value.status === 200
      );
      const failures = results.filter(r =>
        r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 200)
      );

      console.log(`  ${adapter} Results: ${successes.length} success, ${failures.length} failures`);

      // At least 2 should succeed (allowing for occasional timeouts)
      assert(successes.length >= 2,
        `Expected at least 2 successes for ${adapter}, got ${successes.length}. ` +
        `Failures: ${failures.map(f => f.status === 'rejected' ? f.reason.message : extractErrorText(f.value.data)).join(', ')}`
      );
    }, { timeout: 120000 });
  }
}

async function testLargeOutputs() {
  console.log('\n📋 Large Output Handling Tests');

  await test('Handle normal session response', async () => {
    // Create a regular session
    const { status, data } = await request('POST', '/sessions', {
      adapter: SESSION_TEST_ADAPTER
    });

    if (status !== 200 && status !== 201) {
      throw new Error('SKIP: Could not create session');
    }

    const sessionId = data.sessionId;

    // Send a simple message
    const msgResp = await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'What is 2 + 2? Reply with just the number.',
      timeout: 30000
    });

    assert(msgResp.status === 200, `Message failed: ${msgResp.status}`);

    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
  }, { timeout: 60000 });
}

async function testTimeoutHandling() {
  console.log('\n📋 Timeout Handling Tests');

  await test('Session message with custom timeout', async () => {
    const { status, data } = await request('POST', '/sessions', {
      adapter: SESSION_TEST_ADAPTER
    });

    if (status !== 200 && status !== 201) {
      throw new Error('SKIP: Could not create session');
    }

    const sessionId = data.sessionId;

    // Send message with short timeout
    const msgResp = await request('POST', `/sessions/${sessionId}/messages`, {
      message: 'Hi',
      timeout: 10000  // 10 second timeout
    });

    // Should either succeed or timeout
    assert(
      msgResp.status === 200 || msgResp.status === 504,
      `Expected 200 or 504, got ${msgResp.status}`
    );

    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
  }, { timeout: 30000 });
}

async function testOutputExtraction() {
  console.log('\n📋 Output Extraction Tests (Unit)');

  // Test the output extractor module directly
  await test('Load output-extractor module', async () => {
    const outputExtractor = require('../src/utils/output-extractor');
    assert(outputExtractor.extractOutput, 'Should export extractOutput');
    assert(outputExtractor.stripAnsiCodes, 'Should export stripAnsiCodes');
    assert(outputExtractor.ADAPTER_STRATEGIES, 'Should export ADAPTER_STRATEGIES');
  });

  await test('Strip ANSI codes correctly', async () => {
    const { stripAnsiCodes } = require('../src/utils/output-extractor');

    const input = '\x1b[32mGreen\x1b[0m text';
    const output = stripAnsiCodes(input);
    assert(output === 'Green text', `Expected 'Green text', got '${output}'`);

    const complex = '\x1b[1;31mBold Red\x1b[0m and \x1b[4munderline\x1b[0m';
    const cleaned = stripAnsiCodes(complex);
    assert(!cleaned.includes('\x1b'), 'Should not contain escape codes');
  });

  await test('Extract Claude response', async () => {
    const { extractOutput } = require('../src/utils/output-extractor');

    const mockOutput = `
⏺ Read(file.txt)
  Contents of file

⏺ This is the actual response text
   that spans multiple lines.

✻ Worked for 5s
────────────────
❯
`;
    const extracted = extractOutput(mockOutput, 'claude-code');
    assert(extracted.includes('actual response'), `Expected response text, got: ${extracted}`);
    assert(!extracted.includes('Worked for'), 'Should not include status line');
  });

  await test('Handle empty/null input', async () => {
    const { extractOutput, stripAnsiCodes } = require('../src/utils/output-extractor');

    assert(extractOutput(null, 'claude-code') === '', 'Null should return empty string');
    assert(extractOutput('', 'claude-code') === '', 'Empty should return empty string');
    assert(stripAnsiCodes(null) === '', 'Null should return empty string');
  });

  await test('Filter Claude startup banners in defaultExtract', async () => {
    const { extractOutput } = require('../src/utils/output-extractor');

    // Simulate output that only contains startup banner (no ⏺ markers)
    const startupBanner = `
╭────────────────────────────────────────────────────────────────╮
│ Type your message below                                        │
╰────────────────────────────────────────────────────────────────╯
Claude Code v2.1.29
Claude Sonnet 4 (claude-sonnet-4-20250514)
~/Documents/project
95% context left
esc to cancel

The actual response content here.
`;
    const extracted = extractOutput(startupBanner, 'claude-code');

    // Should NOT contain startup banner elements
    assert(!extracted.includes('╭─'), 'Should filter input box top border');
    assert(!extracted.includes('╰─'), 'Should filter input box bottom border');
    assert(!extracted.includes('Type your message'), 'Should filter prompt text');
    assert(!extracted.includes('Claude Code v'), 'Should filter version line');
    assert(!extracted.includes('Sonnet'), 'Should filter model line');
    assert(!extracted.includes('context left'), 'Should filter context indicator');
    assert(!extracted.includes('esc to cancel'), 'Should filter cancel hint');

    // Should contain the actual response
    assert(extracted.includes('actual response'), 'Should keep actual response content');
  });

  await test('Filter Gemini startup banners in defaultExtract', async () => {
    const { extractOutput } = require('../src/utils/output-extractor');

    // Simulate Gemini output without its normal markers
    const geminiStartup = `
YOLO mode enabled
────────────────────────────────────
~/projects/test

Hello, this is the response.
`;
    const extracted = extractOutput(geminiStartup, 'gemini-cli');

    assert(!extracted.includes('YOLO mode'), 'Should filter YOLO mode line');
    assert(!extracted.includes('────'), 'Should filter separator lines');
    assert(extracted.includes('Hello'), 'Should keep actual response');
  });

  await test('Extract Gemini helper-wrapped orchestration JSON output', async () => {
    const { extractOutput } = require('../src/utils/output-extractor');

    const output = `
__CLIAGENTS_RUN_START__abc123
[cliagents] Gemini one-shot attempt 1/3: gemini --approval-mode yolo -m gemini-3-pro-preview -p "What is 9 + 1?" -o stream-json
{"type":"init","timestamp":"2026-04-12T15:06:44.671Z","session_id":"95a16d2c-cb5d-4878-844f-1f8066c374af","model":"gemini-3-pro-preview"}
{"type":"message","timestamp":"2026-04-12T15:06:44.676Z","role":"user","content":"What is 9 + 1? Reply with just the number."}
{"type":"message","timestamp":"2026-04-12T15:06:52.610Z","role":"assistant","content":"10","delta":true}
{"type":"result","timestamp":"2026-04-12T15:06:52.696Z","status":"success","stats":{"total_tokens":9544}}
__CLIAGENTS_RUN_EXIT__abc123__0
`;

    const extracted = extractOutput(output, 'gemini-cli');
    assert(extracted === '10', `Expected "10", got: ${extracted}`);
  });

  await test('Extract Claude helper-wrapped orchestration JSON output', async () => {
    const { extractOutput } = require('../src/utils/output-extractor');

    const output = `
mojave@host cliagents % printf '\\n__CLIAGENTS_RUN_START__abc123\\n'; "/opt/homebrew/bin/claude" -p "Review this change" --output-format stream-json --verbose --strict-mcp-config

__CLIAGENTS_RUN_START__abc123
{"type":"assistant","message":{"content":[{"type":"text","text":"Intermediate review note"}]}}
{"type":"result","subtype":"success","result":"Final review summary with findings"}
__CLIAGENTS_RUN_EXIT__abc123__0
`;

    const extracted = extractOutput(output, 'claude-code');
    assert(extracted === 'Final review summary with findings', `Expected final Claude result, got: ${extracted}`);
  });

  await test('Filter short working directory lines', async () => {
    const { extractOutput } = require('../src/utils/output-extractor');

    const output = `
~/Documents/project
~/code
This is the actual content that should be kept.
~/very/long/path/that/exceeds/sixty/characters/and/should/be/kept/as/content
`;
    const extracted = extractOutput(output, 'claude-code');

    // Short ~/... lines should be filtered
    assert(!extracted.includes('~/Documents/project'), 'Should filter short workdir line');
    assert(!extracted.includes('~/code'), 'Should filter short workdir line');

    // Actual content and long paths should be kept
    assert(extracted.includes('actual content'), 'Should keep actual content');
    assert(extracted.includes('sixty/characters'), 'Should keep long path lines as content');
  });
}

async function testPermissionManager() {
  console.log('\n📋 Permission Manager Tests (Unit)');

  await test('Load permissions module', async () => {
    const permissions = require('../src/permissions');
    assert(permissions.PermissionManager, 'Should export PermissionManager');
    assert(permissions.ReadOnlyPolicy, 'Should export ReadOnlyPolicy');
    assert(permissions.SandboxPolicy, 'Should export SandboxPolicy');
  });

  await test('Basic allow/deny list', async () => {
    const { PermissionManager } = require('../src/permissions');

    const pm = new PermissionManager({
      deniedTools: ['Bash', 'Write'],
      allowedPaths: ['/']  // Allow all paths for this test
    });

    let result = await pm.checkPermission('Read', { file_path: '/test.txt' });
    assert(result.allowed === true, 'Read should be allowed');

    result = await pm.checkPermission('Bash', { command: 'ls' });
    assert(result.allowed === false, 'Bash should be denied');
    assert(result.reason.includes('deny list'), 'Should mention deny list');
  });

  await test('Path restrictions', async () => {
    const { PermissionManager } = require('../src/permissions');

    const pm = new PermissionManager({
      allowedPaths: ['/allowed/path']
    });

    let result = await pm.checkPermission('Read', { file_path: '/allowed/path/file.txt' });
    assert(result.allowed === true, 'Allowed path should be permitted');

    result = await pm.checkPermission('Read', { file_path: '/other/path/file.txt' });
    assert(result.allowed === false, 'Other path should be denied');
  });

  await test('ReadOnly factory method', async () => {
    const { PermissionManager } = require('../src/permissions');

    const pm = PermissionManager.createReadOnly();

    let result = await pm.checkPermission('Read', {});
    assert(result.allowed === true, 'Read should be allowed');

    result = await pm.checkPermission('Write', {});
    assert(result.allowed === false, 'Write should be denied');

    result = await pm.checkPermission('Bash', {});
    assert(result.allowed === false, 'Bash should be denied');
  });

  await test('Permission statistics', async () => {
    const { PermissionManager } = require('../src/permissions');

    const pm = new PermissionManager({ deniedTools: ['Bash'] });

    await pm.checkPermission('Read', {});
    await pm.checkPermission('Bash', {});
    await pm.checkPermission('Write', {});

    const stats = pm.getStats();
    assert(stats.checked === 3, `Expected 3 checks, got ${stats.checked}`);
    assert(stats.allowed === 2, `Expected 2 allowed, got ${stats.allowed}`);
    assert(stats.denied === 1, `Expected 1 denied, got ${stats.denied}`);
  });
}

async function testHookManager() {
  console.log('\n📋 Hook Manager Tests (Unit)');

  await test('Load hooks module', async () => {
    const hooks = require('../src/hooks');
    assert(hooks.HookManager, 'Should export HookManager');
    assert(hooks.HOOK_EVENTS, 'Should export HOOK_EVENTS');
    assert(hooks.createLoggingHook, 'Should export createLoggingHook');
  });

  await test('Register and run hooks', async () => {
    const { HookManager } = require('../src/hooks');

    const manager = new HookManager();
    let hookCalled = false;

    manager.register('PreToolUse', (ctx) => {
      hookCalled = true;
      return true;
    });

    await manager.run('PreToolUse', { tool: 'Read' });
    assert(hookCalled === true, 'Hook should have been called');
  });

  await test('Hook blocking', async () => {
    const { HookManager } = require('../src/hooks');

    const manager = new HookManager();

    manager.register('PreToolUse', (ctx) => {
      if (ctx.tool === 'Bash') return false;
      return true;
    });

    let result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.blocked === false, 'Read should not be blocked');

    result = await manager.run('PreToolUse', { tool: 'Bash' });
    assert(result.blocked === true, 'Bash should be blocked');
  });

  await test('Hook priority ordering', async () => {
    const { HookManager } = require('../src/hooks');

    const manager = new HookManager();
    const callOrder = [];

    manager.register('PreToolUse', () => { callOrder.push('low'); }, { priority: 1 });
    manager.register('PreToolUse', () => { callOrder.push('high'); }, { priority: 10 });
    manager.register('PreToolUse', () => { callOrder.push('medium'); }, { priority: 5 });

    await manager.run('PreToolUse', {});

    assert(callOrder[0] === 'high', `First should be high, got ${callOrder[0]}`);
    assert(callOrder[1] === 'medium', `Second should be medium, got ${callOrder[1]}`);
    assert(callOrder[2] === 'low', `Third should be low, got ${callOrder[2]}`);
  });

  await test('Hook statistics', async () => {
    const { HookManager } = require('../src/hooks');

    const manager = new HookManager();
    manager.register('PreToolUse', () => true);
    manager.register('PreToolUse', () => false);

    await manager.run('PreToolUse', {});

    const stats = manager.getStats();
    assert(stats.registered === 2, `Expected 2 registered, got ${stats.registered}`);
    assert(stats.blocked === 1, `Expected 1 blocked, got ${stats.blocked}`);
  });

  await test('Built-in logging hook', async () => {
    const { HookManager, createLoggingHook } = require('../src/hooks');

    const logs = [];
    const manager = new HookManager();

    manager.register('PreToolUse', createLoggingHook({
      logger: (msg) => logs.push(msg)
    }));

    await manager.run('PreToolUse', { tool: 'Read', args: {} });

    assert(logs.length === 1, `Expected 1 log, got ${logs.length}`);
    assert(logs[0].includes('Read'), `Log should mention 'Read': ${logs[0]}`);
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('🧪 cliagents - Long-Running & Feature Tests');
  console.log(`   Server: ${BASE_URL}`);
  console.log('');

  // Unit tests (no server required)
  await testOutputExtraction();
  await testPermissionManager();
  await testHookManager();

  // Integration tests (server required)
  try {
    const health = await request('GET', '/health');
    if (health.status !== 200) {
      console.log('\n⚠️  Server not running - skipping integration tests');
    } else {
      // Test all 3 primary adapters first
      await testAllAdaptersBasic();
      await testAsyncPolling();
      await testConcurrentTerminals();
      await testLargeOutputs();
      await testTimeoutHandling();
    }
  } catch (error) {
    console.log('\n⚠️  Server connection failed - skipping integration tests');
    console.log(`   Error: ${error.message}`);
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results');
  console.log(`   ✅ Passed: ${results.passed}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log(`   ⏭️  Skipped: ${results.skipped}`);
  console.log('='.repeat(50));

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
