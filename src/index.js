/**
 * cliagents
 *
 * Main entry point - can be used as a module or run directly as a server.
 */

// Load environment variables from .env file
require('dotenv').config();

const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const {
  normalizeManagedRootAdapter,
  inferManagedRootOriginClient,
  normalizeManagedRootLaunchProfile,
  getManagedRootLaunchProfiles
} = require('./orchestration/managed-root-launch');

// Core exports
const AgentAdapter = require('./core/adapter');
const SessionManager = require('./core/session-manager');

// Adapters - Supported broker runtimes
const GeminiCliAdapter = require('./adapters/gemini-cli');
const CodexCliAdapter = require('./adapters/codex-cli');
const QwenCliAdapter = require('./adapters/qwen-cli');
const OpencodeCliAdapter = require('./adapters/opencode-cli');
const ClaudeCodeAdapter = require('./adapters/claude-code');
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

const MANAGED_ROOT_TERMINAL_ENV_KEYS = Object.freeze([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'VTE_VERSION',
  'KITTY_WINDOW_ID',
  'KITTY_PUBLIC_KEY',
  'KITTY_INSTALLATION_DIR',
  'WT_SESSION',
  'WT_PROFILE_ID',
  'TERMUX_VERSION'
]);

const MANAGED_ROOT_SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish']);
const ROOT_SESSION_SCOPE_VALUES = new Set(['user', 'all', 'detached', 'legacy']);
const LIVE_ROOT_SESSION_STATUSES = new Set(['running', 'processing', 'pending', 'partial', 'blocked', 'needs_attention', 'idle']);
const DUMB_TERMINAL_VALUES = new Set(['', 'dumb', 'unknown']);

function buildManagedRootLaunchEnvironment(env = process.env) {
  const launchEnvironment = {};
  for (const key of MANAGED_ROOT_TERMINAL_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      launchEnvironment[key] = value;
    }
  }
  const columns = Number.parseInt(process.stdout?.columns, 10);
  const rows = Number.parseInt(process.stdout?.rows, 10);
  if (Number.isInteger(columns) && columns > 0) {
    launchEnvironment.COLUMNS = String(columns);
  } else if (typeof env?.COLUMNS === 'string' && env.COLUMNS.trim()) {
    launchEnvironment.COLUMNS = env.COLUMNS.trim();
  }
  if (Number.isInteger(rows) && rows > 0) {
    launchEnvironment.LINES = String(rows);
  } else if (typeof env?.LINES === 'string' && env.LINES.trim()) {
    launchEnvironment.LINES = env.LINES.trim();
  }
  return launchEnvironment;
}

function buildManagedRootAttachEnvironment(env = process.env) {
  const attachEnv = { ...env };
  const normalizedTerm = String(attachEnv.TERM || '').trim().toLowerCase();

  // Codex Desktop's shell can report TERM=dumb even though the actual
  // terminal renderer supports a richer tmux client surface.
  if (DUMB_TERMINAL_VALUES.has(normalizedTerm)) {
    attachEnv.TERM = 'xterm-256color';
  }

  if (!String(attachEnv.COLORTERM || '').trim()) {
    attachEnv.COLORTERM = 'truecolor';
  }

  return attachEnv;
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
    profile: 'guarded-root',
    allowedTools: [],
    detach: false,
    profileExplicit: false,
    modelExplicit: false,
    permissionModeExplicit: false,
    providerResumePicker: false,
    freshProviderSession: false
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
        parsed.modelExplicit = true;
        break;
      case '--profile':
        parsed.profile = args.shift();
        parsed.profileExplicit = true;
        break;
      case '--permission-mode':
        parsed.permissionMode = args.shift();
        parsed.permissionModeExplicit = true;
        break;
      case '--system-prompt':
        parsed.systemPrompt = args.shift();
        break;
      case '--external-session-ref':
        parsed.externalSessionRef = args.shift();
        break;
      case '--new':
      case '--new-root':
        parsed.forceNewRoot = true;
        break;
      case '--resume-root':
        parsed.resumeRootSessionId = args.shift();
        break;
      case '--resume-latest':
        parsed.resumeLatest = true;
        break;
      case '--recover-root':
        parsed.recoverRootSessionId = args.shift();
        break;
      case '--recover-latest':
        parsed.recoverLatest = true;
        break;
      case '--resume-provider-session':
        parsed.providerSessionId = args.shift();
        break;
      case '--resume-provider-picker':
      case '--provider-resume-picker':
        parsed.providerResumePicker = true;
        break;
      case '--fresh-provider-session':
        parsed.freshProviderSession = true;
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
  parsed.profile = normalizeManagedRootLaunchProfile(parsed.profile).id;
  if (!parsed.workDir) {
    parsed.workDir = process.cwd();
  }
  const hasResumeFlag = Boolean(parsed.resumeRootSessionId || parsed.resumeLatest);
  const hasRecoverFlag = Boolean(parsed.recoverRootSessionId || parsed.recoverLatest);
  const hasProviderResume = Boolean(parsed.providerSessionId);
  const hasProviderPicker = parsed.providerResumePicker === true;
  if (parsed.forceNewRoot && (hasResumeFlag || hasRecoverFlag)) {
    throw new Error('Cannot combine --new-root with resume or recover flags');
  }
  if (hasProviderResume && (hasResumeFlag || hasRecoverFlag)) {
    throw new Error('Cannot combine --resume-provider-session with resume or recover flags');
  }
  if (hasProviderResume && hasProviderPicker) {
    throw new Error('Cannot combine --resume-provider-session with --resume-provider-picker');
  }
  if (parsed.freshProviderSession && (hasProviderResume || hasProviderPicker)) {
    throw new Error('Cannot combine --fresh-provider-session with provider resume options');
  }
  if (hasProviderPicker && parsed.adapter !== 'codex-cli') {
    throw new Error('--resume-provider-picker is currently supported only for Codex managed roots');
  }
  if (parsed.externalSessionRef && (hasResumeFlag || hasRecoverFlag)) {
    throw new Error('Cannot combine --external-session-ref with resume or recover flags');
  }
  if (hasResumeFlag && hasRecoverFlag) {
    throw new Error('Cannot combine resume and recover flags in the same launch command');
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
  console.log('  --profile <name>              Launch profile (default: guarded-root)');
  console.log('  --permission-mode <mode>      Permission mode override');
  console.log('  --system-prompt <text>        Optional system prompt for the root');
  console.log('  --external-session-ref <id>   Stable external session ref to bind');
  console.log('  --new-root                    Always create a fresh managed root');
  console.log('  --resume-root <id>            Reattach to a specific live managed root');
  console.log('  --resume-latest               Resume the most recent matching root if one exists, preferring live reattach then carried context');
  console.log('  --recover-root <id>           Recover a specific stale or shell-only managed root');
  console.log('  --recover-latest              Recover the most recent stale, interrupted, or shell-only root');
  console.log('  --resume-provider-session <id> Exact-resume a provider-local session into a new managed root');
  console.log('  --resume-provider-picker      Show cliagents provider-session summaries before native picker fallback');
  console.log('  --fresh-provider-session      Start Codex with a fresh provider session, bypassing the picker default');
  console.log('  --allow-tool <tool>           Restrict allowed tools (repeatable)');
  console.log('  --detach                      Create the terminal without attaching');
  console.log('');
  console.log('Profiles:');
  for (const profile of getManagedRootLaunchProfiles()) {
    console.log(`  ${profile.id.padEnd(18)} ${profile.description}`);
  }
}

function parseAdoptArgs(rawArgs = []) {
  const args = [...rawArgs];
  const parsed = {
    adapter: 'codex-cli'
  };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.adapter = normalizeManagedRootAdapter(args.shift());
  }

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--tmux':
      case '--tmux-target':
        parsed.tmuxTarget = args.shift();
        break;
      case '--session':
        parsed.sessionName = args.shift();
        break;
      case '--window':
        parsed.windowName = args.shift();
        break;
      case '--workdir':
      case '--working-directory':
        parsed.workDir = args.shift();
        break;
      case '--model':
        parsed.model = args.shift();
        break;
      case '--external-session-ref':
        parsed.externalSessionRef = args.shift();
        break;
      case '--root-session-id':
        parsed.rootSessionId = args.shift();
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown adopt argument: ${token}`);
    }
  }

  parsed.adapter = normalizeManagedRootAdapter(parsed.adapter);
  return parsed;
}

function printAdoptUsage() {
  console.log('Usage: cliagents adopt <adapter> --tmux <session:window> [options]');
  console.log('');
  console.log('Adapters: codex, claude, qwen, gemini, opencode');
  console.log('Options:');
  console.log('  --tmux <session:window>       Existing tmux target to adopt');
  console.log('  --session <name>              Tmux session name (alternative to --tmux)');
  console.log('  --window <name>               Tmux window name (alternative to --tmux)');
  console.log('  --workdir <path>              Override detected working directory');
  console.log('  --model <name>                Model metadata to associate with the root');
  console.log('  --external-session-ref <id>   Stable external session ref to bind');
  console.log('  --root-session-id <id>        Reuse an existing broker root ID');
}

function getAdapterForModelListing(adapter) {
  switch (normalizeManagedRootAdapter(adapter)) {
    case 'codex-cli':
      return new CodexCliAdapter();
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'qwen-cli':
      return new QwenCliAdapter();
    case 'opencode-cli':
      return new OpencodeCliAdapter();
    case 'gemini-cli':
      return new GeminiCliAdapter();
    default:
      throw new Error(`Unknown adapter: ${adapter}`);
  }
}

function printListModelsUsage() {
  console.log('Usage: cliagents list-models <adapter>');
  console.log('');
  console.log('Adapters: codex, claude, qwen, gemini, opencode');
}

function normalizeRootSessionScope(scope) {
  const normalized = String(scope || 'user').trim().toLowerCase();
  return ROOT_SESSION_SCOPE_VALUES.has(normalized) ? normalized : 'user';
}

function parseListRootsArgs(rawArgs = []) {
  const args = [...rawArgs];
  const parsed = {
    adapter: null,
    includeArchived: false,
    json: false,
    limit: 12,
    liveOnly: true,
    scope: 'user',
    workDir: null
  };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.adapter = normalizeManagedRootAdapter(args.shift());
  }

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--limit': {
        const value = Number.parseInt(String(args.shift() || '').trim(), 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error('Invalid --limit value');
        }
        parsed.limit = value;
        break;
      }
      case '--scope':
        parsed.scope = normalizeRootSessionScope(args.shift());
        break;
      case '--workdir':
      case '--working-directory':
        parsed.workDir = resolveLaunchWorkDir(args.shift());
        break;
      case '--archived':
        parsed.includeArchived = true;
        break;
      case '--all':
        parsed.liveOnly = false;
        break;
      case '--live-only':
        parsed.liveOnly = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown list-roots argument: ${token}`);
    }
  }

  return parsed;
}

function printListRootsUsage() {
  console.log('Usage: cliagents list-roots [adapter] [options]');
  console.log('');
  console.log('Adapters: codex, claude, qwen, gemini, opencode');
  console.log('Options:');
  console.log('  --limit <n>                   Maximum number of roots to inspect (default: 12)');
  console.log('  --scope <scope>               Root scope: user, all, detached, legacy');
  console.log('  --workdir <path>              Filter roots to a specific working directory');
  console.log('  --archived                    Include archived legacy roots');
  console.log('  --all                         Show live and historical roots');
  console.log('  --live-only                   Show only live/attachable roots (default)');
  console.log('  --json                        Emit JSON instead of text');
}

function parseAttachRootArgs(rawArgs = []) {
  const args = [...rawArgs];
  const parsed = {
    adapter: null,
    includeArchived: false,
    latest: false,
    printOnly: false,
    scope: 'user',
    workDir: null
  };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.rootSessionId = args.shift();
  }

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--latest':
        parsed.latest = true;
        break;
      case '--adapter':
        parsed.adapter = normalizeManagedRootAdapter(args.shift());
        break;
      case '--scope':
        parsed.scope = normalizeRootSessionScope(args.shift());
        break;
      case '--workdir':
      case '--working-directory':
        parsed.workDir = resolveLaunchWorkDir(args.shift());
        break;
      case '--archived':
        parsed.includeArchived = true;
        break;
      case '--print-only':
        parsed.printOnly = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown attach-root argument: ${token}`);
    }
  }

  if (parsed.latest && parsed.rootSessionId) {
    throw new Error('Cannot combine an explicit root session id with --latest');
  }
  if (!parsed.latest && !parsed.rootSessionId && !parsed.help) {
    throw new Error('attach-root requires a <rootSessionId> or --latest');
  }

  return parsed;
}

function printAttachRootUsage() {
  console.log('Usage: cliagents attach-root <rootSessionId> [options]');
  console.log('   or: cliagents attach-root --latest [options]');
  console.log('');
  console.log('Options:');
  console.log('  --latest                      Attach to the most recent live root');
  console.log('  --adapter <adapter>           Limit --latest to one adapter');
  console.log('  --scope <scope>               Root scope: user, all, detached, legacy');
  console.log('  --workdir <path>              Limit --latest to a specific working directory');
  console.log('  --archived                    Include archived legacy roots when searching');
  console.log('  --print-only                  Print the attach command without attaching');
}

function parseServePort(value, fallback = 4001) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parseServeArgs(rawArgs = [], env = process.env) {
  const args = [...rawArgs];
  const parsed = {
    host: String(env.CLIAGENTS_HOST || env.HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: parseServePort(env.PORT, 4001),
    orchestration: {
      dataDir: env.CLIAGENTS_DATA_DIR || null,
      logDir: env.CLIAGENTS_LOG_DIR || null,
      tmuxSocketPath: env.CLIAGENTS_TMUX_SOCKET || null,
      workDir: env.CLIAGENTS_WORK_DIR || process.cwd(),
      destroyTerminalsOnStop: env.CLIAGENTS_DESTROY_TERMINALS_ON_STOP === '1'
    }
  };

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--host':
        parsed.host = String(args.shift() || '').trim() || parsed.host;
        break;
      case '--port':
        parsed.port = parseServePort(args.shift(), parsed.port);
        break;
      case '--data-dir':
        parsed.orchestration.dataDir = args.shift() || null;
        break;
      case '--log-dir':
        parsed.orchestration.logDir = args.shift() || null;
        break;
      case '--tmux-socket':
        parsed.orchestration.tmuxSocketPath = args.shift() || null;
        break;
      case '--workdir':
      case '--working-directory':
        parsed.orchestration.workDir = args.shift() || process.cwd();
        break;
      case '--destroy-terminals-on-stop':
        parsed.orchestration.destroyTerminalsOnStop = true;
        break;
      case '--preserve-terminals-on-stop':
        parsed.orchestration.destroyTerminalsOnStop = false;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown serve argument: ${token}`);
    }
  }

  return parsed;
}

function printServeUsage() {
  console.log('Usage: cliagents serve [options]');
  console.log('       cliagents [options]');
  console.log('');
  console.log('Options:');
  console.log('  --host <host>                Host to bind (default: 127.0.0.1; use 0.0.0.0 for LAN)');
  console.log('  --port <port>                Port to bind (default: 4001)');
  console.log('  --data-dir <path>            Broker data directory');
  console.log('  --log-dir <path>             Broker terminal log directory');
  console.log('  --tmux-socket <path>         Isolated tmux socket for this broker');
  console.log('  --workdir <path>             Default orchestration working directory');
  console.log('  --destroy-terminals-on-stop  Tear down broker terminals on shutdown');
  console.log('  --preserve-terminals-on-stop Keep managed roots alive on shutdown');
}

function printServerReadyBanner(port) {
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
}

async function handleServeCommand(rawArgs = [], env = process.env) {
  const serveOptions = parseServeArgs(rawArgs, env);
  if (serveOptions.help) {
    printServeUsage();
    return null;
  }

  const server = new AgentServer(serveOptions);
  await server.start();
  const address = server.server?.address();
  const resolvedPort = address && typeof address === 'object' ? address.port : server.port;
  printServerReadyBanner(resolvedPort);
  return server;
}

function listAdapterModels(rawArgs = []) {
  const adapterArg = rawArgs[0];
  if (!adapterArg || adapterArg === '--help' || adapterArg === '-h') {
    printListModelsUsage();
    return;
  }

  const adapter = normalizeManagedRootAdapter(adapterArg);
  const adapterInstance = getAdapterForModelListing(adapter);
  const models = typeof adapterInstance.getAvailableModels === 'function'
    ? adapterInstance.getAvailableModels()
    : [];

  console.log(`Models for ${adapter}`);
  if (!models.length) {
    console.log('  No explicit model catalog available.');
    return;
  }

  for (const model of models) {
    console.log(`  ${String(model.id || 'unknown').padEnd(28)} ${model.description || model.name || ''}`);
  }
}

function resolveLaunchWorkDir(workDir) {
  return path.resolve(workDir || process.cwd());
}

function describeLaunchWorkDir(workDir) {
  return workDir ? resolveLaunchWorkDir(workDir) : 'the current workspace';
}

function normalizeActivityTimestamp(value) {
  if (value == null) {
    return 0;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRootSessionActivityAge(record) {
  return formatManagedRootCandidateAge({
    lastOccurredAt: record?.lastMessageAt || record?.lastOccurredAt || null,
    lastRecordedAt: record?.lastRecordedAt || null
  });
}

function truncateManagedRootContextText(value, maxLength = 320) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 16)).trimEnd()}... [truncated]`;
}

function isExistingRootModelCompatible(launchOptions = {}, candidate = null) {
  if (!candidate || !launchOptions?.modelExplicit) {
    return true;
  }
  const requestedModel = String(launchOptions.model || '').trim();
  const candidateModel = String(candidate.model || '').trim();
  if (!requestedModel) {
    return true;
  }
  if (!candidateModel) {
    return false;
  }
  return requestedModel === candidateModel;
}

function combineManagedRootSystemPrompt(contextPrompt, explicitPrompt = null) {
  const sections = [];
  const normalizedContext = String(contextPrompt || '').trim();
  const normalizedExplicit = String(explicitPrompt || '').trim();

  if (normalizedContext) {
    sections.push(normalizedContext);
  }
  if (normalizedExplicit) {
    sections.push(`Additional operator instructions:\n${normalizedExplicit}`);
  }

  return sections.join('\n\n') || null;
}

function buildManagedRootContextResumePrompt(candidate, bundle, messageWindow = []) {
  const sections = [
    'You are continuing prior work from an older cliagents root session in a new linked root.',
    `Previous root session: ${candidate?.rootSessionId || 'unknown'}.`
  ];

  if (bundle?.brief) {
    sections.push(`Summary:\n${truncateManagedRootContextText(bundle.brief, 1500)}`);
  } else if (candidate?.latestSummary) {
    sections.push(`Summary:\n${truncateManagedRootContextText(candidate.latestSummary, 1500)}`);
  }

  if (Array.isArray(bundle?.keyDecisions) && bundle.keyDecisions.length > 0) {
    sections.push(`Key decisions:\n${bundle.keyDecisions.slice(0, 8).map((entry) => `- ${truncateManagedRootContextText(entry, 180)}`).join('\n')}`);
  }

  if (Array.isArray(bundle?.pendingItems) && bundle.pendingItems.length > 0) {
    sections.push(`Pending items:\n${bundle.pendingItems.slice(0, 8).map((entry) => `- ${truncateManagedRootContextText(entry, 180)}`).join('\n')}`);
  }

  const formattedMessages = (Array.isArray(messageWindow) ? messageWindow : [])
    .slice(-8)
    .map((entry) => `${entry.role || 'message'}: ${truncateManagedRootContextText(entry.content, 280)}`)
    .filter(Boolean);
  if (formattedMessages.length > 0) {
    sections.push(`Recent conversation excerpts:\n${formattedMessages.join('\n')}`);
  }

  sections.push('Treat this as carried context only. Continue from here instead of asking to reconstruct the prior thread.');
  return sections.filter(Boolean).join('\n\n');
}

function createManagedRootLaunchTarget(action, reason, options = {}) {
  const resumeModeByAction = {
    launch: 'new',
    resume: 'reattach',
    recover: 'exact',
    context: 'context'
  };

  return {
    action,
    resumeMode: resumeModeByAction[action] || 'new',
    reason,
    ...(options.candidate ? { candidate: options.candidate } : {}),
    ...(options.candidates ? { candidates: options.candidates } : {})
  };
}

function canRecoverManagedRootExactly(launchOptions = {}, candidate = null) {
  return Boolean(candidate)
    && isExistingRootModelCompatible(launchOptions, candidate)
    && hasExactManagedRootProviderResume(candidate);
}

function shouldDefaultCodexProviderResumePicker(launchOptions = {}, launchTarget = null, options = {}) {
  void launchOptions;
  void launchTarget;
  void options;
  return false;
}

function applyCodexProviderResumePickerDefault(launchOptions = {}, launchTarget = null, options = {}) {
  if (!shouldDefaultCodexProviderResumePicker(launchOptions, launchTarget, options)) {
    return launchOptions;
  }
  return {
    ...launchOptions,
    providerResumePicker: true,
    providerResumePickerDefaulted: true
  };
}

async function buildManagedRootContextLaunchOptions(launchOptions, candidate, dependencies = {}) {
  if (!candidate) {
    throw new Error('Context resume requires a managed root candidate');
  }

  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const logger = dependencies.logger || console;
  const rootSessionId = candidate.rootSessionId;
  const encodedRootSessionId = encodeURIComponent(rootSessionId);
  const safeCallJson = async (route) => {
    try {
      return await callJson(route);
    } catch (error) {
      logger.warn?.(`[cliagents] Failed to load carried context for ${rootSessionId}: ${error.message}`);
      return null;
    }
  };

  const [bundle, messageWindow] = await Promise.all([
    safeCallJson(
      `/orchestration/memory/bundle/${encodedRootSessionId}?scope_type=root&recent_runs_limit=3&include_raw_pointers=true`
    ),
    safeCallJson(
      `/orchestration/memory/messages?root_session_id=${encodedRootSessionId}&limit=12`
    )
  ]);
  const messageList = Array.isArray(messageWindow?.messages) ? messageWindow.messages : [];
  const contextPrompt = buildManagedRootContextResumePrompt(candidate, bundle, messageList);
  const modelSwitch = launchOptions?.modelExplicit && !isExistingRootModelCompatible(launchOptions, candidate);

  return {
    ...launchOptions,
    adapter: candidate.adapter || launchOptions.adapter,
    workDir: candidate.workDir || launchOptions.workDir,
    profile: launchOptions.profileExplicit ? launchOptions.profile : (candidate.launchProfile || launchOptions.profile),
    model: launchOptions.modelExplicit ? launchOptions.model : (candidate.model || launchOptions.model || null),
    permissionMode: launchOptions.permissionModeExplicit ? launchOptions.permissionMode : null,
    systemPrompt: combineManagedRootSystemPrompt(contextPrompt, launchOptions.systemPrompt),
    externalSessionRef: candidate.externalSessionRef || launchOptions.externalSessionRef || null,
    sessionMetadata: {
      contextResumedManagedRoot: true,
      contextResume: true,
      resumeMode: 'context',
      previousRootSessionId: candidate.rootSessionId,
      previousTerminalId: candidate.terminalId || null,
      previousRootStatus: candidate.status || null,
      previousProcessState: candidate.processState || null,
      previousCurrentCommand: candidate.currentCommand || null,
      previousProviderThreadRef: candidate.providerThreadRef || null,
      previousRecoveryCapability: candidate.recoveryCapability || null,
      recoveryReason: candidate.recoveryReason || null,
      providerResumePicker: launchOptions.providerResumePicker === true,
      modelSwitch,
      carriedContextSource: 'root-bundle+message-window',
      carriedContextMessageCount: messageList.length,
      carriedContextStale: bundle?.isStale === true,
      carriedContextRunIds: Array.isArray(bundle?.rawPointers?.runIds) ? bundle.rawPointers.runIds : []
    }
  };
}

function getRootSessionMainTerminal(snapshot) {
  const terminals = Array.isArray(snapshot?.terminals) ? snapshot.terminals : [];
  return terminals.find((terminal) => (
    String(terminal?.role || '').trim().toLowerCase() === 'main'
    && String(terminal?.session_kind || '').trim().toLowerCase() === 'main'
  )) || terminals.find((terminal) => (
    terminal
    && terminal.root_session_id
    && snapshot?.rootSessionId
    && terminal.root_session_id === snapshot.rootSessionId
  )) || null;
}

function getRootSessionWorkDir(snapshot) {
  const rootSession = snapshot?.rootSession || {};
  const sessionMetadata = rootSession.sessionMetadata && typeof rootSession.sessionMetadata === 'object'
    ? rootSession.sessionMetadata
    : {};
  const mainTerminal = getRootSessionMainTerminal(snapshot);
  return mainTerminal?.work_dir || rootSession.workDir || sessionMetadata.workspaceRoot || null;
}

function buildRootSessionOperatorRecord(summary, snapshot, options = {}) {
  if (!summary) {
    return null;
  }

  const rootSession = snapshot?.rootSession || {};
  const mainTerminal = getRootSessionMainTerminal(snapshot);
  const adapter = String(mainTerminal?.adapter || rootSession.adapter || '').trim().toLowerCase() || null;
  const originClient = String(summary.originClient || rootSession.originClient || '').trim().toLowerCase() || null;

  if (options.adapter) {
    const normalizedAdapter = normalizeManagedRootAdapter(options.adapter);
    const expectedOriginClient = inferManagedRootOriginClient(normalizedAdapter);
    if (adapter !== normalizedAdapter && originClient !== expectedOriginClient) {
      return null;
    }
  }

  const workDir = getRootSessionWorkDir(snapshot);
  if (options.workDir && (!workDir || resolveLaunchWorkDir(workDir) !== resolveLaunchWorkDir(options.workDir))) {
    return null;
  }

  const status = String(summary.status || snapshot?.status || mainTerminal?.status || rootSession.status || 'unknown').trim().toLowerCase() || 'unknown';
  const processState = String(mainTerminal?.process_state || rootSession.processState || '').trim().toLowerCase() || null;
  const terminalStatus = String(mainTerminal?.status || rootSession.terminalStatus || '').trim().toLowerCase() || null;
  const sessionName = mainTerminal?.session_name || null;
  const live = typeof summary.live === 'boolean'
    ? summary.live
    : (
      Boolean(sessionName)
      && LIVE_ROOT_SESSION_STATUSES.has(status)
      && processState !== 'exited'
      && terminalStatus !== 'orphaned'
    );
  const interactiveTerminalId = summary.interactiveTerminalId || snapshot?.interactiveTerminalId || mainTerminal?.terminal_id || rootSession.terminalId || null;

  return {
    rootSessionId: summary.rootSessionId,
    status,
    live,
    archived: Boolean(summary.archived),
    originClient,
    rootType: summary.rootType || snapshot?.rootType || null,
    rootMode: summary.rootMode || snapshot?.rootMode || null,
    externalSessionRef: summary.externalSessionRef || snapshot?.externalSessionRef || null,
    clientName: summary.clientName || snapshot?.clientName || null,
    terminalId: interactiveTerminalId,
    sessionName,
    adapter,
    workDir,
    processState,
    terminalStatus,
    model: summary.model || rootSession.model || null,
    lastMessageAt: summary.lastMessageAt || null,
    messageCount: summary.messageCount || 0,
    lastOccurredAt: summary.lastOccurredAt || null,
    lastRecordedAt: summary.lastRecordedAt || null,
    recoveryCapability: summary.recoveryCapability || null,
    attention: summary.attention || snapshot?.attention || { requiresAttention: false, reasons: [] },
    latestSummary: summary.activitySummary || snapshot?.activitySummary || summary.latestConclusion?.summary || '',
    activityExcerpt: summary.activityExcerpt || snapshot?.activityExcerpt || '',
    activitySource: summary.activitySource || snapshot?.activitySource || 'fallback',
    attachCommand: sessionName ? `tmux attach -t "${sessionName}"` : null,
    consoleUrl: deriveManagedRootConsoleUrl(summary.rootSessionId, interactiveTerminalId)
  };
}

function compareRootSessionOperatorRecords(left, right) {
  if (Boolean(left?.live) !== Boolean(right?.live)) {
    return left.live ? -1 : 1;
  }
  if (Boolean(left?.attention?.requiresAttention) !== Boolean(right?.attention?.requiresAttention)) {
    return left.attention?.requiresAttention ? -1 : 1;
  }
  const rightTime = normalizeActivityTimestamp(right?.lastMessageAt || right?.lastOccurredAt || right?.lastRecordedAt);
  const leftTime = normalizeActivityTimestamp(left?.lastMessageAt || left?.lastOccurredAt || left?.lastRecordedAt);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  return String(left?.rootSessionId || '').localeCompare(String(right?.rootSessionId || ''));
}

async function listOperatorRootSessions(options = {}, dependencies = {}) {
  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const limit = Math.max(Number(options.limit || 12), 1);
  const scope = normalizeRootSessionScope(options.scope || 'user');
  const params = new URLSearchParams({
    limit: String(limit),
    scope
  });
  const statusFilter = options.statusFilter || (options.liveOnly === false ? 'all' : 'live');
  if (statusFilter && statusFilter !== 'all') {
    params.set('statusFilter', statusFilter);
  }
  if (options.includeArchived) {
    params.set('includeArchived', '1');
  }

  const listResponse = await callJson(`/orchestration/root-sessions?${params.toString()}`);
  const summaries = Array.isArray(listResponse?.roots) ? listResponse.roots : [];
  const results = await Promise.allSettled(summaries.map((summary) => (
    callJson(`/orchestration/root-sessions/${encodeURIComponent(summary.rootSessionId)}?eventLimit=120&terminalLimit=40`)
  )));

  const roots = [];
  results.forEach((result, index) => {
    const summary = summaries[index];
    if (!summary) {
      return;
    }
    const snapshot = result.status === 'fulfilled' ? result.value : null;
    const record = buildRootSessionOperatorRecord(summary, snapshot, options);
    if (record) {
      roots.push(record);
    }
  });

  roots.sort(compareRootSessionOperatorRecords);
  return options.liveOnly === false ? roots : roots.filter((record) => record.live);
}

function printOperatorRootSessionList(records, options = {}) {
  const scope = normalizeRootSessionScope(options.scope || 'user');
  console.log(`Root Sessions (${scope})`);
  if (!records.length) {
    console.log('  No matching root sessions found.');
    return;
  }

  const liveRoots = records.filter((record) => record.live);
  const historicalRoots = records.filter((record) => !record.live);
  const sections = [
    { title: 'Live roots', entries: liveRoots },
    { title: 'Historical roots', entries: historicalRoots }
  ].filter((section) => section.entries.length > 0);

  for (const section of sections) {
    console.log(`\n${section.title}:`);
    for (const record of section.entries) {
      const details = [
        record.adapter || record.originClient || 'unknown',
        record.workDir ? path.basename(record.workDir) : null,
        record.externalSessionRef || null
      ].filter(Boolean).join(' • ');
      console.log(`  ${record.rootSessionId}  ${String(record.status).padEnd(16)} ${getRootSessionActivityAge(record)}${details ? `  ${details}` : ''}`);
      if (record.sessionName) {
        console.log(`    tmux: ${record.sessionName}`);
      }
      if (record.attachCommand) {
        console.log(`    attach: ${record.attachCommand}`);
      }
    }
  }
}

function deriveManagedRootConsoleUrl(rootSessionId, terminalId) {
  const consolePath = '/console';
  const baseUrl = getCliagentsBaseUrl();
  const url = new URL(consolePath, baseUrl);
  if (rootSessionId) {
    url.searchParams.set('root', rootSessionId);
  }
  if (terminalId) {
    url.searchParams.set('terminal', terminalId);
  }
  return url.toString();
}

function normalizeManagedRootCurrentCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  return normalized || null;
}

function isManagedRootShellCommand(command) {
  const normalized = normalizeManagedRootCurrentCommand(command);
  return normalized ? MANAGED_ROOT_SHELL_COMMANDS.has(normalized) : false;
}

function buildManagedRootProviderResumeCommand(adapter, sessionId) {
  const normalizedAdapter = normalizeManagedRootAdapter(adapter || 'codex-cli');
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return null;
  }

  switch (normalizedAdapter) {
    case 'claude-code':
      return `claude --resume ${normalizedSessionId}`;
    case 'gemini-cli':
      return `gemini --resume ${normalizedSessionId}`;
    case 'codex-cli':
      return `codex resume ${normalizedSessionId}`;
    case 'qwen-cli':
      return `qwen --resume ${normalizedSessionId}`;
    case 'opencode-cli':
      return `opencode --session ${normalizedSessionId}`;
    default:
      return null;
  }
}

function buildManagedRootProviderLatestResumeCommand(adapter) {
  const normalizedAdapter = normalizeManagedRootAdapter(adapter || 'codex-cli');

  switch (normalizedAdapter) {
    case 'claude-code':
      return 'claude --continue';
    case 'gemini-cli':
      return 'gemini --resume latest';
    case 'codex-cli':
      return 'codex resume --last';
    case 'qwen-cli':
      return 'qwen --continue';
    case 'opencode-cli':
      return 'opencode --continue';
    default:
      return null;
  }
}

function hasExactManagedRootProviderResume(candidate = null) {
  return Boolean(
    candidate
    && (
      candidate.resumeSessionId
      || candidate.resumeCommand
      || candidate.providerThreadRef
    )
  );
}

function extractManagedRootRecoveryHint(snapshot, rootSessionId) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const mainSession = sessions.find((session) => (
    session?.sessionId === rootSessionId
    || (
      String(session?.role || '').trim().toLowerCase() === 'main'
      && String(session?.sessionKind || '').trim().toLowerCase() === 'main'
    )
  )) || null;

  let resumeCommand = mainSession?.resumeCommand || null;
  let attentionMessage = mainSession?.attentionMessage || null;
  let resumeSessionId = null;
  const providerThreadRef = mainSession?.providerThreadRef || null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload_json || {};
    if (!resumeCommand && payload.resumeCommand) {
      resumeCommand = payload.resumeCommand;
    }
    if (!resumeSessionId && payload.resumeSessionId) {
      resumeSessionId = payload.resumeSessionId;
    }
    if (!attentionMessage && payload.attentionMessage) {
      attentionMessage = payload.attentionMessage;
    }
    if (resumeCommand && resumeSessionId && attentionMessage) {
      break;
    }
  }

  return {
    resumeCommand,
    resumeSessionId,
    attentionMessage,
    providerThreadRef
  };
}

function buildManagedRootLaunchCandidate(summary, snapshot, options = {}) {
  const adapter = normalizeManagedRootAdapter(options.adapter || snapshot?.rootSession?.adapter || summary?.originClient || 'codex-cli');
  const expectedOriginClient = inferManagedRootOriginClient(adapter);
  const expectedWorkDir = options.workDir ? resolveLaunchWorkDir(options.workDir) : null;
  const rootSession = snapshot?.rootSession || {};
  const rootMetadata = rootSession.sessionMetadata && typeof rootSession.sessionMetadata === 'object'
    ? rootSession.sessionMetadata
    : {};
  const attachMode = String(rootMetadata.attachMode || '').trim().toLowerCase();
  const managedRoot = rootMetadata.managedLaunch === true
    || rootMetadata.adoptedRoot === true
    || attachMode === 'managed-root-launch'
    || attachMode === 'root-adopt'
    || summary?.rootMode === 'managed'
    || summary?.rootMode === 'adopted'
    || snapshot?.rootMode === 'managed'
    || snapshot?.rootMode === 'adopted';
  if (!managedRoot) {
    return null;
  }
  if (String(rootSession.originClient || summary?.originClient || '').trim().toLowerCase() !== expectedOriginClient) {
    return null;
  }
  if (String(rootSession.adapter || '').trim().toLowerCase() !== adapter) {
    return null;
  }

  const terminals = Array.isArray(snapshot?.terminals) ? snapshot.terminals : [];
  const mainTerminal = terminals.find((terminal) => (
    String(terminal.role || '').trim().toLowerCase() === 'main'
    && String(terminal.session_kind || '').trim().toLowerCase() === 'main'
    && terminal.session_name
  )) || null;

  const candidateWorkDir = mainTerminal?.work_dir || rootSession.workDir || rootMetadata.workspaceRoot || null;
  if (expectedWorkDir && (!candidateWorkDir || resolveLaunchWorkDir(candidateWorkDir) !== expectedWorkDir)) {
    return null;
  }

  const rootSessionId = rootSession.sessionId || summary?.rootSessionId || mainTerminal?.root_session_id || null;
  if (!rootSessionId) {
    return null;
  }

  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const mainSession = sessions.find((session) => (
    session?.sessionId === rootSessionId
    || (
      String(session?.role || '').trim().toLowerCase() === 'main'
      && String(session?.sessionKind || '').trim().toLowerCase() === 'main'
    )
  )) || null;
  const terminalId = summary?.interactiveTerminalId || snapshot?.interactiveTerminalId || mainTerminal?.terminal_id || rootSession.terminalId || null;
  const sessionName = mainTerminal?.session_name || null;
  const rootStatus = String(rootSession.status || summary?.status || mainTerminal?.status || 'unknown').trim().toLowerCase() || 'unknown';
  const processState = String(mainTerminal?.process_state || rootSession.processState || '').trim().toLowerCase() || null;
  const terminalStatus = String(mainTerminal?.status || rootSession.terminalStatus || '').trim().toLowerCase() || null;
  const currentCommand = normalizeManagedRootCurrentCommand(mainTerminal?.current_command || mainTerminal?.currentCommand || null);
  const runtimeCapabilities = Array.isArray(snapshot?.runtimeCapabilities)
    ? snapshot.runtimeCapabilities
    : (Array.isArray(summary?.runtimeCapabilities)
      ? summary.runtimeCapabilities
      : (Array.isArray(rootSession.runtimeCapabilities) ? rootSession.runtimeCapabilities : []));
  const runtimeInputCapable = runtimeCapabilities.length === 0 || runtimeCapabilities.includes('send_input');
  const recoveryHint = extractManagedRootRecoveryHint(snapshot, rootSessionId);
  const providerThreadRef = recoveryHint.providerThreadRef
    || rootSession.providerThreadRef
    || mainTerminal?.provider_thread_ref
    || mainTerminal?.providerThreadRef
    || null;
  const hasExactProviderResume = hasExactManagedRootProviderResume({
    ...recoveryHint,
    providerThreadRef
  });
  const rootDestroyed = Boolean(mainSession?.destroyed || rootSession.destroyed);
  const rootTerminatedWithError = String(mainSession?.terminationStatus || rootSession.terminationStatus || '').trim().toLowerCase() === 'error';
  const hasLiveTerminal = Boolean(sessionName)
    && runtimeInputCapable
    && processState !== 'exited'
    && terminalStatus !== 'orphaned';
  const providerInterrupted = hasExactProviderResume
    && (
      terminalStatus === 'error'
      || rootStatus === 'error'
      || rootTerminatedWithError
    );
  const shellOnlyRoot = hasLiveTerminal && isManagedRootShellCommand(currentCommand);
  if (rootDestroyed && !sessionName && !hasExactProviderResume && !providerThreadRef) {
    return null;
  }
  const launchAction = hasLiveTerminal && !shellOnlyRoot && !providerInterrupted ? 'resume' : 'recover';
  let recoveryReason = null;
  if (launchAction === 'recover') {
    if (providerInterrupted) {
      recoveryReason = 'provider-interrupted';
    } else if (shellOnlyRoot) {
      recoveryReason = 'provider-exited';
    } else if (rootDestroyed) {
      recoveryReason = 'destroyed';
    } else if (terminalStatus === 'orphaned') {
      recoveryReason = 'orphaned';
    } else if (processState === 'exited') {
      recoveryReason = 'process-exited';
    } else {
      recoveryReason = 'no-live-terminal';
    }
  }

  return {
    rootSessionId,
    terminalId,
    sessionName,
    windowName: mainTerminal?.window_name || null,
    adapter,
    originClient: expectedOriginClient,
    status: rootStatus,
    processState,
    workDir: candidateWorkDir,
    model: mainTerminal?.model || rootSession.model || null,
    externalSessionRef: rootSession.externalSessionRef || summary?.externalSessionRef || mainTerminal?.external_session_ref || null,
    launchProfile: rootMetadata.launchProfile || null,
    lastMessageAt: summary?.lastMessageAt || null,
    messageCount: summary?.messageCount || 0,
    lastOccurredAt: summary?.lastOccurredAt || null,
    lastRecordedAt: summary?.lastRecordedAt || null,
    recoveryCapability: summary?.recoveryCapability || null,
    latestSummary: snapshot?.activitySummary
      || summary?.activitySummary
      || rootSession.latestConclusion?.summary
      || summary?.latestConclusion?.summary
      || summary?.latestSummary
      || recoveryHint.attentionMessage
      || null,
    activityExcerpt: snapshot?.activityExcerpt || summary?.activityExcerpt || null,
    rootMode: snapshot?.rootMode || summary?.rootMode || null,
    currentCommand,
    launchAction,
    recoveryReason,
    exactProviderResume: hasExactProviderResume,
    resumeCommand: recoveryHint.resumeCommand,
    resumeSessionId: recoveryHint.resumeSessionId,
    providerThreadRef,
    attentionMessage: recoveryHint.attentionMessage,
    attachCommand: sessionName ? `tmux attach -t "${sessionName}"` : null,
    consoleUrl: deriveManagedRootConsoleUrl(rootSessionId, terminalId)
  };
}

function normalizeManagedRootResumeCandidate(summary, snapshot, options = {}) {
  const candidate = buildManagedRootLaunchCandidate(summary, snapshot, options);
  if (!candidate || candidate.launchAction !== 'resume') {
    return null;
  }
  if (!candidate.terminalId || !candidate.sessionName) {
    return null;
  }
  return candidate;
}

function normalizeManagedRootRecoveryCandidate(summary, snapshot, options = {}) {
  const candidate = buildManagedRootLaunchCandidate(summary, snapshot, options);
  return candidate?.launchAction === 'recover' ? candidate : null;
}

async function listManagedRootLaunchCandidates(options = {}, dependencies = {}) {
  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const adapter = normalizeManagedRootAdapter(options.adapter || 'codex-cli');
  const rootLimit = Math.max(Number(options.rootLimit || 12), 1);
  const resumeLimit = Math.max(Number(options.resumeLimit || options.candidateLimit || 5), 1);
  const recoveryLimit = Math.max(Number(options.recoveryLimit || options.candidateLimit || 5), 1);
  const listResponse = await callJson(
    `/orchestration/root-sessions?limit=${encodeURIComponent(rootLimit)}&scope=user&eventLimit=80&terminalLimit=20`
  );
  const summaries = Array.isArray(listResponse?.roots) ? listResponse.roots : [];
  const resumeCandidates = [];
  const recoverCandidates = [];

  for (const summary of summaries) {
    if (summary?.originClient !== inferManagedRootOriginClient(adapter)) {
      continue;
    }

    const snapshot = await callJson(
      `/orchestration/root-sessions/${encodeURIComponent(summary.rootSessionId)}?eventLimit=120&terminalLimit=40`
    );
    const candidate = buildManagedRootLaunchCandidate(summary, snapshot, {
      adapter,
      workDir: options.workDir
    });
    if (!candidate) {
      continue;
    }

    if (candidate.launchAction === 'resume') {
      if (resumeCandidates.length < resumeLimit) {
        resumeCandidates.push(candidate);
      }
      continue;
    }

    if (recoverCandidates.length < recoveryLimit) {
      recoverCandidates.push(candidate);
    }
  }

  return {
    resumeCandidates,
    recoverCandidates
  };
}

async function listManagedRootResumeCandidates(options = {}, dependencies = {}) {
  const candidates = await listManagedRootLaunchCandidates(options, dependencies);
  return candidates.resumeCandidates;
}

async function listManagedRootRecoveryCandidates(options = {}, dependencies = {}) {
  const candidates = await listManagedRootLaunchCandidates(options, dependencies);
  return candidates.recoverCandidates;
}

function buildRootSessionSummaryFromSnapshot(rootSessionId, snapshot) {
  const rootSession = snapshot?.rootSession || {};
  const lastOccurredAt = (() => {
    const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const sessionTimestamp = sessions.reduce((max, session) => (
      Math.max(max, normalizeActivityTimestamp(session?.lastEventAt || session?.lastActiveAt || session?.createdAt))
    ), 0);
    const eventTimestamp = events.reduce((max, event) => (
      Math.max(max, normalizeActivityTimestamp(event?.occurred_at || event?.recorded_at))
    ), 0);
    const lastTimestamp = Math.max(sessionTimestamp, eventTimestamp);
    return lastTimestamp > 0 ? new Date(lastTimestamp).toISOString() : null;
  })();

  return {
    rootSessionId,
    status: snapshot?.status || rootSession.status || 'unknown',
    originClient: rootSession.originClient || null,
    model: rootSession.model || null,
    rootType: snapshot?.rootType || null,
    rootMode: snapshot?.rootMode || null,
    interactiveTerminalId: snapshot?.interactiveTerminalId || null,
    externalSessionRef: snapshot?.externalSessionRef || rootSession.externalSessionRef || null,
    clientName: snapshot?.clientName || null,
    attention: snapshot?.attention || { requiresAttention: false, reasons: [] },
    latestConclusion: snapshot?.latestConclusion || null,
    activitySummary: snapshot?.activitySummary || null,
    activityExcerpt: snapshot?.activityExcerpt || null,
    activitySource: snapshot?.activitySource || 'fallback',
    lastMessageAt: snapshot?.lastMessageAt || rootSession.lastMessageAt || null,
    messageCount: snapshot?.messageCount || rootSession.messageCount || 0,
    lastOccurredAt,
    recoveryCapability: snapshot?.recoveryCapability || null,
    live: typeof snapshot?.counts?.live === 'number' ? snapshot.counts.live > 0 : null
  };
}

async function getOperatorRootSession(rootSessionId, options = {}, dependencies = {}) {
  if (!rootSessionId) {
    return null;
  }
  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const snapshot = await callJson(
    `/orchestration/root-sessions/${encodeURIComponent(rootSessionId)}?eventLimit=120&terminalLimit=40`
  );
  return buildRootSessionOperatorRecord(
    buildRootSessionSummaryFromSnapshot(rootSessionId, snapshot),
    snapshot,
    options
  );
}

async function handleListRootsCommand(rawArgs = [], dependencies = {}) {
  const options = parseListRootsArgs(rawArgs);
  if (options.help) {
    printListRootsUsage();
    return;
  }

  const roots = await listOperatorRootSessions(options, dependencies);
  if (options.json) {
    console.log(JSON.stringify(roots, null, 2));
    return;
  }

  printOperatorRootSessionList(roots, options);
}

async function handleAttachRootCommand(rawArgs = [], dependencies = {}) {
  const options = parseAttachRootArgs(rawArgs);
  if (options.help) {
    printAttachRootUsage();
    return;
  }

  const roots = options.latest
    ? await listOperatorRootSessions({
        adapter: options.adapter,
        includeArchived: options.includeArchived,
        limit: 20,
        liveOnly: true,
        scope: options.scope,
        workDir: options.workDir
      }, dependencies)
    : null;

  const record = options.latest
    ? roots[0] || null
    : await getOperatorRootSession(options.rootSessionId, {
        adapter: options.adapter,
        workDir: options.workDir
      }, dependencies);

  if (!record) {
    if (options.latest) {
      throw new Error('No live root sessions matched the current filters');
    }
    throw new Error(`Root session ${options.rootSessionId} was not found or did not match the requested filters`);
  }

  if (!record.sessionName || !record.attachCommand) {
    throw new Error(`Root session ${record.rootSessionId} does not have an attachable tmux session`);
  }

  console.log('Managed Root Selected');
  console.log(`  root_session_id: ${record.rootSessionId}`);
  console.log(`  adapter: ${record.adapter || record.originClient || 'unknown'}`);
  console.log(`  status: ${record.status}`);
  console.log(`  session_name: ${record.sessionName}`);
  console.log(`  workdir: ${record.workDir || 'n/a'}`);
  console.log(`  console_url: ${record.consoleUrl}`);
  console.log(`  attach_command: ${record.attachCommand}`);

  if (!options.printOnly && process.stdout.isTTY) {
    attachToManagedSession(record, {
      logger: dependencies.logger,
      spawnSync: dependencies.spawnSync
    });
  }
}

async function getManagedRootResumeCandidate(rootSessionId, options = {}, dependencies = {}) {
  if (!rootSessionId) {
    return null;
  }
  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const snapshot = await callJson(
    `/orchestration/root-sessions/${encodeURIComponent(rootSessionId)}?eventLimit=120&terminalLimit=40`
  );
  return normalizeManagedRootResumeCandidate(null, snapshot, {
    adapter: options.adapter,
    workDir: options.workDir
  });
}

async function getManagedRootRecoveryCandidate(rootSessionId, options = {}, dependencies = {}) {
  if (!rootSessionId) {
    return null;
  }
  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const snapshot = await callJson(
    `/orchestration/root-sessions/${encodeURIComponent(rootSessionId)}?eventLimit=120&terminalLimit=40`
  );
  return normalizeManagedRootRecoveryCandidate(null, snapshot, {
    adapter: options.adapter,
    workDir: options.workDir
  });
}

function formatManagedRootCandidateAge(candidate) {
  const rawValue = candidate.lastMessageAt || candidate.lastOccurredAt || candidate.lastRecordedAt || null;
  const timestamp = rawValue == null ? NaN : Date.parse(rawValue);
  if (!Number.isFinite(timestamp)) {
    return 'recent';
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function truncateManagedRootPromptText(value, maxLength = 140) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function stripTerminalAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function normalizeManagedRootDisplayText(value) {
  let normalized = stripTerminalAnsi(value)
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '';
  }

  normalized = normalized.replace(
    /^[•◦]\s*Working\s*\([^)]*\)(?:\s*·\s*[^›\n\r]+)?\s*/i,
    ''
  ).trim();
  normalized = normalized.replace(/^[›>]\s*/, '').trim();
  normalized = normalized.replace(
    /\s+[\w.-]+(?:\s+(?:none|minimal|low|medium|high|xhigh))?\s+·\s+(?:~|\/)[^\n\r]*$/i,
    ''
  ).trim();
  normalized = normalized.replace(/\s+·\s+(?:~|\/)[^\n\r]*$/i, '').trim();
  return normalized;
}

function isUsefulManagedRootDisplayText(value) {
  const normalized = normalizeManagedRootDisplayText(value);
  if (!normalized || !/[A-Za-z0-9]/.test(normalized)) {
    return false;
  }
  if (/^[•◦]?\s*(?:Working|Processing|Thinking|Running)\b/i.test(normalized)) {
    return false;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1 && normalized.length < 8 && !/^[/@#]/.test(normalized)) {
    return false;
  }

  return true;
}

function extractManagedRootPromptCandidates(value) {
  const raw = stripTerminalAnsi(value).replace(/\r/g, '\n');
  const candidates = [];
  const markerPattern = /(?:^|\s)›\s*([^›\n\r]+)/g;
  let match;
  while ((match = markerPattern.exec(raw)) !== null) {
    const candidate = normalizeManagedRootDisplayText(match[1]);
    if (isUsefulManagedRootDisplayText(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function chooseManagedRootDisplaySummary(candidate) {
  const directSources = [
    candidate.latestSummary
  ];

  for (const source of directSources) {
    const normalized = normalizeManagedRootDisplayText(source);
    if (isUsefulManagedRootDisplayText(normalized)) {
      return normalized;
    }
  }

  const promptSources = [
    candidate.latestSummary,
    candidate.activityExcerpt
  ];
  for (const source of promptSources) {
    const prompts = extractManagedRootPromptCandidates(source);
    if (prompts.length > 0) {
      return prompts[prompts.length - 1];
    }
  }

  const attention = normalizeManagedRootDisplayText(candidate.attentionMessage);
  if (isUsefulManagedRootDisplayText(attention)) {
    return attention;
  }

  return '';
}

function chooseManagedRootDisplayExcerpt(candidate, summary) {
  const directSources = [
    candidate.activityExcerpt
  ];
  for (const source of directSources) {
    const normalized = normalizeManagedRootDisplayText(source);
    if (isUsefulManagedRootDisplayText(normalized) && normalized !== summary) {
      return normalized;
    }

    const prompts = extractManagedRootPromptCandidates(source);
    if (prompts.length > 0) {
      const prompt = prompts[prompts.length - 1];
      if (prompt !== summary) {
        return prompt;
      }
    }
  }

  return '';
}

function describeManagedRootSelectionCandidate(candidate) {
  const workDir = candidate.workDir ? resolveLaunchWorkDir(candidate.workDir) : null;
  const workDirName = workDir ? (path.basename(workDir) || workDir) : null;
  const metadata = [
    workDirName ? `dir=${workDirName}` : null,
    candidate.model ? `model=${candidate.model}` : null,
    candidate.launchProfile ? `profile=${candidate.launchProfile}` : null,
    candidate.processState ? `process=${candidate.processState}` : null,
    candidate.currentCommand ? `cmd=${candidate.currentCommand}` : null,
    candidate.recoveryReason ? `recovery=${candidate.recoveryReason}` : null,
    candidate.externalSessionRef ? candidate.externalSessionRef : null
  ].filter(Boolean).join(' • ');
  const displaySummary = chooseManagedRootDisplaySummary(candidate);
  const summary = truncateManagedRootPromptText(displaySummary);
  const excerpt = truncateManagedRootPromptText(chooseManagedRootDisplayExcerpt(candidate, displaySummary), 120);

  return {
    age: formatManagedRootCandidateAge(candidate),
    workDir,
    metadata,
    summary,
    excerpt
  };
}

function normalizeManagedRootSelectionGroups(candidates) {
  if (Array.isArray(candidates)) {
    return {
      resumeCandidates: candidates,
      recoverCandidates: []
    };
  }

  return {
    resumeCandidates: Array.isArray(candidates?.resumeCandidates) ? candidates.resumeCandidates : [],
    recoverCandidates: Array.isArray(candidates?.recoverCandidates) ? candidates.recoverCandidates : []
  };
}

function createManagedRootSelectionPrompt(candidates, options = {}) {
  const adapter = options.adapter || 'codex-cli';
  const workDir = options.workDir || null;
  const { resumeCandidates, recoverCandidates } = normalizeManagedRootSelectionGroups(candidates);
  const lines = [
    `Recent ${adapter} roots${workDir ? ` in ${workDir}` : ''}:`
  ];
  const selectionEntries = [];
  let selectionIndex = 1;

  if (resumeCandidates.length > 0) {
    lines.push('  Live roots:');
    for (const candidate of resumeCandidates) {
      const description = describeManagedRootSelectionCandidate(candidate);
      lines.push(
        `  ${selectionIndex}. resume  ${candidate.status.padEnd(15)} ${description.age.padEnd(8)} ${candidate.rootSessionId.slice(0, 12)}${description.metadata ? ` ${description.metadata}` : ''}`.trimEnd()
      );
      if (description.workDir) {
        lines.push(`     workdir: ${description.workDir}`);
      }
      if (description.summary) {
        lines.push(`     summary: ${description.summary}`);
      }
      if (description.excerpt && description.excerpt !== description.summary) {
        lines.push(`     excerpt: ${description.excerpt}`);
      }
      selectionEntries.push({ selectionIndex, candidate });
      selectionIndex += 1;
    }
  }

  if (recoverCandidates.length > 0) {
    if (resumeCandidates.length > 0) {
      lines.push('');
    }
    lines.push('  Recoverable roots:');
    for (const candidate of recoverCandidates) {
      const description = describeManagedRootSelectionCandidate(candidate);
      lines.push(
        `  ${selectionIndex}. recover ${candidate.status.padEnd(15)} ${description.age.padEnd(8)} ${candidate.rootSessionId.slice(0, 12)}${description.metadata ? ` ${description.metadata}` : ''}`.trimEnd()
      );
      if (description.workDir) {
        lines.push(`     workdir: ${description.workDir}`);
      }
      if (description.summary) {
        lines.push(`     summary: ${description.summary}`);
      }
      if (description.excerpt && description.excerpt !== description.summary) {
        lines.push(`     excerpt: ${description.excerpt}`);
      }
      selectionEntries.push({ selectionIndex, candidate });
      selectionIndex += 1;
    }
  }

  lines.push('  Enter  Start a new root');
  lines.push('');
  lines.push('Select a root number to resume or recover, or press Enter for a new root: ');
  return {
    text: lines.join('\n'),
    selectionEntries
  };
}

function formatProviderSessionCandidateAge(session) {
  const timestamp = Date.parse(session?.updatedAt || 0);
  if (!Number.isFinite(timestamp)) {
    return 'recent';
  }
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function createProviderSessionSelectionPrompt(sessions, options = {}) {
  const adapter = options.adapter || 'codex-cli';
  const lines = [
    `Recent ${adapter} provider sessions:`
  ];
  const selectionEntries = [];
  let selectionIndex = 1;

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const workDir = session.cwd ? resolveLaunchWorkDir(session.cwd) : null;
    const workDirName = workDir ? (path.basename(workDir) || workDir) : null;
    const metadata = [
      formatProviderSessionCandidateAge(session),
      workDirName ? `dir=${workDirName}` : null,
      session.model ? `model=${session.model}` : null,
      session.messageCount ? `messages=${session.messageCount}` : null
    ].filter(Boolean).join(' • ');
    const title = truncateManagedRootPromptText(session.title || session.providerSessionId || 'session', 96);
    const summary = truncateManagedRootPromptText(session.summary || session.lastUserMessage || session.preview || '', 180);
    const lastAssistant = truncateManagedRootPromptText(session.lastAssistantMessage || '', 160);

    lines.push(`  ${selectionIndex}. ${title}${metadata ? ` (${metadata})` : ''}`);
    lines.push(`     id: ${session.providerSessionId}`);
    if (workDir) {
      lines.push(`     workdir: ${workDir}`);
    }
    if (summary) {
      lines.push(`     summary: ${summary}`);
    }
    if (lastAssistant && lastAssistant !== summary) {
      lines.push(`     last assistant: ${lastAssistant}`);
    }
    selectionEntries.push({ selectionIndex, session });
    selectionIndex += 1;
  }

  lines.push('  Enter  Open native Codex resume picker');
  lines.push('  f      Start a fresh provider session');
  lines.push('');
  lines.push('Select a provider session number, press Enter for native picker, or type f for fresh: ');
  return {
    text: lines.join('\n'),
    selectionEntries
  };
}

async function promptForManagedRootSelection(candidates, options = {}) {
  const { resumeCandidates, recoverCandidates } = normalizeManagedRootSelectionGroups(candidates);
  if (resumeCandidates.length === 0 && recoverCandidates.length === 0) {
    return null;
  }

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || !output.isTTY) {
    return null;
  }

  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const prompt = createManagedRootSelectionPrompt(candidates, options);
      const answer = await new Promise((resolve) => {
        rl.question(prompt.text, resolve);
      });
      const trimmed = String(answer || '').trim();
      if (!trimmed) {
        return null;
      }

      const selectedIndex = Number.parseInt(trimmed, 10);
      const selectedEntry = prompt.selectionEntries.find((entry) => entry.selectionIndex === selectedIndex);
      if (Number.isInteger(selectedIndex) && selectedEntry) {
        return selectedEntry.candidate;
      }

      output.write(`Invalid selection: ${trimmed}\n`);
    }
  } finally {
    rl.close();
  }
}

async function listProviderSessionsForLaunch(options = {}, dependencies = {}) {
  const callJson = dependencies.callCliagentsJson || callCliagentsJson;
  const params = new URLSearchParams();
  params.set('adapter', options.adapter || 'codex-cli');
  params.set('limit', String(options.limit || 12));
  const result = await callJson(`/orchestration/provider-sessions?${params.toString()}`);
  return Array.isArray(result?.sessions) ? result.sessions : [];
}

async function promptForProviderSessionSelection(sessions, options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || !output.isTTY) {
    return null;
  }

  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const prompt = createProviderSessionSelectionPrompt(sessions, options);
      const answer = await new Promise((resolve) => {
        rl.question(prompt.text, resolve);
      });
      const trimmed = String(answer || '').trim();
      if (!trimmed) {
        return null;
      }
      if (trimmed.toLowerCase() === 'f') {
        return { freshProviderSession: true };
      }

      const selectedIndex = Number.parseInt(trimmed, 10);
      const selectedEntry = prompt.selectionEntries.find((entry) => entry.selectionIndex === selectedIndex);
      if (Number.isInteger(selectedIndex) && selectedEntry) {
        return selectedEntry.session;
      }

      output.write(`Invalid selection: ${trimmed}\n`);
    }
  } finally {
    rl.close();
  }
}

async function resolveManagedRootLaunchTarget(launchOptions, dependencies = {}) {
  if (launchOptions.forceNewRoot) {
    return createManagedRootLaunchTarget('launch', 'force-new-root');
  }
  if (launchOptions.externalSessionRef) {
    return createManagedRootLaunchTarget('launch', 'explicit-external-session-ref');
  }

  const listCandidates = dependencies.listManagedRootLaunchCandidates || listManagedRootLaunchCandidates;
  const getCandidate = dependencies.getManagedRootResumeCandidate || getManagedRootResumeCandidate;
  const getRecoveryCandidate = dependencies.getManagedRootRecoveryCandidate || getManagedRootRecoveryCandidate;
  const selectCandidate = dependencies.promptForManagedRootSelection || promptForManagedRootSelection;
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (launchOptions.resumeRootSessionId) {
    const candidate = await getCandidate(launchOptions.resumeRootSessionId, {
      adapter: launchOptions.adapter,
      workDir: launchOptions.workDir
    }, dependencies);
    if (candidate && isExistingRootModelCompatible(launchOptions, candidate)) {
      return createManagedRootLaunchTarget('resume', 'explicit-resume-root', { candidate });
    }
    const recoveryCandidate = await getRecoveryCandidate(launchOptions.resumeRootSessionId, {
      adapter: launchOptions.adapter,
      workDir: launchOptions.workDir
    }, dependencies);
    const contextCandidate = candidate || recoveryCandidate;
    if (contextCandidate) {
      return createManagedRootLaunchTarget(
        'context',
        isExistingRootModelCompatible(launchOptions, contextCandidate)
          ? 'explicit-resume-root-context'
          : 'explicit-resume-root-model-switch',
        { candidate: contextCandidate }
      );
    }
    throw new Error(`Managed root ${launchOptions.resumeRootSessionId} is not attachable for adapter ${launchOptions.adapter}`);
  }

  if (launchOptions.recoverRootSessionId) {
    const candidate = await getRecoveryCandidate(launchOptions.recoverRootSessionId, {
      adapter: launchOptions.adapter,
      workDir: launchOptions.workDir
    }, dependencies);
    if (!candidate) {
      throw new Error(`Managed root ${launchOptions.recoverRootSessionId} is not recoverable for adapter ${launchOptions.adapter}`);
    }
    if (canRecoverManagedRootExactly(launchOptions, candidate)) {
      return createManagedRootLaunchTarget('recover', 'explicit-recover-root', { candidate });
    }
    return createManagedRootLaunchTarget(
      'context',
      isExistingRootModelCompatible(launchOptions, candidate)
        ? 'explicit-recover-root-context'
        : 'explicit-recover-root-model-switch',
      { candidate }
    );
  }

  const candidates = await listCandidates({
    adapter: launchOptions.adapter,
    workDir: launchOptions.workDir
  }, dependencies);
  const resumeCandidates = Array.isArray(candidates?.resumeCandidates) ? candidates.resumeCandidates : [];
  const recoverCandidates = Array.isArray(candidates?.recoverCandidates) ? candidates.recoverCandidates : [];

  if (launchOptions.resumeLatest) {
    if (resumeCandidates.length) {
      const candidate = resumeCandidates[0];
      if (isExistingRootModelCompatible(launchOptions, candidate)) {
        return createManagedRootLaunchTarget('resume', 'resume-latest', { candidate });
      }
      return createManagedRootLaunchTarget('context', 'resume-latest-model-switch', { candidate });
    }
    if (recoverCandidates.length) {
      return createManagedRootLaunchTarget(
        'context',
        isExistingRootModelCompatible(launchOptions, recoverCandidates[0])
          ? 'resume-latest-context'
          : 'resume-latest-model-switch',
        { candidate: recoverCandidates[0] }
      );
    }
    throw new Error(`No resumable managed roots found for ${launchOptions.adapter} in ${describeLaunchWorkDir(launchOptions.workDir)}`);
  }

  if (launchOptions.recoverLatest) {
    if (!recoverCandidates.length) {
      throw new Error(`No recoverable managed roots found for ${launchOptions.adapter} in ${describeLaunchWorkDir(launchOptions.workDir)}`);
    }
    if (canRecoverManagedRootExactly(launchOptions, recoverCandidates[0])) {
      return createManagedRootLaunchTarget('recover', 'recover-latest', { candidate: recoverCandidates[0] });
    }
    return createManagedRootLaunchTarget(
      'context',
      isExistingRootModelCompatible(launchOptions, recoverCandidates[0])
        ? 'recover-latest-context'
        : 'recover-latest-model-switch',
      { candidate: recoverCandidates[0] }
    );
  }

  if (!interactive || launchOptions.detach || (resumeCandidates.length === 0 && recoverCandidates.length === 0)) {
    return createManagedRootLaunchTarget(
      'launch',
      (resumeCandidates.length === 0 && recoverCandidates.length === 0) ? 'no-matching-roots' : 'non-interactive',
      { candidates }
    );
  }

  const selectedCandidate = await selectCandidate(candidates, {
    adapter: launchOptions.adapter,
    workDir: resolveLaunchWorkDir(launchOptions.workDir)
  });
  if (!selectedCandidate) {
    return createManagedRootLaunchTarget('launch', 'interactive-new-root', { candidates });
  }

  if (selectedCandidate.launchAction === 'recover') {
    return createManagedRootLaunchTarget(
      'context',
      isExistingRootModelCompatible(launchOptions, selectedCandidate)
        ? 'interactive-selection-context'
        : 'interactive-selection-model-switch',
      {
        candidate: selectedCandidate,
        candidates
      }
    );
  }

  if (!isExistingRootModelCompatible(launchOptions, selectedCandidate)) {
    return createManagedRootLaunchTarget('context', 'interactive-selection-model-switch', {
      candidate: selectedCandidate,
      candidates
    });
  }

  return createManagedRootLaunchTarget('resume', 'interactive-selection', {
    candidate: selectedCandidate,
    candidates
  });
}

function printManagedRootLaunchResult(result, launchOptions) {
  console.log('Managed Root Launched');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  session_name: ${result.sessionName}`);
  console.log(`  profile: ${launchOptions.profile}`);
  if (result.providerStartMode) {
    console.log(`  provider_start: ${result.providerStartMode}`);
  }
  if (launchOptions.providerResumePicker) {
    console.log(`  provider_resume: picker${launchOptions.providerResumePickerDefaulted ? ' (default)' : ''}`);
  }
  if (launchOptions.providerSessionId) {
    console.log(`  provider_session_id: ${launchOptions.providerSessionId}`);
  }
  console.log(`  external_session_ref: ${result.externalSessionRef || 'n/a'}`);
  console.log(`  workdir: ${result.workDir || launchOptions.workDir || 'n/a'}`);
  console.log(`  console_url: ${new URL(result.consoleUrl || '/console', getCliagentsBaseUrl()).toString()}`);
  if (result.attachCommand) {
    console.log(`  attach_command: ${result.attachCommand}`);
  }
}

function printManagedRootResumeResult(candidate) {
  console.log('Managed Root Resumed');
  console.log(`  adapter: ${candidate.adapter}`);
  console.log(`  root_session_id: ${candidate.rootSessionId}`);
  console.log(`  terminal_id: ${candidate.terminalId}`);
  console.log(`  session_name: ${candidate.sessionName}`);
  console.log(`  status: ${candidate.status}`);
  console.log(`  workdir: ${candidate.workDir || 'n/a'}`);
  console.log(`  external_session_ref: ${candidate.externalSessionRef || 'n/a'}`);
  console.log(`  console_url: ${candidate.consoleUrl}`);
  if (candidate.attachCommand) {
    console.log(`  attach_command: ${candidate.attachCommand}`);
  }
}

function printManagedRootRecoveryResult(result, previousCandidate, launchOptions) {
  const exactProviderResumeId = previousCandidate.resumeSessionId || previousCandidate.providerThreadRef || null;
  const automaticProviderResumeCommand = previousCandidate.resumeCommand
    || buildManagedRootProviderResumeCommand(previousCandidate.adapter, exactProviderResumeId);

  console.log('Managed Root Recovered');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  previous_root_session_id: ${previousCandidate.rootSessionId}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  session_name: ${result.sessionName}`);
  console.log(`  profile: ${launchOptions.profile}`);
  if (result.providerStartMode) {
    console.log(`  provider_start: ${result.providerStartMode}`);
  }
  console.log(`  recovery_reason: ${previousCandidate.recoveryReason || 'stale-root'}`);
  console.log(`  external_session_ref: ${result.externalSessionRef || previousCandidate.externalSessionRef || 'n/a'}`);
  if (automaticProviderResumeCommand) {
    console.log(`  provider_resume: automatic (${automaticProviderResumeCommand})`);
  } else if (launchOptions.providerResumePicker) {
    console.log('  provider_resume: picker');
  } else {
    console.log('  provider_resume: none (exact provider session unavailable; a fresh provider session was started)');
  }
  console.log(`  console_url: ${new URL(result.consoleUrl || '/console', getCliagentsBaseUrl()).toString()}`);
  if (result.attachCommand) {
    console.log(`  attach_command: ${result.attachCommand}`);
  }
}

function printManagedRootContextResult(result, previousCandidate, launchOptions) {
  console.log('Managed Root Resumed with Context');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  previous_root_session_id: ${previousCandidate.rootSessionId}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  session_name: ${result.sessionName}`);
  console.log(`  profile: ${launchOptions.profile}`);
  if (result.providerStartMode) {
    console.log(`  provider_start: ${result.providerStartMode}`);
  }
  console.log('  resume_mode: context');
  console.log(`  context_reason: ${launchOptions.sessionMetadata?.modelSwitch ? 'model-switch' : (previousCandidate.recoveryReason || 'stale-root')}`);
  if (launchOptions.providerResumePicker) {
    console.log('  provider_resume: picker');
  }
  console.log(`  external_session_ref: ${result.externalSessionRef || previousCandidate.externalSessionRef || 'n/a'}`);
  console.log(`  console_url: ${new URL(result.consoleUrl || '/console', getCliagentsBaseUrl()).toString()}`);
  if (result.attachCommand) {
    console.log(`  attach_command: ${result.attachCommand}`);
  }
}

function attachToManagedSession(launchResult, options = {}) {
  const sessionName = launchResult?.sessionName;
  const attachCommand = launchResult?.attachCommand;
  const spawn = options.spawnSync || spawnSync;
  const logger = options.logger || console;

  if (!sessionName) {
    return {
      attempted: false,
      attached: false,
      reason: 'missing_session_name'
    };
  }

  const socketMatch = typeof attachCommand === 'string'
    ? attachCommand.match(/\btmux\s+-S\s+("([^"]+)"|'([^']+)'|(\S+))/)
    : null;
  const tmuxSocketPath = socketMatch?.[2] || socketMatch?.[3] || socketMatch?.[4] || null;
  const tmuxPrefixArgs = tmuxSocketPath ? ['-S', tmuxSocketPath] : [];
  const attachEnv = buildManagedRootAttachEnvironment(process.env);
  const attachAttempts = [];
  if (process.env.TMUX) {
    attachAttempts.push({
      tmuxArgs: [...tmuxPrefixArgs, 'switch-client', '-t', sessionName],
      env: attachEnv,
      attachMode: 'switch-client'
    });
  }
  const detachedEnv = { ...attachEnv };
  delete detachedEnv.TMUX;
  attachAttempts.push({
    tmuxArgs: [...tmuxPrefixArgs, 'attach-session', '-t', sessionName],
    env: detachedEnv,
    attachMode: 'attach-session'
  });

  let lastFailure = null;
  for (let index = 0; index < attachAttempts.length; index += 1) {
    const attempt = attachAttempts[index];
    const result = spawn('tmux', attempt.tmuxArgs, {
      stdio: 'inherit',
      env: attempt.env
    });

    if (!result.error && result.status === 0) {
      return {
        attempted: true,
        attached: true,
        tmuxArgs: attempt.tmuxArgs,
        attachMode: attempt.attachMode,
        fallbackUsed: index > 0,
        attachCommand: attachCommand || null
      };
    }

    lastFailure = {
      message: result.error?.message || `tmux exited with status ${result.status}`,
      tmuxArgs: attempt.tmuxArgs,
      attachMode: attempt.attachMode
    };
  }

  if (lastFailure) {
    logger.warn(`[cliagents] Managed root launched, but automatic tmux attach failed: ${lastFailure.message}`);
    if (attachCommand) {
      logger.warn(`[cliagents] The root is still running. Attach manually with: ${attachCommand}`);
    }
    return {
      attempted: true,
      attached: false,
      message: lastFailure.message,
      tmuxArgs: lastFailure.tmuxArgs,
      attachMode: lastFailure.attachMode,
      fallbackUsed: attachAttempts.length > 1,
      attachCommand: attachCommand || null
    };
  }

  return {
    attempted: true,
    attached: true,
    tmuxArgs: attachAttempts[0].tmuxArgs,
    attachMode: attachAttempts[0].attachMode,
    fallbackUsed: false,
    attachCommand: attachCommand || null
  };
}

async function launchManagedRootSession(options = {}) {
  const profile = normalizeManagedRootLaunchProfile(options.profile);
  const launchEnvironment = buildManagedRootLaunchEnvironment();
  const extraSessionMetadata = options.sessionMetadata && typeof options.sessionMetadata === 'object'
    ? options.sessionMetadata
    : {};
  const providerResumePicker = options.providerResumePicker === true || extraSessionMetadata.providerResumePicker === true;
  return callCliagentsJson('/orchestration/root-sessions/launch', {
    method: 'POST',
    body: {
      adapter: options.adapter,
      workDir: options.workDir,
      model: options.model || null,
      permissionMode: options.permissionMode || profile.permissionMode || 'default',
      systemPrompt: options.systemPrompt || null,
      externalSessionRef: options.externalSessionRef || null,
      sessionMetadata: {
        ...extraSessionMetadata,
        launchProfile: profile.id,
        launchEnvironment,
        providerResumePicker
      },
      resumeMode: options.resumeMode || 'new',
      providerSessionId: options.providerSessionId || null,
      sourceRootSessionId: options.sourceRootSessionId || null,
      providerResumePicker,
      launchEnvironment,
      deferProviderStartUntilAttached: options.deferProviderStartUntilAttached === true,
      allowedTools: Array.isArray(options.allowedTools) && options.allowedTools.length > 0
        ? options.allowedTools
        : null
    }
  });
}

function buildManagedRootRecoveryLaunchOptions(launchOptions, candidate) {
  const providerResumeSessionId = candidate.resumeSessionId || candidate.providerThreadRef || null;

  return {
    ...launchOptions,
    adapter: candidate.adapter || launchOptions.adapter,
    workDir: candidate.workDir || launchOptions.workDir,
    profile: launchOptions.profileExplicit ? launchOptions.profile : (candidate.launchProfile || launchOptions.profile),
    model: launchOptions.modelExplicit ? launchOptions.model : (candidate.model || launchOptions.model || null),
    permissionMode: launchOptions.permissionModeExplicit ? launchOptions.permissionMode : null,
    externalSessionRef: candidate.externalSessionRef || null,
    sessionMetadata: {
      recoveredManagedRoot: true,
      recoveredFromRootSessionId: candidate.rootSessionId,
      recoveredFromTerminalId: candidate.terminalId || null,
      recoveryReason: candidate.recoveryReason || 'stale-root',
      previousRootStatus: candidate.status || null,
      previousProcessState: candidate.processState || null,
      previousCurrentCommand: candidate.currentCommand || null,
      providerResumeCommand: candidate.resumeCommand || null,
      providerResumeSessionId,
      providerResumePicker: launchOptions.providerResumePicker === true && !providerResumeSessionId,
      providerResumeLatest: false
    }
  };
}

async function handleLaunchCommand(rawArgs = []) {
  const launchOptions = parseLaunchArgs(rawArgs);
  if (launchOptions.help) {
    printLaunchUsage();
    return;
  }
  const deferProviderStartUntilAttached = !launchOptions.detach && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (launchOptions.providerSessionId) {
    const result = await launchManagedRootSession({
      ...launchOptions,
      resumeMode: 'exact',
      deferProviderStartUntilAttached
    });
    printManagedRootLaunchResult(result, launchOptions);
    if (!launchOptions.detach && process.stdout.isTTY) {
      attachToManagedSession(result);
    }
    return;
  }

  const launchTarget = await resolveManagedRootLaunchTarget(launchOptions);
  let effectiveLaunchOptions = applyCodexProviderResumePickerDefault(launchOptions, launchTarget, {
    interactive: deferProviderStartUntilAttached
  });
  if (launchTarget.action === 'resume') {
    const candidate = launchTarget.candidate;
    printManagedRootResumeResult(candidate);
    if (!launchOptions.detach && process.stdout.isTTY) {
      attachToManagedSession(candidate);
    }
    return;
  }

  if (launchTarget.action === 'recover') {
    const recoveryOptions = buildManagedRootRecoveryLaunchOptions(effectiveLaunchOptions, launchTarget.candidate);
    recoveryOptions.deferProviderStartUntilAttached = deferProviderStartUntilAttached;
    const result = await launchManagedRootSession(recoveryOptions);
    printManagedRootRecoveryResult(result, launchTarget.candidate, recoveryOptions);
    if (!launchOptions.detach && process.stdout.isTTY) {
      attachToManagedSession(result);
    }
    return;
  }

  if (launchTarget.action === 'context') {
    const contextOptions = await buildManagedRootContextLaunchOptions(effectiveLaunchOptions, launchTarget.candidate);
    contextOptions.deferProviderStartUntilAttached = deferProviderStartUntilAttached;
    const result = await launchManagedRootSession(contextOptions);
    printManagedRootContextResult(result, launchTarget.candidate, contextOptions);
    if (!launchOptions.detach && process.stdout.isTTY) {
      attachToManagedSession(result);
    }
    return;
  }

  if (launchTarget.action === 'launch' && effectiveLaunchOptions.providerResumePicker === true && deferProviderStartUntilAttached) {
    try {
      const providerSessions = await listProviderSessionsForLaunch({
        adapter: effectiveLaunchOptions.adapter,
        limit: 12
      });
      const providerSelection = await promptForProviderSessionSelection(providerSessions, {
        adapter: effectiveLaunchOptions.adapter
      });
      if (providerSelection?.freshProviderSession === true) {
        effectiveLaunchOptions = {
          ...effectiveLaunchOptions,
          providerResumePicker: false,
          providerResumePickerDefaulted: false,
          freshProviderSession: true
        };
      } else if (providerSelection?.providerSessionId) {
        const exactOptions = {
          ...effectiveLaunchOptions,
          providerSessionId: providerSelection.providerSessionId,
          providerResumePicker: false,
          providerResumePickerDefaulted: false,
          resumeMode: 'exact',
          deferProviderStartUntilAttached
        };
        const result = await launchManagedRootSession(exactOptions);
        printManagedRootLaunchResult(result, exactOptions);
        if (!launchOptions.detach && process.stdout.isTTY) {
          attachToManagedSession(result);
        }
        return;
      }
    } catch (error) {
      console.warn(`[cliagents] Provider-session summary picker unavailable; falling back to native Codex picker: ${error.message}`);
    }
  }

  const result = await launchManagedRootSession({
    ...effectiveLaunchOptions,
    deferProviderStartUntilAttached
  });
  printManagedRootLaunchResult(result, effectiveLaunchOptions);
  if (!launchOptions.detach && process.stdout.isTTY) {
    attachToManagedSession(result);
  }
}

async function adoptManagedRootSession(options = {}) {
  return callCliagentsJson('/orchestration/root-sessions/adopt', {
    method: 'POST',
    body: {
      adapter: options.adapter,
      tmuxTarget: options.tmuxTarget || null,
      sessionName: options.sessionName || null,
      windowName: options.windowName || null,
      workDir: options.workDir || null,
      model: options.model || null,
      externalSessionRef: options.externalSessionRef || null,
      rootSessionId: options.rootSessionId || null
    }
  });
}

async function handleAdoptCommand(rawArgs = []) {
  const adoptOptions = parseAdoptArgs(rawArgs);
  if (adoptOptions.help) {
    printAdoptUsage();
    return;
  }

  const result = await adoptManagedRootSession(adoptOptions);
  console.log('Managed Root Adopted');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  tmux_target: ${result.tmuxTarget}`);
  console.log(`  external_session_ref: ${result.externalSessionRef || 'n/a'}`);
  console.log(`  console_url: ${new URL(result.consoleUrl || '/console', getCliagentsBaseUrl()).toString()}`);
  if (result.attachCommand) {
    console.log(`  attach_command: ${result.attachCommand}`);
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
  resolveLaunchWorkDir,
  buildManagedRootLaunchCandidate,
  normalizeManagedRootResumeCandidate,
  normalizeManagedRootRecoveryCandidate,
  createManagedRootSelectionPrompt,
  createProviderSessionSelectionPrompt,
  listProviderSessionsForLaunch,
  promptForProviderSessionSelection,
  listManagedRootLaunchCandidates,
  listManagedRootResumeCandidates,
  listManagedRootRecoveryCandidates,
  getManagedRootResumeCandidate,
  getManagedRootRecoveryCandidate,
  promptForManagedRootSelection,
  resolveManagedRootLaunchTarget,
  launchManagedRootSession,
  buildManagedRootRecoveryLaunchOptions,
  buildManagedRootContextLaunchOptions,
  shouldDefaultCodexProviderResumePicker,
  applyCodexProviderResumePickerDefault,
  attachToManagedSession,
  handleLaunchCommand,
  handleListRootsCommand,
  handleAttachRootCommand,
  handleAdoptCommand,
  handleServeCommand,
  listAdapterModels,
  listOperatorRootSessions,
  getOperatorRootSession,
  parseAdoptArgs,
  parseAttachRootArgs,
  parseListRootsArgs,
  parseServeArgs,
  adoptManagedRootSession,

  // Quick-start factory
  createServer: (options = {}) => new AgentServer(options),

  // Create standalone session manager (without HTTP server)
  // Register the active broker adapters
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
  const runCliCommand = (promise, failureLabel) => {
    promise
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error(`[cliagents] ${failureLabel} failed: ${error.message}`);
        process.exit(1);
      });
  };

  if (command === 'launch') {
    runCliCommand(handleLaunchCommand(args.slice(1)), 'Launch');
    return;
  }

  if (command === 'adopt') {
    runCliCommand(handleAdoptCommand(args.slice(1)), 'Adopt');
    return;
  }

  if (command === 'list-roots') {
    runCliCommand(handleListRootsCommand(args.slice(1)), 'list-roots');
    return;
  }

  if (command === 'attach-root') {
    runCliCommand(handleAttachRootCommand(args.slice(1)), 'attach-root');
    return;
  }

  if (command === 'root' && args[1] === 'attach') {
    runCliCommand(handleAttachRootCommand(args.slice(2)), 'root attach');
    return;
  }

  if (command === 'list-models') {
    try {
      listAdapterModels(args.slice(1));
    } catch (error) {
      console.error(`[cliagents] list-models failed: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'serve') {
    handleServeCommand(args.slice(1)).catch((error) => {
      console.error(`[cliagents] Serve failed: ${error.message}`);
      process.exit(1);
    });
    return;
  }

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

  const shouldTreatAsServeArgs = args.length > 0 && String(command || '').startsWith('-');
  if (shouldTreatAsServeArgs) {
    handleServeCommand(args).catch((error) => {
      console.error(`[cliagents] Serve failed: ${error.message}`);
      process.exit(1);
    });
    return;
  }

  handleServeCommand([]).catch((error) => {
    console.error(`[cliagents] Serve failed: ${error.message}`);
    process.exit(1);
  });

  // Note: Graceful shutdown handlers are registered by AgentServer._setupShutdownHandlers()
}
