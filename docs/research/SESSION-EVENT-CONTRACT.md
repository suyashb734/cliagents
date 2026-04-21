# Session Event Contract

## Purpose

This document defines the durable event model for the session control plane.

The event log exists to support:

- realtime operator visibility
- replay after reconnect
- historical debugging
- explanation of how a conclusion was reached

Without an event contract, a session tree is only a snapshot, not an audit trail.

## Scope

Phase 0 adds:

- the event envelope definition
- ordering and idempotency rules
- replay semantics
- a schema scaffold

Phase 0 does not yet enable live event writers or websocket broadcasting by default.

## Canonical Event Envelope

Each event must contain:

- `id`
- `idempotency_key`
- `root_session_id`
- `session_id`
- `parent_session_id`
- `event_type`
- `sequence_no`
- `occurred_at`
- `recorded_at`
- `origin_client`
- `payload_summary`
- `payload_json`
- `metadata`

Optional linkage fields:

- `run_id`
- `discussion_id`
- `trace_id`
- `parent_event_id`

## Event Types

Initial Phase 0 vocabulary:

- `session_started`
- `session_resumed`
- `session_terminated`
- `session_stale`
- `session_destroyed`
- `message_sent`
- `message_received`
- `delegation_started`
- `delegation_completed`
- `discussion_started`
- `discussion_round_started`
- `discussion_round_completed`
- `judge_completed`
- `consensus_recorded`
- `user_input_requested`
- `user_input_received`

Do not expand this list casually. New event types should correspond to meaningful control-plane state transitions, not arbitrary log lines.

## Ordering

Ordering is defined per `root_session_id`.

Rules:

- `sequence_no` must be monotonically increasing within one `root_session_id`
- there is no promise of a single global event order across the whole broker
- consumers must sort by:
  1. `sequence_no`
  2. `occurred_at`
  3. `recorded_at`
  4. `id`

This gives a stable replay order without pretending distributed workflows have a perfect wall-clock ordering.

## Idempotency

Every event must have an `idempotency_key`.

Rules:

- the key must be unique across the table
- retries must reuse the same key for the same semantic event
- replay must not write a second row for an already-recorded key

Recommended key shape:

`<root_session_id>:<session_id>:<event_type>:<stable_attempt_or_step_key>`

The exact builder can evolve, but it must be deterministic for retry-safe re-emission.

## Replay Semantics

Replay is cursor-based, append-only, and supports forward-only traversal.

Rules:

- replay reads ordered events for one `root_session_id`
- consumers should use `after_sequence_no` (cursor-after) to fetch only new events
- replay must never synthesize missing events
- replay consumers must tolerate gaps caused by future write-path bugs by failing explicitly rather than silently fabricating state

## Pruning and Deletion

The event log is a durable audit trail that outlives the ephemeral terminal row.

Rules:

- Pruning or deleting a terminal/session must NOT delete its associated `session_events`
- Before a terminal row is removed, a `session_destroyed` event must be emitted
- The event log remains the "source of truth" for historical analysis after a session is no longer "live"

## Snapshot vs Delta

The event log is a delta stream, not a replacement for snapshot state.

Rules:

- `terminals` remains the current snapshot surface
- `session_events` records transitions and notable messages
- replay reconstructs state from ordered deltas plus current snapshot reconciliation where needed

## Payload Storage

`payload_summary` is the fast path for UI lists and operator dashboards.

`payload_json` is the durable structured body.

Rules:

- keep `payload_summary` short and scan-friendly
- do not store giant raw transcripts as event payloads
- transcripts and final outputs belong in existing message/run-ledger stores

## Event Lineage

`parent_event_id` is optional and used for causal linkage, not ordering.

Examples:

- `message_received` may reference the preceding `message_sent`
- `delegation_completed` may reference `delegation_started`

The canonical order still comes from `root_session_id + sequence_no`.

## Failure and Staleness

Event writing must be able to represent degraded states.

Required behaviors for future writers:

- stale sessions emit `session_stale`
- explicit destruction emits `session_destroyed`
- partial workflows still emit completion-side events for the surviving participants

## Rollout Flags

Recommended flags:

- `SESSION_EVENTS_ENABLED=0|1`
- `SESSION_EVENT_STREAM_ENABLED=0|1`

Writers and websocket readers must be gated independently.

## Schema Requirements

The initial `session_events` table must support:

- unique `idempotency_key`
- unique `(root_session_id, sequence_no)`
- efficient lookup by `session_id`
- efficient lookup by `run_id`
- efficient lookup by `discussion_id`
- efficient time-ordered replay by `root_session_id`

## Implementation Gate

Do not enable event writers until:

1. the session graph schema scaffold exists
2. event ordering tests exist
3. idempotency tests exist
4. replay cursor semantics are specified at the API layer
