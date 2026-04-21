# Run Ledger Contract

## Purpose

This document defines the binding contract for the first version of the run ledger.
Schema, APIs, and UI should follow this document rather than inventing behavior ad hoc.

Scope for this pass:

- `consensus`
- `plan-review`
- `pr-review`
- target adapters: `gemini-cli`, `codex-cli`, `qwen-cli`

Other adapters are out of scope for this pass.

## Core Principles

1. The run ledger is the canonical record for orchestration runs.
2. Existing `traces`, `spans`, `messages`, and log files remain supporting telemetry.
3. The ledger must be safe for large outputs and concurrent runs.
4. The ledger must preserve enough data for:
   - API inspection
   - UI comparison
   - retry and recovery
   - debugging
5. The ledger must not assume every payload can be stored in full.

## Canonical Run Kinds

- `consensus`
- `plan-review`
- `pr-review`
- `discussion`
- reserved for later:
  - `implementation-run`
  - `research-run`

## Canonical Failure Classes

- `timeout`
- `auth`
- `rate_limit`
- `process_exit`
- `protocol_parse`
- `tool_error`
- `validation`
- `cancelled`
- `unknown`

These are normalized values. Raw provider errors may be stored in metadata, but not used as the primary classification.

## Request Hash Contract

`message_hash` is a SHA-256 hex digest of a canonical JSON payload.

### Included fields

For all orchestration routes, the canonical hash input includes:

- `kind`
- `workingDirectory`
- normalized user payload:
  - `message` for `consensus`
  - `plan` and `context` for `plan-review`
  - `summary`, `diff`, `testResults`, and `context` for `pr-review`
- normalized participants
- normalized judge
- normalized timeout

### Excluded fields

The hash must not include:

- generated IDs
- timestamps
- retry counts
- heartbeat timestamps
- feature flags
- transient environment state
- trace IDs
- session IDs
- log paths

### Normalization algorithm

1. Build a plain JSON object with only included fields.
2. Use UTF-8 encoding.
3. Recursively sort object keys lexicographically.
4. Preserve array order exactly as supplied.
5. Normalize strings by:
   - converting `\r\n` to `\n`
   - trimming trailing whitespace on each line
   - preserving leading whitespace and internal newlines
6. Serialize with `JSON.stringify()` over the already-sorted structure, with no pretty printing.
7. Hash the resulting UTF-8 byte sequence with SHA-256.
8. Store the lowercase hex digest.

### Required test vectors

Before implementation is considered complete, add test vectors for:

- different object key orderings
- CRLF versus LF
- equivalent whitespace at line ends
- participant array reordering
- missing optional judge
- unicode UTF-8 text

## Payload Storage Policy

The ledger stores both summaries and optionally inline payload bodies.

### General rules

1. Every stored payload gets:
   - `content_sha256`
   - `original_bytes`
   - `storage_mode`
   - `is_truncated`
2. Every payload gets a preview string for UI and API.
3. Full inline storage is best-effort and size-bounded.
4. Oversized payloads degrade to preview-only storage.

### `run_outputs`

- `preview_text` max: `16 KiB`
- inline full text max before compression: `64 KiB`
- compressed storage allowed up to compressed size: `256 KiB`
- if compressed or raw payload exceeds threshold:
  - store preview only
  - store `content_sha256`
  - set `storage_mode = 'preview_only'`
  - set `is_truncated = 1`

### `run_tool_events`

- `preview_text` max: `8 KiB`
- inline args/result max before compression: `32 KiB`
- compressed storage allowed up to compressed size: `128 KiB`
- if payload exceeds threshold:
  - store preview only
  - keep full hash and byte count
  - mark `storage_mode = 'preview_only'`

### Compression

- gzip is the default compression format for inline large payload storage
- metadata must record:
  - `compression = 'gzip' | 'none'`
  - `compressed_bytes`

### Phase 1 retention policy

For the initial implementation:

- run metadata and previews: retained indefinitely
- inline compressed/raw payloads: retained indefinitely
- oversized content: not externalized in Phase 1, preview only

This is intentionally conservative. External archival is deferred until Phase 2+.

## Output and Tool Event Shapes

### `run_outputs`

Each output row should capture:

- `run_id`
- `participant_id`
- `output_kind`
  - `participant_final`
  - `judge_final`
  - `participant_error`
- `preview_text`
- `full_text` or `compressed_blob`
- `content_sha256`
- `original_bytes`
- `storage_mode`
- `is_truncated`
- `metadata`

### `run_tool_events`

Each tool event should capture:

- `run_id`
- `participant_id`
- `step_id`
- `tool_class`
  - `mcp`
  - `cli`
  - `api`
  - `web`
  - `filesystem`
  - `browser`
  - `database`
- `tool_name`
- `idempotency`
  - `idempotent`
  - `side_effectful`
  - `unknown`
- `preview_text`
- `content_sha256`
- `storage_mode`
- `is_truncated`
- `started_at`
- `completed_at`
- `status`
- `metadata`

## Query Contract

The following list queries must remain performant:

- runs by `kind + status + started_at`
- runs by `adapter + started_at`
- participants by `run_id`
- steps by `run_id`
- outputs by `participant_id`
- tool events by `run_id` and `participant_id`

Target:

- p95 `GET /orchestration/runs` under `10k` runs: under `150 ms`
- p95 `GET /orchestration/runs/:id`: under `300 ms`

## Integrity Contract

Before the ledger is treated as canonical, implementation must support integrity checks for:

- orphaned participants
- orphaned steps
- orphaned outputs
- orphaned tool events
- impossible status combinations
- missing finalization timestamps on terminal states
- duplicate step attempt keys

## Route Response Contract

All orchestration routes must eventually return:

- `runId`
- route-specific decision payload
- enough top-level metadata for callers to immediately correlate the response with persisted state

The route response may remain lightweight; the detailed inspection surface belongs to `GET /orchestration/runs/:id`.

## Explicit Non-Goals

This contract does not require in Phase 1:

- external blob storage
- cross-database portability
- retention pruning jobs
- UI-driven raw payload editing

## Implementation Gate

Do not begin schema changes until:

1. canonical hashing test vectors are written
2. storage thresholds are accepted
3. integrity constraints and indexes are named explicitly
