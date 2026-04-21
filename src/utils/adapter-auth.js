/**
 * Adapter Authentication Utilities
 *
 * Handles authentication checking and configuration for the supported CLI adapters.
 * Each adapter has different auth mechanisms (interactive login, env vars, config files).
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const QWEN_OAUTH_DISCONTINUED_REASON =
  'Qwen OAuth was discontinued upstream on 2026-04-15. Run "qwen auth" and switch to API Key or Coding Plan.';

// Auth configuration for each supported adapter
// authType: 'interactive' = uses CLI login flow and/or local auth state
//           'config' = uses config file for credentials
//           'env' = requires environment variable credentials
const ADAPTER_AUTH_CONFIG = {
  'claude-code': {
    name: 'Claude Code',
    authType: 'interactive',
    checkCommand: 'claude --version',
    loginCommand: 'claude auth login',
    loginInstructions: 'Run "claude auth login" in your terminal to authenticate Claude Code, or set ANTHROPIC_API_KEY.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['ANTHROPIC_API_KEY'],
    configFile: '~/.claude.json',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code'
  },
  'gemini-cli': {
    name: 'Gemini CLI',
    authType: 'interactive',
    checkCommand: 'gemini --version',
    loginCommand: 'gemini auth login',
    loginInstructions: 'Run "gemini auth login" in your terminal. It will open a browser to authenticate with your Google account. No API key needed.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // CLI handles auth via Google OAuth
    configFile: '~/.gemini/oauth_creds.json',
    docsUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  'qwen-cli': {
    name: 'Qwen Code CLI',
    authType: 'interactive',
    checkCommand: 'qwen --version',
    loginCommand: 'qwen auth',
    loginInstructions: 'Run "qwen auth" in your terminal and configure an API key or Coding Plan provider. Qwen OAuth is no longer supported upstream.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // Uses Qwen OAuth credentials
    configFile: '~/.qwen/oauth_creds.json',
    docsUrl: 'https://github.com/QwenLM/qwen-code'
  },
  'codex-cli': {
    name: 'OpenAI Codex CLI',
    authType: 'interactive',
    checkCommand: 'codex --version',
    loginCommand: 'codex login',
    loginInstructions: 'Run "codex login" in your terminal or set OPENAI_API_KEY.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['OPENAI_API_KEY'],
    configFile: '~/.codex/auth.json',
    docsUrl: 'https://github.com/openai/codex'
  },
  'opencode-cli': {
    name: 'OpenCode CLI',
    authType: 'interactive',
    checkCommand: 'opencode --version',
    loginCommand: 'opencode providers login',
    loginInstructions: 'Run "opencode providers login" in your terminal to authenticate an OpenCode provider.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],
    configFile: '~/.local/share/opencode/auth.json',
    docsUrl: 'https://opencode.ai'
  }
};

/**
 * Expand ~ to home directory
 */
function expandPath(filePath) {
  if (!filePath) return null;
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Check if a CLI command is available
 */
async function checkCliInstalled(command) {
  return new Promise((resolve) => {
    try {
      execSync(`which ${command.split(' ')[0]}`, { stdio: 'ignore' });
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Check if environment variable is set
 */
function checkEnvVar(varName) {
  return !!process.env[varName];
}

/**
 * Check if config file exists
 */
function checkConfigFile(filePath) {
  const expanded = expandPath(filePath);
  return expanded && fs.existsSync(expanded);
}

function readJsonFile(filePath) {
  const expanded = expandPath(filePath);
  if (!expanded || !fs.existsSync(expanded)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(expanded, 'utf8'));
  } catch {
    return null;
  }
}

function getGeminiLocalAuthState() {
  const settings = readJsonFile('~/.gemini/settings.json') || {};
  const accounts = readJsonFile('~/.gemini/google_accounts.json') || {};
  const creds = readJsonFile('~/.gemini/oauth_creds.json') || {};

  return {
    selectedAuthType: settings?.security?.auth?.selectedType || null,
    activeAccount: accounts?.active || null,
    hasOauthCreds: Boolean(creds?.refresh_token || creds?.access_token)
  };
}

function getClaudeLocalAuthState() {
  const config = readJsonFile('~/.claude.json') || {};
  const oauthAccount = config?.oauthAccount && typeof config.oauthAccount === 'object'
    ? config.oauthAccount
    : null;
  const approvedApiKeyResponses = Array.isArray(config?.customApiKeyResponses?.approved)
    ? config.customApiKeyResponses.approved
    : [];

  return {
    oauthAccount,
    emailAddress: oauthAccount?.emailAddress || null,
    accountUuid: oauthAccount?.accountUuid || null,
    hasOauthAccount: Boolean(oauthAccount?.accountUuid || oauthAccount?.emailAddress),
    hasApprovedApiKeyResponses: approvedApiKeyResponses.length > 0,
    installMethod: typeof config?.installMethod === 'string' ? config.installMethod : null
  };
}

function normalizeExpiryTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getQwenLocalAuthState() {
  const settings = readJsonFile('~/.qwen/settings.json') || {};
  const creds = readJsonFile('~/.qwen/oauth_creds.json') || {};
  const selectedAuthType = settings?.security?.auth?.selectedType || null;
  const configuredEnv = settings?.env && typeof settings.env === 'object'
    ? settings.env
    : {};
  const modelProviders = settings?.modelProviders && typeof settings.modelProviders === 'object'
    ? settings.modelProviders
    : {};
  const configuredEnvKeys = new Set(Object.keys(configuredEnv));

  for (const providerEntries of Object.values(modelProviders)) {
    if (!Array.isArray(providerEntries)) {
      continue;
    }
    for (const entry of providerEntries) {
      const envKey = typeof entry?.envKey === 'string' ? entry.envKey.trim() : '';
      if (envKey) {
        configuredEnvKeys.add(envKey);
      }
    }
  }

  const oauthExpiryTimestamp = normalizeExpiryTimestamp(creds?.expiry_date ?? creds?.expires_at);
  const hasOauthCreds = Boolean(creds?.refresh_token || creds?.access_token);
  const hasConfiguredEnvValue = Object.values(configuredEnv).some((value) => (
    typeof value === 'string' ? value.trim().length > 0 : Boolean(value)
  ));
  const hasConfiguredEnvVar = Array.from(configuredEnvKeys).some((envVar) => checkEnvVar(envVar));

  return {
    selectedAuthType,
    hasOauthCreds,
    oauthExpiryTimestamp,
    oauthExpired: oauthExpiryTimestamp != null ? oauthExpiryTimestamp <= Date.now() : null,
    configuredEnvKeys: Array.from(configuredEnvKeys).sort(),
    hasConfiguredEnvValue,
    hasConfiguredEnvVar
  };
}

/**
 * Run a quick test to verify adapter authentication
 * Returns { success: boolean, error?: string, duration?: number }
 */
async function testAdapterAuth(adapterName, adapter, timeout = 30000) {
  const config = ADAPTER_AUTH_CONFIG[adapterName];
  if (!config) {
    return { success: false, error: 'Unknown adapter' };
  }

  const startTime = Date.now();

  return new Promise(async (resolve) => {
    const timeoutId = setTimeout(() => {
      resolve({ success: false, error: 'Test timed out', duration: timeout });
    }, timeout);

    try {
      // Create a temporary session
      const sessionId = `test-${Date.now()}`;
      await adapter.spawn(sessionId, { workDir: process.cwd() });

      let response = '';

      // Send test message
      for await (const chunk of adapter.send(sessionId, config.testPrompt, { timeout: timeout - 1000 })) {
        if (chunk.type === 'chunk') {
          response += chunk.content;
        } else if (chunk.type === 'result') {
          response = chunk.content;
        } else if (chunk.type === 'error') {
          clearTimeout(timeoutId);
          await adapter.terminate(sessionId);
          resolve({
            success: false,
            error: chunk.content,
            duration: Date.now() - startTime
          });
          return;
        }
      }

      // Cleanup
      await adapter.terminate(sessionId);
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      // Check if we got a valid response
      if (response && response.toLowerCase().includes('ok')) {
        resolve({ success: true, duration, response: response.trim() });
      } else if (response) {
        resolve({ success: true, duration, response: response.substring(0, 100) });
      } else {
        resolve({ success: false, error: 'Empty response', duration });
      }
    } catch (error) {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      });
    }
  });
}

/**
 * Get comprehensive status for an adapter
 */
async function getAdapterStatus(adapterName, adapter) {
  const config = ADAPTER_AUTH_CONFIG[adapterName];
  if (!config) {
    return {
      name: adapterName,
      installed: false,
      authenticated: false,
      error: 'Unknown adapter configuration'
    };
  }

  const status = {
    name: adapterName,
    displayName: config.name,
    authType: config.authType,
    installed: false,
    authenticated: 'unknown',
    envVarsSet: {},
    configFileExists: false,
    loginCommand: config.loginCommand,
    loginInstructions: config.loginInstructions,
    docsUrl: config.docsUrl,
    authReason: null
  };

  // Check if CLI is installed
  try {
    status.installed = await adapter.isAvailable();
  } catch {
    status.installed = false;
  }

  if (!status.installed) {
    status.authenticated = false;
    return status;
  }

  // Check environment variables
  for (const envVar of config.envVars) {
    status.envVarsSet[envVar] = checkEnvVar(envVar);
  }

  // Check if any required env var is set
  const hasEnvVar = Object.values(status.envVarsSet).some(v => v);

  // Check config file
  if (config.configFile) {
    status.configFileExists = checkConfigFile(config.configFile);
    status.configFilePath = expandPath(config.configFile);
  }

  if (adapterName === 'gemini-cli') {
    const geminiState = getGeminiLocalAuthState();
    status.selectedAuthType = geminiState.selectedAuthType;
    status.activeAccount = geminiState.activeAccount;
    status.configFileExists = geminiState.hasOauthCreds;

    if (geminiState.activeAccount) {
      status.authenticated = geminiState.hasOauthCreds ? 'likely' : false;
      status.authReason = geminiState.hasOauthCreds
        ? `Active Gemini account: ${geminiState.activeAccount}`
        : `Active Gemini account recorded (${geminiState.activeAccount}), but OAuth credentials are missing`;
    } else {
      status.authenticated = false;
      status.authReason = 'Gemini CLI has no active signed-in account';
    }

    return status;
  }

  if (adapterName === 'claude-code') {
    const claudeState = getClaudeLocalAuthState();
    status.emailAddress = claudeState.emailAddress;
    status.accountUuid = claudeState.accountUuid;
    status.installMethod = claudeState.installMethod;
    status.configFileExists = claudeState.hasOauthAccount || status.configFileExists;

    if (hasEnvVar) {
      status.authenticated = 'likely';
      status.authReason = 'ANTHROPIC_API_KEY is set';
    } else if (claudeState.hasOauthAccount) {
      status.authenticated = 'likely';
      status.authReason = claudeState.emailAddress
        ? `Claude local OAuth state detected for ${claudeState.emailAddress}`
        : 'Claude local OAuth state detected';
    } else if (claudeState.hasApprovedApiKeyResponses) {
      status.authenticated = 'likely';
      status.authReason = 'Claude local API-key approval state detected';
    } else {
      status.authenticated = false;
      status.authReason = 'Claude Code not authenticated. Run "claude auth login" or set ANTHROPIC_API_KEY';
    }

    return status;
  }

  if (adapterName === 'qwen-cli') {
    const qwenState = getQwenLocalAuthState();
    status.selectedAuthType = qwenState.selectedAuthType;
    status.qwenOauthExpired = qwenState.oauthExpired;
    status.configuredEnvKeys = qwenState.configuredEnvKeys;
    status.configFileExists = qwenState.hasOauthCreds || status.configFileExists;

    if (qwenState.selectedAuthType === 'qwen-oauth') {
      status.authenticated = false;
      status.authReason = QWEN_OAUTH_DISCONTINUED_REASON;
    } else if (qwenState.hasConfiguredEnvVar || qwenState.hasConfiguredEnvValue || hasEnvVar) {
      status.authenticated = 'likely';
      status.authReason = qwenState.selectedAuthType
        ? `Qwen settings select ${qwenState.selectedAuthType}; credential configuration detected`
        : 'Qwen credential configuration detected';
    } else {
      status.authenticated = false;
      status.authReason = 'Qwen Code not configured with a supported API key or Coding Plan provider. Run "qwen auth" or update ~/.qwen/settings.json.';
    }

    return status;
  }

  // Determine authentication status based on auth type
  switch (config.authType) {
    case 'env':
      status.authenticated = hasEnvVar ? 'likely' : false;
      status.authReason = hasEnvVar ? 'Environment credentials found' : 'Required environment credentials are missing';
      break;
    case 'config':
      status.authenticated = status.configFileExists ? 'likely' : false;
      status.authReason = status.configFileExists ? 'Credential config file found' : 'Credential config file is missing';
      break;
    case 'interactive':
      // For interactive auth, we can't easily check without running
      // Mark as likely if config exists or env var set
      status.authenticated = (status.configFileExists || hasEnvVar) ? 'likely' : 'unknown';
      status.authReason = (status.configFileExists || hasEnvVar)
        ? 'Local interactive auth state detected'
        : 'Interactive adapter; local auth state not verified';
      break;
  }

  return status;
}

/**
 * Get all adapter statuses
 */
async function getAllAdapterStatuses(sessionManager) {
  const statuses = [];

  for (const name of sessionManager.getAdapterNames()) {
    const adapter = sessionManager.getAdapter(name);
    const status = await getAdapterStatus(name, adapter);
    statuses.push(status);
  }

  return statuses;
}

/**
 * Set an environment variable (for the current process)
 * Note: This won't persist across restarts
 */
function setEnvVar(name, value) {
  process.env[name] = value;
  return true;
}

/**
 * Get auth configuration for an adapter
 */
function getAuthConfig(adapterName) {
  return ADAPTER_AUTH_CONFIG[adapterName] || null;
}

/**
 * Spawn interactive login process
 * Returns a promise that resolves when login is complete
 */
function spawnInteractiveLogin(adapterName) {
  const config = ADAPTER_AUTH_CONFIG[adapterName];
  if (!config || !config.loginCommand) {
    return { success: false, error: 'No login command available' };
  }

  return {
    command: config.loginCommand,
    instructions: config.loginInstructions,
    // Return info for the client to handle
    requiresTerminal: true
  };
}

/**
 * Quick check if an adapter is likely authenticated
 * Returns { authenticated: boolean, reason: string }
 *
 * This is a fast, synchronous check that doesn't spawn processes.
 * For definitive verification, use testAdapterAuth() instead.
 */
function isAdapterAuthenticated(adapterName) {
  const config = ADAPTER_AUTH_CONFIG[adapterName];
  if (!config) {
    return { authenticated: false, reason: 'Unknown adapter' };
  }

  switch (adapterName) {
    case 'gemini-cli': {
      const geminiState = getGeminiLocalAuthState();
      if (geminiState.activeAccount && geminiState.hasOauthCreds) {
        return {
          authenticated: true,
          reason: `Gemini active account: ${geminiState.activeAccount}`
        };
      }
      return {
        authenticated: false,
        reason: geminiState.selectedAuthType === 'oauth-personal'
          ? 'Gemini CLI has no active signed-in Google account. Run "gemini auth login" first.'
          : 'Gemini CLI not authenticated. Run "gemini auth login" first.'
      };
    }

    case 'codex-cli': {
      // Codex supports two auth methods:
      // 1. OPENAI_API_KEY environment variable
      // 2. ChatGPT OAuth login (stored in ~/.codex/auth.json)
      if (checkEnvVar('OPENAI_API_KEY')) {
        return { authenticated: true, reason: 'OPENAI_API_KEY is set' };
      }
      // Check for ChatGPT OAuth credentials
      const codexAuthPath = expandPath('~/.codex/auth.json');
      if (codexAuthPath && fs.existsSync(codexAuthPath)) {
        try {
          const auth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
          // Tokens are nested under auth.tokens object
          const tokens = auth.tokens || auth;
          if (tokens.access_token || tokens.refresh_token) {
            return { authenticated: true, reason: 'ChatGPT OAuth credentials found' };
          }
        } catch (e) {
          // Invalid JSON or read error
        }
      }
      return {
        authenticated: false,
        reason: 'Codex CLI not authenticated. Run "codex login" or set OPENAI_API_KEY'
      };
    }

    case 'claude-code': {
      if (checkEnvVar('ANTHROPIC_API_KEY')) {
        return { authenticated: true, reason: 'ANTHROPIC_API_KEY is set' };
      }

      const claudeState = getClaudeLocalAuthState();
      if (claudeState.hasOauthAccount) {
        return {
          authenticated: true,
          reason: claudeState.emailAddress
            ? `Claude local OAuth state detected for ${claudeState.emailAddress}`
            : 'Claude local OAuth state detected'
        };
      }

      if (claudeState.hasApprovedApiKeyResponses) {
        return {
          authenticated: true,
          reason: 'Claude local API-key approval state detected'
        };
      }

      return {
        authenticated: false,
        reason: 'Claude Code not authenticated. Run "claude auth login" or set ANTHROPIC_API_KEY'
      };
    }

    case 'qwen-cli': {
      const qwenState = getQwenLocalAuthState();

      if (qwenState.selectedAuthType === 'qwen-oauth') {
        return {
          authenticated: false,
          reason: QWEN_OAUTH_DISCONTINUED_REASON
        };
      }

      if (qwenState.hasConfiguredEnvVar || qwenState.hasConfiguredEnvValue) {
        return {
          authenticated: true,
          reason: qwenState.selectedAuthType
            ? `Qwen settings select ${qwenState.selectedAuthType} with configured credentials`
            : 'Qwen credential configuration detected'
        };
      }

      return {
        authenticated: false,
        reason: 'Qwen Code not configured with a supported API key or Coding Plan provider. Run "qwen auth" or update ~/.qwen/settings.json.'
      };
    }

    default: {
      // For other adapters, check env vars and config files
      const hasEnvVar = config.envVars.some(v => checkEnvVar(v));
      const hasConfig = config.configFile && checkConfigFile(config.configFile);

      if (hasEnvVar || hasConfig) {
        return { authenticated: true, reason: 'Credentials found' };
      }

      // For cli-interactive auth types, assume OK (will prompt if needed)
      if (config.authType === 'cli-interactive') {
        return { authenticated: true, reason: 'Interactive auth (may prompt)' };
      }

      return {
        authenticated: false,
        reason: config.loginInstructions || 'Authentication required'
      };
    }
  }
}

module.exports = {
  ADAPTER_AUTH_CONFIG,
  getAdapterStatus,
  getAllAdapterStatuses,
  testAdapterAuth,
  setEnvVar,
  getAuthConfig,
  spawnInteractiveLogin,
  checkEnvVar,
  checkConfigFile,
  expandPath,
  isAdapterAuthenticated,
  readJsonFile,
  getGeminiLocalAuthState,
  getClaudeLocalAuthState,
  getQwenLocalAuthState
};
