#!/usr/bin/env node

const assert = require('assert');

const GeminiCliAdapter = require('../src/adapters/gemini-cli');

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function getModelFromArgs(args) {
  const index = args.indexOf('-m');
  return index >= 0 ? args[index + 1] : null;
}

async function collect(generator) {
  const output = [];
  for await (const item of generator) {
    output.push(item);
  }
  return output;
}

(async () => {
  console.log('Gemini model fallback tests\n');

  await runTest('spawn retries with the next Gemini model on quota error', async () => {
    const adapter = new GeminiCliAdapter({ model: 'gemini-2.5-flash' });
    const attempts = [];

    adapter._listGeminiSessions = () => [];
    adapter._runGeminiCommand = async (args) => {
      const model = getModelFromArgs(args);
      attempts.push(model);
      if (model === 'gemini-2.5-flash') {
        throw new Error('TerminalQuotaError: You have exhausted your capacity on this model.');
      }
      return {
        raw: { session_id: 'gemini-session-123' },
        timedOut: false,
        text: 'Ready.',
        stats: {}
      };
    };

    const result = await adapter.spawn('spawn-fallback', {});
    const session = adapter.sessions.get('spawn-fallback');

    assert.deepStrictEqual(attempts, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert.strictEqual(result.model, 'gemini-2.5-pro');
    assert.strictEqual(session.model, 'gemini-2.5-pro');
  });

  await runTest('json mode send retries with the next Gemini model on quota error', async () => {
    const adapter = new GeminiCliAdapter({ model: 'gemini-2.5-flash' });
    const attempts = [];

    await adapter.spawn('json-fallback', { jsonMode: true });

    adapter._runGeminiCommand = async (args) => {
      const model = getModelFromArgs(args);
      attempts.push(model);
      if (model === 'gemini-2.5-flash') {
        throw new Error('TerminalQuotaError: You have exhausted your capacity on this model.');
      }
      return {
        text: '{"status":"ok"}',
        timedOut: false,
        stats: {}
      };
    };

    const chunks = await collect(adapter.send('json-fallback', 'Return JSON only.'));
    const result = chunks.find((chunk) => chunk.type === 'result');
    const session = adapter.sessions.get('json-fallback');

    assert.deepStrictEqual(attempts, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert(result, 'Expected a final result chunk');
    assert.strictEqual(result.content, '{"status":"ok"}');
    assert.strictEqual(session.model, 'gemini-2.5-pro');
  });

  await runTest('streaming send retries with the next Gemini model before any progress is emitted', async () => {
    const adapter = new GeminiCliAdapter({ model: 'gemini-2.5-flash' });
    const attempts = [];

    adapter.sessions.set('stream-fallback', {
      geminiSessionId: 'gemini-session-456',
      ready: true,
      messageCount: 0,
      systemPrompt: null,
      workDir: process.cwd(),
      model: 'gemini-2.5-flash'
    });

    adapter._resolveGeminiResumeRef = async () => '1';
    adapter._runGeminiCommandStreaming = async function* (args) {
      const model = getModelFromArgs(args);
      attempts.push(model);
      if (model === 'gemini-2.5-flash') {
        yield {
          type: 'error',
          content: 'TerminalQuotaError: You have exhausted your capacity on this model.'
        };
        return;
      }

      yield {
        type: 'result',
        content: 'STREAM_OK',
        stats: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          toolCalls: 0
        }
      };
    };

    const chunks = await collect(adapter.send('stream-fallback', 'Say STREAM_OK'));
    const result = chunks.find((chunk) => chunk.type === 'result');
    const session = adapter.sessions.get('stream-fallback');

    assert.deepStrictEqual(attempts, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert(result, 'Expected a final result chunk');
    assert.strictEqual(result.content, 'STREAM_OK');
    assert.strictEqual(session.model, 'gemini-2.5-pro');
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
})();
