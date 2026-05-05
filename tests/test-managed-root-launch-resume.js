/**
 * Tests for managed-root launch resume selection.
 *
 * Run: node tests/test-managed-root-launch-resume.js
 */

'use strict';

const assert = require('assert');
const {
  parseAttachRootArgs,
  parseLaunchArgs,
  parseListRootsArgs,
  buildManagedRootLaunchCandidate,
  normalizeManagedRootResumeCandidate,
  normalizeManagedRootRecoveryCandidate,
  createManagedRootSelectionPrompt,
  createProviderSessionSelectionPrompt,
  listOperatorRootSessions,
  getOperatorRootSession,
  listManagedRootLaunchCandidates,
  listManagedRootResumeCandidates,
  listManagedRootRecoveryCandidates,
  resolveManagedRootLaunchTarget,
  buildManagedRootRecoveryLaunchOptions,
  buildManagedRootContextLaunchOptions,
  shouldDefaultCodexProviderResumePicker,
  applyCodexProviderResumePickerDefault
} = require('../src/index');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
  }
}

function buildManagedSnapshot(overrides = {}) {
  return {
    rootSession: {
      sessionId: 'root-1',
      adapter: 'codex-cli',
      originClient: 'codex',
      status: 'idle',
      model: 'o4-mini',
      processState: 'alive',
      sessionMetadata: {
        managedLaunch: true,
        attachMode: 'managed-root-launch',
        launchProfile: 'guarded-root'
      },
      externalSessionRef: 'codex:managed:123'
    },
    terminals: [{
      terminal_id: 'term-1',
      session_name: 'cliagents-root1',
      window_name: 'codex-cli-root1',
      adapter: 'codex-cli',
      role: 'main',
      session_kind: 'main',
      status: 'idle',
      process_state: 'alive',
      work_dir: '/tmp/project',
      root_session_id: 'root-1',
      external_session_ref: 'codex:managed:123'
    }],
    ...overrides
  };
}

async function run() {
  console.log('\n📋 Managed Root Launch Resume Tests\n');

  await test('Launch args parse new-root and resume options', async () => {
    const parsed = parseLaunchArgs(['codex', '--resume-root', 'root-123']);
    assert.strictEqual(parsed.adapter, 'codex-cli');
    assert.strictEqual(parsed.resumeRootSessionId, 'root-123');

    const latest = parseLaunchArgs(['codex', '--resume-latest']);
    assert.strictEqual(latest.resumeLatest, true);

    const fresh = parseLaunchArgs(['codex', '--new-root']);
    assert.strictEqual(fresh.forceNewRoot, true);

    const recoverLatest = parseLaunchArgs(['codex', '--recover-latest']);
    assert.strictEqual(recoverLatest.recoverLatest, true);

    const recoverRoot = parseLaunchArgs(['codex', '--recover-root', 'root-stale']);
    assert.strictEqual(recoverRoot.recoverRootSessionId, 'root-stale');

    const exactProviderResume = parseLaunchArgs(['codex', '--resume-provider-session', 'session-123']);
    assert.strictEqual(exactProviderResume.providerSessionId, 'session-123');

    const providerPicker = parseLaunchArgs(['codex', '--resume-provider-picker']);
    assert.strictEqual(providerPicker.providerResumePicker, true);

    const freshProvider = parseLaunchArgs(['codex', '--fresh-provider-session']);
    assert.strictEqual(freshProvider.freshProviderSession, true);
  });

  await test('Launch args reject mixed resume and recover combinations', async () => {
    assert.throws(
      () => parseLaunchArgs(['codex', '--resume-latest', '--recover-latest']),
      /Cannot combine resume and recover flags/
    );
    assert.throws(
      () => parseLaunchArgs(['codex', '--external-session-ref', 'codex:managed:123', '--recover-latest']),
      /Cannot combine --external-session-ref with resume or recover flags/
    );
    assert.throws(
      () => parseLaunchArgs(['codex', '--resume-provider-session', 'session-123', '--resume-latest']),
      /Cannot combine --resume-provider-session with resume or recover flags/
    );
    assert.throws(
      () => parseLaunchArgs(['codex', '--resume-provider-session', 'session-123', '--resume-provider-picker']),
      /Cannot combine --resume-provider-session with --resume-provider-picker/
    );
    assert.throws(
      () => parseLaunchArgs(['codex', '--fresh-provider-session', '--resume-provider-picker']),
      /Cannot combine --fresh-provider-session with provider resume options/
    );
    assert.throws(
      () => parseLaunchArgs(['claude', '--resume-provider-picker']),
      /currently supported only for Codex/
    );
  });

  await test('List-roots args default to live user roots', async () => {
    const parsed = parseListRootsArgs(['codex']);
    assert.strictEqual(parsed.adapter, 'codex-cli');
    assert.strictEqual(parsed.scope, 'user');
    assert.strictEqual(parsed.liveOnly, true);

    const expanded = parseListRootsArgs(['--all', '--scope', 'all', '--json']);
    assert.strictEqual(expanded.liveOnly, false);
    assert.strictEqual(expanded.scope, 'all');
    assert.strictEqual(expanded.json, true);
  });

  await test('Attach-root args support latest selection and print-only mode', async () => {
    const parsed = parseAttachRootArgs(['--latest', '--adapter', 'codex', '--print-only']);
    assert.strictEqual(parsed.latest, true);
    assert.strictEqual(parsed.adapter, 'codex-cli');
    assert.strictEqual(parsed.printOnly, true);

    assert.throws(
      () => parseAttachRootArgs(['root-1', '--latest']),
      /Cannot combine an explicit root session id with --latest/
    );
  });

  await test('Normalize managed resume candidate returns attachable root', async () => {
    const candidate = normalizeManagedRootResumeCandidate({
      rootSessionId: 'root-1',
      originClient: 'codex',
      status: 'idle',
      lastOccurredAt: '2026-04-16T06:00:00.000Z'
    }, buildManagedSnapshot(), {
      adapter: 'codex',
      workDir: '/tmp/project'
    });

    assert(candidate, 'expected attachable candidate');
    assert.strictEqual(candidate.rootSessionId, 'root-1');
    assert.strictEqual(candidate.terminalId, 'term-1');
    assert.strictEqual(candidate.sessionName, 'cliagents-root1');
    assert.strictEqual(candidate.adapter, 'codex-cli');
    assert.strictEqual(candidate.launchProfile, 'guarded-root');
    assert.strictEqual(candidate.attachCommand, 'tmux attach -t "cliagents-root1"');
  });

  await test('Normalize managed resume candidate rejects mismatched workdir and unmanaged roots', async () => {
    const wrongDir = normalizeManagedRootResumeCandidate({
      rootSessionId: 'root-1',
      originClient: 'codex',
      status: 'idle'
    }, buildManagedSnapshot(), {
      adapter: 'codex',
      workDir: '/tmp/other-project'
    });
    assert.strictEqual(wrongDir, null);

    const unmanaged = normalizeManagedRootResumeCandidate({
      rootSessionId: 'root-1',
      originClient: 'codex',
      status: 'idle'
    }, buildManagedSnapshot({
      rootSession: {
        sessionId: 'root-1',
        adapter: 'codex-cli',
        originClient: 'codex',
        status: 'idle',
        sessionMetadata: {
          attachMode: 'explicit-http-attach'
        }
      }
    }), {
      adapter: 'codex',
      workDir: '/tmp/project'
    });
    assert.strictEqual(unmanaged, null);
  });

  await test('Shell-only managed root becomes a recover candidate instead of a resume candidate', async () => {
    const snapshot = buildManagedSnapshot({
      terminals: [{
        terminal_id: 'term-1',
        session_name: 'cliagents-root1',
        window_name: 'codex-cli-root1',
        adapter: 'codex-cli',
        role: 'main',
        session_kind: 'main',
        status: 'idle',
        process_state: 'alive',
        current_command: 'zsh',
        work_dir: '/tmp/project',
        root_session_id: 'root-1',
        external_session_ref: 'codex:managed:123'
      }]
    });

    const resumeCandidate = normalizeManagedRootResumeCandidate({
      rootSessionId: 'root-1',
      originClient: 'codex',
      status: 'idle'
    }, snapshot, {
      adapter: 'codex',
      workDir: '/tmp/project'
    });
    assert.strictEqual(resumeCandidate, null);

    const recoveryCandidate = normalizeManagedRootRecoveryCandidate({
      rootSessionId: 'root-1',
      originClient: 'codex',
      status: 'needs_attention'
    }, snapshot, {
      adapter: 'codex',
      workDir: '/tmp/project'
    });
    assert(recoveryCandidate, 'expected recover candidate');
    assert.strictEqual(recoveryCandidate.recoveryReason, 'provider-exited');
    assert.strictEqual(recoveryCandidate.currentCommand, 'zsh');
  });

  await test('Exited managed root becomes a recover candidate', async () => {
    const recoveryCandidate = normalizeManagedRootRecoveryCandidate({
      rootSessionId: 'root-3',
      originClient: 'codex',
      status: 'needs_attention'
    }, buildManagedSnapshot({
      rootSession: {
        sessionId: 'root-3',
        adapter: 'codex-cli',
        originClient: 'codex',
        status: 'stale',
        processState: 'exited',
        sessionMetadata: {
          managedLaunch: true,
          attachMode: 'managed-root-launch',
          launchProfile: 'supervised-root'
        },
        externalSessionRef: 'codex:managed:stale'
      },
      terminals: [{
        terminal_id: 'term-3',
        session_name: 'cliagents-root3',
        window_name: 'codex-cli-root3',
        adapter: 'codex-cli',
        role: 'main',
        session_kind: 'main',
        status: 'orphaned',
        process_state: 'exited',
        work_dir: '/tmp/project',
        root_session_id: 'root-3',
        external_session_ref: 'codex:managed:stale'
      }]
    }), {
      adapter: 'codex',
      workDir: '/tmp/project'
    });

    assert(recoveryCandidate, 'expected exited root to be recoverable');
    assert.strictEqual(recoveryCandidate.launchAction, 'recover');
    assert.strictEqual(recoveryCandidate.recoveryReason, 'orphaned');
    assert.strictEqual(recoveryCandidate.externalSessionRef, 'codex:managed:stale');
  });

  await test('Interrupted Codex root becomes a recover candidate with exact provider resume', async () => {
    const interruptedSnapshot = buildManagedSnapshot({
      rootSession: {
        sessionId: 'root-4',
        adapter: 'codex-cli',
        originClient: 'codex',
        status: 'error',
        processState: 'alive',
        terminationStatus: 'error',
        sessionMetadata: {
          managedLaunch: true,
          attachMode: 'managed-root-launch',
          launchProfile: 'supervised-root'
        },
        externalSessionRef: 'codex:managed:resumeable'
      },
      sessions: [{
        sessionId: 'root-4',
        role: 'main',
        sessionKind: 'main',
        status: 'error',
        terminationStatus: 'error'
      }],
      events: [{
        payload_json: {
          resumeCommand: 'codex resume 019daf89-b494-7353-8dc8-e4303880a1b5',
          resumeSessionId: '019daf89-b494-7353-8dc8-e4303880a1b5',
          attentionMessage: 'Conversation interrupted - tell the model what to do differently.'
        }
      }],
      terminals: [{
        terminal_id: 'term-4',
        session_name: 'cliagents-root4',
        window_name: 'codex-cli-root4',
        adapter: 'codex-cli',
        role: 'main',
        session_kind: 'main',
        status: 'error',
        process_state: 'alive',
        work_dir: '/tmp/project',
        root_session_id: 'root-4',
        external_session_ref: 'codex:managed:resumeable'
      }]
    });

    const resumeCandidate = normalizeManagedRootResumeCandidate({
      rootSessionId: 'root-4',
      originClient: 'codex',
      status: 'needs_attention'
    }, interruptedSnapshot, {
      adapter: 'codex',
      workDir: '/tmp/project'
    });
    assert.strictEqual(resumeCandidate, null);

    const recoveryCandidate = normalizeManagedRootRecoveryCandidate({
      rootSessionId: 'root-4',
      originClient: 'codex',
      status: 'needs_attention'
    }, interruptedSnapshot, {
      adapter: 'codex',
      workDir: '/tmp/project'
    });

    assert(recoveryCandidate, 'expected interrupted root to recover through provider resume');
    assert.strictEqual(recoveryCandidate.recoveryReason, 'provider-interrupted');
    assert.strictEqual(recoveryCandidate.resumeSessionId, '019daf89-b494-7353-8dc8-e4303880a1b5');
    assert.strictEqual(recoveryCandidate.exactProviderResume, true);
  });

  await test('List managed resume candidates filters live matching roots', async () => {
    const routes = [];
    const candidates = await listManagedRootResumeCandidates({
      adapter: 'codex',
      workDir: '/tmp/project',
      rootLimit: 4,
      candidateLimit: 3
    }, {
      async callCliagentsJson(route) {
        routes.push(route);
        if (route.startsWith('/orchestration/root-sessions?')) {
          return {
            roots: [
              { rootSessionId: 'root-1', originClient: 'codex', status: 'idle', lastOccurredAt: '2026-04-16T06:00:00.000Z' },
              { rootSessionId: 'root-2', originClient: 'gemini', status: 'idle', lastOccurredAt: '2026-04-16T05:59:00.000Z' },
              { rootSessionId: 'root-3', originClient: 'codex', status: 'idle', lastOccurredAt: '2026-04-16T05:58:00.000Z' }
            ]
          };
        }
        if (route.includes('/root-1?')) {
          return buildManagedSnapshot();
        }
        if (route.includes('/root-3?')) {
          return buildManagedSnapshot({
            rootSession: {
              sessionId: 'root-3',
              adapter: 'codex-cli',
              originClient: 'codex',
              status: 'idle',
              sessionMetadata: {
                managedLaunch: true,
                attachMode: 'managed-root-launch'
              }
            },
            terminals: [{
              terminal_id: 'term-3',
              session_name: 'cliagents-root3',
              window_name: 'codex-cli-root3',
              adapter: 'codex-cli',
              role: 'main',
              session_kind: 'main',
              status: 'idle',
              process_state: 'exited',
              work_dir: '/tmp/project',
              root_session_id: 'root-3'
            }]
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].rootSessionId, 'root-1');
    assert(routes.some((route) => route.startsWith('/orchestration/root-sessions?')), 'expected root summary lookup');
    assert(routes.some((route) => route.includes('/root-1?')), 'expected detail lookup for root-1');
  });

  await test('List managed launch candidates separates resume and recovery roots', async () => {
    const candidates = await listManagedRootLaunchCandidates({
      adapter: 'codex',
      workDir: '/tmp/project',
      rootLimit: 4,
      resumeLimit: 3,
      recoveryLimit: 3
    }, {
      async callCliagentsJson(route) {
        if (route.startsWith('/orchestration/root-sessions?')) {
          return {
            roots: [
              { rootSessionId: 'root-1', originClient: 'codex', status: 'idle', lastOccurredAt: '2026-04-16T06:00:00.000Z' },
              { rootSessionId: 'root-2', originClient: 'codex', status: 'needs_attention', lastOccurredAt: '2026-04-16T05:59:00.000Z' }
            ]
          };
        }
        if (route.includes('/root-1?')) {
          return buildManagedSnapshot();
        }
        if (route.includes('/root-2?')) {
          return buildManagedSnapshot({
            rootSession: {
              sessionId: 'root-2',
              adapter: 'codex-cli',
              originClient: 'codex',
              status: 'needs_attention',
              sessionMetadata: {
                managedLaunch: true,
                attachMode: 'managed-root-launch',
                launchProfile: 'guarded-root'
              }
            },
            terminals: [{
              terminal_id: 'term-2',
              session_name: 'cliagents-root2',
              window_name: 'codex-cli-root2',
              adapter: 'codex-cli',
              role: 'main',
              session_kind: 'main',
              status: 'idle',
              process_state: 'alive',
              current_command: 'zsh',
              work_dir: '/tmp/project',
              root_session_id: 'root-2'
            }]
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert.strictEqual(candidates.resumeCandidates.length, 1);
    assert.strictEqual(candidates.recoverCandidates.length, 1);
    assert.strictEqual(candidates.resumeCandidates[0].rootSessionId, 'root-1');
    assert.strictEqual(candidates.recoverCandidates[0].rootSessionId, 'root-2');
  });

  await test('Destroyed roots without provider resume are ignored for managed recovery', async () => {
    const candidates = await listManagedRootRecoveryCandidates({
      adapter: 'codex',
      workDir: '/tmp/project'
    }, {
      async callCliagentsJson(route) {
        if (route.startsWith('/orchestration/root-sessions?')) {
          return {
            roots: [
              { rootSessionId: 'root-destroyed', originClient: 'codex', status: 'needs_attention', lastOccurredAt: '2026-04-16T06:00:00.000Z' }
            ]
          };
        }
        if (route.includes('/root-destroyed?')) {
          return {
            rootSession: {
              sessionId: 'root-destroyed',
              adapter: 'codex-cli',
              originClient: 'codex',
              status: 'stale',
              destroyed: true,
              sessionMetadata: {
                managedLaunch: true,
                attachMode: 'managed-root-launch'
              }
            },
            sessions: [{
              sessionId: 'root-destroyed',
              role: 'main',
              sessionKind: 'main',
              status: 'stale',
              destroyed: true
            }],
            terminals: [],
            events: [{
              payload_json: {
                reason: 'historical-orphan-prune'
              }
            }]
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert.strictEqual(candidates.length, 0);
  });

  await test('Managed root selection prompt includes workdir and summary context', async () => {
    const prompt = createManagedRootSelectionPrompt({
      resumeCandidates: [{
        rootSessionId: 'root-live-1234567890',
        status: 'idle',
        workDir: '/tmp/project-alpha',
        model: 'o4-mini',
        launchProfile: 'guarded-root',
        processState: 'alive',
        currentCommand: 'codex',
        latestSummary: 'Fixing the browser console so the current root view shows child terminals inline.'
      }],
      recoverCandidates: [{
        rootSessionId: 'root-stale-abcdef1234',
        status: 'needs_attention',
        workDir: '/tmp/project-beta',
        launchProfile: 'supervised-root',
        processState: 'exited',
        currentCommand: 'zsh',
        recoveryReason: 'provider-exited',
        latestSummary: 'Gemini exited after finishing the last task and can likely be recovered.'
      }]
    }, {
      adapter: 'codex-cli',
      workDir: '/tmp/project-alpha'
    });

    assert(prompt.text.includes('dir=project-alpha'));
    assert(prompt.text.includes('workdir: /tmp/project-alpha'));
    assert(prompt.text.includes('summary: Fixing the browser console so the current root view shows child terminals inline.'));
    assert(prompt.text.includes('recover'));
    assert(prompt.text.includes('workdir: /tmp/project-beta'));
    assert(prompt.text.includes('summary: Gemini exited after finishing the last task and can likely be recovered.'));
  });

  await test('Managed root selection prompt suppresses Codex TUI noise', async () => {
    const prompt = createManagedRootSelectionPrompt({
      resumeCandidates: [{
        rootSessionId: 'root-noisy-1234567890',
        status: 'idle',
        workDir: '/tmp/project-alpha',
        launchProfile: 'guarded-root',
        processState: 'alive',
        currentCommand: 'node',
        latestSummary: '› daf',
        activityExcerpt: 'https://developers.openai.com/codex/hooks. › daf gpt-5.5 xhigh · ~/Documents/AI-projects'
      }, {
        rootSessionId: 'root-review-abcdef1234',
        status: 'processing',
        workDir: '/tmp/project-alpha',
        launchProfile: 'supervised-root',
        processState: 'alive',
        currentCommand: 'node',
        latestSummary: '• Working (28m 17s • esc to interrupt) · 2 background terminals run…',
        activityExcerpt: '• Working (28m 17s • esc to interrupt) · 2 background terminals run… › Run /review on my current changes gpt-5.4 xhigh · ~/Documents/AI-projects'
      }, {
        rootSessionId: 'root-prompt-fedcba9876',
        status: 'idle',
        workDir: '/tmp/project-alpha',
        launchProfile: 'guarded-root',
        processState: 'alive',
        currentCommand: 'node',
        latestSummary: '› Explain this codebase gpt-5.4 xhigh · ~/Documents/AI-projects'
      }]
    }, {
      adapter: 'codex-cli',
      workDir: '/tmp/project-alpha'
    });

    assert(!prompt.text.includes('summary: › daf'));
    assert(!prompt.text.includes('excerpt: https://developers.openai.com/codex/hooks.'));
    assert(prompt.text.includes('summary: Run /review on my current changes'));
    assert(prompt.text.includes('summary: Explain this codebase'));
  });

  await test('Provider session selection prompt includes transcript summary context', async () => {
    const prompt = createProviderSessionSelectionPrompt([{
      providerSessionId: '019df324-64ff-7192-aff1-b0684cd57387',
      title: 'Analyze disk storage',
      updatedAt: new Date().toISOString(),
      cwd: '/tmp/disk-analysis',
      model: 'gpt-5.4',
      messageCount: 7,
      summary: 'Last user: Check which folders are using the most disk and propose cleanup steps.',
      lastAssistantMessage: 'Found that node_modules and video renders dominate disk usage.'
    }], {
      adapter: 'codex-cli'
    });

    assert(prompt.text.includes('Analyze disk storage'));
    assert(prompt.text.includes('dir=disk-analysis'));
    assert(prompt.text.includes('messages=7'));
    assert(prompt.text.includes('summary: Last user: Check which folders are using the most disk and propose cleanup steps.'));
    assert(prompt.text.includes('last assistant: Found that node_modules and video renders dominate disk usage.'));
    assert(prompt.text.includes('Open native Codex resume picker'));
    assert(prompt.text.includes('Start a fresh provider session'));
  });

  await test('List managed recovery candidates returns only recoverable roots', async () => {
    const candidates = await listManagedRootRecoveryCandidates({
      adapter: 'codex',
      workDir: '/tmp/project'
    }, {
      async callCliagentsJson(route) {
        if (route.startsWith('/orchestration/root-sessions?')) {
          return {
            roots: [
              { rootSessionId: 'root-1', originClient: 'codex', status: 'idle', lastOccurredAt: '2026-04-16T06:00:00.000Z' }
            ]
          };
        }
        if (route.includes('/root-1?')) {
          return buildManagedSnapshot({
            terminals: [{
              terminal_id: 'term-1',
              session_name: 'cliagents-root1',
              window_name: 'codex-cli-root1',
              adapter: 'codex-cli',
              role: 'main',
              session_kind: 'main',
              status: 'idle',
              process_state: 'alive',
              current_command: 'zsh',
              work_dir: '/tmp/project',
              root_session_id: 'root-1'
            }]
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].launchAction, 'recover');
  });

  await test('Operator root listing prefers live roots and can filter by adapter', async () => {
    const roots = await listOperatorRootSessions({
      adapter: 'codex',
      limit: 4,
      liveOnly: false
    }, {
      async callCliagentsJson(route) {
        if (route.startsWith('/orchestration/root-sessions?')) {
          return {
            roots: [
              {
                rootSessionId: 'root-live',
                originClient: 'codex',
                status: 'idle',
                lastOccurredAt: '2026-04-16T06:00:00.000Z',
                externalSessionRef: 'codex:managed:live'
              },
              {
                rootSessionId: 'root-old',
                originClient: 'codex',
                status: 'completed',
                lastOccurredAt: '2026-04-16T05:00:00.000Z',
                externalSessionRef: 'codex:managed:old'
              },
              {
                rootSessionId: 'root-gemini',
                originClient: 'gemini',
                status: 'idle',
                lastOccurredAt: '2026-04-16T06:05:00.000Z',
                externalSessionRef: 'gemini:managed:live'
              }
            ]
          };
        }
        if (route.includes('/root-live?')) {
          return buildManagedSnapshot();
        }
        if (route.includes('/root-old?')) {
          return buildManagedSnapshot({
            rootSession: {
              sessionId: 'root-old',
              adapter: 'codex-cli',
              originClient: 'codex',
              status: 'completed',
              processState: 'exited',
              sessionMetadata: {
                managedLaunch: true,
                attachMode: 'managed-root-launch'
              },
              externalSessionRef: 'codex:managed:old'
            },
            terminals: [{
              terminal_id: 'term-old',
              session_name: 'cliagents-old',
              window_name: 'codex-cli-old',
              adapter: 'codex-cli',
              role: 'main',
              session_kind: 'main',
              status: 'completed',
              process_state: 'exited',
              work_dir: '/tmp/project',
              root_session_id: 'root-old',
              external_session_ref: 'codex:managed:old'
            }]
          });
        }
        if (route.includes('/root-gemini?')) {
          return buildManagedSnapshot({
            rootSession: {
              sessionId: 'root-gemini',
              adapter: 'gemini-cli',
              originClient: 'gemini',
              status: 'idle',
              processState: 'alive',
              sessionMetadata: {
                managedLaunch: true,
                attachMode: 'managed-root-launch'
              },
              externalSessionRef: 'gemini:managed:live'
            },
            terminals: [{
              terminal_id: 'term-gemini',
              session_name: 'cliagents-gemini',
              window_name: 'gemini-cli-root',
              adapter: 'gemini-cli',
              role: 'main',
              session_kind: 'main',
              status: 'idle',
              process_state: 'alive',
              work_dir: '/tmp/project',
              root_session_id: 'root-gemini',
              external_session_ref: 'gemini:managed:live'
            }]
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert.strictEqual(roots.length, 2);
    assert.strictEqual(roots[0].rootSessionId, 'root-live');
    assert.strictEqual(roots[0].live, true);
    assert.strictEqual(roots[1].rootSessionId, 'root-old');
    assert.strictEqual(roots[1].live, false);
  });

  await test('Operator root lookup builds an attachable record from a snapshot', async () => {
    const root = await getOperatorRootSession('root-1', {}, {
      async callCliagentsJson(route) {
        if (route.includes('/root-1?')) {
          return buildManagedSnapshot();
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert(root, 'expected operator root record');
    assert.strictEqual(root.rootSessionId, 'root-1');
    assert.strictEqual(root.sessionName, 'cliagents-root1');
    assert.strictEqual(root.attachCommand, 'tmux attach -t "cliagents-root1"');
    assert.strictEqual(root.live, true);
  });

  await test('Resolve launch target can resume latest candidate', async () => {
    const candidate = {
      rootSessionId: 'root-1',
      terminalId: 'term-1',
      sessionName: 'cliagents-root1',
      adapter: 'codex-cli',
      status: 'idle',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:123',
      consoleUrl: 'http://127.0.0.1:4001/console?root=root-1&terminal=term-1',
      attachCommand: 'tmux attach -t "cliagents-root1"'
    };
    const result = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      resumeLatest: true
    }, {
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [candidate],
        recoverCandidates: []
      })
    });

    assert.strictEqual(result.action, 'resume');
    assert.strictEqual(result.reason, 'resume-latest');
    assert.strictEqual(result.candidate.rootSessionId, 'root-1');
  });

  await test('Resolve launch target falls back to context resume for resume-latest', async () => {
    const recoverCandidate = {
      rootSessionId: 'root-2',
      terminalId: 'term-2',
      sessionName: 'cliagents-root2',
      adapter: 'codex-cli',
      status: 'needs_attention',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:456',
      launchAction: 'recover',
      recoveryReason: 'provider-interrupted',
      resumeCommand: 'codex resume 019daf89-b494-7353-8dc8-e4303880a1b5',
      resumeSessionId: '019daf89-b494-7353-8dc8-e4303880a1b5',
      exactProviderResume: true,
      consoleUrl: 'http://127.0.0.1:4001/console?root=root-2&terminal=term-2',
      attachCommand: 'tmux attach -t "cliagents-root2"'
    };
    const result = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      resumeLatest: true
    }, {
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [],
        recoverCandidates: [recoverCandidate]
      })
    });

    assert.strictEqual(result.action, 'context');
    assert.strictEqual(result.reason, 'resume-latest-context');
    assert.strictEqual(result.candidate.rootSessionId, 'root-2');
  });

  await test('Resolve launch target falls back to context resume for explicit resume-root', async () => {
    const recoverCandidate = {
      rootSessionId: 'root-2',
      terminalId: 'term-2',
      sessionName: 'cliagents-root2',
      adapter: 'codex-cli',
      status: 'needs_attention',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:456',
      launchAction: 'recover',
      recoveryReason: 'provider-interrupted',
      resumeCommand: 'codex resume 019daf89-b494-7353-8dc8-e4303880a1b5',
      resumeSessionId: '019daf89-b494-7353-8dc8-e4303880a1b5',
      exactProviderResume: true,
      consoleUrl: 'http://127.0.0.1:4001/console?root=root-2&terminal=term-2',
      attachCommand: 'tmux attach -t "cliagents-root2"'
    };
    const result = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      resumeRootSessionId: 'root-2'
    }, {
      getManagedRootResumeCandidate: async () => null,
      getManagedRootRecoveryCandidate: async () => recoverCandidate
    });

    assert.strictEqual(result.action, 'context');
    assert.strictEqual(result.reason, 'explicit-resume-root-context');
    assert.strictEqual(result.candidate.rootSessionId, 'root-2');
  });

  await test('Resolve launch target keeps exact recovery for recover-latest when an exact handle exists', async () => {
    const recoverCandidate = {
      rootSessionId: 'root-3',
      terminalId: 'term-3',
      sessionName: 'cliagents-root3',
      adapter: 'codex-cli',
      status: 'needs_attention',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:789',
      launchAction: 'recover',
      recoveryReason: 'provider-interrupted',
      resumeCommand: 'codex resume 019daf89-b494-7353-8dc8-e4303880a1b5',
      resumeSessionId: '019daf89-b494-7353-8dc8-e4303880a1b5',
      exactProviderResume: true
    };

    const result = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      recoverLatest: true
    }, {
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [],
        recoverCandidates: [recoverCandidate]
      })
    });

    assert.strictEqual(result.action, 'recover');
    assert.strictEqual(result.reason, 'recover-latest');
    assert.strictEqual(result.candidate.rootSessionId, 'root-3');
  });

  await test('Resolve launch target falls back to context recovery for recover-latest without an exact handle', async () => {
    const recoverCandidate = {
      rootSessionId: 'root-4',
      terminalId: 'term-4',
      sessionName: 'cliagents-root4',
      adapter: 'codex-cli',
      status: 'needs_attention',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:999',
      launchAction: 'recover',
      recoveryReason: 'process-exited',
      exactProviderResume: false
    };

    const result = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      recoverLatest: true
    }, {
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [],
        recoverCandidates: [recoverCandidate]
      })
    });

    assert.strictEqual(result.action, 'context');
    assert.strictEqual(result.reason, 'recover-latest-context');
    assert.strictEqual(result.candidate.rootSessionId, 'root-4');
  });

  await test('Resolve launch target throws for resume-latest when no matching roots exist', async () => {
    await assert.rejects(
      () => resolveManagedRootLaunchTarget({
        adapter: 'codex-cli',
        resumeLatest: true
      }, {
        listManagedRootLaunchCandidates: async () => ({
          resumeCandidates: [],
          recoverCandidates: []
        })
      }),
      /No resumable managed roots found/
    );
  });

  await test('Resolve launch target respects interactive selection and new-root fallback', async () => {
    const candidate = {
      rootSessionId: 'root-1',
      terminalId: 'term-1',
      sessionName: 'cliagents-root1',
      adapter: 'codex-cli',
      status: 'idle',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:123',
       launchAction: 'resume',
      consoleUrl: 'http://127.0.0.1:4001/console?root=root-1&terminal=term-1',
      attachCommand: 'tmux attach -t "cliagents-root1"'
    };

    const recoverCandidate = {
      rootSessionId: 'root-2',
      terminalId: 'term-2',
      sessionName: 'cliagents-root2',
      adapter: 'codex-cli',
      status: 'needs_attention',
      workDir: '/tmp/project',
      externalSessionRef: 'codex:managed:456',
      launchAction: 'recover',
      recoveryReason: 'provider-exited',
      consoleUrl: 'http://127.0.0.1:4001/console?root=root-2&terminal=term-2',
      attachCommand: 'tmux attach -t "cliagents-root2"'
    };

    const resumed = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project'
    }, {
      interactive: true,
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [candidate],
        recoverCandidates: [recoverCandidate]
      }),
      promptForManagedRootSelection: async () => candidate
    });
    assert.strictEqual(resumed.action, 'resume');

    const recovered = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project'
    }, {
      interactive: true,
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [candidate],
        recoverCandidates: [recoverCandidate]
      }),
      promptForManagedRootSelection: async () => recoverCandidate
    });
    assert.strictEqual(recovered.action, 'context');

    const fresh = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project'
    }, {
      interactive: true,
      listManagedRootLaunchCandidates: async () => ({
        resumeCandidates: [candidate],
        recoverCandidates: []
      }),
      promptForManagedRootSelection: async () => null
    });
    assert.strictEqual(fresh.action, 'launch');
    assert.strictEqual(fresh.reason, 'interactive-new-root');
  });

  await test('Interactive fresh Codex launch defaults to native provider resume picker', async () => {
    const launchOptions = parseLaunchArgs(['codex']);
    const launchTarget = {
      action: 'launch',
      reason: 'interactive-new-root'
    };

    assert.strictEqual(
      shouldDefaultCodexProviderResumePicker(launchOptions, launchTarget, { interactive: true }),
      true
    );

    const defaulted = applyCodexProviderResumePickerDefault(launchOptions, launchTarget, { interactive: true });
    assert.strictEqual(defaulted.providerResumePicker, true);
    assert.strictEqual(defaulted.providerResumePickerDefaulted, true);

    const nonInteractive = applyCodexProviderResumePickerDefault(launchOptions, launchTarget, { interactive: false });
    assert.strictEqual(nonInteractive.providerResumePicker, false);

    const freshProvider = applyCodexProviderResumePickerDefault(
      parseLaunchArgs(['codex', '--fresh-provider-session']),
      launchTarget,
      { interactive: true }
    );
    assert.strictEqual(freshProvider.providerResumePicker, false);

    const attachedRoot = applyCodexProviderResumePickerDefault(
      launchOptions,
      { action: 'resume', reason: 'interactive-selection' },
      { interactive: true }
    );
    assert.strictEqual(attachedRoot.providerResumePicker, false);
  });

  await test('Context launch options carry root memory and preserve sticky identity', async () => {
    const candidate = {
      rootSessionId: 'root-stale',
      terminalId: 'term-stale',
      adapter: 'codex-cli',
      status: 'needs_attention',
      workDir: '/tmp/project',
      model: 'o4-mini',
      externalSessionRef: 'codex:managed:stale',
      recoveryCapability: 'context_resume',
      latestSummary: 'Finish the persistence repair work.'
    };
    const launchOptions = {
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      model: 'o4-mini',
      modelExplicit: true,
      profile: 'guarded-root',
      profileExplicit: false,
      permissionMode: null,
      permissionModeExplicit: false,
      systemPrompt: 'Stay concise.'
    };

    const contextOptions = await buildManagedRootContextLaunchOptions(launchOptions, candidate, {
      async callCliagentsJson(route) {
        if (route.startsWith('/orchestration/memory/bundle/root-stale')) {
          return {
            brief: 'The root was stabilizing persistence and resume behavior.',
            keyDecisions: ['Use context resume for dead roots'],
            pendingItems: ['Run the focused tests'],
            rawPointers: { runIds: ['run-1', 'run-2'] },
            isStale: false
          };
        }
        if (route.startsWith('/orchestration/memory/messages?root_session_id=root-stale')) {
          return {
            messages: [
              { role: 'user', content: 'Finish the resume fix.' },
              { role: 'assistant', content: 'Working through the broker semantics now.' }
            ]
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    });

    assert.strictEqual(contextOptions.externalSessionRef, 'codex:managed:stale');
    assert.strictEqual(contextOptions.sessionMetadata.resumeMode, 'context');
    assert.strictEqual(contextOptions.sessionMetadata.previousRootSessionId, 'root-stale');
    assert.strictEqual(contextOptions.sessionMetadata.carriedContextMessageCount, 2);
    assert.deepStrictEqual(contextOptions.sessionMetadata.carriedContextRunIds, ['run-1', 'run-2']);
    assert(contextOptions.systemPrompt.includes('Use context resume for dead roots'));
    assert(contextOptions.systemPrompt.includes('Finish the resume fix.'));
    assert(contextOptions.systemPrompt.includes('Additional operator instructions'));
  });

  await test('Recovery launch options preserve root lineage and external session ref', async () => {
    const candidate = buildManagedRootLaunchCandidate({
      rootSessionId: 'root-stale',
      originClient: 'codex',
      status: 'needs_attention'
    }, buildManagedSnapshot({
      rootSession: {
        sessionId: 'root-stale',
        adapter: 'codex-cli',
        originClient: 'codex',
        status: 'needs_attention',
        model: 'o4-mini',
        sessionMetadata: {
          managedLaunch: true,
          attachMode: 'managed-root-launch',
          launchProfile: 'supervised-root'
        },
        externalSessionRef: 'codex:managed:stale'
      },
      terminals: [{
        terminal_id: 'term-stale',
        session_name: 'cliagents-stale',
        window_name: 'codex-cli-stale',
        adapter: 'codex-cli',
        role: 'main',
        session_kind: 'main',
        status: 'idle',
        process_state: 'alive',
        current_command: 'zsh',
        work_dir: '/tmp/project',
        root_session_id: 'root-stale',
        external_session_ref: 'codex:managed:stale'
      }]
    }), {
      adapter: 'codex',
      workDir: '/tmp/project'
    });

    const launchOptions = parseLaunchArgs(['codex']);
    const recovered = buildManagedRootRecoveryLaunchOptions(launchOptions, candidate);

    assert.strictEqual(recovered.profile, 'supervised-root');
    assert.strictEqual(recovered.model, 'o4-mini');
    assert.strictEqual(recovered.externalSessionRef, 'codex:managed:stale');
    assert.strictEqual(recovered.sessionMetadata.recoveredManagedRoot, true);
    assert.strictEqual(recovered.sessionMetadata.recoveredFromRootSessionId, 'root-stale');
    assert.strictEqual(recovered.sessionMetadata.recoveryReason, 'provider-exited');
    assert.strictEqual(recovered.sessionMetadata.providerResumeLatest, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
