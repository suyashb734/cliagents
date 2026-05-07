#!/usr/bin/env node
/**
 * Permission Manager Tests
 *
 * Comprehensive tests for the permission system including:
 * - Basic allow/deny list functionality
 * - Path restrictions
 * - Policy composition
 * - Event emissions
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

async function testPermissionManagerBasic() {
  console.log('\n📋 PermissionManager - Basic Tests');

  const { PermissionManager } = require('../src/permissions');

  await test('Create with default options', async () => {
    const pm = new PermissionManager();
    assert(pm.allowedTools === null, 'Default allowedTools should be null');
    assert(Array.isArray(pm.deniedTools), 'deniedTools should be array');
    assert(pm.deniedTools.length === 0, 'deniedTools should be empty');
  });

  await test('Allow all tools by default', async () => {
    const pm = new PermissionManager();
    const result = await pm.checkPermission('AnyTool', {});
    assert(result.allowed === true, 'Should allow all tools by default');
  });

  await test('Deny list takes precedence', async () => {
    const pm = new PermissionManager({
      allowedTools: ['Bash', 'Read'],
      deniedTools: ['Bash']
    });

    const result = await pm.checkPermission('Bash', {});
    assert(result.allowed === false, 'Deny list should take precedence over allow list');
  });

  await test('Allow list restricts tools', async () => {
    const pm = new PermissionManager({
      allowedTools: ['Read', 'Grep']
    });

    let result = await pm.checkPermission('Read', {});
    assert(result.allowed === true, 'Read should be allowed');

    result = await pm.checkPermission('Write', {});
    assert(result.allowed === false, 'Write should not be allowed');
  });
}

async function testPathRestrictions() {
  console.log('\n📋 PermissionManager - Path Restrictions');

  const { PermissionManager } = require('../src/permissions');
  const path = require('path');

  await test('Restrict to allowed paths', async () => {
    const pm = new PermissionManager({
      allowedPaths: ['/project/src']
    });

    let result = await pm.checkPermission('Read', { file_path: '/project/src/index.js' });
    assert(result.allowed === true, 'Should allow path in allowed directory');

    result = await pm.checkPermission('Read', { file_path: '/etc/passwd' });
    assert(result.allowed === false, 'Should deny path outside allowed directory');
  });

  await test('Denied paths take precedence', async () => {
    const pm = new PermissionManager({
      allowedPaths: ['/project'],
      deniedPaths: ['/project/secrets']
    });

    let result = await pm.checkPermission('Read', { file_path: '/project/src/app.js' });
    assert(result.allowed === true, 'Should allow non-denied path');

    result = await pm.checkPermission('Read', { file_path: '/project/secrets/api-key.txt' });
    assert(result.allowed === false, 'Should deny path in denied directory');
  });

  await test('Handle different path argument names', async () => {
    const pm = new PermissionManager({
      allowedPaths: ['/allowed']
    });

    let result = await pm.checkPermission('Read', { path: '/allowed/file.txt' });
    assert(result.allowed === true, 'Should handle "path" argument');

    result = await pm.checkPermission('Read', { filePath: '/allowed/file.txt' });
    assert(result.allowed === true, 'Should handle "filePath" argument');
  });
}

async function testPolicies() {
  console.log('\n📋 Built-in Policies');

  const { PermissionManager, ReadOnlyPolicy, SandboxPolicy, RateLimitPolicy } = require('../src/permissions');

  await test('ReadOnlyPolicy blocks write operations', async () => {
    const pm = new PermissionManager({
      policies: [new ReadOnlyPolicy()]
    });

    let result = await pm.checkPermission('Read', {});
    assert(result.allowed === true, 'Read should be allowed');

    result = await pm.checkPermission('Write', {});
    assert(result.allowed === false, 'Write should be blocked');

    result = await pm.checkPermission('Edit', {});
    assert(result.allowed === false, 'Edit should be blocked');
  });

  await test('SandboxPolicy restricts paths', async () => {
    const violations = [];
    const sandbox = new SandboxPolicy(['/sandbox'], {
      onViolation: (v) => violations.push(v)
    });

    // Disable default path check by allowing all paths
    const pm = new PermissionManager({
      policies: [sandbox],
      allowedPaths: ['/']  // Allow all paths at PM level, let policy handle it
    });

    let result = await pm.checkPermission('Read', { file_path: '/sandbox/file.txt' });
    assert(result.allowed === true, 'Should allow sandbox path');

    result = await pm.checkPermission('Read', { file_path: '/other/file.txt' });
    assert(result.allowed === false, 'Should deny non-sandbox path');
    assert(violations.length === 1, 'Should record violation');
  });

  await test('SandboxPolicy blocks directory traversal', async () => {
    const sandbox = new SandboxPolicy(['/sandbox']);
    const pm = new PermissionManager({ policies: [sandbox] });

    const result = await pm.checkPermission('Read', { file_path: '/sandbox/../etc/passwd' });
    assert(result.allowed === false, 'Should block traversal attempt');
  });

  await test('RateLimitPolicy enforces limits', async () => {
    const rateLimit = new RateLimitPolicy({}, {
      defaultMax: 3,
      defaultWindowMs: 1000
    });

    const pm = new PermissionManager({ policies: [rateLimit] });

    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      const result = await pm.checkPermission('Read', {});
      assert(result.allowed === true, `Request ${i + 1} should be allowed`);
    }

    // 4th should be denied
    const result = await pm.checkPermission('Read', {});
    assert(result.allowed === false, 'Request 4 should be rate limited');
  });
}

async function testEvents() {
  console.log('\n📋 PermissionManager - Events');

  const { PermissionManager } = require('../src/permissions');

  await test('Emit permission-allowed event', async () => {
    const pm = new PermissionManager();
    let eventData = null;

    pm.on('permission-allowed', (data) => {
      eventData = data;
    });

    await pm.checkPermission('Read', { file: 'test.txt' });
    assert(eventData !== null, 'Should emit event');
    assert(eventData.toolName === 'Read', 'Should include tool name');
  });

  await test('Emit permission-denied event', async () => {
    const pm = new PermissionManager({ deniedTools: ['Bash'] });
    let eventData = null;

    pm.on('permission-denied', (data) => {
      eventData = data;
    });

    await pm.checkPermission('Bash', {});
    assert(eventData !== null, 'Should emit event');
    assert(eventData.toolName === 'Bash', 'Should include tool name');
    assert(eventData.reason, 'Should include reason');
  });
}

async function testStatistics() {
  console.log('\n📋 PermissionManager - Statistics');

  const { PermissionManager } = require('../src/permissions');

  await test('Track check statistics', async () => {
    const pm = new PermissionManager({ deniedTools: ['Bash'] });

    await pm.checkPermission('Read', {});
    await pm.checkPermission('Write', {});
    await pm.checkPermission('Bash', {});

    const stats = pm.getStats();
    assert(stats.checked === 3, 'Should count 3 checks');
    assert(stats.allowed === 2, 'Should count 2 allowed');
    assert(stats.denied === 1, 'Should count 1 denied');
  });

  await test('Track per-tool statistics', async () => {
    const pm = new PermissionManager();

    await pm.checkPermission('Read', {});
    await pm.checkPermission('Read', {});
    await pm.checkPermission('Write', {});

    const stats = pm.getStats();
    assert(stats.byTool.Read === 2, 'Should count 2 Read calls');
    assert(stats.byTool.Write === 1, 'Should count 1 Write call');
  });

  await test('Reset statistics', async () => {
    const pm = new PermissionManager();

    await pm.checkPermission('Read', {});
    pm.resetStats();

    const stats = pm.getStats();
    assert(stats.checked === 0, 'Should reset check count');
  });
}

async function testFactoryMethods() {
  console.log('\n📋 PermissionManager - Factory Methods');

  const { PermissionManager, SAFE_TOOLS } = require('../src/permissions');

  await test('createReadOnly blocks write tools', async () => {
    const pm = PermissionManager.createReadOnly();

    assert((await pm.checkPermission('Read', {})).allowed === true, 'Read allowed');
    assert((await pm.checkPermission('Grep', {})).allowed === true, 'Grep allowed');
    assert((await pm.checkPermission('Write', {})).allowed === false, 'Write blocked');
    assert((await pm.checkPermission('Edit', {})).allowed === false, 'Edit blocked');
    assert((await pm.checkPermission('Bash', {})).allowed === false, 'Bash blocked');
  });

  await test('createSafeOnly allows only safe tools', async () => {
    const pm = PermissionManager.createSafeOnly();

    for (const tool of SAFE_TOOLS) {
      const result = await pm.checkPermission(tool, {});
      assert(result.allowed === true, `${tool} should be allowed`);
    }

    const result = await pm.checkPermission('Bash', {});
    assert(result.allowed === false, 'Bash should be blocked');
  });
}

async function testBashCommandRestrictions() {
  console.log('\n📋 PermissionManager - Bash Command Restrictions');

  const { PermissionManager } = require('../src/permissions');

  await test('Allow simple bash command without restricted constructs', async () => {
    const pm = new PermissionManager({ allowedPaths: ['/'] });
    const result = await pm.checkPermission('Bash', { command: 'echo hello' });
    assert(result.allowed === true, 'Simple echo should be allowed');
  });

  await test('Block shell command substitution forms', async () => {
    const pm = new PermissionManager({ allowedPaths: ['/'] });

    let result = await pm.checkPermission('Bash', { command: 'echo $(whoami)' });
    assert(result.allowed === false, 'Should block $() command substitution');

    result = await pm.checkPermission('Bash', { command: 'echo `whoami`' });
    assert(result.allowed === false, 'Should block backtick command substitution');
  });

  await test('Block dangerous shell expansion and escape constructs', async () => {
    const pm = new PermissionManager({ allowedPaths: ['/'] });

    let result = await pm.checkPermission('Bash', { command: 'echo ${MISSING:-fallback}' });
    assert(result.allowed === false, 'Should block default-value shell expansion');

    result = await pm.checkPermission('Bash', { command: 'printf "\\x2fetc\\x2fpasswd"' });
    assert(result.allowed === false, 'Should block hex escape construction');

    result = await pm.checkPermission('Bash', { command: 'printf "\\u002fetc\\u002fpasswd"' });
    assert(result.allowed === false, 'Should block unicode escape construction');
  });

  await test('Block shell separators and background operators', async () => {
    const pm = new PermissionManager({ allowedPaths: ['/'] });

    let result = await pm.checkPermission('Bash', { command: 'echo hello; echo world' });
    assert(result.allowed === false, 'Should block semicolon chaining');

    result = await pm.checkPermission('Bash', { command: 'echo hello && echo world' });
    assert(result.allowed === false, 'Should block ampersand operators');

    result = await pm.checkPermission('Bash', { command: 'echo hello!' });
    assert(result.allowed === false, 'Should block shell history expansion marker');
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('🧪 Permission Manager Tests');
  console.log('');

  await testPermissionManagerBasic();
  await testPathRestrictions();
  await testPolicies();
  await testEvents();
  await testStatistics();
  await testFactoryMethods();
  await testBashCommandRestrictions();

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
