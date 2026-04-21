#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function getTableNames(db) {
  return db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
}

function getIndexNames(db, tableName) {
  return db.db.prepare(`PRAGMA index_list(${tableName})`).all().map((row) => row.name);
}

function getColumnNames(db, tableName) {
  return db.db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function getForeignKeys(db, tableName) {
  return db.db.prepare(`PRAGMA foreign_key_list(${tableName})`).all();
}

function assertContainsAll(actualValues, expectedValues, label) {
  for (const expectedValue of expectedValues) {
    assert(
      actualValues.includes(expectedValue),
      `${label} is missing expected value: ${expectedValue}`
    );
  }
}

function run() {
  const rootDir = makeTempDir('cliagents-run-ledger-schema-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });

  try {
    const migrations = db.db.prepare(
      'SELECT version FROM schema_migrations ORDER BY version'
    ).all().map((row) => row.version);

    assertContainsAll(
      migrations,
      ['000000000000_schema_baseline', '0001_run_ledger_core.sql', '0002_run_ledger_inputs.sql'],
      'schema_migrations'
    );

    const tableNames = getTableNames(db);
    assertContainsAll(
      tableNames,
      ['runs', 'run_participants', 'run_steps', 'run_inputs', 'run_outputs', 'run_tool_events'],
      'table set'
    );

    assertContainsAll(
      getColumnNames(db, 'runs'),
      ['id', 'kind', 'status', 'message_hash', 'started_at', 'last_heartbeat_at'],
      'runs columns'
    );

    assertContainsAll(
      getColumnNames(db, 'run_participants'),
      ['id', 'run_id', 'adapter', 'attempt_key', 'status'],
      'run_participants columns'
    );

    assertContainsAll(
      getColumnNames(db, 'run_steps'),
      ['id', 'run_id', 'participant_id', 'step_key', 'step_name'],
      'run_steps columns'
    );

    assertContainsAll(
      getColumnNames(db, 'run_inputs'),
      ['id', 'run_id', 'participant_id', 'input_kind', 'content_sha256', 'storage_mode'],
      'run_inputs columns'
    );

    assertContainsAll(
      getColumnNames(db, 'run_outputs'),
      ['id', 'run_id', 'participant_id', 'output_kind', 'content_sha256', 'storage_mode'],
      'run_outputs columns'
    );

    assertContainsAll(
      getColumnNames(db, 'run_tool_events'),
      ['id', 'run_id', 'participant_id', 'tool_class', 'tool_name', 'storage_mode'],
      'run_tool_events columns'
    );

    assertContainsAll(
      getIndexNames(db, 'runs'),
      ['idx_runs_kind_status_started_at', 'idx_runs_message_hash'],
      'runs indexes'
    );

    assertContainsAll(
      getIndexNames(db, 'run_participants'),
      ['idx_run_participants_run_id', 'idx_run_participants_adapter_run_id', 'sqlite_autoindex_run_participants_2'],
      'run_participants indexes'
    );

    assertContainsAll(
      getIndexNames(db, 'run_inputs'),
      ['idx_run_inputs_run_id_created_at', 'idx_run_inputs_kind_run_id_created_at'],
      'run_inputs indexes'
    );

    assertContainsAll(
      getIndexNames(db, 'run_steps'),
      ['idx_run_steps_run_id_started_at', 'idx_run_steps_attempt_key'],
      'run_steps indexes'
    );

    const participantFks = getForeignKeys(db, 'run_participants');
    assert(
      participantFks.some((fk) => fk.table === 'runs' && fk.from === 'run_id' && fk.on_delete === 'CASCADE'),
      'run_participants should cascade to runs'
    );

    const inputFks = getForeignKeys(db, 'run_inputs');
    assert(
      inputFks.some((fk) => fk.table === 'runs' && fk.from === 'run_id'),
      'run_inputs should reference runs'
    );
    assert(
      inputFks.some((fk) => fk.table === 'run_participants' && fk.from === 'participant_id'),
      'run_inputs should reference run_participants'
    );

    const outputFks = getForeignKeys(db, 'run_outputs');
    assert(
      outputFks.some((fk) => fk.table === 'runs' && fk.from === 'run_id'),
      'run_outputs should reference runs'
    );
    assert(
      outputFks.some((fk) => fk.table === 'run_participants' && fk.from === 'participant_id'),
      'run_outputs should reference run_participants'
    );

    console.log('✅ Run-ledger migration created expected tables, indexes, and foreign keys');
  } finally {
    db.close();
  }
}

try {
  run();
  console.log('\nRun-ledger schema tests passed');
} catch (error) {
  console.error('\nRun-ledger schema tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
