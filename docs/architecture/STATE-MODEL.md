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

## Session Control Mode

- `observer`: remote clients may inspect but not deliver input.
- `operator`: normal remote-control mode.
- `exclusive`: marks exclusive operator intent; V1 records it, with lease
  enforcement deferred.

Queued input also records a control mode so mobile/web clients can audit why an
input was deliverable or blocked.

## Terminal Input Queue Status

- `pending`: queued and ready for delivery.
- `held_for_approval`: waiting for explicit operator approval.
- `delivered`: sent through the runtime host.
- `expired`: no longer deliverable.
- `cancelled`: denied or cancelled before delivery.

## Root IO Event Kind

Root IO events are redacted before persistence and ordered per root session.

- `input`: broker-sent or operator-sent input.
- `output`: terminal output chunk with optional log offsets.
- `screen_snapshot`: visible TUI/screen state sample.
- `parsed_message`: best-effort parsed user, assistant, system, or tool turn.
- `tool_event`: tool-call or tool-result metadata when exposed.
- `usage`: provider usage metadata when exposed outside normal usage records.
- `liveness`: heartbeat, blocked, or progress signal.

## Memory Summary Edge

Summary lineage edges connect derived memory to its sources. Edge namespaces are
`structural`, `derivation`, or `execution`; edge kinds are `contains`,
`continues`, `summarizes`, `supersedes`, `derived_from`, `blocks`, and
`unblocks`. Direct cycles are rejected in the persistence helper.

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

## Continuity Rule

Compatible child-lane reuse is the default when a delegated task is attached to
a root session. Reuse is compatible only when adapter, model, effort, workdir or
worktree, role, session kind, session label, tool policy, permission mode,
system prompt, and task or assignment scope match.

Use `reply_to_terminal` for exact continuation of a known child terminal. Use
`delegate_task` for routed bounded work; it should return a reuse decision that
explains whether a compatible terminal was selected or why a new binding was
created. Use `collaborator: true` with a `sessionLabel` only when a named child
should preserve provider continuity.
