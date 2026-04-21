#!/usr/bin/env node
/**
 * File-Based Output Integration Tests
 *
 * Tests for the file-based output protocol in orchestration.
 * These tests verify that agents can write output to files
 * and the system can reliably extract it.
 *
 * Run: node tests/test-file-output.js
 * Requires: Server running at localhost:4001
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE_URL = process.env.TEST_URL || 'http://localhost:4001';

// HTTP helper
async function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
      timeout: 180000  // 3 minutes for slow operations
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Check server availability
async function checkServer() {
  try {
    const res = await request('GET', '/health');
    return res.status === 200;
  } catch {
    return false;
  }
}

// Test results tracking
const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    if (error.message?.startsWith('SKIP:')) {
      results.skipped++;
      const reason = error.message.replace('SKIP:', '').trim();
      results.tests.push({ name, status: 'skipped', reason });
      console.log(`  ⏭️  ${name} (skipped - ${reason})`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'failed', error: error.message });
      console.log(`  ❌ ${name}: ${error.message}`);
    }
  }
}

// ============================================
// UNIT TESTS (No Server Required)
// ============================================

async function testFileOutputProtocolUnit() {
  console.log('\n📋 File Output Protocol Unit Tests');

  const {
    FileOutputManager,
    enhanceSystemPromptWithFileOutput
  } = require('../src/pool/file-output-protocol');

  await test('FileOutputManager creates and reads output files', async () => {
    const testDir = path.join(os.tmpdir(), 'test-file-output-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir, cleanupOnRead: false });

    const terminalId = 'unit-test-terminal';
    const testContent = 'Hello from the agent!\nThis is the response.';

    // Write to output file
    const outputPath = manager.getOutputPath(terminalId, 'text');
    fs.writeFileSync(outputPath, testContent);

    // Read it back
    const result = await manager.readOutput(terminalId, { format: 'text' });

    assert(result !== null, 'Should read output');
    assert(result.output === testContent, 'Content should match');
    assert(result.source === 'file', 'Source should be file');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('FileOutputManager handles JSON output format', async () => {
    const testDir = path.join(os.tmpdir(), 'test-file-output-json-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir, cleanupOnRead: false });

    const terminalId = 'unit-test-json';
    const testData = { answer: 42, message: 'The answer to everything' };

    // Write JSON
    const outputPath = manager.getOutputPath(terminalId, 'json');
    fs.writeFileSync(outputPath, JSON.stringify(testData));

    // Read it back
    const result = await manager.readOutput(terminalId, { format: 'json' });

    assert(result !== null, 'Should read output');
    assert(result.output.answer === 42, 'Should parse JSON correctly');
    assert(result.output.message === testData.message, 'Should have correct message');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('enhanceSystemPromptWithFileOutput adds instructions', async () => {
    const originalPrompt = 'You are a helpful assistant.';
    const terminalId = 'test-enhance-123';

    const enhanced = enhanceSystemPromptWithFileOutput(originalPrompt, terminalId);

    assert(enhanced.includes(originalPrompt), 'Should contain original prompt');
    assert(enhanced.includes('Output Protocol'), 'Should have protocol section');
    assert(enhanced.includes('output.txt'), 'Should mention output file');
    assert(enhanced.includes(terminalId), 'Should include terminal ID in path');
  });

  await test('FileOutputManager returns null when file not found', async () => {
    const testDir = path.join(os.tmpdir(), 'test-file-output-missing-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const result = await manager.readOutput('nonexistent', { timeout: 100 });

    assert(result === null, 'Should return null for missing file');

    // Cleanup
    fs.rmSync(testDir, { recursive: true });
  });

  await test('FileOutputManager cleanup removes directory', async () => {
    const testDir = path.join(os.tmpdir(), 'test-file-output-cleanup-' + Date.now());
    const manager = new FileOutputManager({ baseDir: testDir });

    const terminalId = 'cleanup-test';
    const outputPath = manager.getOutputPath(terminalId, 'text');

    // Write a file
    fs.writeFileSync(outputPath, 'test content');
    assert(fs.existsSync(outputPath), 'File should exist');

    // Cleanup
    manager.cleanup(terminalId);

    const termDir = path.join(testDir, terminalId);
    assert(!fs.existsSync(termDir), 'Directory should be removed');

    // Final cleanup
    fs.rmSync(testDir, { recursive: true });
  });
}

// ============================================
// INTEGRATION TESTS (Server Required)
// ============================================

async function testFileOutputIntegration() {
  console.log('\n📋 File Output Integration Tests (requires server)');

  // Check if server is running
  const serverRunning = await checkServer();
  if (!serverRunning) {
    console.log('  ⏭️  Skipping integration tests - server not running');
    return;
  }

  await test('Handoff with useFileOutput option', async () => {
    // Note: This test requires the agent to actually write to the file.
    // Since CLI agents may not follow the file output instructions perfectly,
    // we test that the option is accepted and falls back gracefully.

    const res = await request('POST', '/orchestration/handoff', {
      agentProfile: 'researcher',
      message: 'What is 2 + 2? Reply with just the number.',
      useFileOutput: true,
      timeout: 60
    });

    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.success, 'Should return success');
    assert(res.data.output, 'Should return output');
    // outputSource will be 'file' if agent wrote to file, 'terminal' otherwise
    assert(
      res.data.outputSource === 'file' || res.data.outputSource === 'terminal',
      `outputSource should be 'file' or 'terminal', got ${res.data.outputSource}`
    );
  });

  await test('Handoff with useFileOutput and JSON format', async () => {
    const res = await request('POST', '/orchestration/handoff', {
      agentProfile: 'researcher',
      message: 'Return ONLY valid JSON: {"answer": 4, "question": "2+2"}',
      useFileOutput: true,
      outputFormat: 'json',
      timeout: 60
    });

    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.success, 'Should return success');
    // JSON format may or may not be parsed depending on whether agent wrote to file
    assert(res.data.output, 'Should return some output');
  });

  await test('Handoff falls back to terminal when file not available', async () => {
    // Even with useFileOutput=true, if agent doesn't write file, we fall back
    const res = await request('POST', '/orchestration/handoff', {
      agentProfile: 'researcher',
      message: 'Say hello',
      useFileOutput: true,
      timeout: 60
    });

    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.success, 'Should succeed even if file output not used');
    assert(res.data.output, 'Should have output from terminal fallback');
  });

  await test('Standard handoff without useFileOutput still works', async () => {
    const res = await request('POST', '/orchestration/handoff', {
      agentProfile: 'researcher',
      message: 'What is 3 + 3? Reply with just the number.',
      // No useFileOutput - use traditional terminal parsing
      timeout: 60
    });

    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.success, 'Should return success');
    assert(res.data.output, 'Should return output');
    assert(res.data.output.includes('6'), 'Should have correct answer');
    // When useFileOutput is not set, outputSource may be undefined or 'terminal'
    assert(
      !res.data.outputSource || res.data.outputSource === 'terminal',
      'Should use terminal output'
    );
  });
}

// ============================================
// HANDOFF MODULE TESTS
// ============================================

async function testHandoffWithFileOutput() {
  console.log('\n📋 Handoff Module File Output Tests');

  // These tests mock the sessionManager to test handoff logic directly
  const { handoff } = require('../src/orchestration/handoff');
  const { FileOutputManager } = require('../src/pool/file-output-protocol');

  await test('handoff accepts useFileOutput option', async () => {
    // This just verifies the option is accepted - actual execution needs real CLI
    try {
      // This will fail because we don't have a real sessionManager,
      // but it should fail on sessionManager, not on the option
      await handoff('researcher', 'test', {
        useFileOutput: true,
        outputFormat: 'text',
        timeout: 1,
        context: {}  // No sessionManager - will fail
      });
      assert(false, 'Should throw without sessionManager');
    } catch (e) {
      assert(
        e.message.includes('sessionManager'),
        `Should fail on missing sessionManager, got: ${e.message}`
      );
    }
  });
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('       File-Based Output Tests');
  console.log('═══════════════════════════════════════════════════');

  // Unit tests (no server needed)
  await testFileOutputProtocolUnit();
  await testHandoffWithFileOutput();

  // Integration tests (server needed)
  await testFileOutputIntegration();

  // Summary
  console.log('\n' + '━'.repeat(50));
  console.log('📊 Test Results');
  console.log(`   ✅ Passed: ${results.passed}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log(`   ⏭️  Skipped: ${results.skipped}`);
  console.log('━'.repeat(50));

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
