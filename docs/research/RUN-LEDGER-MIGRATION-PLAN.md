# Run Ledger Migration and Rollout Plan

## Purpose

This document defines how run-ledger schema and route changes are introduced safely.

The goal is to avoid breaking already-working orchestration routes while adding durable persistence.

## Constraints

- Existing routes already work for `gemini-cli`, `codex-cli`, and `qwen-cli`.
- Existing DB already contains:
  - `traces`
  - `spans`
  - `messages`
  - `discussions`
  - shared memory tables
- Migrations must be file-driven.
- Do not rely on shell-escaped inline SQL blobs.

## Migration Style

### Source of truth

- `src/database/schema.sql` remains the schema baseline.
- Versioned migration files should be added under a new directory:
  - `src/database/migrations/`

### Migration execution

The DB layer should:

1. create a migration tracking table if missing
2. apply unapplied migration files in lexical order
3. wrap each migration in a transaction where SQLite permits
4. stop on first failure
5. record applied migration version and timestamp

### Required metadata table

- `schema_migrations`
  - `version`
  - `applied_at`
  - `checksum`

## Rollout Flags

Initial rollout must be feature-flagged.

Recommended flags:

- `RUN_LEDGER_ENABLED=0|1`
- `RUN_LEDGER_READS_ENABLED=0|1`
- `RUN_LEDGER_UI_ENABLED=0|1`

### Meaning

- `RUN_LEDGER_ENABLED`
  - enable write path from orchestration routes into ledger tables
- `RUN_LEDGER_READS_ENABLED`
  - enable `GET /orchestration/runs*`
- `RUN_LEDGER_UI_ENABLED`
  - expose the UI pages that depend on run APIs

## Rollout Stages

### Stage 0: Contracts only

- write Phase 0 docs
- no schema changes
- no route changes

### Stage 1: Schema landed, writes disabled

- apply migrations
- ledger tables exist
- route behavior unchanged
- no writes to new tables in normal execution

Success gate:

- migrations apply cleanly on existing local DB
- server still starts
- current orchestration tests still pass

### Stage 2: Dual-write enabled

- `RUN_LEDGER_ENABLED=1`
- routes continue normal behavior
- routes also write ledger records
- reads still treated as internal/testing only

Success gate:

- route responses unchanged except optional `runId`
- write-path failures do not silently corrupt orchestration response
- consistency checks pass between route response and ledger rows

### Stage 3: Read APIs enabled

- `RUN_LEDGER_READS_ENABLED=1`
- `GET /orchestration/runs`
- `GET /orchestration/runs/:id`

Success gate:

- list/detail APIs are stable
- tests prove `runId` correlation
- p95 query latency stays within target

### Stage 4: UI enabled

- `RUN_LEDGER_UI_ENABLED=1`
- run inspector uses only public run APIs

Success gate:

- UI renders multi-participant runs correctly
- no direct DB coupling in UI

## Rollback Strategy

### If migration application fails

Required behavior:

1. fail startup clearly
2. leave DB in a valid pre-migration state via transaction rollback where possible
3. do not partially enable flags

### If dual-write introduces route regressions

Rollback path:

1. set `RUN_LEDGER_ENABLED=0`
2. keep tables in place
3. continue serving existing route behavior without ledger writes

This is preferred over dropping tables immediately.

### If read APIs are wrong

Rollback path:

1. set `RUN_LEDGER_READS_ENABLED=0`
2. keep writes enabled if data quality is still acceptable
3. repair query layer without touching existing orchestration routes

### If UI is wrong

Rollback path:

1. set `RUN_LEDGER_UI_ENABLED=0`
2. keep read APIs available for testing
3. continue using API/DB verification until UI stabilizes

## Compatibility Rules

1. Existing route contracts should not be broken during Stage 2.
2. Adding `runId` is allowed.
3. Existing decision payloads should remain stable.
4. Existing working tests for non-Claude adapters must remain green.

## Migration Test Requirements

Before enabling dual-write:

1. migration applies on a fresh DB
2. migration applies on an existing populated DB
3. migration preserves:
   - `traces`
   - `spans`
   - `messages`
   - `discussions`
4. migration rollback path is documented and tested
5. startup failure behavior is explicit and non-destructive

## Integrity Validation After Migration

Add an internal validation routine that checks:

- required tables exist
- required indexes exist
- foreign key relationships are valid
- no orphaned run-ledger rows exist
- `schema_migrations` matches expected version set

This should run in tests and be available from an internal diagnostic path before UI rollout.

## Decision on Destructive Rollback

Phase 1 should avoid destructive down-migrations in normal rollback.

Preferred rollback order:

1. disable feature flags
2. preserve data
3. fix forward

Only use a destructive schema rollback if:

- the migration never reached production use
- the data written is disposable
- a backup exists

## Immediate Implementation Sequence

1. add migration runner and `schema_migrations`
2. add run-ledger migration files
3. add integrity validation helpers
4. add dual-write route integration behind flag
5. add read APIs behind flag
6. add UI behind flag

## Implementation Gate

Do not start Stage 2 until:

1. migration application is file-driven
2. rollback behavior is tested
3. flags are wired
4. existing orchestration suites stay green
