#!/usr/bin/env node

/**
 * Interactive CLI authentication setup for the supported broker adapters.
 *
 * Supported adapters:
 * - Gemini CLI
 * - Codex CLI
 * - Qwen CLI
 * - OpenCode CLI
 */

const { spawn, execSync } = require('child_process');
const readline = require('readline');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m'
};

const c = colors;

const CLI_CONFIGS = [
  {
    name: 'Gemini CLI',
    id: 'gemini-cli',
    checkCmd: 'gemini --version',
    loginCmd: 'gemini auth login',
    profileCmd: 'cat ~/.gemini/google_accounts.json 2>/dev/null || cat ~/.gemini/oauth_creds.json 2>/dev/null',
    parseProfile: (output) => {
      const activeAccount = output.match(/"active":\s*"([^"]+@[^"]+)"/);
      if (activeAccount) return activeAccount[1];
      if (output.includes('refresh_token') || output.includes('access_token')) {
        return 'Authenticated (Google OAuth)';
      }
      return null;
    },
    description: 'Google Gemini CLI using browser OAuth authentication',
    access: 'ACCOUNT'
  },
  {
    name: 'Codex CLI',
    id: 'codex-cli',
    checkCmd: 'codex --version',
    loginCmd: 'codex login',
    profileCmd: 'if [ -n "$OPENAI_API_KEY" ]; then echo "env_api_key"; elif [ -f ~/.codex/auth.json ]; then cat ~/.codex/auth.json; else echo "no_auth"; fi',
    parseProfile: (output) => {
      if (output.includes('env_api_key')) return 'Authenticated (OPENAI_API_KEY)';
      if (output.includes('access_token') || output.includes('refresh_token')) {
        return 'Authenticated (ChatGPT OAuth)';
      }
      return null;
    },
    description: 'OpenAI Codex CLI using ChatGPT OAuth or OPENAI_API_KEY',
    access: 'SUB',
    note: 'ChatGPT Plus/Pro login works; OPENAI_API_KEY also works if you prefer API auth.'
  },
  {
    name: 'Qwen CLI',
    id: 'qwen-cli',
    checkCmd: 'qwen --version',
    loginCmd: 'qwen auth',
    profileCmd: 'cat ~/.qwen/oauth_creds.json 2>/dev/null',
    parseProfile: (output) => {
      if (output.includes('refresh_token') || output.includes('access_token')) {
        return 'Authenticated (Qwen OAuth)';
      }
      return null;
    },
    description: 'Qwen Code CLI using browser OAuth authentication',
    access: 'ACCOUNT'
  },
  {
    name: 'OpenCode CLI',
    id: 'opencode-cli',
    checkCmd: 'opencode --version',
    loginCmd: 'opencode providers login',
    profileCmd: 'cat ~/.local/share/opencode/auth.json 2>/dev/null',
    parseProfile: (output) => {
      if (output.includes('refreshToken') || output.includes('accessToken') || output.includes('provider')) {
        return 'Authenticated (OpenCode provider login)';
      }
      return null;
    },
    description: 'OpenCode CLI using provider login stored locally',
    access: 'ACCOUNT'
  }
];

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

function checkInstalled(cli) {
  try {
    execSync(cli.checkCmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getProfile(cli) {
  if (!cli.profileCmd) return null;

  try {
    const output = execSync(cli.profileCmd, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });
    return cli.parseProfile ? cli.parseProfile(output) : (output.trim() || null);
  } catch (err) {
    if (err.stderr && cli.parseProfile) {
      return cli.parseProfile(err.stderr);
    }
    return null;
  }
}

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

function displayStatus(cli, installed, profile) {
  const nameCol = cli.name.padEnd(22);
  const accessTag = `${c.cyan}${cli.access}${c.reset}`;

  if (!installed) {
    print(`${c.dim}✗ ${nameCol}${c.reset} [Not installed]`);
    return;
  }

  if (profile) {
    print(`${c.green}✓${c.reset} ${nameCol} ${accessTag}  ${c.cyan}${profile}${c.reset}`);
  } else {
    print(`${c.yellow}○${c.reset} ${nameCol} ${accessTag}  ${c.dim}Not authenticated${c.reset}`);
  }
}

async function setupCli(cli) {
  printHeader(cli.name);
  print(`${c.dim}${cli.description}${c.reset}`);
  if (cli.note) {
    print(`${c.yellow}Note: ${cli.note}${c.reset}`);
  }
  print();

  const profile = getProfile(cli);
  if (profile) {
    printSuccess(`Already authenticated as: ${c.cyan}${profile}${c.reset}`);
    const answer = await question(`\n${c.bright}Re-authenticate?${c.reset} [y/N]: `);
    if (answer.toLowerCase() !== 'y') {
      return { status: 'already-auth', profile };
    }
  }

  const answer = await question(`\n${c.bright}Run login command?${c.reset} (${cli.loginCmd}) [Y/n]: `);
  if (answer.toLowerCase() === 'n') {
    printInfo('Skipped');
    return { status: 'skipped' };
  }

  const success = await runInteractiveLogin(cli.loginCmd);
  const newProfile = getProfile(cli);

  if (newProfile) {
    printSuccess(`Authenticated as: ${c.cyan}${newProfile}${c.reset}`);
    return { status: 'authenticated', profile: newProfile };
  }

  if (success) {
    printWarning('Login completed but profile verification was inconclusive');
    return { status: 'unknown' };
  }

  printError('Login may have failed');
  return { status: 'failed' };
}

async function main() {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status') || args.includes('-s');

  createReadline();

  print();
  print(`${c.bgGreen}${c.bright} cliagents - Supported CLI Authentication ${c.reset}`);
  print();

  if (statusOnly) {
    print(`${c.bright}Authentication Status:${c.reset}`);
    print();
  } else {
    print('This will help you authenticate the supported broker CLIs.');
    print();
  }

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
      if (!profile) {
        needsAuth.push(cli);
      }
    }
  }

  print(`${'─'.repeat(60)}`);
  print();

  const authed = installed.filter((item) => item.profile);
  print(`${c.bright}Summary:${c.reset} ${installed.length} installed, ${authed.length} authenticated`);

  if (statusOnly) {
    rl.close();
    return;
  }

  if (needsAuth.length === 0) {
    if (installed.length === 0) {
      print();
      printWarning('No supported CLIs installed. Install one first:');
      print(`  ${c.cyan}Gemini CLI:${c.reset}  npm install -g @google/gemini-cli`);
      print(`  ${c.cyan}Codex CLI:${c.reset}   npm i -g @openai/codex`);
      print(`  ${c.cyan}Qwen CLI:${c.reset}    npm install -g @qwen-code/qwen-code`);
      print(`  ${c.cyan}OpenCode CLI:${c.reset} npm install -g opencode-ai`);
    } else {
      print();
      printSuccess('All supported CLIs are authenticated.');
    }
    rl.close();
    return;
  }

  print();
  print(`${c.yellow}${needsAuth.length} CLI(s) need authentication:${c.reset} ${needsAuth.map((cli) => cli.name).join(', ')}`);

  const answer = await question(`\n${c.bright}Set up authentication now?${c.reset} [Y/n]: `);
  if (answer.toLowerCase() === 'n') {
    print(`\nRun ${c.cyan}npm run setup${c.reset} anytime to authenticate.`);
    rl.close();
    return;
  }

  for (const cli of needsAuth) {
    await setupCli(cli);
  }

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
  print(`Test your CLIs at: ${c.cyan}http://localhost:4001/dashboard${c.reset}`);
  print();

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
