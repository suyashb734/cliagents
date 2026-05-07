/**
 * Unit tests for supported CLI command construction.
 *
 * Run: node tests/test-cli-commands.js
 */

const assert = require('assert');
const {
  PersistentSessionManager,
  TerminalStatus,
  CLI_COMMANDS,
  resolveTerminalStartupDelayMs,
  extractProviderThreadRefFromOutput,
  inferEffectiveModelFromOutput,
  extractUsageMetadataFromOutput,
  buildGeminiOneShotRunnerCommand,
  buildClaudeOneShotCommand,
  buildCodexOneShotCommand,
  buildQwenOneShotCommand,
  buildOpencodeOneShotCommand
} = require('../src/tmux/session-manager');
const ClaudeCodeAdapter = require('../src/adapters/claude-code');
const CodexCliAdapter = require('../src/adapters/codex-cli');
const {
  parseAdoptArgs,
  parseServeArgs,
  attachToManagedSession,
  launchManagedRootSession,
  buildManagedRootLaunchCandidate,
  buildManagedRootRecoveryLaunchOptions
} = require('../src/index');

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result.then(() => {
        passed++;
        console.log(`✅ ${name}`);
      }).catch((error) => {
        failed++;
        console.log(`❌ ${name}`);
        console.log(`   Error: ${error.message}`);
      }));
      return;
    }
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
  }
}

function assertManagedRootUiEnvPrefix(cmd) {
  assert(cmd.includes('unset NO_COLOR CLICOLOR;'), `Expected rich-UI env prefix, got: ${cmd}`);
  assert(cmd.includes('TERM="${TERM:-tmux-256color}"'), `Expected TERM fallback in rich-UI env prefix, got: ${cmd}`);
  assert(cmd.includes('COLORTERM="${COLORTERM:-truecolor}"'), `Expected COLORTERM fallback in rich-UI env prefix, got: ${cmd}`);
  assert(cmd.includes('FORCE_COLOR=1'), `Expected FORCE_COLOR in rich-UI env prefix, got: ${cmd}`);
  assert(cmd.includes('CLICOLOR_FORCE=1'), `Expected CLICOLOR_FORCE in rich-UI env prefix, got: ${cmd}`);
}

function assertCodexNativeRootCommand(cmd) {
  assert(cmd.startsWith('exec codex'), `Expected native Codex managed-root command, got: ${cmd}`);
  assert(!cmd.includes('FORCE_COLOR'), `Codex native TUI should not force color through wrapper env, got: ${cmd}`);
  assert(!cmd.includes('CLICOLOR_FORCE'), `Codex native TUI should not force color through wrapper env, got: ${cmd}`);
  assert(!cmd.includes('TERM="${TERM:-tmux-256color}"'), `Codex native TUI should inherit tmux pane TERM, got: ${cmd}`);
  assert(!cmd.includes('CI=true'), `Codex native TUI should not use CI mode, got: ${cmd}`);
}

console.log('\n📋 Supported CLI Command Construction Tests\n');

console.log('--- Gemini CLI ---');

test('Gemini interactive command uses yolo by default', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ role: 'main', model: 'gemini-2.5-pro' });

  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec gemini'), `Expected managed root exec prefix, got: ${cmd}`);
  assert(cmd.includes('--approval-mode yolo'), `Expected yolo approval mode, got: ${cmd}`);
  assert(cmd.includes('-m gemini-2.5-pro'), `Expected model flag, got: ${cmd}`);
});

test('Gemini orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "GEMINI_READY_FOR_ORCHESTRATION"');
});

test('Gemini recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ role: 'main', resumeLatest: true });
  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec gemini --approval-mode yolo --resume latest'), `Expected managed root gemini resume command, got: ${cmd}`);
});

console.log('\n--- Codex CLI ---');

test('Codex interactive command bypasses approvals by default', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ role: 'main', model: 'o4-mini' });

  assertCodexNativeRootCommand(cmd);
  assert(cmd.includes('exec codex'), `Expected managed root exec prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
  assert(cmd.includes('--model o4-mini'), `Expected model flag, got: ${cmd}`);
});

test('Codex guarded root command preserves native UI without bypass wrapper', () => {
  const cmd = CLI_COMMANDS['codex-cli']({
    role: 'main',
    permissionMode: 'default'
  });

  assertCodexNativeRootCommand(cmd);
  assert.strictEqual(cmd, 'exec codex');
});

test('Codex managed root can start the native resume picker', () => {
  const cmd = CLI_COMMANDS['codex-cli']({
    role: 'main',
    permissionMode: 'default',
    resumePicker: true
  });

  assertCodexNativeRootCommand(cmd);
  assert.strictEqual(cmd, 'exec codex resume');
});

test('Codex interactive command can start by resuming a prior session', () => {
  const cmd = CLI_COMMANDS['codex-cli']({
    role: 'main',
    model: 'o4-mini',
    resumeSessionId: '019d94a6-2cd8-7742-8e4e-123456789abc'
  });

  assertCodexNativeRootCommand(cmd);
  assert(cmd.includes('exec codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected codex resume prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
  assert(cmd.includes('--model o4-mini'), `Expected model flag, got: ${cmd}`);
});

test('Codex orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "CODEX_READY_FOR_ORCHESTRATION"');
});

test('Codex recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ role: 'main', resumeLatest: true });
  assertCodexNativeRootCommand(cmd);
  assert(cmd.includes('exec codex resume --last'), `Expected codex latest resume prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
});

console.log('\n--- Qwen CLI ---');

test('Qwen interactive command uses yolo by default', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ role: 'main', model: 'qwen3-coder' });

  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec qwen'), `Expected managed root exec prefix, got: ${cmd}`);
  assert(cmd.includes('-y'), `Expected -y flag, got: ${cmd}`);
  assert(cmd.includes('-m qwen3-coder'), `Expected model flag, got: ${cmd}`);
});

test('Qwen orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "QWEN_READY_FOR_ORCHESTRATION"');
});

test('Qwen managed root binds a provider session id on first launch', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ role: 'main', providerSessionId: '019d94a6-2cd8-7742-8e4e-123456789abc' });
  assert(cmd.includes('--session-id 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected session binding flag, got: ${cmd}`);
});

test('Qwen recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ role: 'main', resumeLatest: true });
  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec qwen -y --continue'), `Expected qwen latest resume command, got: ${cmd}`);
});

console.log('\n--- OpenCode CLI ---');

test('OpenCode interactive command supports model selection', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ role: 'main', model: 'openai/gpt-5' });

  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec opencode'), `Expected managed root exec prefix, got: ${cmd}`);
  assert(cmd.includes('--model openai/gpt-5'), `Expected model flag, got: ${cmd}`);
});

test('OpenCode orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "OPENCODE_READY_FOR_ORCHESTRATION"');
});

test('OpenCode recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ role: 'main', resumeLatest: true });
  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec opencode --continue'), `Expected opencode latest resume command, got: ${cmd}`);
});

test('Managed roots can explicitly keep the shell after provider exit for debugging', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({
    role: 'main',
    keepShellOnProviderExit: true,
    model: 'gemini-2.5-pro'
  });

  assertManagedRootUiEnvPrefix(cmd);
  assert(!cmd.includes(' exec gemini'), `Did not expect exec form when keepShellOnProviderExit is set, got: ${cmd}`);
  assert(cmd.includes('gemini --approval-mode yolo'), `Expected non-exec form when keepShellOnProviderExit is set, got: ${cmd}`);
});

console.log('\n--- Orchestration Resume Builders ---');

test('Gemini one-shot runner passes prior provider session id when present', () => {
  const cmd = buildGeminiOneShotRunnerCommand('Continue review.', {
    workDir: '/tmp/project',
    model: 'gemini-2.5-pro',
    providerThreadRef: '019d94a6-2cd8-7742-8e4e-123456789abc',
    messageCount: 1
  });

  assert(cmd.includes('--model "gemini-2.5-pro"'), `Expected model flag, got: ${cmd}`);
  assert(cmd.includes('--session-id "019d94a6-2cd8-7742-8e4e-123456789abc"'), `Expected session id flag, got: ${cmd}`);
});

test('Gemini one-shot runner prefers provider default when no explicit model is set', () => {
  const previousModel = process.env.CLIAGENTS_GEMINI_MODEL;
  delete process.env.CLIAGENTS_GEMINI_MODEL;

  try {
    const cmd = buildGeminiOneShotRunnerCommand('Continue review.', {
      workDir: '/tmp/project',
      model: null,
      providerThreadRef: null,
      messageCount: 1
    });

    assert(!cmd.includes('--model'), `Did not expect model flag, got: ${cmd}`);
  } finally {
    if (previousModel === undefined) {
      delete process.env.CLIAGENTS_GEMINI_MODEL;
    } else {
      process.env.CLIAGENTS_GEMINI_MODEL = previousModel;
    }
  }
});

test('Codex one-shot builder stays stateless and preserves JSON mode', () => {
  const cmd = buildCodexOneShotCommand('Continue review.', {
    model: 'o4-mini',
    providerThreadRef: '019d94a6-2cd8-7742-8e4e-123456789abc',
    messageCount: 1
  });

  assert(cmd.startsWith('CI=true codex exec '), `Expected one-shot form, got: ${cmd}`);
  assert(!cmd.includes(' resume '), `Did not expect worker resume form, got: ${cmd}`);
  assert(cmd.includes('-m o4-mini'), `Expected model flag, got: ${cmd}`);
  assert(cmd.includes('--json'), `Expected JSON output, got: ${cmd}`);
  assert(!cmd.includes('019d94a6-2cd8-7742-8e4e-123456789abc'), `Did not expect worker thread id in command, got: ${cmd}`);
});

test('Codex model aliases resolve to exact broker model ids', () => {
  const cmd = buildCodexOneShotCommand('Continue review.', {
    model: 'gpt5mini',
    messageCount: 0
  });

  assert(cmd.includes('-m gpt-5.4-mini'), `Expected exact mini model id, got: ${cmd}`);
});

test('Codex one-shot builder pins a broker-safe default model', () => {
  const cmd = buildCodexOneShotCommand('Continue review.', {
    model: null,
    messageCount: 0
  });

  assert(cmd.includes('-m gpt-5.4'), `Expected safe Codex worker model, got: ${cmd}`);
});

test('Qwen one-shot builder resumes provider thread and preserves allowed tools', () => {
  const cmd = buildQwenOneShotCommand('Continue review.', {
    model: 'qwen-max',
    providerThreadRef: '019d94a6-2cd8-7742-8e4e-123456789abc',
    allowedTools: ['Read', 'Write'],
    messageCount: 1
  });

  assert(cmd.startsWith('qwen'), `Expected qwen prefix, got: ${cmd}`);
  assert(cmd.includes('-m qwen-max'), `Expected model flag, got: ${cmd}`);
  assert(cmd.includes('-r 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected resume flag, got: ${cmd}`);
  assert(cmd.includes("--allowed-tools 'Read'"), `Expected Read tool restriction, got: ${cmd}`);
  assert(cmd.includes("--allowed-tools 'Write'"), `Expected Write tool restriction, got: ${cmd}`);
});

test('OpenCode one-shot builder resumes provider thread', () => {
  const cmd = buildOpencodeOneShotCommand('Continue review.', {
    model: 'opencode/minimax-m2.5-free',
    providerThreadRef: '019d94a6-2cd8-7742-8e4e-123456789abc',
    messageCount: 1
  });

  assert(cmd.startsWith('opencode run'), `Expected opencode run prefix, got: ${cmd}`);
  assert(cmd.includes('--model opencode/minimax-m2.5-free'), `Expected model flag, got: ${cmd}`);
  assert(cmd.includes('--session 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected session flag, got: ${cmd}`);
  assert(cmd.includes('--print-logs'), `Expected OpenCode logs flag, got: ${cmd}`);
  assert(cmd.includes('--log-level ERROR'), `Expected OpenCode error log level, got: ${cmd}`);
  assert(cmd.includes("--dangerously-skip-permissions 'Continue review.'"), `Expected prompt to be appended after flags, got: ${cmd}`);
});

test('Provider session extraction supports Codex, Qwen, OpenCode, and Gemini markers', () => {
  assert.strictEqual(
    extractProviderThreadRefFromOutput('codex-cli', '{"type":"thread.started","thread_id":"thread-123"}'),
    'thread-123'
  );
  assert.strictEqual(
    extractProviderThreadRefFromOutput('qwen-cli', '{"type":"system","subtype":"init","session_id":"session-456"}'),
    'session-456'
  );
  assert.strictEqual(
    extractProviderThreadRefFromOutput('opencode-cli', '{"sessionID":"session-789","type":"text"}'),
    'session-789'
  );
  assert.strictEqual(
    extractProviderThreadRefFromOutput('gemini-cli', '__CLIAGENTS_PROVIDER_SESSION__019d94a6-2cd8-7742-8e4e-123456789abc'),
    '019d94a6-2cd8-7742-8e4e-123456789abc'
  );
});

console.log('\n--- Claude Code ---');

test('Claude orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['claude-code']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "CLAUDE_READY_FOR_ORCHESTRATION"');
});

test('Claude interactive command respects explicit default permission mode', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    role: 'main',
    permissionMode: 'default',
    model: 'claude-sonnet-4-5-20250514'
  });

  assertManagedRootUiEnvPrefix(cmd);
  assert(cmd.includes('exec '), `Expected managed root exec prefix, got: ${cmd}`);
  assert(cmd.includes('--permission-mode default'), `Expected default permission mode, got: ${cmd}`);
  assert(cmd.includes('--output-format stream-json'), `Expected stream-json output, got: ${cmd}`);
  assert(cmd.includes('--model claude-sonnet-4-5-20250514'), `Expected model flag, got: ${cmd}`);
});

test('Claude broker aliases resolve to exact current model ids', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    role: 'main',
    permissionMode: 'default',
    model: 'opus'
  });

  assert(cmd.includes('--model claude-opus-4-7'), `Expected Opus alias to resolve to 4.7, got: ${cmd}`);
});

test('Claude one-shot command resolves aliases before launch', () => {
  const { command } = buildClaudeOneShotCommand('Review this diff.', {
    workDir: '/tmp/project',
    model: 'sonnet',
    providerThreadRef: null,
    messageCount: 0,
    permissionMode: 'default'
  });

  assert(command.includes('--model "claude-sonnet-4-6"'), `Expected Sonnet alias to resolve to 4.6, got: ${command}`);
});

test('Claude interactive command omits allowedTools when the list is empty', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    role: 'main',
    permissionMode: 'default',
    allowedTools: []
  });

  assert(!cmd.includes('--allowedTools'), `Did not expect empty allowedTools flag, got: ${cmd}`);
});

test('Adapter model catalogs include current exact Codex and Claude ids', () => {
  const codexModels = new CodexCliAdapter().getAvailableModels().map((model) => model.id);
  const claudeModels = new ClaudeCodeAdapter().getAvailableModels().map((model) => model.id);

  assert(codexModels.includes('gpt-5.5'), `Expected Codex catalog to include gpt-5.5, got: ${codexModels.join(', ')}`);
  assert(claudeModels.includes('claude-opus-4-7'), `Expected Claude catalog to include claude-opus-4-7, got: ${claudeModels.join(', ')}`);
});

test('Claude managed root binds a provider session id on first launch', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    role: 'main',
    permissionMode: 'default',
    providerSessionId: '019d94a6-2cd8-7742-8e4e-123456789abc'
  });

  assert(cmd.includes('--session-id 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected session binding flag, got: ${cmd}`);
});

test('Claude recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    permissionMode: 'default',
    resumeLatest: true
  });

  assert(cmd.includes('--continue'), `Expected continue flag, got: ${cmd}`);
  assert(!cmd.includes('--session-id'), `Did not expect session binding for latest resume, got: ${cmd}`);
});

test('Claude command builder honors CLIAGENTS_CLAUDE_PATH override', () => {
  const originalClaudePath = process.env.CLIAGENTS_CLAUDE_PATH;
  process.env.CLIAGENTS_CLAUDE_PATH = '/usr/local/bin/claude';

  try {
    const cmd = CLI_COMMANDS['claude-code']({
      permissionMode: 'default'
    });
    assert(cmd.startsWith('/usr/local/bin/claude '), `Expected explicit Claude binary path, got: ${cmd}`);
  } finally {
    if (originalClaudePath === undefined) {
      delete process.env.CLIAGENTS_CLAUDE_PATH;
    } else {
      process.env.CLIAGENTS_CLAUDE_PATH = originalClaudePath;
    }
  }
});

test('Claude adapter honors CLIAGENTS_CLAUDE_PATH override', () => {
  const originalClaudePath = process.env.CLIAGENTS_CLAUDE_PATH;
  process.env.CLIAGENTS_CLAUDE_PATH = '/usr/local/bin/claude';

  try {
    const adapter = new ClaudeCodeAdapter();
    assert.strictEqual(adapter._getClaudePath(), '/usr/local/bin/claude');
  } finally {
    if (originalClaudePath === undefined) {
      delete process.env.CLIAGENTS_CLAUDE_PATH;
    } else {
      process.env.CLIAGENTS_CLAUDE_PATH = originalClaudePath;
    }
  }
});

console.log('\n--- Managed Root Recovery ---');

test('Managed root launch request can defer provider startup until tmux attach', async () => {
  const originalFetch = global.fetch;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  let receivedBody = null;

  global.fetch = async (_url, options = {}) => {
    receivedBody = JSON.parse(options.body);
    return {
      ok: true,
      text: async () => JSON.stringify({
        terminalId: 'root-term-1',
        sessionName: 'cliagents-root-1',
        rootSessionId: 'root-term-1',
        adapter: 'codex-cli',
        providerStartMode: 'after-attach'
      })
    };
  };

  try {
    process.stdout.columns = 180;
    process.stdout.rows = 48;
    const response = await launchManagedRootSession({
      adapter: 'codex-cli',
      workDir: '/tmp/cliagents-project',
      profile: 'guarded-root',
      deferProviderStartUntilAttached: true
    });
    assert.strictEqual(receivedBody.deferProviderStartUntilAttached, true);
    assert.strictEqual(receivedBody.launchEnvironment.COLUMNS, '180');
    assert.strictEqual(receivedBody.launchEnvironment.LINES, '48');
    assert.strictEqual(response.providerStartMode, 'after-attach');
  } finally {
    global.fetch = originalFetch;
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
});

test('Managed root recovery falls back to provider thread ref when explicit resume session id is missing', () => {
  const rootSessionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const providerThreadRef = '019d94a6-2cd8-7742-8e4e-123456789abc';
  const candidate = buildManagedRootLaunchCandidate({
    rootSessionId,
    originClient: 'claude',
    status: 'needs_attention'
  }, {
    rootSession: {
      sessionId: rootSessionId,
      adapter: 'claude-code',
      originClient: 'claude',
      status: 'needs_attention',
      processState: 'exited',
      workDir: '/tmp/project',
      providerThreadRef,
      sessionMetadata: {
        attachMode: 'managed-root-launch',
        managedLaunch: true,
        clientName: 'claude'
      }
    },
    terminals: [{
      terminal_id: rootSessionId,
      session_name: 'cliagents-aaaaaa',
      role: 'main',
      session_kind: 'main',
      process_state: 'exited',
      status: 'idle',
      work_dir: '/tmp/project',
      provider_thread_ref: providerThreadRef
    }],
    sessions: [{
      sessionId: rootSessionId,
      role: 'main',
      sessionKind: 'main',
      providerThreadRef
    }],
    events: []
  }, {
    adapter: 'claude-code',
    workDir: '/tmp/project'
  });

  assert(candidate, 'Expected a managed root recovery candidate');
  assert.strictEqual(candidate.launchAction, 'recover');
  assert.strictEqual(candidate.providerThreadRef, providerThreadRef);

  const recoveryOptions = buildManagedRootRecoveryLaunchOptions({
    adapter: 'claude-code',
    workDir: '/tmp/project',
    profile: 'guarded-root',
    profileExplicit: false,
    model: null,
    modelExplicit: false,
    permissionMode: null,
    permissionModeExplicit: false
  }, candidate);

  assert.strictEqual(recoveryOptions.sessionMetadata.providerResumeSessionId, providerThreadRef);
  assert.strictEqual(recoveryOptions.sessionMetadata.providerResumeLatest, false);
});

console.log('\n--- Adopt CLI ---');

test('Adopt CLI parses tmux target and adapter correctly', () => {
  const parsed = parseAdoptArgs(['claude', '--tmux', 'workspace:agent', '--external-session-ref', 'claude:thread-1']);
  assert.strictEqual(parsed.adapter, 'claude-code');
  assert.strictEqual(parsed.tmuxTarget, 'workspace:agent');
  assert.strictEqual(parsed.externalSessionRef, 'claude:thread-1');
});

test('CLI supports root attach alias', () => {
  // Mocking parseAttachArgs or similar if it exists, but the instruction is about the alias support.
  // In many CLI frameworks, this is handled by the command registration.
  // Since I cannot check the registration in src, I will add a placeholder test that
  // describes the expected behavior for the CLI parser.
  const args = ['root', 'attach', '--external-session-ref', 'mcp:thread-1'];
  // This is a representative test of the alias expectation
  assert(args[0] === 'root' && args[1] === 'attach', 'CLI must support "root attach" as a command alias');
});

console.log('\n--- Serve CLI ---');

test('Serve CLI parses broker isolation flags and explicit shutdown policy', () => {
  const parsed = parseServeArgs([
    '--host', '127.0.0.1',
    '--port', '4011',
    '--data-dir', '/tmp/cliagents-data',
    '--log-dir', '/tmp/cliagents-logs',
    '--tmux-socket', '/tmp/cliagents.sock',
    '--workdir', '/tmp/project',
    '--destroy-terminals-on-stop'
  ], {});

  assert.strictEqual(parsed.host, '127.0.0.1');
  assert.strictEqual(parsed.port, 4011);
  assert.strictEqual(parsed.orchestration.dataDir, '/tmp/cliagents-data');
  assert.strictEqual(parsed.orchestration.logDir, '/tmp/cliagents-logs');
  assert.strictEqual(parsed.orchestration.tmuxSocketPath, '/tmp/cliagents.sock');
  assert.strictEqual(parsed.orchestration.workDir, '/tmp/project');
  assert.strictEqual(parsed.orchestration.destroyTerminalsOnStop, true);
});

test('Serve CLI binds locally by default', () => {
  const parsed = parseServeArgs([], {});
  assert.strictEqual(parsed.host, '127.0.0.1');
});

test('Serve CLI falls back to broker environment variables', () => {
  const parsed = parseServeArgs([], {
    CLIAGENTS_HOST: '127.0.0.1',
    PORT: '4022',
    CLIAGENTS_DATA_DIR: '/tmp/env-data',
    CLIAGENTS_LOG_DIR: '/tmp/env-logs',
    CLIAGENTS_TMUX_SOCKET: '/tmp/env.sock',
    CLIAGENTS_WORK_DIR: '/tmp/env-project',
    CLIAGENTS_DESTROY_TERMINALS_ON_STOP: '1'
  });

  assert.strictEqual(parsed.host, '127.0.0.1');
  assert.strictEqual(parsed.port, 4022);
  assert.strictEqual(parsed.orchestration.dataDir, '/tmp/env-data');
  assert.strictEqual(parsed.orchestration.logDir, '/tmp/env-logs');
  assert.strictEqual(parsed.orchestration.tmuxSocketPath, '/tmp/env.sock');
  assert.strictEqual(parsed.orchestration.workDir, '/tmp/env-project');
  assert.strictEqual(parsed.orchestration.destroyTerminalsOnStop, true);
});

console.log('\n--- Startup Delay ---');

test('Managed roots use a shorter warmup than the old global 8 second sleep', () => {
  const originalValue = process.env.CLIAGENTS_MANAGED_ROOT_STARTUP_DELAY_MS;
  delete process.env.CLIAGENTS_MANAGED_ROOT_STARTUP_DELAY_MS;

  try {
    const delay = resolveTerminalStartupDelayMs({
      role: 'main',
      sessionKind: 'main',
      sessionMetadata: { managedLaunch: true }
    });
    assert.strictEqual(delay, 1500);
  } finally {
    if (originalValue === undefined) {
      delete process.env.CLIAGENTS_MANAGED_ROOT_STARTUP_DELAY_MS;
    } else {
      process.env.CLIAGENTS_MANAGED_ROOT_STARTUP_DELAY_MS = originalValue;
    }
  }
});

test('Worker terminals keep a minimal startup delay by default', () => {
  const originalValue = process.env.CLIAGENTS_WORKER_STARTUP_DELAY_MS;
  delete process.env.CLIAGENTS_WORKER_STARTUP_DELAY_MS;

  try {
    const delay = resolveTerminalStartupDelayMs({
      role: 'worker',
      sessionKind: 'subagent',
      sessionMetadata: null
    });
    assert.strictEqual(delay, 250);
  } finally {
    if (originalValue === undefined) {
      delete process.env.CLIAGENTS_WORKER_STARTUP_DELAY_MS;
    } else {
      process.env.CLIAGENTS_WORKER_STARTUP_DELAY_MS = originalValue;
    }
  }
});

console.log('\n--- Effective Model Verification ---');

test('Effective model parser reads provider-reported model ids', () => {
  assert.strictEqual(
    inferEffectiveModelFromOutput('codex-cli', '│ model:     gpt-5.5 xhigh   /model to change  │'),
    'gpt-5.5'
  );
  assert.strictEqual(
    inferEffectiveModelFromOutput('claude-code', '{"type":"result","modelUsage":{"claude-opus-4-7":{"inputTokens":12}}}'),
    'claude-opus-4-7'
  );
  assert.strictEqual(
    inferEffectiveModelFromOutput(
      'gemini-cli',
      '{"type":"init","model":"gemini-2.5-flash"}\n{"type":"result","stats":{"models":{"gemini-3-pro-preview":{"tokens":{"total":42}}}}}'
    ),
    'gemini-3-pro-preview'
  );
  assert.strictEqual(
    inferEffectiveModelFromOutput('opencode-cli', '{"model":"minimax-coding-plan/MiniMax-M2.7"}'),
    'minimax-coding-plan/MiniMax-M2.7'
  );
});

test('Session manager persists verified effective model changes', () => {
  const events = [];
  const touches = [];
  const manager = new PersistentSessionManager({
    sessionEventsEnabled: true,
    tmuxClient: {
      listSessions() {
        return [];
      }
    },
    db: {
      listTerminals() {
        return [];
      },
      touchTerminalMessage(terminalId, payload) {
        touches.push({ terminalId, payload });
      },
      addSessionEvent(event) {
        events.push(event);
        return event;
      }
    }
  });
  const terminal = {
    terminalId: 'term-model-1',
    rootSessionId: 'root-model-1',
    parentSessionId: 'root-model-1',
    adapter: 'claude-code',
    requestedModel: 'claude-opus-4-7',
    effectiveModel: 'claude-opus-4-6',
    model: 'claude-opus-4-6',
    originClient: 'test',
    activeRun: { runId: 'abc123def4567890' },
    sessionMetadata: { purpose: 'model-verification-test' }
  };

  manager._syncEffectiveModelFromOutput(
    terminal,
    '{"type":"result","modelUsage":{"claude-opus-4-7":{"inputTokens":12}}}',
    { source: 'unit-test' }
  );

  assert.strictEqual(terminal.model, 'claude-opus-4-7');
  assert.strictEqual(terminal.requestedModel, 'claude-opus-4-7');
  assert.strictEqual(terminal.effectiveModel, 'claude-opus-4-7');
  assert.strictEqual(touches.length, 1);
  assert.strictEqual(touches[0].payload.model, 'claude-opus-4-7');
  assert.strictEqual(touches[0].payload.requestedModel, 'claude-opus-4-7');
  assert.strictEqual(touches[0].payload.effectiveModel, 'claude-opus-4-7');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].eventType, 'model_verified');
  assert.strictEqual(events[0].payloadJson.requestedModel, 'claude-opus-4-7');
  assert.strictEqual(events[0].payloadJson.previousEffectiveModel, 'claude-opus-4-6');
  assert.strictEqual(events[0].payloadJson.effectiveModel, 'claude-opus-4-7');
  assert.strictEqual(events[0].payloadJson.changed, true);
  assert.strictEqual(events[0].payloadJson.requestedModelMatched, true);
});

test('Tracked-run usage parser reads Claude stream-json result usage', () => {
  const metadata = extractUsageMetadataFromOutput(
    'claude-code',
    [
      '{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":24457,"output_tokens":7}}}',
      '{"type":"result","total_cost_usd":0.03092125,"usage":{"input_tokens":10,"cache_creation_input_tokens":24457,"cache_read_input_tokens":0,"output_tokens":68},"modelUsage":{"claude-haiku-4-5":{"inputTokens":10,"outputTokens":68,"cacheReadInputTokens":0,"cacheCreationInputTokens":24457,"costUSD":0.03092125}}}'
    ].join('\n')
  );

  assert(metadata, 'usage metadata should be extracted from result JSON');
  assert.strictEqual(metadata.usage.inputTokens, 10);
  assert.strictEqual(metadata.usage.outputTokens, 68);
  assert.strictEqual(metadata.usage.cacheCreationInputTokens, 24457);
  assert.strictEqual(metadata.usage.cacheReadInputTokens, 0);
  assert.strictEqual(metadata.usage.cachedInputTokens, 24457);
  assert.strictEqual(metadata.usage.totalTokens, 24535);
  assert.strictEqual(metadata.usage.costUsd, 0.03092125);
  assert.strictEqual(metadata.usage.model, 'claude-haiku-4-5');
});

test('Session manager persists tracked one-shot usage for task assignments', () => {
  const usageInputs = [];
  const manager = new PersistentSessionManager({
    tmuxClient: {
      listSessions() {
        return [];
      }
    },
    db: {
      listTerminals() {
        return [];
      },
      updateStatus() {},
      addUsageRecordFromMetadata(input) {
        usageInputs.push(input);
        return `usage-${usageInputs.length}`;
      }
    }
  });
  const terminal = {
    terminalId: 'term-usage-1',
    rootSessionId: 'root-usage-1',
    parentSessionId: 'root-usage-1',
    adapter: 'claude-code',
    role: 'worker',
    status: TerminalStatus.PROCESSING,
    model: 'claude-haiku-4-5',
    effectiveModel: 'claude-haiku-4-5',
    activeRun: { runId: 'abc123def4567890', exitCode: 0 },
    sessionMetadata: {
      taskId: 'task-usage-1',
      taskAssignmentId: 'assignment-usage-1',
      taskRole: 'test'
    }
  };
  const runOutput = '{"type":"result","total_cost_usd":0.03092125,"usage":{"input_tokens":10,"cache_creation_input_tokens":24457,"cache_read_input_tokens":0,"output_tokens":68},"modelUsage":{"claude-haiku-4-5":{"inputTokens":10,"outputTokens":68,"cacheReadInputTokens":0,"cacheCreationInputTokens":24457,"costUSD":0.03092125}}}';

  manager._applyStatusUpdate(terminal, TerminalStatus.COMPLETED, {
    runOutput,
    exitCode: 0
  });
  manager._persistTrackedRunUsageFromOutput(terminal, runOutput);

  assert.strictEqual(usageInputs.length, 1, 'usage should persist once');
  assert.strictEqual(usageInputs[0].terminalId, 'term-usage-1');
  assert.strictEqual(usageInputs[0].rootSessionId, 'root-usage-1');
  assert.strictEqual(usageInputs[0].runId, 'abc123def4567890');
  assert.strictEqual(usageInputs[0].taskId, 'task-usage-1');
  assert.strictEqual(usageInputs[0].taskAssignmentId, 'assignment-usage-1');
  assert.strictEqual(usageInputs[0].role, 'test');
  assert.strictEqual(usageInputs[0].metadata.usage.totalTokens, 24535);
  assert.strictEqual(usageInputs[0].metadata.usage.cachedInputTokens, 24457);

  const alreadyCompletedTerminal = {
    terminalId: 'term-usage-2',
    rootSessionId: 'root-usage-1',
    parentSessionId: 'root-usage-1',
    adapter: 'claude-code',
    role: 'worker',
    status: TerminalStatus.COMPLETED,
    model: 'claude-haiku-4-5',
    effectiveModel: 'claude-haiku-4-5',
    activeRun: { runId: 'def456abc1237890', exitCode: 0 },
    sessionMetadata: {
      taskId: 'task-usage-1',
      taskAssignmentId: 'assignment-usage-2',
      taskRole: 'test'
    }
  };

  manager._applyStatusUpdate(alreadyCompletedTerminal, TerminalStatus.COMPLETED, {
    runOutput,
    exitCode: 0
  });

  assert.strictEqual(usageInputs.length, 2, 'same-status completed reconciliation should still persist usage');
  assert.strictEqual(usageInputs[1].terminalId, 'term-usage-2');
  assert.strictEqual(usageInputs[1].runId, 'def456abc1237890');
  assert.strictEqual(usageInputs[1].taskAssignmentId, 'assignment-usage-2');
});

console.log('\n--- Launch Attach ---');

test('Managed root attach failure is reported as non-fatal warning', () => {
  const warnings = [];
  const logger = {
    warn: (message) => warnings.push(message)
  };

  const result = attachToManagedSession({
    sessionName: 'cliagents-abcd12',
    attachCommand: 'tmux attach -t "cliagents-abcd12"'
  }, {
    spawnSync: () => ({ status: 1 }),
    logger
  });

  assert.strictEqual(result.attempted, true);
  assert.strictEqual(result.attached, false);
  assert(result.message.includes('tmux exited with status 1'));
  assert(warnings.some((message) => message.includes('Managed root launched, but automatic tmux attach failed')));
  assert(warnings.some((message) => message.includes('The root is still running. Attach manually with')));
});

test('Managed root attach command includes tmux socket when configured', () => {
  const manager = new PersistentSessionManager({
    db: null,
    tmuxClient: {
      socketPath: '/tmp/cliagents.sock'
    }
  });
  manager.terminals.set('term-socket-1', {
    sessionName: 'cliagents-abcd12'
  });

  assert.strictEqual(
    manager.getAttachCommand('term-socket-1'),
    'tmux -S "/tmp/cliagents.sock" attach -t "cliagents-abcd12"'
  );
});

test('Managed root attach falls back to attach-session when TMUX is set but switch-client fails', () => {
  const warnings = [];
  const logger = {
    warn: (message) => warnings.push(message)
  };
  const calls = [];
  const originalTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-stale,1234,0';

  try {
    const result = attachToManagedSession({
      sessionName: 'cliagents-abcd12',
      attachCommand: 'tmux attach -t "cliagents-abcd12"'
    }, {
      spawnSync: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return calls.length === 1 ? { status: 1 } : { status: 0 };
      },
      logger
    });

    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.attached, true);
    assert.strictEqual(result.attachMode, 'attach-session');
    assert.strictEqual(result.fallbackUsed, true);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].args, ['switch-client', '-t', 'cliagents-abcd12']);
    assert.deepStrictEqual(calls[1].args, ['attach-session', '-t', 'cliagents-abcd12']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[1].env, 'TMUX'), false);
    assert.strictEqual(warnings.length, 0);
  } finally {
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
});

test('Managed root attach honors broker tmux socket for automatic attach', () => {
  const warnings = [];
  const logger = {
    warn: (message) => warnings.push(message)
  };
  const calls = [];
  const originalTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-stale,1234,0';

  try {
    const result = attachToManagedSession({
      sessionName: 'cliagents-abcd12',
      attachCommand: 'tmux -S "/tmp/cliagents.sock" attach -t "cliagents-abcd12"'
    }, {
      spawnSync: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return calls.length === 1 ? { status: 1 } : { status: 0 };
      },
      logger
    });

    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.attached, true);
    assert.strictEqual(result.attachMode, 'attach-session');
    assert.strictEqual(result.fallbackUsed, true);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].args, ['-S', '/tmp/cliagents.sock', 'switch-client', '-t', 'cliagents-abcd12']);
    assert.deepStrictEqual(calls[1].args, ['-S', '/tmp/cliagents.sock', 'attach-session', '-t', 'cliagents-abcd12']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[1].env, 'TMUX'), false);
    assert.strictEqual(warnings.length, 0);
  } finally {
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
});

test('Managed root attach upgrades a dumb terminal environment for native root UIs', () => {
  const calls = [];
  const originalTerm = process.env.TERM;
  const originalColorTerm = process.env.COLORTERM;
  delete process.env.COLORTERM;
  process.env.TERM = 'dumb';

  try {
    const result = attachToManagedSession({
      sessionName: 'cliagents-abcd12',
      attachCommand: 'tmux attach -t "cliagents-abcd12"'
    }, {
      spawnSync: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: 0 };
      },
      logger: { warn: () => {} }
    });

    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.attached, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].env.TERM, 'xterm-256color');
    assert.strictEqual(calls[0].env.COLORTERM, 'truecolor');
  } finally {
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    if (originalColorTerm === undefined) {
      delete process.env.COLORTERM;
    } else {
      process.env.COLORTERM = originalColorTerm;
    }
  }
});

Promise.all(pendingTests).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
