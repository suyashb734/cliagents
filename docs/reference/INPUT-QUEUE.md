# Terminal Input Queue

Status: `reference`

Last reviewed: `2026-05-07`

## Purpose

The terminal input queue is the remote-safe write path for broker-owned
terminals. It records operator intent before delivery so web, mobile, and MCP
clients can inspect, approve, deny, cancel, or deliver input without sending
untracked raw keystrokes.

## Queue States

- `pending`: ready to deliver when runtime and session-control checks pass.
- `held_for_approval`: recorded but not deliverable until approved.
- `delivered`: sent to the runtime host.
- `expired`: no longer deliverable after `expires_at`.
- `cancelled`: denied or cancelled without delivery.

## Control Modes

- `observer`: read-only. Inputs in this mode cannot be delivered.
- `operator`: normal remote operator mode.
- `exclusive`: reserved for stronger ownership/lease rules later; V1 records
  the mode and otherwise treats it as operator-capable.

## Input Kinds

- `message`: normal terminal input, delivered through `send_input`.
- `approval`: permission approval, delivered as `y` plus Enter when
  `sendSpecialKey` is available.
- `denial`: permission denial, delivered as `n` plus Enter when
  `sendSpecialKey` is available.

Approval and denial delivery requires the runtime to advertise
`approve_permission` or, for older tmux records, `send_input`.

## HTTP Routes

- `POST /orchestration/terminals/:id/input-queue`
- `GET /orchestration/terminals/:id/input-queue`
- `GET /orchestration/input-queue`
- `GET /orchestration/input-queue/:inputId`
- `POST /orchestration/input-queue/:inputId/approve`
- `POST /orchestration/input-queue/:inputId/deny`
- `POST /orchestration/input-queue/:inputId/cancel`
- `POST /orchestration/input-queue/:inputId/deliver`

Direct `/orchestration/terminals/:id/input` remains available for immediate
operator input, but it uses the same runtime capability and session-control
checks as queued delivery.

## MCP Tools

- `enqueue_terminal_input`
- `list_terminal_input_queue`
- `approve_terminal_input`
- `deny_terminal_input`
- `cancel_terminal_input`
- `deliver_terminal_input`

## Non-Goals

- No multi-operator lease protocol in V1.
- No full diff renderer in V1; queue metadata may carry diff references.
- No provider-specific permission parser changes in this slice.
