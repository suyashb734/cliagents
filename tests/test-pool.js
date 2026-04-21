#!/usr/bin/env node
/**
 * Pool Module Tests
 *
 * Tests for warm agent pool and file-based output protocol.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

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
// WARM POOL TESTS
// ============================================

async function testWarmPoolUnit() {
  console.log('\n📋 Warm Pool Unit Tests');

  const { WarmPool, DEFAULT_CONFIG } = require('../src/pool/warm-pool');

  await test('Load warm pool module', async () => {
    assert(WarmPool, 'WarmPool should exist');
    assert(DEFAULT_CONFIG, 'DEFAULT_CONFIG should exist');
  });

  await test('Default config has expected values', async () => {
    assert(DEFAULT_CONFIG.poolSizes['gemini-cli'] >= 1, 'Gemini pool size should be >= 1');
    assert(DEFAULT_CONFIG.poolSizes['codex-cli'] >= 1, 'Codex pool size should be >= 1');
    assert(DEFAULT_CONFIG.poolSizes['qwen-cli'] >= 1, 'Qwen pool size should be >= 1');
    assert(DEFAULT_CONFIG.poolSizes['opencode-cli'] >= 1, 'OpenCode pool size should be >= 1');
    assert(DEFAULT_CONFIG.initTimeout > 0, 'initTimeout should be positive');
    assert(DEFAULT_CONFIG.maxTerminalAge > 0, 'maxTerminalAge should be positive');
  });

  await test('Constructor requires sessionManager', async () => {
    try {
      new WarmPool();
      assert(false, 'Should throw without sessionManager');
    } catch (e) {
      assert(e.message.includes('sessionManager'), 'Error should mention sessionManager');
    }
  });

  await test('Constructor initializes pools', async () => {
    const mockSessionManager = {};
    const pool = new WarmPool({ sessionManager: mockSessionManager });

    assert(pool.pools instanceof Map, 'pools should be a Map');
    assert(pool.pools.has('codex-cli'), 'Should have codex-cli pool');
    assert(pool.pools.has('gemini-cli'), 'Should have gemini-cli pool');
    assert(pool.pools.has('qwen-cli'), 'Should have qwen-cli pool');
    assert(pool.pools.has('opencode-cli'), 'Should have opencode-cli pool');
  });

  await test('getStats returns expected structure', async () => {
    const mockSessionManager = {};
    const pool = new WarmPool({ sessionManager: mockSessionManager });

    const stats = pool.getStats();
    assert(stats.acquired === 0, 'Initial acquired should be 0');
    assert(stats.poolHits === 0, 'Initial poolHits should be 0');
    assert(stats.pools, 'Should have pools object');
    assert(stats.pools['gemini-cli'], 'Should have gemini-cli stats');
  });

  await test('Custom config overrides defaults', async () => {
    const mockSessionManager = {};
    const pool = new WarmPool({
      sessionManager: mockSessionManager,
      config: {
        poolSizes: { 'gemini-cli': 5 },
        initTimeout: 120000
      }
    });

    assert(pool.config.poolSizes['gemini-cli'] === 5, 'Should override pool size');
    assert(pool.config.initTimeout === 120000, 'Should override initTimeout');
    // Default values should remain
    assert(pool.config.healthCheckInterval === DEFAULT_CONFIG.healthCheckInterval, 'Non-overridden should keep default');
  });
}

// ============================================
// FILE OUTPUT PROTOCOL TESTS
// ============================================

async function testFileOutputProtocol() {
  console.log('\n📋 File Output Protocol Tests');

  const {
    FileOutputManager,
    enhanceSystemPromptWithFileOutput,
    getFileOutputManager
  } = require('../src/pool/file-output-protocol');

  await test('Load file output module', async () => {
    assert(FileOutputManager, 'FileOutputManager should exist');
    assert(enhanceSystemPromptWithFileOutput, 'enhanceSystemPromptWithFileOutput should exist');
    assert(getFileOutputManager, 'getFileOutputManager should exist');
  });

  await test('FileOutputManager creates base directory', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    assert(fs.existsSync(testDir), 'Base directory should exist');

    // Cleanup
    fs.rmdirSync(testDir);
  });

  await test('getOutputDir creates terminal directory', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'test-terminal-123';
    const outputDir = manager.getOutputDir(terminalId);

    assert(outputDir.includes(terminalId), 'Output dir should include terminal ID');
    assert(fs.existsSync(outputDir), 'Output directory should exist');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('getOutputPath returns correct paths', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'test-terminal-456';

    const textPath = manager.getOutputPath(terminalId, 'text');
    assert(textPath.endsWith('output.txt'), 'Text path should end with output.txt');

    const jsonPath = manager.getOutputPath(terminalId, 'json');
    assert(jsonPath.endsWith('output.json'), 'JSON path should end with output.json');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('getSystemPromptAddition includes output path', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'test-terminal-789';
    const addition = manager.getSystemPromptAddition(terminalId);

    assert(addition.includes('Output Protocol'), 'Should have protocol header');
    assert(addition.includes('output.txt'), 'Should mention output file');
    assert(addition.includes(terminalId), 'Should include terminal ID');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('getSystemPromptAddition includes JSON schema when provided', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'test-terminal-schema';
    const addition = manager.getSystemPromptAddition(terminalId, {
      format: 'json',
      jsonSchema: { type: 'object', properties: { result: { type: 'string' } } }
    });

    assert(addition.includes('output.json'), 'Should mention JSON output file');
    assert(addition.includes('JSON'), 'Should mention JSON format');
    assert(addition.includes('"type": "object"'), 'Should include schema');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('readOutput returns content from file', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir, cleanupOnRead: false });

    const terminalId = 'test-terminal-read';
    const outputPath = manager.getOutputPath(terminalId, 'text');

    // Write test content
    const testContent = 'Hello from agent!';
    fs.writeFileSync(outputPath, testContent);

    // Read it back
    const result = await manager.readOutput(terminalId);

    assert(result !== null, 'Should return result');
    assert(result.output === testContent, 'Content should match');
    assert(result.source === 'file', 'Source should be file');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('readOutput returns null when file not found', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const result = await manager.readOutput('nonexistent-terminal', { timeout: 100 });

    assert(result === null, 'Should return null for missing file');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('readOutput parses JSON when format is json', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir, cleanupOnRead: false });

    const terminalId = 'test-terminal-json';
    const outputPath = manager.getOutputPath(terminalId, 'json');

    // Write test JSON
    const testData = { result: 'success', count: 42 };
    fs.writeFileSync(outputPath, JSON.stringify(testData));

    // Read it back
    const result = await manager.readOutput(terminalId, { format: 'json' });

    assert(result !== null, 'Should return result');
    assert(result.output.result === 'success', 'Should parse JSON correctly');
    assert(result.output.count === 42, 'Should have correct values');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('cleanup removes terminal directory', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'test-terminal-cleanup';
    const outputDir = manager.getOutputDir(terminalId);
    const outputPath = manager.getOutputPath(terminalId, 'text');

    // Write a file
    fs.writeFileSync(outputPath, 'test');
    assert(fs.existsSync(outputPath), 'File should exist before cleanup');

    // Cleanup
    manager.cleanup(terminalId);

    assert(!fs.existsSync(outputDir), 'Directory should be removed');

    // Final cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('enhanceSystemPromptWithFileOutput adds to existing prompt', async () => {
    const originalPrompt = 'You are a helpful assistant.';
    const terminalId = 'test-enhance';

    const enhanced = enhanceSystemPromptWithFileOutput(originalPrompt, terminalId);

    assert(enhanced.includes(originalPrompt), 'Should contain original prompt');
    assert(enhanced.includes('Output Protocol'), 'Should add file output protocol');
    assert(enhanced.length > originalPrompt.length, 'Should be longer');
  });

  await test('hasOutput returns correct boolean', async () => {
    const testDir = path.join(os.tmpdir(), 'test-cliagents-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'test-has-output';

    // Before writing
    assert(!manager.hasOutput(terminalId), 'Should return false when no file');

    // Write file
    const outputPath = manager.getOutputPath(terminalId, 'text');
    fs.writeFileSync(outputPath, 'content');

    // After writing
    assert(manager.hasOutput(terminalId), 'Should return true when file exists');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });
}

// ============================================
// MODULE INDEX TESTS
// ============================================

async function testPoolIndex() {
  console.log('\n📋 Pool Module Index Tests');

  await test('Pool module exports all components', async () => {
    const pool = require('../src/pool');

    assert(pool.WarmPool, 'Should export WarmPool');
    assert(pool.DEFAULT_CONFIG, 'Should export DEFAULT_CONFIG');
    assert(pool.FileOutputManager, 'Should export FileOutputManager');
    assert(pool.enhanceSystemPromptWithFileOutput, 'Should export enhanceSystemPromptWithFileOutput');
    assert(pool.getFileOutputManager, 'Should export getFileOutputManager');
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('🧪 Pool Module Tests');
  console.log('');

  await testWarmPoolUnit();
  await testFileOutputProtocol();
  await testPoolIndex();

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
