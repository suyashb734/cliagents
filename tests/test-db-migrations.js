#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { RunLedgerService } = require('../src/orchestration/run-ledger');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMigration(dir, version, sql) {
  fs.writeFileSync(path.join(dir, version), `${sql.trim()}\n`, 'utf8');
}

function copyMigration(sourceDir, targetDir, fileName) {
  fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
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

function runProjectAnchorMigrationRegressionTest() {
  const rootDir = makeTempDir('cliagents-db-project-anchor-migrate-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const limitedMigrationsDir = path.join(rootDir, 'migrations-pre-0013');
  const fullMigrationsDir = path.join(__dirname, '../src/database/migrations');
  fs.mkdirSync(limitedMigrationsDir, { recursive: true });

  try {
    for (const fileName of [
      '0001_run_ledger_core.sql',
      '0002_run_ledger_inputs.sql',
      '0003_session_control_plane_scaffold.sql',
      '0004_terminal_identity_and_adoption.sql',
      '0005_usage_records.sql',
      '0006_memory_snapshots.sql',
      '0007_resume_linkage_and_recency.sql',
      '0008_provider_sessions_and_rooms.sql',
      '0009_tasks_v1.sql',
      '0010_task_observability_usage_scope.sql',
      '0011_adapter_readiness_reports.sql',
      '0012_run_blocked_state_and_operator_actions.sql'
    ]) {
      copyMigration(fullMigrationsDir, limitedMigrationsDir, fileName);
    }

    const workspaceRoot = path.join(rootDir, 'workspace-legacy');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const legacyDb = new OrchestrationDB({
      dbPath,
      dataDir: rootDir,
      migrationsDir: limitedMigrationsDir
    });

    try {
      const ledger = new RunLedgerService(legacyDb);

      legacyDb.createTask({
        id: 'task-legacy-project',
        title: 'Legacy Project Task',
        workspaceRoot
      });
      legacyDb.registerTerminal(
        'term-legacy-project',
        'legacy-project-session',
        'legacy-project-window',
        'codex-cli',
        null,
        'worker',
        workspaceRoot,
        null,
        { rootSessionId: 'root-legacy-project' }
      );
      legacyDb.registerTerminal(
        'term-legacy-metadata',
        'legacy-meta-session',
        'legacy-meta-window',
        'codex-cli',
        null,
        'worker',
        null,
        null,
        {
          rootSessionId: 'root-legacy-meta',
          sessionMetadata: { workspaceRoot }
        }
      );
      legacyDb.createRoom({
        id: 'room-legacy-project',
        rootSessionId: 'root-room-legacy-project',
        taskId: 'task-legacy-project',
        title: 'Legacy project room'
      });

      ledger.createRun({
        id: 'run-legacy-project',
        kind: 'discussion',
        status: 'completed',
        inputSummary: 'Legacy project run',
        workingDirectory: workspaceRoot,
        rootSessionId: 'root-legacy-project',
        taskId: 'task-legacy-project',
        startedAt: Date.now() - 5000,
        completedAt: Date.now() - 1000,
        durationMs: 4000
      });

      legacyDb.upsertMemorySnapshot({
        scope: 'run',
        scopeId: 'run-legacy-project',
        runId: 'run-legacy-project',
        rootSessionId: 'root-legacy-project',
        taskId: 'task-legacy-project',
        brief: 'Legacy run snapshot',
        generationTrigger: 'repair'
      });

      legacyDb.addUsageRecord({
        terminalId: 'term-legacy-project',
        rootSessionId: 'root-legacy-project',
        runId: 'run-legacy-project',
        taskId: 'task-legacy-project',
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        createdAt: Date.now()
      });
    } finally {
      legacyDb.close();
    }

    const migratedDb = new OrchestrationDB({
      dbPath,
      dataDir: rootDir,
      migrationsDir: fullMigrationsDir
    });

    try {
      const projectColumns = migratedDb.db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name);
      assert.deepStrictEqual(
        projectColumns,
        ['id', 'workspace_root', 'metadata', 'created_at', 'updated_at'],
        'projects table should use the Phase 1 anchor schema'
      );

      const projects = migratedDb.listProjects();
      assert.strictEqual(projects.length, 1, 'migration should backfill one project anchor');
      assert.strictEqual(projects[0].workspaceRoot, fs.realpathSync(workspaceRoot));

      const projectId = projects[0].id;
      assert.strictEqual(migratedDb.getTask('task-legacy-project').projectId, projectId);
      assert.strictEqual(migratedDb.getRunById('run-legacy-project').projectId, projectId);
      assert.strictEqual(migratedDb.getRoom('room-legacy-project').projectId, projectId);
      assert.strictEqual(migratedDb.getMemorySnapshot('run', 'run-legacy-project').projectId, projectId);
      assert.strictEqual(migratedDb.listUsageRecords({ runId: 'run-legacy-project' })[0].projectId, projectId);
      assert.strictEqual(migratedDb.getTerminal('term-legacy-project').project_id, projectId);
      assert.strictEqual(migratedDb.getTerminal('term-legacy-metadata').project_id, projectId);

      const rerun = migratedDb.repairProjectAnchors();
      assert.deepStrictEqual(
        rerun,
        {
          projectsCreated: 0,
          taskProjectsLinked: 0,
          runProjectsLinked: 0,
          roomProjectsLinked: 0,
          usageProjectsLinked: 0,
          memorySnapshotProjectsLinked: 0,
          terminalProjectsLinked: 0
        },
        'Phase 1 project repair should be idempotent after migration backfill'
      );
    } finally {
      migratedDb.close();
    }

    console.log('✅ Phase 1 migration backfills project anchors safely for migrated databases');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function runProjectAnchorRepairAndDiagnosticsTest() {
  const rootDir = makeTempDir('cliagents-db-project-anchor-diagnostics-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });

  try {
    const ledger = new RunLedgerService(db);
    const workspaceRoot = path.join(rootDir, 'workspace-known');
    const conflictingWorkspaceRoot = path.join(rootDir, 'workspace-conflict');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(conflictingWorkspaceRoot, { recursive: true });

    db.createTask({
      id: 'task-project-recoverable',
      title: 'Recoverable Project Task',
      workspaceRoot
    });
    db.createTask({
      id: 'task-project-unknown',
      title: 'Unknown Project Task'
    });

    db.registerTerminal(
      'term-root-known',
      'root-known-session',
      'root-known-window',
      'codex-cli',
      null,
      'worker',
      workspaceRoot,
      null,
      { rootSessionId: 'root-known' }
    );
    db.registerTerminal(
      'term-root-conflict',
      'root-conflict-session',
      'root-conflict-window',
      'codex-cli',
      null,
      'worker',
      workspaceRoot,
      null,
      {
        rootSessionId: 'root-conflict',
        sessionMetadata: { workspaceRoot: conflictingWorkspaceRoot }
      }
    );

    ledger.createRun({
      id: 'run-root-recoverable',
      kind: 'discussion',
      status: 'completed',
      inputSummary: 'Recoverable root linkage',
      workingDirectory: workspaceRoot,
      taskId: 'task-project-recoverable',
      startedAt: Date.now() - 4000,
      completedAt: Date.now() - 1000,
      durationMs: 3000
    });
    ledger.createRun({
      id: 'run-root-unknown',
      kind: 'discussion',
      status: 'completed',
      inputSummary: 'Unknown root linkage',
      startedAt: Date.now() - 3000,
      completedAt: Date.now() - 500,
      durationMs: 2500
    });
    db.addSessionEvent({
      rootSessionId: 'root-known',
      sessionId: 'root-known',
      runId: 'run-root-recoverable',
      eventType: 'session_started',
      idempotencyKey: 'recoverable-run-root-link'
    });

    db.createRoom({
      id: 'room-project-recoverable',
      rootSessionId: 'root-room-known',
      taskId: 'task-project-recoverable',
      title: 'Recoverable room'
    });
    db.createRoom({
      id: 'room-project-unknown',
      rootSessionId: 'root-room-unknown',
      title: 'Unknown room'
    });

    db.upsertMemorySnapshot({
      scope: 'run',
      scopeId: 'run-root-recoverable',
      runId: 'run-root-recoverable',
      taskId: 'task-project-recoverable',
      brief: 'Recoverable run snapshot',
      generationTrigger: 'repair'
    });
    db.db.prepare(`
      UPDATE memory_snapshots
      SET project_id = NULL
      WHERE scope = 'run' AND scope_id = 'run-root-recoverable'
    `).run();

    db.db.prepare(`
      INSERT INTO messages (terminal_id, trace_id, root_session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'term-root-known',
      'trace-recoverable-message',
      null,
      'assistant',
      'recoverable root message',
      '{}',
      Date.now()
    );
    db.db.prepare(`
      INSERT INTO messages (terminal_id, trace_id, root_session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'term-root-missing',
      'trace-unknown-message',
      null,
      'assistant',
      'unknown root message',
      '{}',
      Date.now()
    );

    db.addUsageRecord({
      terminalId: 'term-root-known',
      runId: 'run-root-recoverable',
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      createdAt: Date.now()
    });
    db.addUsageRecord({
      terminalId: 'term-root-missing',
      runId: 'run-missing',
      taskId: 'task-missing',
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      createdAt: Date.now()
    });
    db.db.prepare(`
      INSERT INTO usage_records (
        root_session_id,
        terminal_id,
        run_id,
        task_id,
        task_assignment_id,
        participant_id,
        adapter,
        provider,
        model,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_input_tokens,
        total_tokens,
        cost_usd,
        duration_ms,
        source_confidence,
        metadata,
        project_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      null,
      'term-root-known',
      null,
      null,
      null,
      null,
      'codex-cli',
      null,
      null,
      1,
      1,
      0,
      0,
      2,
      null,
      null,
      'unknown',
      '{}',
      'project-missing',
      Date.now()
    );

    const diagnostics = db.getMemoryLinkageDiagnostics({ sampleLimit: 10 });
    assert.strictEqual(diagnostics.rootSessionId.recoverable.runs, 1);
    assert.strictEqual(diagnostics.rootSessionId.unknown.runs, 1);
    assert.strictEqual(diagnostics.rootSessionId.recoverable.messages, 1);
    assert.strictEqual(diagnostics.rootSessionId.unknown.messages, 1);
    assert.strictEqual(diagnostics.rootSessionId.recoverable.usageRecords, 2);
    assert.strictEqual(diagnostics.rootSessionId.unknown.usageRecords, 1);
    assert.strictEqual(diagnostics.taskId.recoverable.usageRecords, 1);
    assert.strictEqual(diagnostics.taskId.unknown.runs, 1);
    assert.strictEqual(diagnostics.taskId.unknown.rooms, 1);
    assert.strictEqual(diagnostics.taskId.unknown.usageRecords, 1);
    assert.strictEqual(diagnostics.projectId.recoverable.tasks, 0);
    assert.strictEqual(diagnostics.projectId.unknown.tasks, 1);
    assert.strictEqual(diagnostics.projectId.recoverable.terminals, 0);
    assert.strictEqual(diagnostics.projectId.unknown.terminals, 1);
    assert.strictEqual(diagnostics.projectId.recoverable.runs, 0);
    assert.strictEqual(diagnostics.projectId.unknown.runs, 1);
    assert.strictEqual(diagnostics.projectId.recoverable.rooms, 0);
    assert.strictEqual(diagnostics.projectId.unknown.rooms, 1);
    assert.strictEqual(diagnostics.projectId.recoverable.usageRecords, 0);
    assert.strictEqual(diagnostics.projectId.unknown.usageRecords, 1);
    assert.strictEqual(diagnostics.projectId.recoverable.memorySnapshots, 1);
    assert.strictEqual(diagnostics.usageLinkage.missingTerminal, 1);
    assert.strictEqual(diagnostics.usageLinkage.missingRun, 1);
    assert.strictEqual(diagnostics.usageLinkage.missingTask, 1);
    assert.strictEqual(diagnostics.usageLinkage.missingProject, 1);

    const repair = db.repairProjectAnchors();
    assert.strictEqual(repair.projectsCreated, 1, 'repair should create the conflicting metadata project only');
    assert.strictEqual(repair.taskProjectsLinked, 0);
    assert.strictEqual(repair.terminalProjectsLinked, 0);
    assert.strictEqual(repair.runProjectsLinked, 0);
    assert.strictEqual(repair.roomProjectsLinked, 0);
    assert.strictEqual(repair.usageProjectsLinked, 1);
    assert.strictEqual(repair.memorySnapshotProjectsLinked, 1);

    const project = db.getTask('task-project-recoverable').projectId;
    assert(project, 'recoverable task should link to a project after repair');
    assert.strictEqual(db.getRunById('run-root-recoverable').projectId, project);
    assert.strictEqual(db.getRoom('room-project-recoverable').projectId, project);
    assert.strictEqual(db.getMemorySnapshot('run', 'run-root-recoverable').projectId, project);
    assert.strictEqual(
      db.listUsageRecords({ runId: 'run-root-recoverable' })[0].projectId,
      project,
      'recoverable usage record should backfill its project link'
    );

    const repairedDiagnostics = db.getMemoryLinkageDiagnostics({ sampleLimit: 10 });
    assert.strictEqual(repairedDiagnostics.projectId.recoverable.tasks, 0);
    assert.strictEqual(repairedDiagnostics.projectId.recoverable.runs, 0);
    assert.strictEqual(repairedDiagnostics.projectId.recoverable.rooms, 0);
    assert.strictEqual(repairedDiagnostics.projectId.recoverable.memorySnapshots, 0);
    assert.strictEqual(repairedDiagnostics.projectId.recoverable.usageRecords, 0);
    assert.strictEqual(repairedDiagnostics.projectId.unknown.tasks, 1);
    assert.strictEqual(repairedDiagnostics.projectId.unknown.runs, 1);

    console.log('✅ Phase 1 diagnostics separate safe backfills from unknown links on fresh databases');
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function runTerminalModelStateMigrationRegressionTest() {
  const rootDir = makeTempDir('cliagents-db-terminal-model-state-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const limitedMigrationsDir = path.join(rootDir, 'migrations-pre-0017');
  const fullMigrationsDir = path.join(__dirname, '../src/database/migrations');
  fs.mkdirSync(limitedMigrationsDir, { recursive: true });

  try {
    for (const fileName of fs.readdirSync(fullMigrationsDir).filter((file) => (
      file.endsWith('.sql') && file < '0017_terminal_requested_effective_models.sql'
    )).sort()) {
      copyMigration(fullMigrationsDir, limitedMigrationsDir, fileName);
    }

    const legacyDb = new OrchestrationDB({
      dbPath,
      dataDir: rootDir,
      migrationsDir: limitedMigrationsDir
    });

    try {
      legacyDb.registerTerminal(
        'term-legacy-model-state',
        'legacy-model-session',
        'legacy-model-window',
        'codex-cli',
        null,
        'worker',
        rootDir,
        null,
        {
          rootSessionId: 'root-legacy-model-state',
          model: 'gpt-5.4'
        }
      );
    } finally {
      legacyDb.close();
    }

    const migratedDb = new OrchestrationDB({
      dbPath,
      dataDir: rootDir,
      migrationsDir: fullMigrationsDir
    });

    try {
      const terminalColumns = migratedDb.db.prepare('PRAGMA table_info(terminals)').all().map((column) => column.name);
      assert(terminalColumns.includes('requested_model'), 'terminals should include requested_model');
      assert(terminalColumns.includes('effective_model'), 'terminals should include effective_model');
      assert(terminalColumns.includes('requested_effort'), 'terminals should include requested_effort');
      assert(terminalColumns.includes('effective_effort'), 'terminals should include effective_effort');
      const assignmentColumns = migratedDb.db.prepare('PRAGMA table_info(task_assignments)').all().map((column) => column.name);
      assert(assignmentColumns.includes('reasoning_effort'), 'task_assignments should include reasoning_effort');

      const legacyTerminal = migratedDb.getTerminal('term-legacy-model-state');
      assert.strictEqual(legacyTerminal.model, 'gpt-5.4');
      assert.strictEqual(legacyTerminal.requested_model, 'gpt-5.4');
      assert.strictEqual(legacyTerminal.effective_model, 'gpt-5.4');

      migratedDb.registerTerminal(
        'term-new-model-state',
        'new-model-session',
        'new-model-window',
        'claude-code',
        null,
        'worker',
        rootDir,
        null,
        {
          rootSessionId: 'root-new-model-state',
          model: 'claude-opus-4-6',
          requestedModel: 'claude-opus-4-7',
          effectiveModel: 'claude-opus-4-6',
          requestedEffort: 'high',
          effectiveEffort: 'high'
        }
      );

      let newTerminal = migratedDb.getTerminal('term-new-model-state');
      assert.strictEqual(newTerminal.model, 'claude-opus-4-6');
      assert.strictEqual(newTerminal.requested_model, 'claude-opus-4-7');
      assert.strictEqual(newTerminal.effective_model, 'claude-opus-4-6');
      assert.strictEqual(newTerminal.requested_effort, 'high');
      assert.strictEqual(newTerminal.effective_effort, 'high');

      migratedDb.touchTerminalMessage('term-new-model-state', {
        model: 'claude-opus-4-7',
        requestedModel: 'claude-opus-4-7',
        effectiveModel: 'claude-opus-4-7',
        requestedEffort: 'xhigh',
        effectiveEffort: 'xhigh',
        timestamp: Date.now()
      });

      newTerminal = migratedDb.getTerminal('term-new-model-state');
      assert.strictEqual(newTerminal.model, 'claude-opus-4-7');
      assert.strictEqual(newTerminal.requested_model, 'claude-opus-4-7');
      assert.strictEqual(newTerminal.effective_model, 'claude-opus-4-7');
      assert.strictEqual(newTerminal.requested_effort, 'xhigh');
      assert.strictEqual(newTerminal.effective_effort, 'xhigh');
    } finally {
      migratedDb.close();
    }

    console.log('✅ Terminal model-state migration backfills and persists requested/effective models');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
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
  runProjectAnchorMigrationRegressionTest();
  runProjectAnchorRepairAndDiagnosticsTest();
  runTerminalModelStateMigrationRegressionTest();
}

try {
  run();
  console.log('\nDB migration tests passed');
} catch (error) {
  console.error('\nDB migration tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
