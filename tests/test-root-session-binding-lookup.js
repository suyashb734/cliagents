#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function run() {
  const rootDir = makeTempDir('cliagents-root-binding-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    db.addSessionEvent({
      rootSessionId: 'root-binding-owner',
      sessionId: 'root-binding-owner',
      eventType: 'session_started',
      originClient: 'codex',
      idempotencyKey: 'root-binding-owner:session_started',
      payloadSummary: 'owner root attached',
      payloadJson: {
        attachMode: 'explicit-http-attach',
        externalSessionRef: 'binding-ref-owner',
        clientName: 'codex'
      },
      metadata: {
        clientName: 'codex',
        externalSessionRef: 'binding-ref-owner'
      }
    });

    const ownerBinding = db.findLatestRootSessionByClientRef({
      originClient: 'codex',
      externalSessionRef: 'binding-ref-owner',
      clientName: 'codex'
    });
    assert.strictEqual(ownerBinding.root_session_id, 'root-binding-owner');

    const forgedClientBinding = db.findLatestRootSessionByClientRef({
      originClient: 'codex',
      externalSessionRef: 'binding-ref-owner',
      clientName: 'attacker-codex'
    });
    assert.strictEqual(
      forgedClientBinding,
      null,
      'session-event fallback must not bind an external session ref to a mismatched client name'
    );

    console.log('OK Root session binding lookup rejects forged client-name fallback matches');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Root session binding lookup tests failed:', error);
  process.exit(1);
});
