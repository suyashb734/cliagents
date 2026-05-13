'use strict';

const { spawn } = require('child_process');

const DEFAULT_NOTIFY_STATUSES = Object.freeze([
  'idle',
  'completed',
  'waiting_permission',
  'waiting_user_answer',
  'error'
]);

const STATUS_ALIASES = Object.freeze({
  done: ['idle', 'completed'],
  blocked: ['waiting_permission', 'waiting_user_answer'],
  attention: ['waiting_permission', 'waiting_user_answer', 'error'],
  all: DEFAULT_NOTIFY_STATUSES
});

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function isDisabled(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'none' || normalized === 'disabled';
}

function normalizeNotifyStatuses(value) {
  const entries = splitList(value);
  if (entries.length === 0) {
    return [...DEFAULT_NOTIFY_STATUSES];
  }

  const statuses = [];
  for (const entry of entries) {
    if (STATUS_ALIASES[entry]) {
      statuses.push(...STATUS_ALIASES[entry]);
    } else {
      statuses.push(entry);
    }
  }
  return unique(statuses);
}

function normalizeChannels(value, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const webhookUrl = String(env.CLIAGENTS_NOTIFY_WEBHOOK_URL || env.CLIAGENTS_NOTIFICATION_WEBHOOK_URL || '').trim();
  const telegramBotToken = String(env.CLIAGENTS_TELEGRAM_BOT_TOKEN || '').trim();
  const telegramChatId = String(env.CLIAGENTS_TELEGRAM_CHAT_ID || '').trim();
  const hasTelegram = Boolean(telegramBotToken && telegramChatId);

  if (value && isDisabled(value)) {
    return [];
  }

  const entries = splitList(value);
  if (entries.length === 0) {
    return [];
  }

  const expanded = [];
  for (const entry of entries) {
    if (entry === 'all') {
      if (platform === 'darwin') expanded.push('macos');
      if (webhookUrl) expanded.push('webhook');
      if (hasTelegram) expanded.push('telegram');
    } else {
      expanded.push(entry);
    }
  }
  return unique(expanded);
}

function resolveManagedRootNotificationConfig(env = process.env, options = {}) {
  const channelValue = env.CLIAGENTS_NOTIFICATIONS || env.CLIAGENTS_NOTIFY_CHANNELS || '';
  const channels = normalizeChannels(channelValue, {
    env,
    platform: options.platform || process.platform
  });
  const webhookUrl = String(env.CLIAGENTS_NOTIFY_WEBHOOK_URL || env.CLIAGENTS_NOTIFICATION_WEBHOOK_URL || '').trim() || null;
  const telegramBotToken = String(env.CLIAGENTS_TELEGRAM_BOT_TOKEN || '').trim() || null;
  const telegramChatId = String(env.CLIAGENTS_TELEGRAM_CHAT_ID || '').trim() || null;

  return {
    enabled: channels.length > 0,
    channels,
    statuses: normalizeNotifyStatuses(env.CLIAGENTS_NOTIFY_ON),
    webhookUrl,
    telegramBotToken,
    telegramChatId,
    timeoutMs: Math.max(Number(env.CLIAGENTS_NOTIFY_TIMEOUT_MS || 5000), 1000)
  };
}

function truncate(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeAppleScriptString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function buildNotificationText(payload = {}) {
  const adapter = payload.adapter || 'agent';
  const status = payload.status || 'done';
  const workspace = payload.workDir ? ` in ${payload.workDir}` : '';
  const model = payload.model ? ` (${payload.model})` : '';
  const summary = truncate(payload.summary || payload.attentionMessage || '', 180);
  return {
    title: 'cliagents',
    subtitle: truncate(`${adapter}${model}: ${status}`, 120),
    body: summary || truncate(`Managed root ${payload.rootSessionId || payload.terminalId || ''}${workspace}`, 180)
  };
}

function runMacosNotification(payload, dependencies = {}) {
  const spawnImpl = dependencies.spawn || spawn;
  const text = buildNotificationText(payload);
  const script = [
    'display notification ',
    `"${escapeAppleScriptString(text.body)}"`,
    ` with title "${escapeAppleScriptString(text.title)}"`,
    ` subtitle "${escapeAppleScriptString(text.subtitle)}"`
  ].join('');

  return new Promise((resolve) => {
    const child = spawnImpl('osascript', ['-e', script], {
      stdio: 'ignore'
    });
    child.on('error', (error) => resolve({ ok: false, channel: 'macos', error: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, channel: 'macos', code }));
  });
}

async function postJson(url, body, dependencies = {}, timeoutMs = 5000) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch_unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

class ManagedRootNotifier {
  constructor(config = {}, dependencies = {}) {
    this.config = {
      enabled: Boolean(config.enabled),
      channels: Array.isArray(config.channels) ? config.channels : [],
      statuses: Array.isArray(config.statuses) ? config.statuses : [...DEFAULT_NOTIFY_STATUSES],
      webhookUrl: config.webhookUrl || null,
      telegramBotToken: config.telegramBotToken || null,
      telegramChatId: config.telegramChatId || null,
      timeoutMs: Math.max(Number(config.timeoutMs || 5000), 1000)
    };
    this.dependencies = dependencies;
  }

  isEnabled() {
    return this.config.enabled && this.config.channels.length > 0;
  }

  shouldNotifyStatus(status) {
    return this.config.statuses.includes(String(status || '').toLowerCase());
  }

  async notifyManagedRootStatus(payload = {}) {
    if (!this.isEnabled() || !this.shouldNotifyStatus(payload.status)) {
      return [];
    }

    const deliveries = [];
    for (const channel of this.config.channels) {
      if (channel === 'macos') {
        deliveries.push(runMacosNotification(payload, this.dependencies));
      } else if (channel === 'webhook' && this.config.webhookUrl) {
        deliveries.push(postJson(this.config.webhookUrl, payload, this.dependencies, this.config.timeoutMs)
          .then((result) => ({ ...result, channel: 'webhook' })));
      } else if (channel === 'telegram' && this.config.telegramBotToken && this.config.telegramChatId) {
        const text = buildNotificationText(payload);
        const telegramUrl = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
        deliveries.push(postJson(telegramUrl, {
          chat_id: this.config.telegramChatId,
          text: [text.subtitle, text.body].filter(Boolean).join('\n'),
          disable_web_page_preview: true
        }, this.dependencies, this.config.timeoutMs).then((result) => ({ ...result, channel: 'telegram' })));
      }
    }

    return Promise.all(deliveries);
  }
}

function createManagedRootNotifierFromEnv(env = process.env, dependencies = {}) {
  return new ManagedRootNotifier(resolveManagedRootNotificationConfig(env, dependencies), dependencies);
}

module.exports = {
  DEFAULT_NOTIFY_STATUSES,
  ManagedRootNotifier,
  buildNotificationText,
  createManagedRootNotifierFromEnv,
  resolveManagedRootNotificationConfig
};
