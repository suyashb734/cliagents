#!/usr/bin/env node

/**
 * Interactive CLI Authentication Setup
 *
 * Walks through each installed CLI adapter and helps you authenticate.
 * Only includes FREE CLIs that use OAuth/account login (no API keys).
 *
 * Run: node src/scripts/setup-auth.js
 *      or: npm run setup
 */

const { spawn, execSync } = require('child_process');
const readline = require('readline');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

const c = colors;

// CLI configurations - ONLY FREE CLIs with OAuth/account login
const CLI_CONFIGS = [
  {
    name: 'Claude Code',
    id: 'claude-code',
    checkCmd: 'claude --version',
    loginCmd: 'claude',
    // Check for usage history - if it exists, user has authenticated before
    profileCmd: 'test -f ~/.claude/history.jsonl && echo "has_history" || echo "no_history"',
    parseProfile: (output) => {
      if (output.includes('has_history')) {
        return 'Authenticated (Claude Pro)';
      }
      return null;
    },
    description: 'Anthropic\'s official CLI - FREE with Claude Pro subscription',
    free: true
  },
  {
    name: 'Gemini CLI',
    id: 'gemini-cli',
    checkCmd: 'gemini --version',
    loginCmd: 'gemini auth login',
    // Check google_accounts.json for active account
    profileCmd: 'cat ~/.gemini/google_accounts.json 2>/dev/null',
    parseProfile: (output) => {
      // Parse google_accounts.json
      const match = output.match(/"active":\s*"([^"]+@[^"]+)"/);
      if (match) return match[1];
      // Check for oauth_creds.json as fallback
      return null;
    },
    // Also check oauth file exists as backup
    altProfileCmd: 'test -f ~/.gemini/oauth_creds.json && echo "authenticated"',
    description: 'Google\'s Gemini CLI - FREE tier available',
    free: true
  },
  {
    name: 'GitHub Copilot CLI',
    id: 'github-copilot',
    checkCmd: 'gh copilot --version',
    loginCmd: 'gh auth login',
    profileCmd: 'gh auth status',
    parseProfile: (output) => {
      // Parse gh auth status
      const match = output.match(/Logged in to [^\s]+ as ([^\s]+)/);
      if (match) return match[1];
      const accountMatch = output.match(/account ([^\s]+)/i);
      if (accountMatch) return accountMatch[1];
      return null;
    },
    description: 'GitHub Copilot in terminal - Requires Copilot subscription',
    preReq: 'After login: gh extension install github/gh-copilot',
    free: false,
    note: 'Requires GitHub Copilot subscription ($10/mo or free for students)'
  },
  {
    name: 'Goose',
    id: 'goose',
    checkCmd: 'goose --version',
    loginCmd: 'goose configure',
    profileCmd: 'cat ~/.config/goose/config.yaml 2>/dev/null || echo "not configured"',
    parseProfile: (output) => {
      if (output.includes('not configured')) return null;
      // Check for provider in config
      const providerMatch = output.match(/provider[:\s]+([^\n]+)/i);
      if (providerMatch) return `Provider: ${providerMatch[1].trim()}`;
      return 'Configured';
    },
    description: 'Block\'s open-source AI agent - Uses your own API keys',
    free: false,
    note: 'Open source but requires API keys for providers'
  },
  {
    name: 'Amazon Q Developer',
    id: 'amazon-q',
    checkCmd: 'kiro --version',
    altCheckCmd: '~/.local/bin/kiro --version',
    loginCmd: 'kiro login',
    profileCmd: 'kiro whoami 2>/dev/null || ~/.local/bin/kiro whoami 2>/dev/null',
    parseProfile: (output) => {
      // Parse AWS identity or Q whoami
      const arnMatch = output.match(/"Arn":\s*"([^"]+)"/);
      if (arnMatch) {
        const arn = arnMatch[1];
        const parts = arn.split('/');
        return parts[parts.length - 1] || arn;
      }
      const userMatch = output.match(/"UserId":\s*"([^"]+)"/);
      if (userMatch) return userMatch[1];
      if (output.includes('@')) {
        const match = output.match(/([^\s]+@[^\s]+)/);
        if (match) return match[1];
      }
      return null;
    },
    description: 'AWS\'s AI coding assistant - FREE tier available',
    free: true
  },
  {
    name: 'Plandex',
    id: 'plandex',
    checkCmd: 'plandex version',
    loginCmd: 'plandex sign-in',
    profileCmd: 'plandex whoami 2>/dev/null || cat ~/.plandex-home/auth.json 2>/dev/null',
    parseProfile: (output) => {
      if (output.includes('@')) {
        const match = output.match(/([^\s"]+@[^\s"]+)/);
        if (match) return match[1];
      }
      const emailMatch = output.match(/"email":\s*"([^"]+)"/);
      if (emailMatch) return emailMatch[1];
      return null;
    },
    description: 'AI coding agent for large projects - FREE cloud tier',
    free: true
  },
  {
    name: 'aichat',
    id: 'aichat',
    checkCmd: 'aichat --version',
    loginCmd: 'aichat',
    profileCmd: 'cat ~/.config/aichat/config.yaml 2>/dev/null',
    parseProfile: (output) => {
      if (!output || output.includes('No such file')) return null;
      // Look for model or api_key indicators
      const modelMatch = output.match(/model[:\s]+([^\n]+)/i);
      if (modelMatch) return `Model: ${modelMatch[1].trim()}`;
      return 'Configured';
    },
    description: 'Multi-provider CLI - Uses your own API keys',
    free: false,
    note: 'Requires API keys for providers'
  },
  {
    name: 'Codex CLI',
    id: 'codex-cli',
    checkCmd: 'codex --version',
    loginCmd: 'codex login',
    profileCmd: 'test -f ~/.codex/auth.json && echo "has_auth" || echo "no_auth"',
    parseProfile: (output) => {
      if (output.includes('has_auth')) {
        return 'Authenticated (ChatGPT Plus)';
      }
      return null;
    },
    description: 'OpenAI\'s Codex CLI - FREE with ChatGPT Plus subscription',
    free: true,
    note: 'Requires ChatGPT Plus ($20/mo) - same cost model as Claude Code'
  },
  {
    name: 'Mistral Vibe CLI',
    id: 'mistral-vibe',
    checkCmd: 'vibe --version',
    loginCmd: 'vibe --setup',
    profileCmd: 'cat ~/.vibe/config.toml 2>/dev/null || cat ~/.config/vibe/config.toml 2>/dev/null',
    parseProfile: (output) => {
      if (!output || output.includes('No such file')) return null;
      // Check for API key in config
      if (output.includes('api_key') || output.includes('MISTRAL')) {
        return 'Authenticated (Mistral API)';
      }
      return 'Configured';
    },
    description: 'Mistral\'s Devstral 2 CLI - FREE through Dec 2025',
    free: true,
    note: 'FREE API access through December 2025, then paid'
  }
];

// Readline interface
let rl;

function createReadline() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function print(msg = '') {
  console.log(msg);
}

function printHeader(text) {
  print();
  print(`${c.bgBlue}${c.bright} ${text} ${c.reset}`);
  print();
}

function printSuccess(text) {
  print(`${c.green}✓${c.reset} ${text}`);
}

function printWarning(text) {
  print(`${c.yellow}⚠${c.reset} ${text}`);
}

function printError(text) {
  print(`${c.red}✗${c.reset} ${text}`);
}

function printInfo(text) {
  print(`${c.cyan}ℹ${c.reset} ${text}`);
}

// Check if CLI is installed
function checkInstalled(cli) {
  try {
    execSync(cli.checkCmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    if (cli.altCheckCmd) {
      try {
        execSync(cli.altCheckCmd, { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// Get profile/auth status
function getProfile(cli) {
  if (!cli.profileCmd) return null;

  try {
    const output = execSync(cli.profileCmd, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (cli.parseProfile) {
      return cli.parseProfile(output);
    }
    return output.trim() || null;
  } catch (err) {
    // Try to parse stderr too
    if (err.stderr && cli.parseProfile) {
      return cli.parseProfile(err.stderr);
    }
    return null;
  }
}

// Run interactive login command
function runInteractiveLogin(cmd) {
  return new Promise((resolve) => {
    print();
    print(`${c.dim}Running: ${cmd}${c.reset}`);
    print(`${c.dim}${'─'.repeat(50)}${c.reset}`);

    const proc = spawn(cmd, [], {
      stdio: 'inherit',
      shell: true
    });

    proc.on('close', (code) => {
      print(`${c.dim}${'─'.repeat(50)}${c.reset}`);
      resolve(code === 0);
    });

    proc.on('error', (err) => {
      printError(`Failed to run command: ${err.message}`);
      resolve(false);
    });
  });
}

// Display CLI status
function displayStatus(cli, installed, profile) {
  const nameCol = cli.name.padEnd(22);
  const freeTag = cli.free ? `${c.green}FREE${c.reset}` : `${c.yellow}PAID${c.reset}`;

  if (!installed) {
    print(`${c.dim}✗ ${nameCol}${c.reset} [Not installed]`);
    return;
  }

  if (profile) {
    print(`${c.green}✓${c.reset} ${nameCol} ${freeTag}  ${c.cyan}${profile}${c.reset}`);
  } else {
    print(`${c.yellow}○${c.reset} ${nameCol} ${freeTag}  ${c.dim}Not authenticated${c.reset}`);
  }
}

// Setup single CLI
async function setupCli(cli) {
  printHeader(`${cli.name}`);
  print(`${c.dim}${cli.description}${c.reset}`);
  if (cli.note) {
    print(`${c.yellow}Note: ${cli.note}${c.reset}`);
  }
  if (cli.preReq) {
    print(`${c.cyan}${cli.preReq}${c.reset}`);
  }
  print();

  // Check current auth status
  const profile = getProfile(cli);
  if (profile) {
    printSuccess(`Already authenticated as: ${c.cyan}${profile}${c.reset}`);

    const answer = await question(`\n${c.bright}Re-authenticate?${c.reset} [y/N]: `);
    if (answer.toLowerCase() !== 'y') {
      return { status: 'already-auth', profile };
    }
  }

  // Run login
  const answer = await question(`\n${c.bright}Run login command?${c.reset} (${cli.loginCmd}) [Y/n]: `);

  if (answer.toLowerCase() !== 'n') {
    const success = await runInteractiveLogin(cli.loginCmd);

    // Check new profile
    const newProfile = getProfile(cli);
    if (newProfile) {
      printSuccess(`Authenticated as: ${c.cyan}${newProfile}${c.reset}`);
      return { status: 'authenticated', profile: newProfile };
    } else if (success) {
      printWarning(`Login completed but couldn't verify profile`);
      return { status: 'unknown' };
    } else {
      printError(`Login may have failed`);
      return { status: 'failed' };
    }
  }

  printInfo(`Skipped`);
  return { status: 'skipped' };
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status') || args.includes('-s');

  createReadline();

  print();
  print(`${c.bgGreen}${c.bright} cliagents - CLI Authentication ${c.reset}`);
  print();

  if (statusOnly) {
    print(`${c.bright}Authentication Status:${c.reset}`);
    print();
  } else {
    print(`This will help you authenticate with FREE CLI tools.`);
    print(`${c.dim}(Skipping API-key based CLIs that require payment)${c.reset}`);
    print();
  }

  // Check all CLIs and show status
  print(`${c.bright}CLI Status:${c.reset}`);
  print(`${'─'.repeat(60)}`);

  const installed = [];
  const needsAuth = [];

  for (const cli of CLI_CONFIGS) {
    const isInstalled = checkInstalled(cli);
    const profile = isInstalled ? getProfile(cli) : null;

    displayStatus(cli, isInstalled, profile);

    if (isInstalled) {
      installed.push({ cli, profile });
      if (!profile && cli.free) {
        needsAuth.push(cli);
      }
    }
  }

  print(`${'─'.repeat(60)}`);
  print();

  // Summary
  const authed = installed.filter(i => i.profile);
  const freeInstalled = installed.filter(i => i.cli.free);

  print(`${c.bright}Summary:${c.reset} ${installed.length} installed, ${authed.length} authenticated`);

  if (statusOnly) {
    rl.close();
    return;
  }

  // If all free CLIs are authenticated, we're done
  if (needsAuth.length === 0) {
    if (freeInstalled.length === 0) {
      print();
      printWarning(`No free CLIs installed. Install some first:`);
      print(`  ${c.cyan}Claude Code:${c.reset}  npm i -g @anthropic-ai/claude-code`);
      print(`  ${c.cyan}Gemini CLI:${c.reset}   npx @anthropic-ai/claude-code  (or pip install gemini-cli)`);
      print(`  ${c.cyan}Amazon Q:${c.reset}     Install from AWS`);
    } else {
      print();
      printSuccess(`All free CLIs are authenticated!`);
    }
    rl.close();
    return;
  }

  print();
  print(`${c.yellow}${needsAuth.length} CLI(s) need authentication:${c.reset} ${needsAuth.map(c => c.name).join(', ')}`);

  const answer = await question(`\n${c.bright}Set up authentication now?${c.reset} [Y/n]: `);

  if (answer.toLowerCase() === 'n') {
    print(`\nRun ${c.cyan}npm run setup${c.reset} anytime to authenticate.`);
    rl.close();
    return;
  }

  // Setup each CLI that needs auth
  const results = [];

  for (const cli of needsAuth) {
    const result = await setupCli(cli);
    results.push({ name: cli.name, ...result });
  }

  // Final summary
  printHeader('Setup Complete');

  print(`${c.bright}Final Status:${c.reset}`);
  print(`${'─'.repeat(60)}`);

  for (const cli of CLI_CONFIGS) {
    const isInstalled = checkInstalled(cli);
    const profile = isInstalled ? getProfile(cli) : null;
    displayStatus(cli, isInstalled, profile);
  }

  print(`${'─'.repeat(60)}`);
  print();
  print(`Test your CLIs at: ${c.cyan}http://localhost:3001/dashboard${c.reset}`);
  print();

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
