# Session Graph Contract

## Purpose

This document defines the identity model for broker-managed sessions.

The current broker already knows how to create terminals and persist runs. The missing contract is how those terminals become a stable session graph that can support:

- managed root sessions
- delegated child sessions
- realtime tree views
- historical replay
- remote operator controls

## Scope

Phase 0 only defines the contract and schema scaffold.

It does not enable:

- automatic tree writes for every workflow
- attach-mode sidecars
- websocket session replay
- UI session-tree rendering as the authoritative source of truth

## Canonical Session Identity

Phase 0 uses the existing `terminals.terminal_id` as the canonical session identifier.

Rules:

- `session_id` is an alias for `terminal_id`
- no second independent session identifier should be introduced
- future APIs may expose `sessionId`, but it must map directly to `terminal_id`

This avoids a split-brain model where transport code speaks in terminal IDs while the control plane invents a second identity layer.

## Session Graph Fields

The `terminals` table is extended with these control-plane fields:

- `root_session_id`
- `parent_session_id`
- `session_kind`
- `origin_client`
- `external_session_ref`
- `lineage_depth`
- `session_metadata`

### Field semantics

#### `root_session_id`

- identifies the root of the session tree
- for a managed root session, `root_session_id = session_id`
- for a child session, `root_session_id = root session's id`
- for legacy rows, Phase 0 backfill sets `root_session_id = session_id`

#### `parent_session_id`

- direct parent in the session tree
- `NULL` for root sessions
- `NULL` for legacy rows until an explicit parent relationship exists

#### `session_kind`

Allowed Phase 0 values:

- `legacy`
- `main`
- `subagent`
- `reviewer`
- `judge`
- `discussion`
- `workflow`
- `attach`
- `monitor`

Rules:

- existing broker-created rows default to `legacy`
- new managed launch flows will explicitly set a non-legacy kind
- `monitor` is for intentionally supervisory watcher sessions only, not accidental poll loops

#### `origin_client`

Allowed Phase 0 values:

- `legacy`
- `http`
- `mcp`
- `cli`
- `ui`
- `system`
- `attach`

This identifies where the session creation request came from, not which model adapter it uses.

#### `external_session_ref`

- optional provider-specific or client-specific reference
- examples:
  - Codex thread/session id
  - Qwen session id
  - attach-mode external shell ref
- must not replace `session_id`

#### `lineage_depth`

- root sessions must use `0`
- child sessions must use `parent.lineage_depth + 1`
- legacy rows backfill to `0`

#### `session_metadata`

- JSON text for non-indexed extension data
- must not contain canonical identity fields already modeled as columns

## Relationship Rules

### Roots

A root session must satisfy:

- `root_session_id = session_id`
- `parent_session_id IS NULL`
- `lineage_depth = 0`

### Children

A child session must satisfy:

- `root_session_id IS NOT NULL`
- `parent_session_id IS NOT NULL`
- `root_session_id != parent_session_id` only when depth > 1
- `lineage_depth >= 1`

### Legacy rows

Backfilled legacy rows must satisfy:

- `root_session_id = session_id`
- `parent_session_id IS NULL`
- `session_kind = 'legacy'`
- `origin_client = 'legacy'`
- `lineage_depth = 0`

This preserves auditability without pretending old rows had richer semantics than they actually did.

## Backfill Rules

When the scaffold migration lands on an existing database:

1. keep every existing terminal row
2. set `root_session_id = terminal_id`
3. set `session_kind = 'legacy'` when missing
4. set `origin_client = 'legacy'` when missing
5. set `lineage_depth = 0` when missing
6. leave `parent_session_id` and `external_session_ref` as `NULL`

Backfill must be deterministic and idempotent.

## Integrity Rules

Phase 0 uses application-level integrity for session graph relationships.

Reasons:

- terminal rows may be deleted while audit history remains useful
- attach mode and legacy backfill create temporary partial states
- self-referential foreign keys would complicate migration and cleanup without giving strong operational value yet

Required invariants to test in future write paths:

- root sessions self-reference `root_session_id`
- children inherit the correct root
- lineage depth is monotonic
- no cycle is allowed

## Run and Discussion Linkage

The session graph is not a replacement for the run ledger.

Rules:

- runs remain the source of truth for bounded orchestration workflows
- discussions remain the source of truth for bounded discussion history
- session graph identity should allow joining a session to runs/discussions/events, not absorbing those models

## Attach Mode

Attach mode is explicitly secondary.

Rules:

- unmanaged sessions are not auto-discovered
- attach mode must be initiated intentionally
- attached sessions must be labeled `session_kind = 'attach'`
- fidelity limits must be explicit in the UI

## Rollout Flags

Recommended flags:

- `SESSION_GRAPH_WRITES_ENABLED=0|1`
- `SESSION_EVENTS_ENABLED=0|1`
- `SESSION_EVENT_STREAM_ENABLED=0|1`
- `SESSION_TREE_UI_ENABLED=0|1`
- `SESSION_ATTACH_ENABLED=0|1`

Phase 0 only lands the schema scaffold and docs. Feature-flagged writers/readers come later.

## Implementation Gate

Do not treat the session graph as authoritative until:

1. adapter conformance is green
2. root/parent propagation is covered by tests
3. session event ordering and replay contract is defined
4. session graph writes are behind explicit flags
