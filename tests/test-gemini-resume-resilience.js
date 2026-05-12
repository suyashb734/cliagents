#!/usr/bin/env node

'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const GeminiCliAdapter = require('../src/adapters/gemini-cli');

const originalExecSync = childProcess.execSync;
const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMockedExecFile(mock, fn) {
  childProcess.execFile = (path, args, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    try {
      const result = mock(path, args, options);
      // Mock returns string output, execFile callback expects (err, stdout, stderr)
      process.nextTick(() => callback(null, result, ''));
    } catch (e) {
      process.nextTick(() => callback(e));
    }
  };
  childProcess.execSync = () => '';

  try {
    await fn();
  } finally {
    childProcess.execFile = originalExecFile;
    childProcess.execSync = originalExecSync;
  }
}

async function run() {
  console.log('Running Gemini resume resilience tests...');

  const adapter = new GeminiCliAdapter({ workDir: '/tmp/gemini-test' });
  adapter._geminiPathCache = '/mock/gemini';

  const geminiSessionId = 'gemini-uuid-123';
  const session = {
    geminiSessionId,
    ready: true,
    workDir: '/tmp/gemini-test',
    messageCount: 0
  };

  await withMockedExecFile((command, args) => {
    if (args.includes('--list-sessions')) {
      return `  1. Some session [${geminiSessionId}]\n  2. Other session [other-uuid]`;
    }
    return '';
  }, async () => {
    const index = await adapter._resolveGeminiResumeRef(session, {
      timeoutMs: 2000,
      pollIntervalMs: 100
    });
    assert.strictEqual(index, '1');
  });
  console.log('  ✓ resolves an existing session on the first list call');

  const missingWorkDir = path.join(os.tmpdir(), `cliagents-gemini-missing-${Date.now()}`);
  fs.rmSync(missingWorkDir, { recursive: true, force: true });
  await withMockedExecFile((command, args, options) => {
    assert(args.includes('--list-sessions'), 'expected session list command');
    assert(fs.existsSync(options.cwd), 'expected list-sessions cwd to be created before spawn');
    assert.strictEqual(
      String(options.env?.PATH || '').split(path.delimiter)[0],
      path.dirname(process.execPath),
      'expected Gemini subprocess PATH to prefer the current Node runtime'
    );
    return '';
  }, async () => {
    const sessions = await adapter._listGeminiSessions(missingWorkDir, { maxAttempts: 1 });
    assert.deepStrictEqual(sessions, []);
  });
  fs.rmSync(missingWorkDir, { recursive: true, force: true });
  console.log('  ✓ creates missing list-session workdirs and pins Gemini subprocess PATH');

  await withMockedExecFile((command, args) => {
    if (args.includes('--list-sessions')) {
      return '  1. Other session [other-uuid]';
    }
    return '';
  }, async () => {
    const index = await adapter._resolveGeminiResumeRef(session, {
      timeoutMs: 120,
      pollIntervalMs: 30
    });
    assert.strictEqual(index, null);
  });
  console.log('  ✓ returns null when a stored session never reappears before timeout');

  await withMockedExecFile(() => {
    throw new Error('Transient Gemini failure');
  }, async () => {
    const sessions = await adapter._listGeminiSessions('/tmp/gemini-test');
    assert.deepStrictEqual(sessions, []);
  });
  console.log('  ✓ retries list-session failures and degrades to an empty result');

  let callCount = 0;
  await withMockedExecFile((command, args) => {
    if (!args.includes('--list-sessions')) {
      return '';
    }
    callCount += 1;
    if (callCount <= 2) {
      throw new Error('Transient Gemini failure');
    }
    return `  1. Label with spaces [${geminiSessionId}] (active)\n  2. Other label [other-uuid] [ignored]`;
  }, async () => {
    const index = await adapter._resolveGeminiResumeRef(session, {
      timeoutMs: 2000,
      pollIntervalMs: 50
    });
    assert.strictEqual(index, '1');
    assert.strictEqual(callCount, 3);
  });
  console.log('  ✓ resolves after transient failures and tolerates extra text in list output');

  await withMockedExecFile((command, args) => {
    if (!args.includes('--list-sessions')) {
      return '';
    }
    // High index (2) should be preferred if it's the newest
    return '  1. Older session [older-session]\n  2. Newer session [fresh-session]';
  }, async () => {
    const detected = await adapter._detectNewGeminiSessionId('/tmp/gemini-test', [], {
      timeoutMs: 2000,
      pollIntervalMs: 50
    });
    // This will test that it prefers the LAST one when beforeSet is empty
    assert.strictEqual(detected, 'fresh-session');
  });
  console.log('  ✓ prefers the newest (last) visible session when the workdir had no prior sessions');

  // New test: Timeout fallback path coverage
  let detectCallCount = 0;
  await withMockedExecFile((command, args) => {
    if (!args.includes('--list-sessions')) {
      return '';
    }
    detectCallCount++;
    // Always return the same sessions that are already in beforeSet to force timeout
    return '  1. Old session [old-uuid]\n  2. Newer session [new-uuid]';
  }, async () => {
    const beforeSessions = [
      { index: 1, sessionId: 'old-uuid' },
      { index: 2, sessionId: 'new-uuid' }
    ];
    // This should timeout because no NEW sessions are found
    const detected = await adapter._detectNewGeminiSessionId('/tmp/gemini-test', beforeSessions, {
      timeoutMs: 200,
      pollIntervalMs: 50
    });
    assert.strictEqual(detected, null, 'Should return null on timeout if sessions were already known');
  });
  console.log('  ✓ returns null on detection timeout if no new sessions appear and workdir was not empty');

  await withMockedExecFile((command, args) => {
    if (!args.includes('--list-sessions')) {
      return '';
    }
    return '  1. Existing session [known-uuid]';
  }, async () => {
    const startedAt = Date.now();
    const detected = await adapter._detectNewGeminiSessionId('/tmp/gemini-test', [], {
      deadline: Date.now() + 25,
      timeoutMs: 2000,
      pollIntervalMs: 250
    });
    const elapsedMs = Date.now() - startedAt;
    assert.strictEqual(detected, 'known-uuid');
    assert(elapsedMs < 250, `expected explicit deadline to bound detection, took ${elapsedMs}ms`);
  });
  console.log('  ✓ honors caller-supplied deadline during new-session detection');

  const budgetAdapter = new GeminiCliAdapter({ workDir: '/tmp/gemini-test' });
  const budgetWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-gemini-budget-'));
  let capturedInitTimeout = null;
  budgetAdapter._listGeminiSessions = async () => {
    await sleep(20);
    return [];
  };
  budgetAdapter._runGeminiCommand = async (args, options) => {
    capturedInitTimeout = options.timeout;
    return {
      text: 'READY',
      raw: { session_id: 'budget-session-id' },
      stats: {}
    };
  };

  try {
    await budgetAdapter.spawn('budget-session', {
      workDir: budgetWorkDir,
      timeout: 80
    });
    assert(capturedInitTimeout > 0 && capturedInitTimeout < 80, `expected init timeout to use remaining budget, got ${capturedInitTimeout}`);
  } finally {
    await budgetAdapter.terminate('budget-session').catch(() => {});
    fs.rmSync(budgetWorkDir, { recursive: true, force: true });
  }
  console.log('  ✓ bounds Gemini init by remaining spawn deadline after session listing');

  const timeoutWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-gemini-timeout-'));
  const timeoutSignals = [];
  childProcess.spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = (signal) => {
      timeoutSignals.push(signal);
      if (signal === 'SIGKILL') {
        proc.stdout.end();
        proc.stderr.end();
        process.nextTick(() => proc.emit('close', null));
      }
      return true;
    };
    return proc;
  };

  try {
    const chunks = [];
    for await (const chunk of adapter._runGeminiCommandStreaming(['-p', 'never returns'], {
      timeout: 5,
      workDir: timeoutWorkDir
    })) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(timeoutSignals, ['SIGTERM', 'SIGKILL']);
    assert(chunks.some((chunk) => chunk.type === 'error' && chunk.timedOut === true), 'expected timed-out error chunk');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(timeoutWorkDir, { recursive: true, force: true });
  }
  console.log('  ✓ force-kills Gemini streaming commands that ignore SIGTERM');
  
  console.log('Gemini resume resilience tests passed.');
}

run().catch((error) => {
  console.error('Gemini resume resilience tests failed:', error);
  process.exit(1);
}).finally(() => {
  childProcess.execFile = originalExecFile;
  childProcess.execSync = originalExecSync;
  childProcess.spawn = originalSpawn;
});
