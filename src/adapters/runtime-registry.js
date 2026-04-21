'use strict';

const GeminiCliAdapter = require('./gemini-cli');
const CodexCliAdapter = require('./codex-cli');
const QwenCliAdapter = require('./qwen-cli');
const OpencodeCliAdapter = require('./opencode-cli');
const ClaudeCodeAdapter = require('./claude-code');
const { ACTIVE_BROKER_ADAPTERS } = require('./active-surface');

const ACTIVE_ADAPTER_FACTORIES = Object.freeze({
  'gemini-cli': (options = {}) => new GeminiCliAdapter(options.geminiCli || {}),
  'codex-cli': (options = {}) => new CodexCliAdapter(options.codexCli || {}),
  'qwen-cli': (options = {}) => new QwenCliAdapter(options.qwenCli || {}),
  'opencode-cli': (options = {}) => new OpencodeCliAdapter(options.opencodeCli || {}),
  'claude-code': (options = {}) => new ClaudeCodeAdapter(options.claudeCode || {})
});

function registerActiveAdapters(manager, options = {}) {
  for (const adapterName of ACTIVE_BROKER_ADAPTERS) {
    const createAdapter = ACTIVE_ADAPTER_FACTORIES[adapterName];
    manager.registerAdapter(adapterName, createAdapter(options));
  }
}

module.exports = {
  ACTIVE_ADAPTER_FACTORIES,
  registerActiveAdapters
};
