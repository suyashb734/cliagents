#!/usr/bin/env node

'use strict';

const assert = require('assert');

const {
  createManagedRootNotifierFromEnv,
  resolveManagedRootNotificationConfig
} = require('../src/services/managed-root-notifier');
const {
  PersistentSessionManager,
  TerminalStatus
} = require('../src/tmux/session-manager');

async function testNotificationConfigDefaults() {
  const config = resolveManagedRootNotificationConfig({}, { platform: 'darwin' });
  assert.strictEqual(config.enabled, true);
  assert.deepStrictEqual(config.channels, ['macos']);
  assert(config.statuses.includes('idle'));
  assert(config.statuses.includes('error'));

  const disabled = resolveManagedRootNotificationConfig({
    CLIAGENTS_NOTIFICATIONS: 'off',
    CLIAGENTS_NOTIFY_WEBHOOK_URL: 'https://example.invalid/hook'
  }, { platform: 'darwin' });
  assert.strictEqual(disabled.enabled, false);
  assert.deepStrictEqual(disabled.channels, []);

  const webhookAndTelegram = resolveManagedRootNotificationConfig({
    CLIAGENTS_NOTIFY_WEBHOOK_URL: 'https://example.invalid/hook',
    CLIAGENTS_TELEGRAM_BOT_TOKEN: 'token:secret',
    CLIAGENTS_TELEGRAM_CHAT_ID: '12345',
    CLIAGENTS_NOTIFY_ON: 'done,blocked,error'
  }, { platform: 'linux' });
  assert.deepStrictEqual(webhookAndTelegram.channels, ['webhook', 'telegram']);
  assert.deepStrictEqual(webhookAndTelegram.statuses, [
    'idle',
    'completed',
    'waiting_permission',
    'waiting_user_answer',
    'error'
  ]);
}

async function testWebhookAndTelegramDelivery() {
  const calls = [];
  const notifier = createManagedRootNotifierFromEnv({
    CLIAGENTS_NOTIFICATIONS: 'webhook,telegram',
    CLIAGENTS_NOTIFY_WEBHOOK_URL: 'https://example.invalid/hook',
    CLIAGENTS_TELEGRAM_BOT_TOKEN: 'token:secret',
    CLIAGENTS_TELEGRAM_CHAT_ID: '12345'
  }, {
    platform: 'linux',
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    }
  });

  const results = await notifier.notifyManagedRootStatus({
    type: 'managed_root_status',
    terminalId: 'term-1',
    rootSessionId: 'root-1',
    adapter: 'codex-cli',
    status: 'idle',
    model: 'gpt-5.5',
    summary: 'Finished the requested work.'
  });

  assert.strictEqual(results.length, 2);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'https://example.invalid/hook');
  assert.strictEqual(calls[0].body.rootSessionId, 'root-1');
  assert(calls[1].url.includes('https://api.telegram.org/bottoken:secret/sendMessage'));
  assert.strictEqual(calls[1].body.chat_id, '12345');
  assert(calls[1].body.text.includes('codex-cli'));
}

async function testManagedRootStatusTransitionDispatch() {
  const delivered = [];
  const manager = new PersistentSessionManager({
    managedRootNotificationMonitor: false,
    managedRootNotifier: {
      isEnabled: () => true,
      shouldNotifyStatus: (status) => status === TerminalStatus.IDLE || status === TerminalStatus.ERROR,
      notifyManagedRootStatus: async (payload) => {
        delivered.push(payload);
        return [{ ok: true, channel: 'test' }];
      }
    }
  });

  const emitted = [];
  manager.on('managed-root-notification', (payload) => emitted.push(payload));

  const managedRoot = {
    terminalId: 'term-managed-root',
    rootSessionId: 'root-managed',
    adapter: 'codex-cli',
    role: 'main',
    sessionKind: 'main',
    sessionMetadata: {
      managedLaunch: true
    },
    status: TerminalStatus.PROCESSING,
    workDir: '/tmp/project',
    effectiveModel: 'gpt-5.5',
    effectiveEffort: 'xhigh',
    activeRun: null
  };

  manager._applyStatusUpdate(managedRoot, TerminalStatus.IDLE, {
    output: 'assistant: Finished the implementation and tests.'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(delivered[0].rootSessionId, 'root-managed');
  assert.strictEqual(delivered[0].status, TerminalStatus.IDLE);
  assert.strictEqual(delivered[0].previousStatus, TerminalStatus.PROCESSING);
  assert.strictEqual(delivered[0].model, 'gpt-5.5');
  assert(delivered[0].summary.includes('Finished the implementation'));

  const worker = {
    ...managedRoot,
    terminalId: 'term-worker',
    rootSessionId: 'root-worker',
    role: 'worker',
    sessionKind: 'implementer',
    sessionMetadata: {},
    status: TerminalStatus.PROCESSING
  };
  manager._applyStatusUpdate(worker, TerminalStatus.IDLE, {
    output: 'assistant: Worker done.'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(delivered.length, 1, 'worker transitions should not trigger managed-root notifications');
}

async function run() {
  await testNotificationConfigDefaults();
  await testWebhookAndTelegramDelivery();
  await testManagedRootStatusTransitionDispatch();
  console.log('✅ Managed root notification config, delivery, and status dispatch work');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
