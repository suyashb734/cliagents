/**
 * Tests for managed-root launch resume selection.
 *
 * Run: node tests/test-managed-root-launch-resume.js
 */

'use strict';

const assert = require('assert');
const {
  parseLaunchArgs,
  buildManagedRootLaunchCandidate,
  normalizeManagedRootResumeCandidate,
  normalizeManagedRootRecoveryCandidate,
  listManagedRootLaunchCandidates,
  listManagedRootResumeCandidates,
  listManagedRootRecoveryCandidates,
  resolveManagedRootLaunchTarget,
  buildManagedRootRecoveryLaunchOptions
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
    assert.strictEqual(recovered.action, 'recover');

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
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
