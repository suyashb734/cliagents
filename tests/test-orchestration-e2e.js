/**
 * E2E Integration Tests for Orchestration Terminals
 *
 * These tests verify that orchestration terminals actually work end-to-end:
 * - Terminal creation starts the CLI
 * - CLI reaches 'idle' status
 * - Messages can be sent and responses received
 *
 * IMPORTANT: These tests require:
 * - tmux installed
 * - At least one CLI (claude, gemini, or codex) installed
 *
 * The suite starts/stops an isolated test server automatically.
 * Run: node tests/test-orchestration-e2e.js
 */

const http = require('http');
const { execSync } = require('child_process');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');
const { extractOutput } = require('../src/utils/output-extractor');

let BASE_URL = 'http://localhost:4001';
const TIMEOUT = 60000; // 60s for CLI startup
let testServer = null;

// Test results
let passed = 0;
let failed = 0;
const results = [];

function log(msg) {
  console.log(`[E2E] ${msg}`);
}

async function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: TIMEOUT
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

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    results.push({ name, status: 'FAIL', error: error.message });
    console.log(`✗ ${name}: ${error.message}`);
  }
}

// Check which CLIs are available
function getAvailableCLIs() {
  const clis = [];

  try {
    execSync('which claude', { stdio: 'pipe' });
    clis.push('claude-code');
  } catch {}

  try {
    execSync('which gemini', { stdio: 'pipe' });
    clis.push('gemini-cli');
  } catch {}

  try {
    execSync('which codex', { stdio: 'pipe' });
    clis.push('codex-cli');
  } catch {}

  return clis;
}

// Verify tmux is available
function verifyTmux() {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Get tmux session content
function getTmuxContent(sessionName) {
  try {
    return execSync(`tmux capture-pane -t "${sessionName}" -p -S -100`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    return '';
  }
}

// Main tests
async function runTests() {
  console.log('\n=== Orchestration E2E Tests ===\n');

  // Pre-flight checks
  if (!verifyTmux()) {
    console.error('ERROR: tmux is not installed. Install with: brew install tmux');
    process.exit(1);
  }

  const availableCLIs = getAvailableCLIs();
  if (availableCLIs.length === 0) {
    console.error('ERROR: No CLI agents installed (claude, gemini, or codex)');
    process.exit(1);
  }

  log(`Available CLIs: ${availableCLIs.join(', ')}`);

  testServer = await startTestServer();
  BASE_URL = testServer.baseUrl;
  log(`Test server running at ${BASE_URL}`);

  // Test each available CLI
  for (const adapter of availableCLIs) {
    await testAdapterOrchestration(adapter);
  }

  // Print summary
  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }

  await stopTestServer(testServer);
  process.exit(failed > 0 ? 1 : 0);
}

async function testAdapterOrchestration(adapter) {
  let terminalId = null;
  let sessionName = null;

  await test(`${adapter}: Create orchestration terminal`, async () => {
    const res = await request('POST', '/orchestration/terminals', {
      adapter,
      agentProfile: 'test-worker',
      role: 'worker'
    });

    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Expected 200/201, got ${res.status}: ${JSON.stringify(res.data)}`);
    }

    if (!res.data.terminalId) {
      throw new Error('Response missing terminalId');
    }

    terminalId = res.data.terminalId;
    sessionName = res.data.sessionName;
    log(`Created terminal: ${terminalId}, session: ${sessionName}`);
  });

  if (!terminalId) {
    log(`Skipping remaining ${adapter} tests (terminal creation failed)`);
    return;
  }

  await test(`${adapter}: Terminal reaches idle status`, async () => {
    const startTime = Date.now();
    const maxWait = 45000; // 45 seconds

    while (Date.now() - startTime < maxWait) {
      const res = await request('GET', `/orchestration/terminals/${terminalId}`);

      if (res.status !== 200) {
        throw new Error(`Failed to get terminal: ${res.status}`);
      }

      const status = res.data.status;
      log(`Status: ${status}`);

      if (status === 'idle' || status === 'completed') {
        return; // Success
      }

      if (status === 'error') {
        // Get tmux content for debugging
        const content = getTmuxContent(sessionName);
        throw new Error(`Terminal reached error state. Output:\n${content.slice(-500)}`);
      }

      await sleep(2000);
    }

    // Timeout - get tmux content for debugging
    const content = getTmuxContent(sessionName);
    throw new Error(`Timeout waiting for idle status. Last output:\n${content.slice(-500)}`);
  });

  await test(`${adapter}: Send message and receive response`, async () => {
    const res = await request('POST', `/orchestration/terminals/${terminalId}/input`, {
      message: 'Say "Hello E2E Test" and nothing else.'
    });

    if (res.status !== 200) {
      throw new Error(`Failed to send message: ${res.status}: ${JSON.stringify(res.data)}`);
    }

    // Wait for response (check terminal status goes to processing then back to idle/completed)
    const startTime = Date.now();
    const maxWait = 120000;

    while (Date.now() - startTime < maxWait) {
      const statusRes = await request('GET', `/orchestration/terminals/${terminalId}`);
      const status = statusRes.data.status;

      if (status === 'idle' || status === 'completed') {
        // Pull server-side output and extract adapter response instead of relying on raw tmux pane.
        const outputRes = await request('GET', `/orchestration/terminals/${terminalId}/output?lines=600`);
        const extracted = extractOutput(String(outputRes.data?.output || ''), adapter).toLowerCase();
        if (extracted.includes('hello') || extracted.includes('e2e')) {
          return; // Success
        }
      }

      await sleep(1000);
    }

    throw new Error('Timeout waiting for response');
  });

  // Cleanup
  await test(`${adapter}: Cleanup terminal`, async () => {
    const res = await request('DELETE', `/orchestration/terminals/${terminalId}`);

    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`Failed to delete terminal: ${res.status}`);
    }
  });
}

// Run
runTests().catch(error => {
  console.error('Test runner error:', error);
  if (testServer) {
    stopTestServer(testServer).catch(() => {});
  }
  process.exit(1);
});
