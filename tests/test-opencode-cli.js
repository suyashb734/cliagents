#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OpencodeCliAdapter = require('../src/adapters/opencode-cli');

function isSkippableProviderFailure(message = '') {
  const text = String(message).toLowerCase();
  return [
    'not authenticated',
    'authentication failed',
    'please log in',
    'login required',
    'api key',
    'quota',
    'rate limit',
    'resourceexhausted',
    'no active provider',
    'no provider',
    'request timed out',
    'timed out'
  ].some((pattern) => text.includes(pattern));
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

async function main() {
  await runTest('OpenCode send validates allowedTools and places the prompt after flags', async () => {
    const adapter = new OpencodeCliAdapter({ timeout: 1000 });
    const sessionId = 'opencode-unit-send';
    await adapter.spawn(sessionId, { workDir: process.cwd(), model: 'openai/gpt-5' });

    let capturedArgs = null;
    adapter._runOpencodeCommandStreaming = async function* (args) {
      capturedArgs = args;
      yield {
        type: 'result',
        content: '6',
        stats: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2
        }
      };
    };

    const response = await adapter.sendAndWait(sessionId, '--help me with this', { allowedTools: ['Read', 'Write'] });
    assert.strictEqual(String(response.result || '').trim(), '6');
    assert.deepStrictEqual(
      capturedArgs,
      [
        'run',
        '--model', 'openai/gpt-5',
        '--format', 'json',
        '--dangerously-skip-permissions',
        '--allowed-tools', 'Read',
        '--allowed-tools', 'Write',
        '--help me with this'
      ]
    );

    await assert.rejects(
      adapter.sendAndWait(sessionId, 'hello', { allowedTools: ['Read', 'bad tool'] }),
      /Invalid tool name/
    );

    await adapter.terminate(sessionId);
  });

  await runTest('OpenCode background discovery swallows synchronous spawn failures', async () => {
    const adapter = new OpencodeCliAdapter({ timeout: 1000 });
    const unhandledRejections = [];
    const handleUnhandledRejection = (error) => {
      unhandledRejections.push(error);
    };

    adapter._spawnProcess = () => {
      throw new Error('spawn failed');
    };

    process.on('unhandledRejection', handleUnhandledRejection);

    try {
      assert.deepStrictEqual(adapter.getAvailableModels(), adapter.availableModels);
      assert.deepStrictEqual(adapter.getProviderSummary(), []);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandledRejections, []);
    } finally {
      process.removeListener('unhandledRejection', handleUnhandledRejection);
    }
  });

  const adapter = new OpencodeCliAdapter({ timeout: 120000 });

  if (!(await adapter.isAvailable())) {
    console.log('⏭️  OpenCode CLI not installed; skipping smoke test');
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-opencode-smoke-'));
  const oneshotSessionId = 'opencode-smoke-oneshot';
  const memorySessionId = 'opencode-smoke-memory';

  try {
    await adapter.spawn(oneshotSessionId, { workDir });

    const ready = await adapter.sendAndWait(oneshotSessionId, 'Reply with just: OPENCODE_SMOKE_READY');
    assert.strictEqual(String(ready.result || '').trim(), 'OPENCODE_SMOKE_READY');

    await adapter.terminate(oneshotSessionId);

    await adapter.spawn(memorySessionId, { workDir });

    const remember = await adapter.sendAndWait(memorySessionId, 'Remember CERULEANFOX. Reply READY.');
    assert(
      String(remember.result || '').trim().length > 0,
      'Expected a non-empty acknowledgment after the remember step'
    );

    const recall = await adapter.sendAndWait(memorySessionId, 'What exact token did I ask you to remember? Reply just the token.');
    assert.strictEqual(String(recall.result || '').trim(), 'CERULEANFOX');

    console.log('✅ OpenCode adapter handles one-shot and multi-turn session resume');
  } catch (error) {
    if (isSkippableProviderFailure(error.message)) {
      console.log(`⏭️  OpenCode provider unavailable; skipping smoke test (${error.message})`);
      return;
    }
    throw error;
  } finally {
    await adapter.terminate(oneshotSessionId);
    await adapter.terminate(memorySessionId);
  }
}

main().catch((error) => {
  console.error('OpenCode smoke test failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
