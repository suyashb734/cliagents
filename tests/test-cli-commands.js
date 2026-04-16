/**
 * Unit tests for supported CLI command construction.
 *
 * Run: node tests/test-cli-commands.js
 */

const assert = require('assert');
const { CLI_COMMANDS } = require('../src/tmux/session-manager');
const ClaudeCodeAdapter = require('../src/adapters/claude-code');
const {
  parseAdoptArgs,
  attachToManagedSession,
  buildManagedRootLaunchCandidate,
  buildManagedRootRecoveryLaunchOptions
} = require('../src/index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
  }
}

console.log('\n📋 Supported CLI Command Construction Tests\n');

console.log('--- Gemini CLI ---');

test('Gemini interactive command uses yolo by default', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ model: 'gemini-2.5-pro' });

  assert(cmd.startsWith('gemini'), `Expected to start with "gemini", got: ${cmd}`);
  assert(cmd.includes('--approval-mode yolo'), `Expected yolo approval mode, got: ${cmd}`);
  assert(cmd.includes('-m gemini-2.5-pro'), `Expected model flag, got: ${cmd}`);
});

test('Gemini orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "GEMINI_READY_FOR_ORCHESTRATION"');
});

test('Gemini recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['gemini-cli']({ resumeLatest: true });
  assert.strictEqual(cmd, 'gemini --approval-mode yolo --resume latest');
});

console.log('\n--- Codex CLI ---');

test('Codex interactive command bypasses approvals by default', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ model: 'o4-mini' });

  assert(cmd.startsWith('codex'), `Expected codex prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
  assert(cmd.includes('--model o4-mini'), `Expected model flag, got: ${cmd}`);
});

test('Codex interactive command can start by resuming a prior session', () => {
  const cmd = CLI_COMMANDS['codex-cli']({
    model: 'o4-mini',
    resumeSessionId: '019d94a6-2cd8-7742-8e4e-123456789abc'
  });

  assert(cmd.startsWith('codex resume 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected codex resume prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
  assert(cmd.includes('--model o4-mini'), `Expected model flag, got: ${cmd}`);
});

test('Codex orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "CODEX_READY_FOR_ORCHESTRATION"');
});

test('Codex recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['codex-cli']({ resumeLatest: true });
  assert(cmd.startsWith('codex resume --last'), `Expected codex latest resume prefix, got: ${cmd}`);
  assert(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), `Expected bypass flag, got: ${cmd}`);
});

console.log('\n--- Qwen CLI ---');

test('Qwen interactive command uses yolo by default', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ model: 'qwen3-coder' });

  assert(cmd.startsWith('qwen'), `Expected to start with "qwen", got: ${cmd}`);
  assert(cmd.includes('-y'), `Expected -y flag, got: ${cmd}`);
  assert(cmd.includes('-m qwen3-coder'), `Expected model flag, got: ${cmd}`);
});

test('Qwen orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "QWEN_READY_FOR_ORCHESTRATION"');
});

test('Qwen managed root binds a provider session id on first launch', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ providerSessionId: '019d94a6-2cd8-7742-8e4e-123456789abc' });
  assert(cmd.includes('--session-id 019d94a6-2cd8-7742-8e4e-123456789abc'), `Expected session binding flag, got: ${cmd}`);
});

test('Qwen recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['qwen-cli']({ resumeLatest: true });
  assert.strictEqual(cmd, 'qwen -y --continue');
});

console.log('\n--- OpenCode CLI ---');

test('OpenCode interactive command supports model selection', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ model: 'openai/gpt-5' });

  assert(cmd.startsWith('opencode'), `Expected to start with "opencode", got: ${cmd}`);
  assert(cmd.includes('--model openai/gpt-5'), `Expected model flag, got: ${cmd}`);
});

test('OpenCode orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "OPENCODE_READY_FOR_ORCHESTRATION"');
});

test('OpenCode recovered root can resume the latest provider session automatically', () => {
  const cmd = CLI_COMMANDS['opencode-cli']({ resumeLatest: true });
  assert.strictEqual(cmd, 'opencode --continue');
});

console.log('\n--- Claude Code ---');

test('Claude orchestration command uses ready marker', () => {
  const cmd = CLI_COMMANDS['claude-code']({ orchestration: true });
  assert.strictEqual(cmd, 'echo "CLAUDE_READY_FOR_ORCHESTRATION"');
});

test('Claude interactive command respects explicit default permission mode', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    permissionMode: 'default',
    model: 'claude-sonnet-4-5-20250514'
  });

  assert(cmd.split(' ')[0].endsWith('claude'), `Expected Claude executable prefix, got: ${cmd}`);
  assert(cmd.includes('--permission-mode default'), `Expected default permission mode, got: ${cmd}`);
  assert(cmd.includes('--output-format stream-json'), `Expected stream-json output, got: ${cmd}`);
  assert(cmd.includes('--model claude-sonnet-4-5-20250514'), `Expected model flag, got: ${cmd}`);
});

test('Claude interactive command omits allowedTools when the list is empty', () => {
  const cmd = CLI_COMMANDS['claude-code']({
    permissionMode: 'default',
    allowedTools: []
  });

  assert(!cmd.includes('--allowedTools'), `Did not expect empty allowedTools flag, got: ${cmd}`);
});

test('Claude managed root binds a provider session id on first launch', () => {
  const cmd = CLI_COMMANDS['claude-code']({
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
