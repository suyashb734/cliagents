# cliagents State Model

This document summarizes the canonical state concepts used by roots, children,
tasks, and assignments.

## Session Kinds

- `main`: human-managed root lane.
- `ephemeral`: bounded child worker. Shell reuse may be allowed, but provider
  conversation state can be reset.
- `collaborator`: named child intended for continued work. Compatible reuse must
  preserve provider thread state.
- `legacy`: unmanaged or pre-control-plane terminal records.

## Terminal Status

- `idle`: ready for input.
- `processing`: currently running work.
- `completed`: latest tracked work finished.
- `waiting_permission`: provider is waiting for approval.
- `waiting_user_answer`: provider is waiting for a human answer.
- `error`: terminal or provider failed.
- `orphaned`: persisted terminal whose tmux backing is missing.

Busy terminals reject new input with `terminal_busy` instead of silently mixing
turns.

## Derived Session State

`sessionState` is derived on read and does not replace raw terminal or API
session status.

- `task`: one of `working`, `needs_input`, `idle`, `completed`, `failed`, or
  `stopped`.
- `liveness`: one of `alive`, `exited`, `orphaned`, `evicted`, or `unknown`.
- `attention`: true when the session needs human action or failure inspection.

`GET /sessions/:sessionId/status` remains lifecycle-focused. `GET
/sessions/:sessionId/peek` returns a bounded read-only operational snapshot with
derived `sessionState`, pending input, active input lease, and optional output
tail. `sessionId` means an API session id for API sessions and a terminal id for
broker-managed terminals.

## Session Control Mode

- `observer`: remote clients may inspect but not deliver input.
- `operator`: normal remote-control mode.
- `exclusive`: marks exclusive operator intent. V1 enforces active input leases
  when a lease exists.

Queued input also records a control mode so mobile/web clients can audit why an
input was deliverable or blocked.

## Terminal Input Lease Status

Terminal input leases are short-lived ownership records around remote input.

- `active`: holder owns the input surface until expiry or release.
- `released`: holder voluntarily released the lease.
- `revoked`: server or operator revoked the lease.
- `expired`: lease timed out without heartbeat.

One terminal can have at most one active lease. Heartbeats extend the lease,
and the server can revoke it to avoid deadlock.

## Terminal Input Queue Status

- `pending`: queued and ready for delivery.
- `held_for_approval`: waiting for explicit operator approval.
- `delivered`: sent through the runtime host.
- `expired`: no longer deliverable.
- `cancelled`: denied or cancelled before delivery.

## Root IO Event Kind

Root IO events are redacted before persistence and ordered per root session.

- `input`: broker-sent or operator-sent input.
- `output`: bounded terminal-log chunk with byte offsets back to the raw log.
- `screen_snapshot`: visible TUI/screen state sample.
- `parsed_message`: best-effort parsed user, assistant, system, or tool turn.
- `tool_event`: tool-call or tool-result metadata when exposed.
- `usage`: provider usage metadata when exposed outside normal usage records.
- `liveness`: heartbeat, blocked, or progress signal.

## Memory Summary Edge

Summary lineage edges connect derived memory to its sources. Edge namespaces are
`structural`, `derivation`, or `execution`; edge kinds are `contains`,
`continues`, `summarizes`, `supersedes`, `derived_from`, `blocks`, and
`unblocks`. Direct cycles are rejected in the persistence helper. Generated run
and root memory snapshots write `derivation/summarizes` edges to the run records
they summarize; repair backfills those edges idempotently for existing
snapshots.

Root memory bundles do not require a completed run. When a native or
human-managed root only has root IO, parsed messages, session events, or usage,
the bundle falls back to those durable records so supervisors can inspect recent
activity without reading raw tmux logs directly.

## Task Status

Task status is derived from assignment state:

- `pending`: no assignments.
- `blocked`: at least one effective assignment is blocked.
- `running`: at least one effective assignment is running and none are blocked.
- `failed`: at least one assignment failed and none are blocked or running.
- `completed`: all assignments are terminal and none failed.

## Assignment Status

Assignments store a queue/status hint, but effective status is derived from the
linked terminal when a terminal exists.

- `queued`: not started.
- `running`: linked terminal is processing.
- `blocked`: linked terminal is waiting for permission or a user answer.
- `completed`: linked terminal completed or is idle after tracked work.
- `failed`: linked terminal or launch path failed.

## Assignment Isolation

Assignments may carry `worktreePath` and `worktreeBranch` metadata. When
started, the broker prepares that path before routing execution and records an
`isolation` summary on the assignment payload. Existing registered git
worktrees must be under an allowed worktree root, outside the primary repo, and
already checked out on the requested branch. Missing worktree paths require a
branch and are created with `git worktree add`.

## Room Moderator Readout

Room discussions keep raw discussion runs and optional curated transcript
artifacts as audit records, but each completed room discussion also writes a
broker-native moderator readout into the room turn metadata. The readout records
participant success counts, round success counts, judge status, linked run and
discussion ids, and a compact summary for room list/get/MCP clients.

## Dispatch Boundary

Long-horizon orchestration records work intent before a child run or terminal is
spawned. `dispatch_requests` are mutable queue records for queued, claimed,
spawned, deferred, cancelled, or failed work. `run_context_snapshots` are
immutable redacted context packets captured at dispatch time. `task_session_bindings`
are append-only records of the selected adapter, model, effort, runtime, provider
thread, and reuse decision for a task or assignment lane.

Task assignment start now creates this boundary on the existing broker route.
Normal starts create a queued dispatch request, claim it with a conditional
single-row update before worktree preparation/spawn, capture
the redacted assignment prompt and linked task metadata in a context snapshot,
and write a root-scoped task-session binding after the terminal/runtime/provider
decision is known. Duplicate active starts for the same assignment coalesce into
the existing dispatch instead of spawning a second terminal. Future starts can be
deferred; a deferred start leaves the assignment queued and returns `202` with no
route or terminal until a scheduler/operator claims it later. Assignment read
surfaces expose compact dispatch and session-binding summaries, including
dispatch liveness (`queued`, `claimed`, `deferred`, `ready`, `spawned`,
`stale`, or `terminal_missing`) and the broker's next action. Context snapshots
remain durable audit records and are not expanded into every task list response.
The memory read model projects dispatch requests, context snapshots, and
task-session bindings as queryable records with task/root/assignment/terminal
lineage. Task memory bundles include compact dispatch, context-snapshot, and
task-session-binding summaries so operators and external supervisors can inspect
assignment continuity without reconstructing it from raw tables.

Supervisor loops must treat dispatch liveness as part of assignment eligibility:
future deferred dispatches, active queued/claimed dispatches, and stale or
missing-terminal dispatches block duplicate starts. A deferred dispatch whose
liveness is `ready` may be started through the normal assignment-start route.

## Continuity Rule

Compatible child-lane reuse is the default when a delegated task is attached to
a root session. Reuse is compatible only when adapter, model, effort, workdir or
worktree, role, session kind, session label, tool policy, permission mode,
system prompt, and task or assignment scope match.

Broker-owned tmux sessions export `CLIAGENTS_URL`, `CLIAGENTS_DATA_DIR`, and
`CLIAGENTS_LOCAL_API_KEY_FILE` so roots and child agents can call the same broker
without copying the local token into their environment.

Use `reply_to_terminal` for exact continuation of a known child terminal. Use
`delegate_task` for routed bounded work; it should return a reuse decision that
explains whether a compatible terminal was selected or why a new binding was
created. Use `collaborator: true` with a `sessionLabel` only when a named child
should preserve provider continuity.
