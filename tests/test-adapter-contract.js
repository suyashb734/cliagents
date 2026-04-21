#!/usr/bin/env node

const assert = require('assert');

const BaseLLMAdapter = require('../src/core/base-llm-adapter');
const CodexCliAdapter = require('../src/adapters/codex-cli');
const GeminiCliAdapter = require('../src/adapters/gemini-cli');
const QwenCliAdapter = require('../src/adapters/qwen-cli');
const OpencodeCliAdapter = require('../src/adapters/opencode-cli');
const ClaudeCodeAdapter = require('../src/adapters/claude-code');
const {
  EXECUTION_MODES,
  LIVENESS_STATES,
  TIMEOUT_TYPES,
  validateAdapterContract
} = require('../src/adapters/contract');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

console.log('Adapter contract tests\n');

test('Active broker surface (Codex, Gemini, Qwen, OpenCode, Claude) publishes explicit contract metadata', () => {
  const adapters = [
    new CodexCliAdapter(),
    new GeminiCliAdapter(),
    new QwenCliAdapter(),
    new OpencodeCliAdapter(),
    new ClaudeCodeAdapter()
  ];

  for (const adapter of adapters) {
    const validation = validateAdapterContract(adapter);
    assert.strictEqual(validation.valid, true, `${adapter.name} missing methods: ${validation.missingMethods.join(', ')}`);

    // Strengthened required-method inheritance check:
    // Active adapters must not rely on the BaseLLMAdapter placeholders for session tracking
    // or the throw-only implementations of abstract methods.
    const mustOverride = [
      'isAvailable',
      'spawn',
      'send',
      'terminate',
      'isSessionActive',
      'getActiveSessions'
    ];
    for (const method of mustOverride) {
      assert.notStrictEqual(
        adapter[method],
        BaseLLMAdapter.prototype[method],
        `${adapter.name} must provide its own ${method} implementation (inherited BaseLLMAdapter placeholder is insufficient for the active surface)`
      );
    }

    assert(validation.capabilities, `${adapter.name} should publish capabilities`);
    assert(validation.contract, `${adapter.name} should publish contract`);
    assert.strictEqual(validation.contract.executionMode, EXECUTION_MODES.DIRECT_SESSION);
    assert(validation.contract.readiness, `${adapter.name} should publish readiness metadata`);
    assert(Number.isFinite(validation.contract.readiness.initTimeoutMs), `${adapter.name} missing readiness initTimeoutMs`);
    assert(validation.contract.readiness.initTimeoutMs >= 1000, `${adapter.name} initTimeoutMs should be sane`);
    assert(Array.isArray(validation.contract.readiness.promptHandlers), `${adapter.name} missing readiness prompt handlers array`);

    // Strengthened liveness and failure contract assertions
    assert(Array.isArray(validation.contract.failureClasses), `${adapter.name} missing failureClasses`);
    assert(validation.contract.failureClasses.includes('auth'), `${adapter.name} missing auth failure class`);
    assert(validation.contract.failureClasses.includes('rate_limit'), `${adapter.name} missing rate_limit failure class`);
    assert(validation.contract.failureClasses.includes('tool_error'), `${adapter.name} missing tool_error failure class`);

    assert(Array.isArray(validation.contract.runStates), `${adapter.name} missing runStates`);
    assert(validation.contract.runStates.includes('abandoned'), `${adapter.name} missing abandoned state`);
    assert.strictEqual(validation.contract.requiredMethods.includes('classifyFailure'), true, `${adapter.name} should require classifyFailure`);

    assert(validation.contract.timeoutTypes, `${adapter.name} missing timeoutTypes`);
    assert.strictEqual(validation.contract.timeoutTypes.RESPONSE, TIMEOUT_TYPES.RESPONSE);
    assert(validation.contract.livenessStates, `${adapter.name} missing livenessStates`);
    assert.strictEqual(validation.contract.livenessStates.ALIVE, LIVENESS_STATES.ALIVE);

    assert.strictEqual(typeof adapter.classifyFailure, 'function', `${adapter.name} missing classifyFailure implementation`);
    assert.strictEqual(typeof adapter.getTimeoutInfo, 'function', `${adapter.name} missing getTimeoutInfo implementation`);
    assert(validation.contract.optionalMethods.includes('getSessionLiveness'), `${adapter.name} should advertise getSessionLiveness`);
    assert(validation.contract.optionalMethods.includes('recordHeartbeat'), `${adapter.name} should advertise recordHeartbeat`);
    assert(validation.contract.optionalMethods.includes('getTimeoutInfo'), `${adapter.name} should advertise getTimeoutInfo`);

    assert.strictEqual(validation.capabilities.usesOfficialCli, true);
    assert.strictEqual(validation.capabilities.supportsMultiTurn, true);
    assert.strictEqual(validation.capabilities.supportsStreaming, true);
  }
});

test('Base adapter provides default failure classification and liveness helpers', () => {
  const adapter = new BaseLLMAdapter();

  assert.strictEqual(adapter.classifyFailure(new Error('request timed out waiting for response')), 'timeout');
  assert.strictEqual(adapter.classifyFailure(new Error('quota exceeded by provider')), 'rate_limit');
  assert.strictEqual(adapter.classifyFailure(new Error('tool call failed during execution')), 'tool_error');
  assert.strictEqual(adapter.classifyFailure(new Error('unknown meltdown')), 'unknown');

  const timeoutInfo = adapter.getTimeoutInfo();
  assert.strictEqual(timeoutInfo.defaultTimeoutMs, 60000);
  assert.strictEqual(timeoutInfo.defaultTimeoutType, TIMEOUT_TYPES.RESPONSE);

  const missing = adapter.getSessionLiveness('missing');
  assert.strictEqual(missing.state, LIVENESS_STATES.DEAD);

  adapter.recordHeartbeat('session-1');
  const active = adapter.getSessionLiveness('session-1');
  assert.strictEqual(active.state, LIVENESS_STATES.ALIVE);
  assert.strictEqual(typeof active.lastHeartbeat, 'number');
});

test('sendAndWait ignores thinking progress while preserving assistant-visible output', async () => {
  class StreamingAdapter extends BaseLLMAdapter {
    async isAvailable() {
      return true;
    }

    async spawn() {
      return { sessionId: 'streaming' };
    }

    async *send() {
      yield { type: 'progress', progressType: 'thinking', content: 'internal reasoning' };
      yield { type: 'progress', progressType: 'assistant', content: 'visible draft ' };
      yield { type: 'text', content: 'final answer' };
      yield { type: 'result', content: 'visible draft final answer' };
    }

    async terminate() {}

    isSessionActive() {
      return true;
    }

    getActiveSessions() {
      return ['streaming'];
    }
  }

  const adapter = new StreamingAdapter();
  const response = await adapter.sendAndWait('streaming', 'hello');

  assert.strictEqual(response.text, 'visible draft final answer');
  assert.strictEqual(response.result, 'visible draft final answer');
  assert.strictEqual(response.metadata.truncated, false);
  assert.strictEqual(response.metadata.missingResult, false);
});

test('Contract validator rejects subclasses that inherit required base methods unchanged', () => {
  class IncompleteAdapter extends BaseLLMAdapter {
    constructor() {
      super();
      this.name = 'incomplete';
    }

    getCapabilities() {
      return { executionMode: EXECUTION_MODES.DIRECT_SESSION };
    }

    getContract() {
      return { executionMode: EXECUTION_MODES.DIRECT_SESSION };
    }
  }

  const validation = validateAdapterContract(new IncompleteAdapter());
  assert.strictEqual(validation.valid, false);
  assert(validation.inheritedRequiredMethods.includes('isAvailable'));
  assert(validation.inheritedRequiredMethods.includes('spawn'));
  assert(validation.inheritedRequiredMethods.includes('send'));
  assert(validation.inheritedRequiredMethods.includes('terminate'));
  assert(validation.inheritedRequiredMethods.includes('isSessionActive'));
  assert(validation.inheritedRequiredMethods.includes('getActiveSessions'));
});

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
    } catch (error) {
      console.error(`  ❌ ${name}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

run().catch((error) => {
  console.error(`  ❌ Test runner failed: ${error.message}`);
  process.exit(1);
});
