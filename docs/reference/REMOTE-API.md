# Remote API

Status: `reference`

Last reviewed: `2026-05-06`

## Purpose

Remote API V1 gives web and mobile clients a runtime-neutral broker view. It is
for inspecting and steering broker objects, not for exposing raw tmux or shell
internals.

## Default Access Model

- The server binds to `127.0.0.1` by default.
- Use `--host 0.0.0.0` or `CLIAGENTS_HOST=0.0.0.0` only when explicitly
  exposing the broker on a LAN or through a tunnel.
- Remote clients should use broker routes and capability checks instead of
  sending raw terminal control.
- Terminal input remains gated by runtime capability. A runtime must advertise
  `send_input` before `/orchestration/terminals/:id/input` accepts input.

## Snapshot Route

`GET /orchestration/remote/snapshot`

Returns a compact read-only snapshot for remote clients:

- `access`: bind host, auth state, local-default flag, and terminal-input mode.
- `capabilities`: supported runtime hosts and broker object groups.
- `routes`: canonical runtime-neutral routes for follow-up inspection.
- `roots`: root summaries with runtime host metadata and attention state.
- `tasks`: first-class task summaries with assignment and usage rollups.
- `rooms`: room summaries with participant, turn, and message counts.
- `usage`: global token totals when `includeUsage` is enabled.

Useful query parameters:

- `rootLimit`, `taskLimit`, `roomLimit`: bound snapshot size.
- `terminalLimit`, `eventLimit`: bound root summary detail scans.
- `includeUsage=0`: omit usage totals.
- `scope`, `status`, `includeArchived`: root summary filters.
- `workspaceRoot`: task workspace filter.
- `roomStatus`: room status filter.

## MCP Surface

The MCP tool `get_remote_snapshot` wraps the HTTP snapshot route and can return
either a compact summary or raw JSON.

Use specific MCP tools for follow-up detail:

- `get_root_session_status`
- `list_child_sessions`
- `list_tasks` / `get_task`
- `list_task_assignments`
- `list_rooms` / `get_room`
- `get_usage_summary`
- `get_memory_bundle`

## Non-Goals

- No tunnel or relay is created in V1.
- No direct PTY or terminal renderer is introduced.
- No remote approval state machine is added here.
- No raw shell control is exposed without runtime capability checks.
