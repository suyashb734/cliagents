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

Use `reply_to_terminal` for exact continuation of a known child terminal. Use
`delegate_task` for new bounded work. Use `collaborator: true` with a
`sessionLabel` only when a named child should preserve provider continuity.
