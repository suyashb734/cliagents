#!/usr/bin/env node

'use strict';

const assert = require('assert');

const {
  applyLocalSmokeAuthEnv,
  classifyFailure,
  getRetryPolicy,
  hasConfiguredApiKey,
  parseArgs,
  restoreLocalSmokeAuthEnv
} = require('../scripts/track-a-launch-smoke');

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
}

run('classifyFailure identifies binary_not_found', () => {
  assert.strictEqual(classifyFailure('command not found: codex'), 'binary_not_found');
});

run('classifyFailure identifies auth_failed', () => {
  assert.strictEqual(classifyFailure('401 Unauthorized from provider'), 'auth_failed');
  assert.strictEqual(classifyFailure('anything', 'auth_required'), 'auth_failed');
});

run('classifyFailure identifies terminal_busy', () => {
  assert.strictEqual(classifyFailure('terminal_busy from route'), 'terminal_busy');
  assert.strictEqual(classifyFailure('Terminal abc is busy (processing).'), 'terminal_busy');
  assert.strictEqual(classifyFailure('anything', 'terminal_busy'), 'terminal_busy');
});

run('classifyFailure identifies rate_limited', () => {
  assert.strictEqual(classifyFailure('rate limit exceeded by provider'), 'rate_limited');
  assert.strictEqual(classifyFailure('anything', 'quota_exceeded'), 'rate_limited');
});

run('classifyFailure identifies timeout', () => {
  assert.strictEqual(classifyFailure('request timed out after 60s'), 'timeout');
  assert.strictEqual(classifyFailure('anything', 'timeout'), 'timeout');
});

run('classifyFailure identifies process_exit', () => {
  assert.strictEqual(classifyFailure('process exited with code 1'), 'process_exit');
});

run('getRetryPolicy returns expected retry counts', () => {
  assert.deepStrictEqual(getRetryPolicy('terminal_busy'), { maxRetries: 1, delayMs: 1000 });
  assert.deepStrictEqual(getRetryPolicy('binary_not_found'), { maxRetries: 0, delayMs: 0 });
  assert.deepStrictEqual(getRetryPolicy('auth_failed'), { maxRetries: 0, delayMs: 0 });
  assert.deepStrictEqual(getRetryPolicy('root_attach_required'), { maxRetries: 0, delayMs: 0 });
  assert.deepStrictEqual(getRetryPolicy('rate_limited'), { maxRetries: 2, delayMs: 15000 });
  assert.deepStrictEqual(getRetryPolicy('timeout'), { maxRetries: 2, delayMs: 5000 });
  assert.deepStrictEqual(getRetryPolicy('process_exit'), { maxRetries: 1, delayMs: 3000 });
});

run('parseArgs defaults apiKey from canonical env when --api-key is omitted', () => {
  withEnv(
    {
      CLIAGENTS_API_KEY: 'env-secret',
      CLI_AGENTS_API_KEY: undefined
    },
    () => {
      const parsed = parseArgs(['--adapters', 'codex-cli,gemini-cli']);
      assert.strictEqual(parsed.apiKey, 'env-secret');
    }
  );
});

run('parseArgs defaults apiKey from legacy env alias when canonical is absent', () => {
  withEnv(
    {
      CLIAGENTS_API_KEY: undefined,
      CLI_AGENTS_API_KEY: 'legacy-secret'
    },
    () => {
      const parsed = parseArgs(['--adapters', 'codex-cli,gemini-cli']);
      assert.strictEqual(parsed.apiKey, 'legacy-secret');
    }
  );
});

run('parseArgs keeps --api-key as an explicit override over env defaults', () => {
  withEnv(
    {
      CLIAGENTS_API_KEY: 'env-secret',
      CLI_AGENTS_API_KEY: 'legacy-secret'
    },
    () => {
      const parsed = parseArgs([
        '--adapters', 'codex-cli,gemini-cli',
        '--base-url', 'https://example.test',
        '--api-key', 'arg-secret',
        '--timeout-ms', '20000',
        '--require-successful-adapters', '2',
        '--json',
        '--quiet'
      ]);

      assert.deepStrictEqual(parsed.adapters, ['codex-cli', 'gemini-cli']);
      assert.strictEqual(parsed.baseUrl, 'https://example.test');
      assert.strictEqual(parsed.apiKey, 'arg-secret');
      assert.strictEqual(parsed.timeoutMs, 20000);
      assert.strictEqual(parsed.requireSuccessfulAdapters, 2);
      assert.strictEqual(parsed.json, true);
      assert.strictEqual(parsed.quiet, true);
    }
  );
});

run('hasConfiguredApiKey checks canonical and legacy env aliases', () => {
  assert.strictEqual(
    hasConfiguredApiKey({ CLIAGENTS_API_KEY: ' canonical ', CLI_AGENTS_API_KEY: '' }),
    true
  );
  assert.strictEqual(
    hasConfiguredApiKey({ CLIAGENTS_API_KEY: '', CLI_AGENTS_API_KEY: ' legacy ' }),
    true
  );
  assert.strictEqual(
    hasConfiguredApiKey({ CLIAGENTS_API_KEY: ' ', CLI_AGENTS_API_KEY: '\n' }),
    false
  );
});

run('applyLocalSmokeAuthEnv enables localhost unauth mode only when no API key is configured', () => {
  const env = {};
  const state = applyLocalSmokeAuthEnv(env);
  assert.strictEqual(state.changed, true);
  assert.strictEqual(env.CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST, '1');
  restoreLocalSmokeAuthEnv(state, env);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST'), false);
});

run('applyLocalSmokeAuthEnv preserves existing localhost unauth env and restores original value', () => {
  const env = { CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST: '1' };
  const state = applyLocalSmokeAuthEnv(env);
  assert.strictEqual(state.changed, false);
  assert.strictEqual(env.CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST, '1');
  restoreLocalSmokeAuthEnv(state, env);
  assert.strictEqual(env.CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST, '1');
});

run('applyLocalSmokeAuthEnv does not enable localhost unauth mode when API key is configured', () => {
  const env = { CLIAGENTS_API_KEY: 'configured-key' };
  const state = applyLocalSmokeAuthEnv(env);
  assert.strictEqual(state.changed, false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST'), false);
  restoreLocalSmokeAuthEnv(state, env);
});

console.log('✅ test-track-a-launch-smoke: all assertions passed');
