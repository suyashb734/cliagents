#!/usr/bin/env node

const assert = require('assert');
const { TerminalStatus } = require('../src/models/terminal-status');
const { handleInitPrompts } = require('../src/orchestration/handoff');

function createMockSessionManager(sequence, output = '') {
  let index = 0;
  const sentKeys = [];

  return {
    sentKeys,
    getStatus() {
      const value = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return value;
    },
    getOutput() {
      return output;
    },
    sendSpecialKey(_terminalId, key) {
      sentKeys.push(key);
    }
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('Handoff init prompt tests\n');

  await test('returns quickly when terminal is already idle', async () => {
    const manager = createMockSessionManager([TerminalStatus.IDLE]);
    const startedAt = Date.now();

    await handleInitPrompts(manager, 'terminal-1', 'codex-cli', 'trace-1', {
      readiness: {
        promptMaxWaitMs: 50,
        promptPollIntervalMs: 5,
        promptSettleDelayMs: 5
      }
    });

    const elapsed = Date.now() - startedAt;
    assert(elapsed < 100, `expected quick return, got ${elapsed}ms`);
    assert.deepStrictEqual(manager.sentKeys, []);
  });

  await test('dismisses Claude settings prompt without waiting for a fixed startup sleep', async () => {
    const manager = createMockSessionManager(
      [TerminalStatus.WAITING_USER_ANSWER, TerminalStatus.IDLE],
      'Settings Error\nContinue without these settings'
    );

    await handleInitPrompts(manager, 'terminal-2', 'claude-code', 'trace-2', {
      readiness: {
        promptMaxWaitMs: 50,
        promptPollIntervalMs: 5,
        promptSettleDelayMs: 5
      }
    });

    assert.deepStrictEqual(manager.sentKeys, ['Down', 'Enter']);
  });

  await test('uses contract-driven prompt handlers when readiness metadata is provided', async () => {
    const manager = createMockSessionManager(
      [TerminalStatus.WAITING_USER_ANSWER, TerminalStatus.IDLE],
      'Custom startup gate'
    );

    await handleInitPrompts(manager, 'terminal-3', 'opencode-cli', 'trace-3', {
      readiness: {
        promptMaxWaitMs: 50,
        promptPollIntervalMs: 5,
        promptSettleDelayMs: 5,
        promptHandlers: [
          {
            matchAny: ['Custom startup gate'],
            actions: ['Escape', 'Enter']
          }
        ],
        promptFallbackAction: null
      }
    });

    assert.deepStrictEqual(manager.sentKeys, ['Escape', 'Enter']);
  });

  await test('runtime adapter contract overrides legacy prompt handlers', async () => {
    const manager = createMockSessionManager(
      [TerminalStatus.WAITING_USER_ANSWER, TerminalStatus.IDLE],
      'Update now\nSkip until next version'
    );
    const runtimeAdapter = {
      getContract() {
        return {
          readiness: {
            promptMaxWaitMs: 50,
            promptPollIntervalMs: 5,
            promptSettleDelayMs: 5,
            promptFallbackAction: null,
            promptHandlers: [
              {
                matchAny: ['Update now', 'Skip until next version'],
                actions: ['Escape'],
                description: 'custom-contract-handler'
              }
            ]
          }
        };
      }
    };

    await handleInitPrompts(manager, 'terminal-4', 'codex-cli', 'trace-4', {
      runtimeAdapter
    });

    assert.deepStrictEqual(manager.sentKeys, ['Escape']);
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

run();
