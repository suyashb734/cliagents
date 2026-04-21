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

function copyMigration(sourceDir, targetDir, fileName) {
  fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
}

function getColumnNames(db, tableName) {
  return db.db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function getIndexNames(db, tableName) {
  return db.db.prepare(`PRAGMA index_list(${tableName})`).all().map((row) => row.name);
}

function assertContainsAll(actualValues, expectedValues, label) {
  for (const expectedValue of expectedValues) {
    assert(
      actualValues.includes(expectedValue),
      `${label} is missing expected value: ${expectedValue}`
    );
  }
}

function runFreshSchemaAssertions() {
  const rootDir = makeTempDir('cliagents-session-control-plane-fresh-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });

  try {
    const migrations = db.db.prepare(
      'SELECT version FROM schema_migrations ORDER BY version'
    ).all().map((row) => row.version);

    assertContainsAll(
      migrations,
      ['000000000000_schema_baseline', '0001_run_ledger_core.sql', '0002_run_ledger_inputs.sql', '0003_session_control_plane_scaffold.sql'],
      'schema_migrations'
    );

    assertContainsAll(
      getColumnNames(db, 'terminals'),
      ['root_session_id', 'parent_session_id', 'session_kind', 'origin_client', 'external_session_ref', 'lineage_depth', 'session_metadata'],
      'terminals columns'
    );

    assertContainsAll(
      getColumnNames(db, 'session_events'),
      ['id', 'idempotency_key', 'root_session_id', 'session_id', 'event_type', 'sequence_no', 'occurred_at', 'recorded_at'],
      'session_events columns'
    );

    assertContainsAll(
      getIndexNames(db, 'terminals'),
      ['idx_terminals_root_session_id', 'idx_terminals_parent_session_id', 'idx_terminals_session_kind', 'idx_terminals_origin_client'],
      'terminals indexes'
    );

    assertContainsAll(
      getIndexNames(db, 'session_events'),
      ['idx_session_events_idempotency_key', 'idx_session_events_root_sequence', 'idx_session_events_session_id_occurred_at'],
      'session_events indexes'
    );

    db.registerTerminal('term-fresh', 'session-fresh', 'window-0', 'codex-cli', 'architect', 'worker', '/tmp/work', '/tmp/log');
    const terminal = db.getTerminal('term-fresh');
    assert.strictEqual(terminal.root_session_id, 'term-fresh');
    assert.strictEqual(terminal.parent_session_id, null);
    assert.strictEqual(terminal.session_kind, 'legacy');
    assert.strictEqual(terminal.origin_client, 'legacy');
    assert.strictEqual(terminal.lineage_depth, 0);

    console.log('✅ Fresh DB includes session graph scaffold and default terminal metadata');
  } finally {
    db.close();
  }
}

function runPopulatedMigrationAssertions() {
  const rootDir = makeTempDir('cliagents-session-control-plane-existing-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const limitedMigrationsDir = path.join(rootDir, 'migrations-pre-0003');
  const fullMigrationsDir = path.join(__dirname, '../src/database/migrations');
  fs.mkdirSync(limitedMigrationsDir, { recursive: true });

  copyMigration(fullMigrationsDir, limitedMigrationsDir, '0001_run_ledger_core.sql');
  copyMigration(fullMigrationsDir, limitedMigrationsDir, '0002_run_ledger_inputs.sql');

  let db = new OrchestrationDB({
    dbPath,
    dataDir: rootDir,
    migrationsDir: limitedMigrationsDir
  });

  try {
    db.db.run(`
      INSERT INTO terminals (
        terminal_id,
        session_name,
        window_name,
        adapter,
        agent_profile,
        role,
        work_dir,
        log_path
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, 'term-existing', 'session-existing', 'window-0', 'qwen-cli', 'reviewer', 'worker', '/tmp/existing', '/tmp/existing.log');
    const legacyTerminal = db.db.get('SELECT * FROM terminals WHERE terminal_id = ?', 'term-existing');
    assert.strictEqual(legacyTerminal.terminal_id, 'term-existing');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyTerminal, 'root_session_id'), false);
  } finally {
    db.close();
  }

  db = new OrchestrationDB({
    dbPath,
    dataDir: rootDir,
    migrationsDir: fullMigrationsDir
  });

  try {
    const migratedTerminal = db.getTerminal('term-existing');
    assert.strictEqual(migratedTerminal.root_session_id, 'term-existing');
    assert.strictEqual(migratedTerminal.parent_session_id, null);
    assert.strictEqual(migratedTerminal.session_kind, 'legacy');
    assert.strictEqual(migratedTerminal.origin_client, 'legacy');
    assert.strictEqual(migratedTerminal.lineage_depth, 0);

    console.log('✅ Existing terminal rows backfill cleanly through the session control-plane scaffold migration');
  } finally {
    db.close();
  }
}

try {
  runFreshSchemaAssertions();
  runPopulatedMigrationAssertions();
  console.log('\nSession control-plane schema tests passed');
} catch (error) {
  console.error('\nSession control-plane schema tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
