#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMigration(dir, version, sql) {
  fs.writeFileSync(path.join(dir, version), `${sql.trim()}\n`, 'utf8');
}

function getAppliedVersions(db) {
  return db.db.prepare(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version'
  ).all();
}

function runLegacyMessagesMigrationRegressionTest() {
  const rootDir = makeTempDir('cliagents-db-messages-migration-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const migrationsDir = path.join(rootDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });

  writeMigration(
    migrationsDir,
    '0001_probe.sql',
    `
    CREATE TABLE IF NOT EXISTS migration_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value TEXT NOT NULL
    );
    `
  );

  const db = new OrchestrationDB({
    dbPath,
    dataDir: rootDir,
    migrationsDir
  });

  try {
    db.db.exec(`
      DROP TABLE IF EXISTS messages;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        terminal_id TEXT NOT NULL,
        trace_id TEXT,
        root_session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (terminal_id) REFERENCES terminals(terminal_id) ON DELETE CASCADE
      );
    `);

    db.db.prepare(`
      INSERT INTO terminals (
        terminal_id,
        session_name,
        window_name,
        adapter,
        role,
        work_dir,
        log_path,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-term',
      'legacy-session',
      'legacy-window',
      'codex-cli',
      'worker',
      rootDir,
      null,
      'idle'
    );
    db.db.prepare(`
      INSERT INTO messages (terminal_id, trace_id, root_session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-term',
      'trace-legacy',
      'legacy-root',
      'assistant',
      'legacy message',
      '{}',
      Date.now()
    );

    db._migrateMessagesTableRemoveFK();

    const messageColumns = db.db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name);
    const messagesNewTable = db.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_new'
    `).get();
    const migratedRow = db.db.prepare(`
      SELECT terminal_id, trace_id, root_session_id, role, content
      FROM messages
      WHERE terminal_id = ?
    `).get('legacy-term');

    assert(messageColumns.includes('root_session_id'), 'legacy migration should preserve root_session_id');
    assert.strictEqual(messagesNewTable, undefined, 'legacy migration should not leave a stale messages_new table behind');
    assert.strictEqual(migratedRow.root_session_id, 'legacy-root');
    assert.strictEqual(migratedRow.content, 'legacy message');
    assert.deepStrictEqual(
      db.db.prepare('PRAGMA foreign_key_list(messages)').all(),
      [],
      'legacy migration should remove the terminal foreign key'
    );

    console.log('✅ Legacy messages migration preserves root_session_id and cleans up temp tables');
  } finally {
    db.close();
  }
}

function run() {
  const rootDir = makeTempDir('cliagents-db-migrations-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const migrationsDir = path.join(rootDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });

  writeMigration(
    migrationsDir,
    '0001_create_migration_probe.sql',
    `
    CREATE TABLE IF NOT EXISTS migration_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value TEXT NOT NULL
    );
    `
  );

  writeMigration(
    migrationsDir,
    '0002_seed_migration_probe.sql',
    `
    INSERT INTO migration_probe (value) VALUES ('applied-once');
    `
  );

  let db = new OrchestrationDB({
    dbPath,
    dataDir: rootDir,
    migrationsDir
  });

  try {
    const appliedVersions = getAppliedVersions(db);
    assert.strictEqual(appliedVersions.length, 3, 'Expected baseline plus two SQL migrations');
    assert.strictEqual(appliedVersions[0].version, '000000000000_schema_baseline');
    assert.strictEqual(appliedVersions[1].version, '0001_create_migration_probe.sql');
    assert.strictEqual(appliedVersions[2].version, '0002_seed_migration_probe.sql');

    const seededRows = db.db.prepare('SELECT id, value FROM migration_probe ORDER BY id').all();
    assert.deepStrictEqual(
      seededRows.map((row) => row.value),
      ['applied-once'],
      'Seed migration should execute exactly once'
    );

    console.log('✅ Fresh DB applies baseline and ordered SQL migrations');
  } finally {
    db.close();
  }

  db = new OrchestrationDB({
    dbPath,
    dataDir: rootDir,
    migrationsDir
  });

  try {
    const reappliedRows = db.db.prepare('SELECT id, value FROM migration_probe ORDER BY id').all();
    assert.deepStrictEqual(
      reappliedRows.map((row) => row.value),
      ['applied-once'],
      'Reopening the DB must not rerun applied migrations'
    );

    console.log('✅ Reopening the DB does not rerun applied migrations');
  } finally {
    db.close();
  }

  writeMigration(
    migrationsDir,
    '0002_seed_migration_probe.sql',
    `
    INSERT INTO migration_probe (value) VALUES ('mutated-migration');
    `
  );

  assert.throws(
    () => new OrchestrationDB({ dbPath, dataDir: rootDir, migrationsDir }),
    /checksum mismatch/i,
    'Mutating an applied migration file should fail fast'
  );

  console.log('✅ Checksum mismatch is detected for mutated applied migrations');
  runLegacyMessagesMigrationRegressionTest();
}

try {
  run();
  console.log('\nDB migration tests passed');
} catch (error) {
  console.error('\nDB migration tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
