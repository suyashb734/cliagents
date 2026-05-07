#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const QwenCliAdapter = require('../src/adapters/qwen-cli');

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

async function collect(generator) {
  const output = [];
  for await (const item of generator) {
    output.push(item);
  }
  return output;
}

async function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), timeoutMs);
    })
  ]);
}

(async () => {
  console.log('Qwen adapter tests\n');

  await runTest('send converts provider auth text into an error chunk', async () => {
    const adapter = new QwenCliAdapter({ timeout: 1000 });
    await adapter.spawn('qwen-auth-error', { workDir: process.cwd() });

    adapter._runQwenCommandStreaming = async function* () {
      yield {
        type: 'result',
        content: '[API Error: 401 invalid access token or token expired]',
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        }
      };
    };

    const chunks = await collect(adapter.send('qwen-auth-error', 'Say hello.'));
    const errorChunk = chunks.find((chunk) => chunk.type === 'error');
    const resultChunk = chunks.find((chunk) => chunk.type === 'result');

    assert(errorChunk, 'Expected an error chunk');
    assert.strictEqual(resultChunk, undefined, 'Did not expect a result chunk');
    assert.strictEqual(errorChunk.failureClass, 'auth');
    assert(errorChunk.content.includes('Qwen provider authentication failed'));
  });

  await runTest('sendAndWait throws when Qwen returns provider auth text', async () => {
    const adapter = new QwenCliAdapter({ timeout: 1000 });
    await adapter.spawn('qwen-auth-throw', { workDir: process.cwd() });

    adapter._runQwenCommandStreaming = async function* () {
      yield {
        type: 'result',
        content: '[API Error: 401 invalid access token or token expired]',
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        }
      };
    };

    await assert.rejects(
      adapter.sendAndWait('qwen-auth-throw', 'Say hello.'),
      /Qwen provider authentication failed/
    );
  });

  await runTest('_getQwenPath falls back to bare qwen command when which has no stdout payload', async () => {
    const adapter = new QwenCliAdapter({ timeout: 1000 });
    adapter.isAvailable = async () => true;
    adapter._spawnProcess = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      process.nextTick(() => {
        proc.emit('close', 0);
      });
      return proc;
    };

    const resolved = await adapter._getQwenPath();
    assert.strictEqual(resolved, 'qwen');
  });

  await runTest('_getQwenPath caches qwen-not-found results without repeated which calls', async () => {
    const adapter = new QwenCliAdapter({ timeout: 1000 });
    let spawnCount = 0;
    adapter.isAvailable = async () => {
      throw new Error('isAvailable should not be called for cached not-found results');
    };
    adapter._spawnProcess = () => {
      spawnCount += 1;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      process.nextTick(() => {
        proc.emit('close', 1);
      });
      return proc;
    };

    const first = await adapter._getQwenPath();
    const second = await adapter._getQwenPath();
    assert.strictEqual(first, null);
    assert.strictEqual(second, null);
    assert.strictEqual(spawnCount, 1);
  });

  await runTest('_runQwenCommandStreaming escalates to SIGKILL when timeout ignores SIGTERM', async () => {
    const adapter = new QwenCliAdapter({ timeout: 20, terminationGraceMs: 10 });
    const killSignals = [];

    adapter._getQwenPath = async () => '/usr/local/bin/qwen';
    adapter._spawnProcess = () => {
      const proc = new EventEmitter();
      proc.stdout = Readable.from([]);
      proc.stderr = new EventEmitter();
      proc.stdin = { end() {} };
      proc.exitCode = null;
      proc.signalCode = null;
      proc.killed = false;
      proc.kill = (signal) => {
        killSignals.push(signal);
        proc.killed = true;
        if (signal === 'SIGKILL') {
          proc.signalCode = 'SIGKILL';
          process.nextTick(() => proc.emit('close', 137));
        }
        return true;
      };
      return proc;
    };

    const chunks = await withTimeout(collect(adapter._runQwenCommandStreaming(['-p', 'timeout-test'], {
      timeout: 20,
      sessionId: 'qwen-timeout-escalation',
      workDir: process.cwd()
    })), 1000, 'timeout path did not settle');

    const errorChunk = chunks.find((chunk) => chunk.type === 'error');
    assert(errorChunk, 'Expected an error chunk after timeout');
    assert.strictEqual(errorChunk.timedOut, true, 'Timeout error should be marked timedOut=true');
    assert.deepStrictEqual(
      killSignals.slice(0, 2),
      ['SIGTERM', 'SIGKILL'],
      `Expected SIGTERM then SIGKILL escalation, got ${killSignals.join(', ')}`
    );
  });

  await runTest('send rejects invalid allowedTools entries', async () => {
    const adapter = new QwenCliAdapter({ timeout: 1000 });
    await adapter.spawn('qwen-invalid-tools', { workDir: process.cwd() });

    await assert.rejects(
      collect(adapter.send('qwen-invalid-tools', 'Say hello.', { allowedTools: ['Read', 'bad tool'] })),
      /Invalid tool name/
    );
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
})();
