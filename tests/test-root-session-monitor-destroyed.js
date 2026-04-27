#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { listRootSessionSummaries } = require('../src/orchestration/root-session-monitor');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function run() {
  const rootDir = makeTempDir('cliagents-root-monitor-destroyed-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    db.addSessionEvent({
      rootSessionId: 'destroyed-root',
      sessionId: 'destroyed-root',
      eventType: 'session_started',
      originClient: 'codex',
      idempotencyKey: 'destroyed-root-start',
      payloadJson: {
        sessionKind: 'main',
        adapter: 'codex-cli',
        externalSessionRef: 'codex:managed:destroyed'
      },
      metadata: {
        clientName: 'codex',
        attachMode: 'managed-root-launch',
        externalSessionRef: 'codex:managed:destroyed'
      }
    });

    db.addSessionEvent({
      rootSessionId: 'destroyed-root',
      sessionId: 'destroyed-root',
      eventType: 'session_stale',
      originClient: 'codex',
      idempotencyKey: 'destroyed-root-stale',
      payloadJson: {
        adapter: 'codex-cli',
        status: 'orphaned'
      }
    });

    db.addSessionEvent({
      rootSessionId: 'destroyed-root',
      sessionId: 'destroyed-root',
      eventType: 'session_destroyed',
      originClient: 'codex',
      idempotencyKey: 'destroyed-root-pruned',
      payloadJson: {
        adapter: 'codex-cli',
        status: 'orphaned',
        reason: 'historical-orphan-prune'
      }
    });

    const summaries = listRootSessionSummaries({
      db,
      limit: 10,
      eventLimit: 20,
      terminalLimit: 10,
      statusFilter: 'all'
    });

    const destroyed = summaries.roots.find((root) => root.rootSessionId === 'destroyed-root');
    assert(destroyed, 'expected destroyed root summary');
    assert.strictEqual(destroyed.status, 'completed');
    assert.strictEqual(destroyed.attention.requiresAttention, false);
    assert.strictEqual(destroyed.counts.stale, 0);
    assert.strictEqual(destroyed.live, false);

    console.log('✅ Destroyed roots no longer surface as stale attention');
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
