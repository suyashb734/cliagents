/**
 * cliagents
 *
 * Main entry point - can be used as a module or run directly as a server.
 */

// Load environment variables from .env file
require('dotenv').config();

const { spawnSync } = require('child_process');
const { normalizeManagedRootAdapter } = require('./orchestration/managed-root-launch');

// Core exports
const AgentAdapter = require('./core/adapter');
const SessionManager = require('./core/session-manager');

// Adapters - Supported broker runtimes
const GeminiCliAdapter = require('./adapters/gemini-cli');
const CodexCliAdapter = require('./adapters/codex-cli');
const QwenCliAdapter = require('./adapters/qwen-cli');
const OpencodeCliAdapter = require('./adapters/opencode-cli');
const { registerActiveAdapters } = require('./adapters/runtime-registry');

// Utilities
const SessionWrapper = require('./utils/session-wrapper');

// Server
const AgentServer = require('./server');

// Transcription Service
const { transcribeAudio } = require('./services/transcriptionService');

function getCliagentsBaseUrl() {
  return process.env.CLIAGENTS_URL || `http://127.0.0.1:${process.env.PORT || 4001}`;
}

async function callCliagentsJson(route, options = {}) {
  const baseUrl = getCliagentsBaseUrl();
  const url = new URL(route, baseUrl);
  const headers = { 'content-type': 'application/json' };
  const apiKey = process.env.CLIAGENTS_API_KEY || process.env.CLI_AGENTS_API_KEY;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const rawText = await response.text();
  let data = rawText;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = rawText;
  }

  if (!response.ok) {
    const message = data?.error?.message || rawText || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function parseLaunchArgs(rawArgs = []) {
  const args = [...rawArgs];
  const parsed = {
    adapter: 'codex-cli',
    workDir: process.cwd(),
    allowedTools: [],
    detach: false
  };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.adapter = normalizeManagedRootAdapter(args.shift());
  }

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--detach':
        parsed.detach = true;
        break;
      case '--workdir':
      case '--working-directory':
        parsed.workDir = args.shift();
        break;
      case '--model':
        parsed.model = args.shift();
        break;
      case '--permission-mode':
        parsed.permissionMode = args.shift();
        break;
      case '--system-prompt':
        parsed.systemPrompt = args.shift();
        break;
      case '--external-session-ref':
        parsed.externalSessionRef = args.shift();
        break;
      case '--allow-tool':
        parsed.allowedTools.push(args.shift());
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown launch argument: ${token}`);
    }
  }

  parsed.adapter = normalizeManagedRootAdapter(parsed.adapter);
  if (!parsed.workDir) {
    parsed.workDir = process.cwd();
  }
  parsed.allowedTools = parsed.allowedTools.filter(Boolean);
  return parsed;
}

function printLaunchUsage() {
  console.log('Usage: cliagents launch <adapter> [options]');
  console.log('');
  console.log('Adapters: codex, claude, qwen, gemini, opencode');
  console.log('Options:');
  console.log('  --workdir <path>              Working directory for the root terminal');
  console.log('  --model <name>                Model override for the launched root');
  console.log('  --permission-mode <mode>      Permission mode (default: default)');
  console.log('  --system-prompt <text>        Optional system prompt for the root');
  console.log('  --external-session-ref <id>   Stable external session ref to bind');
  console.log('  --allow-tool <tool>           Restrict allowed tools (repeatable)');
  console.log('  --detach                      Create the terminal without attaching');
}

function attachToManagedSession(launchResult) {
  const sessionName = launchResult?.sessionName;
  const attachCommand = launchResult?.attachCommand;

  if (!sessionName) {
    return;
  }

  const tmuxArgs = process.env.TMUX
    ? ['switch-client', '-t', sessionName]
    : ['attach', '-t', sessionName];
  const result = spawnSync('tmux', tmuxArgs, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    const message = result.error?.message || `tmux exited with status ${result.status}`;
    console.error(`[cliagents] Failed to attach automatically: ${message}`);
    if (attachCommand) {
      console.error(`[cliagents] Attach manually with: ${attachCommand}`);
    }
  }
}

async function launchManagedRootSession(options = {}) {
  return callCliagentsJson('/orchestration/root-sessions/launch', {
    method: 'POST',
    body: {
      adapter: options.adapter,
      workDir: options.workDir,
      model: options.model || null,
      permissionMode: options.permissionMode || 'default',
      systemPrompt: options.systemPrompt || null,
      externalSessionRef: options.externalSessionRef || null,
      allowedTools: Array.isArray(options.allowedTools) && options.allowedTools.length > 0
        ? options.allowedTools
        : null
    }
  });
}

async function handleLaunchCommand(rawArgs = []) {
  const launchOptions = parseLaunchArgs(rawArgs);
  if (launchOptions.help) {
    printLaunchUsage();
    return;
  }

  const result = await launchManagedRootSession(launchOptions);
  console.log('Managed Root Launched');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  session_name: ${result.sessionName}`);
  console.log(`  external_session_ref: ${result.externalSessionRef || 'n/a'}`);
  console.log(`  console_url: ${new URL(result.consoleUrl || '/console', getCliagentsBaseUrl()).toString()}`);
  if (result.attachCommand) {
    console.log(`  attach_command: ${result.attachCommand}`);
  }

  if (!launchOptions.detach && process.stdout.isTTY) {
    attachToManagedSession(result);
  }
}

// Export for use as a module
module.exports = {
  // Core
  AgentAdapter,
  SessionManager,
  SessionWrapper,

  // Adapters - Supported broker runtimes
  GeminiCliAdapter,
  CodexCliAdapter,
  QwenCliAdapter,
  OpencodeCliAdapter,

  // Server
  AgentServer,

  // Transcription
  transcribeAudio,

  // Managed root launch helpers
  parseLaunchArgs,
  launchManagedRootSession,
  handleLaunchCommand,

  // Quick-start factory
  createServer: (options = {}) => new AgentServer(options),

  // Create standalone session manager (without HTTP server)
  // Registers the focused broker adapters
  createSessionManager: (options = {}) => {
    const manager = new SessionManager(options);
    registerActiveAdapters(manager, options);

    return manager;
  }
};

// Run as server if executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'launch') {
    handleLaunchCommand(args.slice(1)).catch((error) => {
      console.error(`[cliagents] Launch failed: ${error.message}`);
      process.exit(1);
    });
    return;
  }

  const port = process.env.PORT || 4001;
  const transcribeIndex = args.indexOf('--transcribe');

  if (transcribeIndex !== -1) {
    const audioFilePath = args[transcribeIndex + 1];
    if (audioFilePath) {
      console.log(`Transcribing audio file: ${audioFilePath}`);
      transcribeAudio(audioFilePath)
        .then(transcript => {
          console.log('Transcription Result:');
          console.log(transcript);
          process.exit(0);
        })
        .catch(error => {
          console.error('Transcription failed:', error);
          process.exit(1);
        });
    } else {
      console.error('Error: Please provide an audio file path after --transcribe');
      process.exit(1);
    }
    return; // Exit here, don't start the server
  }

  const server = new AgentServer({ port });

  server.start().then(() => {
    console.log('\nAPI Endpoints:');
    console.log('  GET  /health              - Health check');
    console.log('  GET  /adapters            - List available adapters');
    console.log('  POST /sessions            - Create new session');
    console.log('  GET  /sessions            - List all sessions');
    console.log('  GET  /sessions/:id        - Get session info');
    console.log('  POST /sessions/:id/messages - Send message');
    console.log('  POST /sessions/:id/parse  - Parse response text');
    console.log('  DELETE /sessions/:id      - Terminate session');
    console.log('  POST /ask                 - One-shot ask (auto session)');
    console.log('\nWebSocket: ws://localhost:' + port + '/ws');
    console.log('\nReady to accept connections!\n');
  });

  // Note: Graceful shutdown handlers are registered by AgentServer._setupShutdownHandlers()
}
