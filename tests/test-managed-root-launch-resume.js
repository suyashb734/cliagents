/**
 * Tests for managed-root launch resume selection.
 *
 * Run: node tests/test-managed-root-launch-resume.js
 */

'use strict';

const assert = require('assert');
const {
  parseLaunchArgs,
  normalizeManagedRootResumeCandidate,
  listManagedRootResumeCandidates,
  resolveManagedRootLaunchTarget
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
      listManagedRootResumeCandidates: async () => [candidate]
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
      consoleUrl: 'http://127.0.0.1:4001/console?root=root-1&terminal=term-1',
      attachCommand: 'tmux attach -t "cliagents-root1"'
    };

    const resumed = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project'
    }, {
      interactive: true,
      listManagedRootResumeCandidates: async () => [candidate],
      promptForManagedRootSelection: async () => candidate
    });
    assert.strictEqual(resumed.action, 'resume');

    const fresh = await resolveManagedRootLaunchTarget({
      adapter: 'codex-cli',
      workDir: '/tmp/project'
    }, {
      interactive: true,
      listManagedRootResumeCandidates: async () => [candidate],
      promptForManagedRootSelection: async () => null
    });
    assert.strictEqual(fresh.action, 'launch');
    assert.strictEqual(fresh.reason, 'interactive-new-root');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
