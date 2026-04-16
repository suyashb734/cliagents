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

function buildManagedRootLaunchEnvironment(env = process.env) {
  const launchEnvironment = {};
  for (const key of MANAGED_ROOT_TERMINAL_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      launchEnvironment[key] = value;
    }
  }
  return launchEnvironment;
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
    permissionModeExplicit: false
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
  if (parsed.forceNewRoot && (hasResumeFlag || hasRecoverFlag)) {
    throw new Error('Cannot combine --new-root with resume or recover flags');
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
  console.log('  --resume-latest               Reattach to the most recent matching live root');
  console.log('  --recover-root <id>           Recover a specific stale or shell-only managed root');
  console.log('  --recover-latest              Recover the most recent stale or shell-only root');
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
    attentionMessage
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
    || attachMode === 'root-adopt';
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

  const terminalId = mainTerminal?.terminal_id || rootSession.terminalId || null;
  const sessionName = mainTerminal?.session_name || null;
  const processState = String(mainTerminal?.process_state || rootSession.processState || '').trim().toLowerCase() || null;
  const terminalStatus = String(mainTerminal?.status || rootSession.terminalStatus || '').trim().toLowerCase() || null;
  const currentCommand = normalizeManagedRootCurrentCommand(mainTerminal?.current_command || mainTerminal?.currentCommand || null);
  const hasLiveTerminal = Boolean(sessionName)
    && processState !== 'exited'
    && terminalStatus !== 'orphaned';
  const shellOnlyRoot = hasLiveTerminal && isManagedRootShellCommand(currentCommand);
  const recoveryHint = extractManagedRootRecoveryHint(snapshot, rootSessionId);
  const launchAction = hasLiveTerminal && !shellOnlyRoot ? 'resume' : 'recover';
  let recoveryReason = null;
  if (launchAction === 'recover') {
    if (shellOnlyRoot) {
      recoveryReason = 'provider-exited';
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
    status: String(rootSession.status || summary?.status || terminalStatus || 'unknown').trim().toLowerCase() || 'unknown',
    processState,
    workDir: candidateWorkDir,
    model: rootSession.model || null,
    externalSessionRef: rootSession.externalSessionRef || summary?.externalSessionRef || mainTerminal?.external_session_ref || null,
    launchProfile: rootMetadata.launchProfile || null,
    lastOccurredAt: summary?.lastOccurredAt || null,
    lastRecordedAt: summary?.lastRecordedAt || null,
    currentCommand,
    launchAction,
    recoveryReason,
    resumeCommand: recoveryHint.resumeCommand,
    resumeSessionId: recoveryHint.resumeSessionId,
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
  const rawValue = candidate.lastOccurredAt || candidate.lastRecordedAt || null;
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

function describeManagedRootSelectionCandidate(candidate) {
  const details = [
    candidate.launchProfile ? `profile=${candidate.launchProfile}` : null,
    candidate.processState ? `process=${candidate.processState}` : null,
    candidate.currentCommand ? `cmd=${candidate.currentCommand}` : null,
    candidate.recoveryReason ? `recovery=${candidate.recoveryReason}` : null,
    candidate.externalSessionRef ? candidate.externalSessionRef : null
  ].filter(Boolean).join(' • ');

  return {
    age: formatManagedRootCandidateAge(candidate),
    details
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
        `  ${selectionIndex}. resume  ${candidate.status.padEnd(15)} ${description.age.padEnd(8)} ${candidate.rootSessionId.slice(0, 12)} ${description.details}`.trimEnd()
      );
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
        `  ${selectionIndex}. recover ${candidate.status.padEnd(15)} ${description.age.padEnd(8)} ${candidate.rootSessionId.slice(0, 12)} ${description.details}`.trimEnd()
      );
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

async function resolveManagedRootLaunchTarget(launchOptions, dependencies = {}) {
  if (launchOptions.forceNewRoot) {
    return { action: 'launch', reason: 'force-new-root' };
  }
  if (launchOptions.externalSessionRef) {
    return { action: 'launch', reason: 'explicit-external-session-ref' };
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
    if (!candidate) {
      throw new Error(`Managed root ${launchOptions.resumeRootSessionId} is not attachable for adapter ${launchOptions.adapter}`);
    }
    return {
      action: 'resume',
      reason: 'explicit-resume-root',
      candidate
    };
  }

  if (launchOptions.recoverRootSessionId) {
    const candidate = await getRecoveryCandidate(launchOptions.recoverRootSessionId, {
      adapter: launchOptions.adapter,
      workDir: launchOptions.workDir
    }, dependencies);
    if (!candidate) {
      throw new Error(`Managed root ${launchOptions.recoverRootSessionId} is not recoverable for adapter ${launchOptions.adapter}`);
    }
    return {
      action: 'recover',
      reason: 'explicit-recover-root',
      candidate
    };
  }

  const candidates = await listCandidates({
    adapter: launchOptions.adapter,
    workDir: launchOptions.workDir
  }, dependencies);
  const resumeCandidates = Array.isArray(candidates?.resumeCandidates) ? candidates.resumeCandidates : [];
  const recoverCandidates = Array.isArray(candidates?.recoverCandidates) ? candidates.recoverCandidates : [];

  if (launchOptions.resumeLatest) {
    if (!resumeCandidates.length) {
      throw new Error(`No resumable managed roots found for ${launchOptions.adapter} in ${resolveLaunchWorkDir(launchOptions.workDir)}`);
    }
    return {
      action: 'resume',
      reason: 'resume-latest',
      candidate: resumeCandidates[0]
    };
  }

  if (launchOptions.recoverLatest) {
    if (!recoverCandidates.length) {
      throw new Error(`No recoverable managed roots found for ${launchOptions.adapter} in ${resolveLaunchWorkDir(launchOptions.workDir)}`);
    }
    return {
      action: 'recover',
      reason: 'recover-latest',
      candidate: recoverCandidates[0]
    };
  }

  if (!interactive || launchOptions.detach || (resumeCandidates.length === 0 && recoverCandidates.length === 0)) {
    return {
      action: 'launch',
      reason: (resumeCandidates.length === 0 && recoverCandidates.length === 0) ? 'no-matching-roots' : 'non-interactive',
      candidates
    };
  }

  const selectedCandidate = await selectCandidate(candidates, {
    adapter: launchOptions.adapter,
    workDir: resolveLaunchWorkDir(launchOptions.workDir)
  });
  if (!selectedCandidate) {
    return {
      action: 'launch',
      reason: 'interactive-new-root',
      candidates
    };
  }

  return {
    action: selectedCandidate.launchAction === 'recover' ? 'recover' : 'resume',
    reason: 'interactive-selection',
    candidate: selectedCandidate,
    candidates
  };
}

function printManagedRootLaunchResult(result, launchOptions) {
  console.log('Managed Root Launched');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  session_name: ${result.sessionName}`);
  console.log(`  profile: ${launchOptions.profile}`);
  console.log(`  external_session_ref: ${result.externalSessionRef || 'n/a'}`);
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
  console.log('Managed Root Recovered');
  console.log(`  adapter: ${result.adapter}`);
  console.log(`  previous_root_session_id: ${previousCandidate.rootSessionId}`);
  console.log(`  root_session_id: ${result.rootSessionId}`);
  console.log(`  terminal_id: ${result.terminalId}`);
  console.log(`  session_name: ${result.sessionName}`);
  console.log(`  profile: ${launchOptions.profile}`);
  console.log(`  recovery_reason: ${previousCandidate.recoveryReason || 'stale-root'}`);
  console.log(`  external_session_ref: ${result.externalSessionRef || previousCandidate.externalSessionRef || 'n/a'}`);
  if (previousCandidate.adapter === 'codex-cli' && previousCandidate.resumeSessionId) {
    console.log(`  provider_resume: automatic (${previousCandidate.resumeCommand || `codex resume ${previousCandidate.resumeSessionId}`})`);
  } else if (previousCandidate.resumeCommand) {
    console.log(`  provider_resume_command: ${previousCandidate.resumeCommand}`);
  }
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

  const attachAttempts = [];
  if (process.env.TMUX) {
    attachAttempts.push({
      tmuxArgs: ['switch-client', '-t', sessionName],
      env: process.env,
      attachMode: 'switch-client'
    });
  }
  const detachedEnv = { ...process.env };
  delete detachedEnv.TMUX;
  attachAttempts.push({
    tmuxArgs: ['attach-session', '-t', sessionName],
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
        launchEnvironment
      },
      launchEnvironment,
      allowedTools: Array.isArray(options.allowedTools) && options.allowedTools.length > 0
        ? options.allowedTools
        : null
    }
  });
}

function buildManagedRootRecoveryLaunchOptions(launchOptions, candidate) {
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
      providerResumeSessionId: candidate.resumeSessionId || null
    }
  };
}

async function handleLaunchCommand(rawArgs = []) {
  const launchOptions = parseLaunchArgs(rawArgs);
  if (launchOptions.help) {
    printLaunchUsage();
    return;
  }

  const launchTarget = await resolveManagedRootLaunchTarget(launchOptions);
  if (launchTarget.action === 'resume') {
    const candidate = launchTarget.candidate;
    printManagedRootResumeResult(candidate);
    if (!launchOptions.detach && process.stdout.isTTY) {
      attachToManagedSession(candidate);
    }
    return;
  }

  if (launchTarget.action === 'recover') {
    const recoveryOptions = buildManagedRootRecoveryLaunchOptions(launchOptions, launchTarget.candidate);
    const result = await launchManagedRootSession(recoveryOptions);
    printManagedRootRecoveryResult(result, launchTarget.candidate, recoveryOptions);
    if (!launchOptions.detach && process.stdout.isTTY) {
      attachToManagedSession(result);
    }
    return;
  }

  const result = await launchManagedRootSession(launchOptions);
  printManagedRootLaunchResult(result, launchOptions);
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
  listManagedRootLaunchCandidates,
  listManagedRootResumeCandidates,
  listManagedRootRecoveryCandidates,
  getManagedRootResumeCandidate,
  getManagedRootRecoveryCandidate,
  promptForManagedRootSelection,
  resolveManagedRootLaunchTarget,
  launchManagedRootSession,
  buildManagedRootRecoveryLaunchOptions,
  attachToManagedSession,
  handleLaunchCommand,
  handleAdoptCommand,
  listAdapterModels,
  parseAdoptArgs,
  adoptManagedRootSession,

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

  if (command === 'adopt') {
    handleAdoptCommand(args.slice(1)).catch((error) => {
      console.error(`[cliagents] Adopt failed: ${error.message}`);
      process.exit(1);
    });
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
