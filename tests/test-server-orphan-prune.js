#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { startTestServer, stopTestServer } = require('./helpers/server-harness');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testServerStartupPrunesHistoricalOrphanedTerminals() {
  const rootDir = makeTempDir('cliagents-startup-prune-data-');
  const logDir = makeTempDir('cliagents-startup-prune-logs-');
  const db = new OrchestrationDB({ dataDir: rootDir });

  try {
    db.registerTerminal('old-orphan', 'cliagents-old', 'worker-old', 'codex-cli', null, 'worker', null, null, {
      rootSessionId: 'cliagents-old'
    });
    db.registerTerminal('fresh-orphan', 'cliagents-fresh', 'worker-fresh', 'qwen-cli', null, 'worker', null, null, {
      rootSessionId: 'cliagents-fresh'
    });

    db.db.run(
      "UPDATE terminals SET status = 'orphaned', created_at = datetime('now', '-48 hours') WHERE terminal_id = ?",
      'old-orphan'
    );
    db.db.run(
      "UPDATE terminals SET status = 'orphaned', created_at = datetime('now', '-2 hours') WHERE terminal_id = ?",
      'fresh-orphan'
    );
  } finally {
    db.db.close();
  }

  const serverHandle = await startTestServer({
    orchestration: {
      dataDir: rootDir,
      logDir,
      pruneOrphanedTerminals: true,
      pruneOrphanedTerminalHours: 24,
      pruneOrphanedTerminalLimit: 1000
    }
  });

  try {
    const liveDb = serverHandle.server.orchestration.db;
    assert.strictEqual(liveDb.getTerminal('old-orphan'), undefined, 'old orphan should be pruned on startup');
    assert(liveDb.getTerminal('fresh-orphan'), 'fresh orphan should be retained');

    const events = liveDb.listSessionEvents({ rootSessionId: 'cliagents-old' });
    assert(events.some((e) => e.event_type === 'session_destroyed'), 'session_destroyed event should be emitted before pruning');
    assert(events.length > 0, 'session_events should be preserved after terminal pruning');
  } finally {
    await stopTestServer(serverHandle);
  }
}

async function main() {
  await testServerStartupPrunesHistoricalOrphanedTerminals();
  console.log('test-server-orphan-prune: all assertions passed');
}

main().catch((error) => {
  console.error('test-server-orphan-prune: failed');
  console.error(error);
  process.exit(1);
});
