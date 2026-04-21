# Run Ledger State Machine

## Purpose

This document defines the lifecycle semantics for runs, participants, retries, liveness, and recovery.

Without this contract, the ledger will store facts but not explain what they mean.

## Run State Machine

Canonical run states:

- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`
- `partial`
- `abandoned`

### Definitions

- `pending`
  - run record created
  - no participant has started
- `running`
  - at least one participant or judge is currently active
- `completed`
  - all required work finished successfully
  - final decision present
- `failed`
  - the run cannot produce a valid final result
  - failure is terminal
- `cancelled`
  - the user or system explicitly stopped the run
- `partial`
  - some useful outputs exist, but the planned workflow did not finish cleanly
  - example: reviewer quorum succeeded but judge failed and no safe fallback exists
- `abandoned`
  - run was `running` but lost liveness and no longer has an owning executor

### Allowed transitions

- `pending -> running`
- `running -> completed`
- `running -> failed`
- `running -> cancelled`
- `running -> partial`
- `running -> abandoned`
- `abandoned -> running`
- `abandoned -> failed`
- `abandoned -> cancelled`
- `partial -> running`
- `partial -> failed`
- `partial -> completed`

Disallowed:

- terminal state back to `pending`
- `completed` back to any active state
- `failed` back to `running` without creating a recovery attempt

## Participant State Machine

Canonical participant states:

- `queued`
- `running`
- `completed`
- `failed`
- `retrying`
- `cancelled`
- `abandoned`

### Allowed transitions

- `queued -> running`
- `running -> completed`
- `running -> failed`
- `running -> cancelled`
- `running -> abandoned`
- `failed -> retrying`
- `retrying -> running`
- `abandoned -> retrying`
- `retrying -> failed`
- `retrying -> completed`

## Attempt Model

Each participant execution attempt must have:

- `participant_id`
- `attempt_index`
- `attempt_key`

`attempt_key` format:

`<run_id>:<participant_id>:<attempt_index>`

This key is unique and is the basis for deduplicating writes and linking retries.

## Heartbeat and Liveness

### Heartbeat rules

- active runs write `last_heartbeat_at`
- active participants write `last_heartbeat_at`
- heartbeat interval target: every `15 seconds`

### Lease expiry

A run or participant is considered stale when:

- current time - `last_heartbeat_at` > `90 seconds`

If stale and still marked active:

- participant becomes `abandoned`
- run becomes `abandoned` unless another participant is still healthy

### Zombie-run handling

If a run is `running` but all active participants are stale:

- mark run `abandoned`
- attach `failure_class = 'unknown'` unless a more specific cause is known
- require recovery evaluation before any retry

## Recovery Semantics

### Resumable

A run is `resumable` when:

- status is `abandoned` or `partial`
- at least one step completed successfully
- no unresolved side-effectful tool event is in ambiguous state

### Restart-required

A run is `restart_required` when:

- the ledger does not have a trustworthy checkpoint boundary
- a side-effectful participant died mid-step and completion is unknown
- canonical input or participant set changed

### Retry-safe

A participant attempt is `retry_safe` when:

- failure class is `timeout`, `process_exit`, or `rate_limit`
- no side-effectful tool event was left ambiguous
- no schema or contract mismatch was detected

### Never auto-retry

Do not auto-retry on:

- `auth`
- `validation`
- `protocol_parse` after repeated parse failure
- `tool_error` for side-effectful operations

## Retry Policy

Default automatic retry limits:

- participant auto-retries: `1`
- judge auto-retries: `1`
- run-level auto-recovery attempts: `1`

Backoff guidance:

- `timeout`: fixed `5 seconds`
- `rate_limit`: exponential backoff starting at `10 seconds`
- `process_exit`: fixed `3 seconds`

If the retry budget is exceeded:

- participant becomes `failed`
- run becomes `partial` or `failed` depending on quorum/fallback rules

## Quorum and Result Semantics

### Consensus

- if all participants fail:
  - run `failed`
- if at least one participant succeeds and no judge configured:
  - run may `completed` with participant outputs only
- if participants succeed and judge fails:
  - run is `partial` unless explicit fallback rule exists

### Plan Review / PR Review

- if all reviewers fail:
  - run `failed`
- if reviewers succeed and judge succeeds:
  - run `completed`
- if reviewers succeed and judge fails:
  - fallback aggregated decision allowed
  - run can still be `completed`
  - decision source must be `aggregated-reviewers`

## Step Checkpoints

Ledger writes must occur at these boundaries:

1. run created
2. participant registered
3. participant started
4. participant completed or failed
5. judge started
6. judge completed or failed
7. final run decision written
8. run finalized

These are the only safe recovery boundaries for Phase 1.

## Side-Effect Semantics

Tool events must be classified as:

- `idempotent`
- `side_effectful`
- `unknown`

Recovery rules:

- `idempotent` and `unknown` events may be replayed only when explicitly marked retry-safe
- `side_effectful` events may not be replayed automatically after ambiguous failure

## Recovery Decision Matrix

- `abandoned` + no side effects + checkpoint after participant start:
  - retry participant
- `abandoned` + ambiguous side effect:
  - mark run `restart_required`
- `partial` + judge failed + reviewers complete:
  - use fallback if protocol allows
- `partial` + required participant missing:
  - retry missing participant if retry-safe

## Minimum Telemetry Required

Each active run should record:

- `last_heartbeat_at`
- `current_step`
- `active_participant_count`
- `retry_count`
- `failure_class`

Each participant attempt should record:

- `attempt_index`
- `started_at`
- `last_heartbeat_at`
- `ended_at`
- `failure_class`
- `retry_safe`

## Implementation Gate

Do not implement resume or retry until:

1. state transitions are encoded as tests
2. heartbeat expiry logic is deterministic
3. side-effectful event classification exists in the tool-event model
