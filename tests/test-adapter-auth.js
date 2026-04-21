#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getAdapterStatus,
  getClaudeLocalAuthState,
  getGeminiLocalAuthState,
  getQwenLocalAuthState,
  isAdapterAuthenticated
} = require('../src/utils/adapter-auth');

function makeTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function run() {
  const originalHome = process.env.HOME;
  const homeDir = makeTempHome('cliagents-adapter-auth-');

  try {
    process.env.HOME = homeDir;

    writeJson(path.join(homeDir, '.gemini', 'settings.json'), {
      security: {
        auth: {
          selectedType: 'oauth-personal'
        }
      }
    });
    writeJson(path.join(homeDir, '.gemini', 'google_accounts.json'), {
      active: null,
      old: ['old@example.com']
    });

    const unauthState = getGeminiLocalAuthState();
    assert.strictEqual(unauthState.selectedAuthType, 'oauth-personal');
    assert.strictEqual(unauthState.activeAccount, null);
    assert.strictEqual(unauthState.hasOauthCreds, false);

    const unauthFastCheck = isAdapterAuthenticated('gemini-cli');
    assert.strictEqual(unauthFastCheck.authenticated, false);
    assert(unauthFastCheck.reason.includes('no active signed-in Google account'));

    const unauthStatus = await getAdapterStatus('gemini-cli', {
      async isAvailable() {
        return true;
      }
    });
    assert.strictEqual(unauthStatus.authenticated, false);
    assert.strictEqual(unauthStatus.activeAccount, null);
    assert.strictEqual(unauthStatus.selectedAuthType, 'oauth-personal');
    assert(unauthStatus.authReason.includes('no active signed-in account'));

    writeJson(path.join(homeDir, '.gemini', 'google_accounts.json'), {
      active: 'active@example.com',
      old: ['old@example.com']
    });

    const missingCredsStatus = await getAdapterStatus('gemini-cli', {
      async isAvailable() {
        return true;
      }
    });
    assert.strictEqual(missingCredsStatus.authenticated, false);
    assert.strictEqual(missingCredsStatus.activeAccount, 'active@example.com');
    assert(missingCredsStatus.authReason.includes('OAuth credentials are missing'));

    writeJson(path.join(homeDir, '.gemini', 'google_accounts.json'), {
      active: 'active@example.com',
      old: ['old@example.com']
    });
    writeJson(path.join(homeDir, '.gemini', 'oauth_creds.json'), {
      refresh_token: 'test-refresh-token'
    });

    const authState = getGeminiLocalAuthState();
    assert.strictEqual(authState.activeAccount, 'active@example.com');
    assert.strictEqual(authState.hasOauthCreds, true);

    const authFastCheck = isAdapterAuthenticated('gemini-cli');
    assert.strictEqual(authFastCheck.authenticated, true);
    assert(authFastCheck.reason.includes('active@example.com'));

    const authStatus = await getAdapterStatus('gemini-cli', {
      async isAvailable() {
        return true;
      }
    });
    assert.strictEqual(authStatus.authenticated, 'likely');
    assert.strictEqual(authStatus.activeAccount, 'active@example.com');
    assert(authStatus.authReason.includes('active@example.com'));

    writeJson(path.join(homeDir, '.qwen', 'settings.json'), {
      security: {
        auth: {
          selectedType: 'qwen-oauth'
        }
      }
    });
    writeJson(path.join(homeDir, '.qwen', 'oauth_creds.json'), {
      access_token: 'legacy-token',
      refresh_token: 'legacy-refresh-token',
      expiry_date: Date.now() + 3600_000
    });

    const qwenOauthState = getQwenLocalAuthState();
    assert.strictEqual(qwenOauthState.selectedAuthType, 'qwen-oauth');
    assert.strictEqual(qwenOauthState.hasOauthCreds, true);

    const qwenOauthFastCheck = isAdapterAuthenticated('qwen-cli');
    assert.strictEqual(qwenOauthFastCheck.authenticated, false);
    assert(qwenOauthFastCheck.reason.includes('Qwen OAuth was discontinued'));

    const qwenOauthStatus = await getAdapterStatus('qwen-cli', {
      async isAvailable() {
        return true;
      }
    });
    assert.strictEqual(qwenOauthStatus.authenticated, false);
    assert.strictEqual(qwenOauthStatus.selectedAuthType, 'qwen-oauth');
    assert(qwenOauthStatus.authReason.includes('Qwen OAuth was discontinued'));

    writeJson(path.join(homeDir, '.qwen', 'settings.json'), {
      security: {
        auth: {
          selectedType: 'openai'
        }
      },
      modelProviders: {
        openai: [
          {
            id: 'qwen3.6-plus',
            envKey: 'DASHSCOPE_API_KEY'
          }
        ]
      },
      env: {
        DASHSCOPE_API_KEY: 'test-key'
      }
    });

    const qwenConfiguredState = getQwenLocalAuthState();
    assert.strictEqual(qwenConfiguredState.selectedAuthType, 'openai');
    assert.strictEqual(qwenConfiguredState.hasConfiguredEnvValue, true);
    assert(qwenConfiguredState.configuredEnvKeys.includes('DASHSCOPE_API_KEY'));

    const qwenConfiguredFastCheck = isAdapterAuthenticated('qwen-cli');
    assert.strictEqual(qwenConfiguredFastCheck.authenticated, true);
    assert(qwenConfiguredFastCheck.reason.includes('openai'));

    const qwenConfiguredStatus = await getAdapterStatus('qwen-cli', {
      async isAvailable() {
        return true;
      }
    });
    assert.strictEqual(qwenConfiguredStatus.authenticated, 'likely');
    assert.strictEqual(qwenConfiguredStatus.selectedAuthType, 'openai');
    assert(qwenConfiguredStatus.authReason.includes('openai'));

    const unauthClaudeFastCheck = isAdapterAuthenticated('claude-code');
    assert.strictEqual(unauthClaudeFastCheck.authenticated, false);
    assert(unauthClaudeFastCheck.reason.includes('Claude Code not authenticated'));

    writeJson(path.join(homeDir, '.claude.json'), {
      oauthAccount: {
        accountUuid: '2a2ffaa3-c00e-4f55-ab5d-f553ba1b8b72',
        emailAddress: 'suyash@example.com'
      },
      installMethod: 'global'
    });

    const claudeState = getClaudeLocalAuthState();
    assert.strictEqual(claudeState.hasOauthAccount, true);
    assert.strictEqual(claudeState.emailAddress, 'suyash@example.com');
    assert.strictEqual(claudeState.installMethod, 'global');

    const authClaudeFastCheck = isAdapterAuthenticated('claude-code');
    assert.strictEqual(authClaudeFastCheck.authenticated, true);
    assert(authClaudeFastCheck.reason.includes('suyash@example.com'));

    const claudeStatus = await getAdapterStatus('claude-code', {
      async isAvailable() {
        return true;
      }
    });
    assert.strictEqual(claudeStatus.authenticated, 'likely');
    assert.strictEqual(claudeStatus.emailAddress, 'suyash@example.com');
    assert(claudeStatus.authReason.includes('suyash@example.com'));

    console.log('✅ Gemini auth detection requires an active account and OAuth state');
    console.log('✅ Qwen auth detection rejects discontinued OAuth and accepts configured API-key settings');
    console.log('✅ Claude auth detection recognizes local OAuth state from ~/.claude.json');
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

run().catch((error) => {
  console.error('\nAdapter auth tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
