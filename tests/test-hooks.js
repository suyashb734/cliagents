#!/usr/bin/env node
/**
 * Hook Manager Tests
 *
 * Comprehensive tests for the hooks system including:
 * - Hook registration and execution
 * - Priority ordering
 * - Blocking and context modification
 * - Built-in hooks
 */

// Test utilities
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function testHookManagerBasic() {
  console.log('\n📋 HookManager - Basic Tests');

  const { HookManager, HOOK_EVENTS } = require('../src/hooks');

  await test('Create HookManager instance', async () => {
    const manager = new HookManager();
    assert(manager instanceof HookManager, 'Should create instance');
    assert(manager.enabled === true, 'Should be enabled by default');
  });

  await test('HOOK_EVENTS constants defined', async () => {
    assert(HOOK_EVENTS.PRE_TOOL_USE === 'PreToolUse', 'PRE_TOOL_USE defined');
    assert(HOOK_EVENTS.POST_TOOL_USE === 'PostToolUse', 'POST_TOOL_USE defined');
    assert(HOOK_EVENTS.ON_ERROR === 'OnError', 'ON_ERROR defined');
    assert(HOOK_EVENTS.ON_COMPLETE === 'OnComplete', 'ON_COMPLETE defined');
  });

  await test('Register hook returns unregister function', async () => {
    const manager = new HookManager();
    const unregister = manager.register('PreToolUse', () => true);
    assert(typeof unregister === 'function', 'Should return function');

    const hooks = manager.getHooks();
    assert(hooks.PreToolUse.length === 1, 'Should have 1 hook');

    unregister();
    const hooksAfter = manager.getHooks();
    assert(hooksAfter.PreToolUse.length === 0, 'Should remove hook');
  });

  await test('Throw on invalid event type', async () => {
    const manager = new HookManager();
    let threw = false;

    try {
      manager.register('InvalidEvent', () => true);
    } catch (e) {
      threw = true;
      assert(e.message.includes('Unknown hook event'), 'Should mention unknown event');
    }

    assert(threw, 'Should throw error');
  });
}

async function testHookExecution() {
  console.log('\n📋 HookManager - Execution');

  const { HookManager } = require('../src/hooks');

  await test('Hook receives context', async () => {
    const manager = new HookManager();
    let receivedCtx = null;

    manager.register('PreToolUse', (ctx) => {
      receivedCtx = ctx;
      return true;
    });

    await manager.run('PreToolUse', { tool: 'Read', args: { file: 'test.txt' } });

    assert(receivedCtx !== null, 'Should receive context');
    assert(receivedCtx.tool === 'Read', 'Should have tool name');
    assert(receivedCtx.args.file === 'test.txt', 'Should have args');
  });

  await test('Hook can block execution', async () => {
    const manager = new HookManager();

    manager.register('PreToolUse', (ctx) => {
      return ctx.tool !== 'Bash';
    });

    let result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.blocked === false, 'Read should not be blocked');

    result = await manager.run('PreToolUse', { tool: 'Bash' });
    assert(result.blocked === true, 'Bash should be blocked');
    assert(result.reason.includes('hook'), 'Should mention hook in reason');
  });

  await test('Hook can modify context', async () => {
    const manager = new HookManager();

    manager.register('PreToolUse', (ctx) => {
      return { modified: { extra: 'data' } };
    });

    const result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.context.extra === 'data', 'Should have modified context');
    assert(result.context.tool === 'Read', 'Should preserve original context');
  });

  await test('Multiple hooks run in priority order', async () => {
    const manager = new HookManager();
    const order = [];

    manager.register('PreToolUse', () => { order.push(1); }, { priority: 1 });
    manager.register('PreToolUse', () => { order.push(3); }, { priority: 10 });
    manager.register('PreToolUse', () => { order.push(2); }, { priority: 5 });

    await manager.run('PreToolUse', {});

    assert(order[0] === 3, 'Highest priority first');
    assert(order[1] === 2, 'Medium priority second');
    assert(order[2] === 1, 'Lowest priority last');
  });

  await test('First blocking hook stops execution', async () => {
    const manager = new HookManager();
    let secondCalled = false;

    manager.register('PreToolUse', () => false, { priority: 10 });
    manager.register('PreToolUse', () => { secondCalled = true; }, { priority: 1 });

    await manager.run('PreToolUse', {});

    assert(secondCalled === false, 'Second hook should not run after block');
  });

  await test('Async hooks supported', async () => {
    const manager = new HookManager();
    let completed = false;

    manager.register('PreToolUse', async () => {
      await sleep(10);
      completed = true;
      return true;
    });

    await manager.run('PreToolUse', {});
    assert(completed === true, 'Async hook should complete');
  });
}

async function testHookOnce() {
  console.log('\n📋 HookManager - One-time Hooks');

  const { HookManager } = require('../src/hooks');

  await test('Once hook runs only once', async () => {
    const manager = new HookManager();
    let callCount = 0;

    manager.register('PreToolUse', () => { callCount++; }, { once: true });

    await manager.run('PreToolUse', {});
    await manager.run('PreToolUse', {});
    await manager.run('PreToolUse', {});

    assert(callCount === 1, `Should run once, ran ${callCount} times`);
  });

  await test('Once hook removed after execution', async () => {
    const manager = new HookManager();

    manager.register('PreToolUse', () => true, { once: true, name: 'one-timer' });

    const hooksBefore = manager.getHooks();
    assert(hooksBefore.PreToolUse.length === 1, 'Should have 1 hook before');

    await manager.run('PreToolUse', {});

    const hooksAfter = manager.getHooks();
    assert(hooksAfter.PreToolUse.length === 0, 'Should remove after run');
  });
}

async function testEnableDisable() {
  console.log('\n📋 HookManager - Enable/Disable');

  const { HookManager } = require('../src/hooks');

  await test('Disable bypasses all hooks', async () => {
    const manager = new HookManager();
    let hookCalled = false;

    manager.register('PreToolUse', () => { hookCalled = true; return false; });
    manager.disable();

    const result = await manager.run('PreToolUse', {});

    assert(hookCalled === false, 'Hook should not be called when disabled');
    assert(result.blocked === false, 'Should not block when disabled');
  });

  await test('Enable re-enables hooks', async () => {
    const manager = new HookManager();
    let hookCalled = false;

    manager.register('PreToolUse', () => { hookCalled = true; return true; });
    manager.disable();
    manager.enable();

    await manager.run('PreToolUse', {});
    assert(hookCalled === true, 'Hook should run after re-enable');
  });

  await test('Individual hook can be disabled', async () => {
    const manager = new HookManager();
    const calls = [];

    manager.register('PreToolUse', () => { calls.push('a'); }, { name: 'hook-a' });
    manager.register('PreToolUse', () => { calls.push('b'); }, { name: 'hook-b' });

    manager.setHookEnabled('PreToolUse', 'hook-a', false);

    await manager.run('PreToolUse', {});

    assert(calls.length === 1, `Expected 1 call, got ${calls.length}`);
    assert(calls[0] === 'b', 'Only hook-b should run');
  });
}

async function testConvenienceMethods() {
  console.log('\n📋 HookManager - Convenience Methods');

  const { HookManager } = require('../src/hooks');

  await test('onPreToolUse registers PreToolUse hook', async () => {
    const manager = new HookManager();
    let called = false;

    manager.onPreToolUse(() => { called = true; });
    await manager.run('PreToolUse', {});

    assert(called === true, 'Hook should be called');
  });

  await test('onPostToolUse registers PostToolUse hook', async () => {
    const manager = new HookManager();
    let called = false;

    manager.onPostToolUse(() => { called = true; });
    await manager.run('PostToolUse', {});

    assert(called === true, 'Hook should be called');
  });

  await test('onError registers OnError hook', async () => {
    const manager = new HookManager();
    let called = false;

    manager.onError(() => { called = true; });
    await manager.run('OnError', { error: new Error('test') });

    assert(called === true, 'Hook should be called');
  });
}

async function testBuiltInHooks() {
  console.log('\n📋 Built-in Hooks');

  const {
    HookManager,
    createLoggingHook,
    createToolFilterHook,
    createRateLimitHook,
    createContentFilterHook
  } = require('../src/hooks');

  await test('createLoggingHook logs tool usage', async () => {
    const manager = new HookManager();
    const logs = [];

    manager.onPreToolUse(createLoggingHook({
      logger: (msg) => logs.push(msg)
    }));

    await manager.run('PreToolUse', { tool: 'Read', args: {} });
    await manager.run('PreToolUse', { tool: 'Write', args: {} });

    assert(logs.length === 2, `Expected 2 logs, got ${logs.length}`);
    assert(logs[0].includes('Read'), 'First log should mention Read');
    assert(logs[1].includes('Write'), 'Second log should mention Write');
  });

  await test('createToolFilterHook blocks specified tools', async () => {
    const manager = new HookManager();

    manager.onPreToolUse(createToolFilterHook(['Bash', 'Write']));

    let result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.blocked === false, 'Read should not be blocked');

    result = await manager.run('PreToolUse', { tool: 'Bash' });
    assert(result.blocked === true, 'Bash should be blocked');

    result = await manager.run('PreToolUse', { tool: 'Write' });
    assert(result.blocked === true, 'Write should be blocked');
  });

  await test('createRateLimitHook enforces limits', async () => {
    const manager = new HookManager();

    manager.onPreToolUse(createRateLimitHook(2));  // 2 per minute

    let result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.blocked === false, 'First request allowed');

    result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.blocked === false, 'Second request allowed');

    result = await manager.run('PreToolUse', { tool: 'Read' });
    assert(result.blocked === true, 'Third request blocked');
  });

  await test('createContentFilterHook blocks sensitive content', async () => {
    const manager = new HookManager();

    manager.onPreToolUse(createContentFilterHook([
      /password\s*=\s*['"][^'"]+['"]/i
    ]));

    let result = await manager.run('PreToolUse', {
      tool: 'Write',
      args: { content: 'hello world' }
    });
    assert(result.blocked === false, 'Safe content allowed');

    result = await manager.run('PreToolUse', {
      tool: 'Write',
      args: { content: 'password = "secret123"' }
    });
    assert(result.blocked === true, 'Sensitive content blocked');
  });
}

async function testStatistics() {
  console.log('\n📋 HookManager - Statistics');

  const { HookManager } = require('../src/hooks');

  await test('Track execution statistics', async () => {
    const manager = new HookManager();

    manager.register('PreToolUse', () => true);
    manager.register('PreToolUse', () => false);  // Will block

    await manager.run('PreToolUse', {});

    const stats = manager.getStats();
    assert(stats.registered === 2, `Expected 2 registered, got ${stats.registered}`);
    assert(stats.executed === 2, `Expected 2 executed, got ${stats.executed}`);
    assert(stats.blocked === 1, `Expected 1 blocked, got ${stats.blocked}`);
  });

  await test('Clear resets all hooks', async () => {
    const manager = new HookManager();

    manager.register('PreToolUse', () => true);
    manager.register('PostToolUse', () => true);

    manager.clear();

    const hooks = manager.getHooks();
    assert(hooks.PreToolUse.length === 0, 'PreToolUse should be empty');
    assert(hooks.PostToolUse.length === 0, 'PostToolUse should be empty');

    const stats = manager.getStats();
    assert(stats.registered === 0, 'Stats should be reset');
  });
}

async function testErrorHandling() {
  console.log('\n📋 HookManager - Error Handling');

  const { HookManager } = require('../src/hooks');

  await test('Hook errors do not block execution', async () => {
    const manager = new HookManager();
    let secondHookCalled = false;

    manager.register('PreToolUse', () => {
      throw new Error('Hook error');
    }, { priority: 10 });

    manager.register('PreToolUse', () => {
      secondHookCalled = true;
    }, { priority: 1 });

    // Suppress error output for test
    const originalWarn = console.error;
    console.error = () => {};

    const result = await manager.run('PreToolUse', {});

    console.error = originalWarn;

    assert(secondHookCalled === true, 'Second hook should still run');
    assert(result.blocked === false, 'Errors should not block');
  });

  await test('Error events are tracked in statistics', async () => {
    const manager = new HookManager();

    manager.register('PreToolUse', () => {
      throw new Error('Test error');
    });

    // Suppress error output for test
    const originalWarn = console.error;
    console.error = () => {};

    await manager.run('PreToolUse', {});

    console.error = originalWarn;

    const stats = manager.getStats();
    assert(stats.errors === 1, 'Should track error count');
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('🧪 Hook Manager Tests');
  console.log('');

  await testHookManagerBasic();
  await testHookExecution();
  await testHookOnce();
  await testEnableDisable();
  await testConvenienceMethods();
  await testBuiltInHooks();
  await testStatistics();
  await testErrorHandling();

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
