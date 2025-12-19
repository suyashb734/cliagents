/**
 * Adapter Authentication Utilities
 *
 * Handles authentication checking and configuration for all CLI adapters.
 * Each adapter has different auth mechanisms (interactive login, env vars, config files).
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Auth configuration for each adapter
// authType: 'cli-interactive' = uses CLI's own login flow (OAuth, browser)
//           'api-key' = requires API key environment variable
//           'config-file' = uses config file for credentials
const ADAPTER_AUTH_CONFIG = {
  'claude-code': {
    name: 'Claude Code',
    authType: 'cli-interactive',
    checkCommand: 'claude --version',
    loginCommand: 'claude',
    loginInstructions: 'Run "claude" in your terminal. It will open a browser to authenticate with your Anthropic account. No API key needed - the CLI handles authentication.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // CLI handles auth, no env vars needed
    configFile: null,
    docsUrl: 'https://docs.anthropic.com/claude-code'
  },
  'gemini-cli': {
    name: 'Gemini CLI',
    authType: 'cli-interactive',
    checkCommand: 'gemini --version',
    loginCommand: 'gemini auth login',
    loginInstructions: 'Run "gemini auth login" in your terminal. It will open a browser to authenticate with your Google account. No API key needed.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // CLI handles auth via Google OAuth
    configFile: '~/.gemini/config.yaml',
    docsUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  'codex-cli': {
    name: 'OpenAI Codex CLI',
    authType: 'api-key',
    checkCommand: 'codex --version',
    loginCommand: null,
    loginInstructions: 'Set your OpenAI API key as an environment variable: export OPENAI_API_KEY="sk-..."',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['OPENAI_API_KEY'],
    configFile: null,
    docsUrl: 'https://github.com/openai/codex'
  },
  'aider': {
    name: 'Aider',
    authType: 'api-key',
    checkCommand: 'aider --version',
    loginCommand: null,
    loginInstructions: 'Set API key for your preferred provider. Aider supports multiple providers - set whichever you want to use.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'],
    configFile: '~/.aider.conf.yml',
    docsUrl: 'https://aider.chat'
  },
  'goose': {
    name: 'Goose',
    authType: 'cli-interactive',
    checkCommand: 'goose --version',
    loginCommand: 'goose configure',
    loginInstructions: 'Run "goose configure" in your terminal to set up your provider credentials interactively.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // Uses interactive configuration
    configFile: '~/.config/goose/config.yaml',
    docsUrl: 'https://github.com/block/goose'
  },
  'amazon-q': {
    name: 'Amazon Q Developer',
    authType: 'cli-interactive',
    checkCommand: 'q --version',
    altCheckCommand: 'kiro --version',
    loginCommand: 'q login',
    altLoginCommand: 'kiro login',
    loginInstructions: 'Run "q login" in your terminal to authenticate with your AWS account via browser. Alternatively, configure AWS credentials with "aws configure".',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // Uses AWS SSO/IAM authentication
    configFile: '~/.aws/credentials',
    docsUrl: 'https://aws.amazon.com/q/developer/'
  },
  'plandex': {
    name: 'Plandex',
    authType: 'cli-interactive',
    checkCommand: 'plandex version',
    loginCommand: 'plandex sign-in',
    loginInstructions: 'Run "plandex sign-in" in your terminal to authenticate with your Plandex account.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // Uses Plandex account authentication
    configFile: '~/.plandex/config.json',
    docsUrl: 'https://plandex.ai'
  },
  'continue-cli': {
    name: 'Continue CLI',
    authType: 'config-file',
    checkCommand: 'cn --version',
    loginCommand: null,
    loginInstructions: 'Edit ~/.continue/config.json to add your model provider API keys.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],  // Can also use env vars
    configFile: '~/.continue/config.json',
    docsUrl: 'https://continue.dev/docs'
  },
  'mistral-vibe': {
    name: 'Mistral Vibe CLI',
    authType: 'api-key',
    checkCommand: 'vibe --version',
    loginCommand: null,
    loginInstructions: 'Set your Mistral API key: export MISTRAL_API_KEY="..."',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['MISTRAL_API_KEY'],
    configFile: null,
    docsUrl: 'https://github.com/mistralai/mistral-vibe'
  },
  'shell-gpt': {
    name: 'Shell-GPT',
    authType: 'api-key',
    checkCommand: 'sgpt --version',
    loginCommand: null,
    loginInstructions: 'Set your OpenAI API key: export OPENAI_API_KEY="sk-..."',
    testPrompt: 'Say "ok" and nothing else',
    envVars: ['OPENAI_API_KEY'],
    configFile: '~/.config/shell_gpt/.sgptrc',
    docsUrl: 'https://github.com/TheR1D/shell_gpt'
  },
  'aichat': {
    name: 'aichat',
    authType: 'cli-interactive',
    checkCommand: 'aichat --version',
    loginCommand: 'aichat',
    loginInstructions: 'Run "aichat" for the first time - it will prompt you to configure your provider and API key interactively.',
    testPrompt: 'Say "ok" and nothing else',
    envVars: [],  // Uses interactive first-run configuration
    configFile: '~/.config/aichat/config.yaml',
    docsUrl: 'https://github.com/sigoden/aichat'
  },
  'github-copilot': {
    name: 'GitHub Copilot CLI',
    authType: 'cli-interactive',
    checkCommand: 'gh copilot --version',
    loginCommand: 'gh auth login',
    loginInstructions: 'Run "gh auth login" in your terminal to authenticate with GitHub. Then enable Copilot with "gh extension install github/gh-copilot".',
    testPrompt: 'explain "echo hello"',
    envVars: [],  // Uses GitHub OAuth
    configFile: null,
    docsUrl: 'https://github.com/features/copilot/cli'
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
      await adapter.spawn(sessionId, { workDir: '/tmp/agent-test' });

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
    docsUrl: config.docsUrl
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

  // Determine authentication status based on auth type
  switch (config.authType) {
    case 'env':
      status.authenticated = hasEnvVar ? 'likely' : false;
      break;
    case 'config':
      status.authenticated = status.configFileExists ? 'likely' : false;
      break;
    case 'interactive':
      // For interactive auth, we can't easily check without running
      // Mark as likely if config exists or env var set
      status.authenticated = (status.configFileExists || hasEnvVar) ? 'likely' : 'unknown';
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
  expandPath
};
