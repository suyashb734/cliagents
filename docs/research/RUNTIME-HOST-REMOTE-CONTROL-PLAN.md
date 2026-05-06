# Runtime Host And Remote Control Plan

## Status

Status: `active-plan`

Last reviewed: `2026-05-06`

Review source: Claude Code architecture review through `cliagents` terminal
`ddc645aa08f0c7a3b9c8fcfbab3be4c4`.

## Objective

Make `cliagents` a remote-capable broker/control plane with multiple runtime
hosts, not a tmux wrapper and not a terminal emulator.

The durable object model stays centered on roots, child sessions, rooms, tasks,
assignments, runs, usage, and memory. Runtime hosts are execution details that
must report into those broker objects.

## Key Decision

Runtime host modeling must come before remote API and UI work.

If remote routes are built directly around tmux concepts, tmux assumptions will
leak into the public API and will be expensive to remove later. The API should
control broker objects and runtime capabilities, not tmux sessions directly.

## Runtime Host Model

Every tracked terminal/root should be representable by:

- `runtime_host`: `tmux`, `adopted`, `direct_pty`, `ssh`, or `container`.
- `runtime_id`: host-specific identifier, opaque to public clients.
- `runtime_capabilities`: supported actions such as `read_output`,
  `send_input`, `resize`, `detach`, `multi_viewer`, `approve_permission`, and
  `stream_events`.
- `workdir`: effective working directory.
- `adapter`: provider CLI adapter.
- `model`: selected model when known.
- `effort`: selected reasoning effort when known.
- `provider_session_id`: provider-native resume id when known.
- `status`: normalized broker status.
- `fidelity`: explicit quality label such as `managed`, `adopted-partial`, or
  `native-visible`.

The host abstraction should hide runtime-specific details from MCP, HTTP, and
future web/mobile clients.

## Runtime Split

### tmux Host

Use tmux for broker-owned managed work:

- long-running managed roots
- child workers
- reviewer and judge lanes
- background/autonomous execution
- mobile-steered sessions where control matters more than perfect TUI fidelity

Prefer tmux control mode where practical. It should reduce dependence on raw
`send-keys` and `capture-pane` behavior by exposing more structured tmux events.

### Adopted Host

Use adopted sessions for human-facing native provider CLI sessions.

The user can launch Codex, Claude, OpenCode, or another CLI natively, then
`cliagents` adopts the session for tracking, summary, usage, and limited
steering. This is the fastest path to native UI fidelity without building a
terminal emulator.

Adopted sessions must be labeled clearly. They may have weaker input control,
permission detection, and event completeness than broker-owned tmux sessions.

### Direct PTY Host

Defer direct PTY ownership until broker supervision and event capture are
stronger.

Direct PTY is useful for native-feeling roots controlled by `cliagents`, but it
requires process supervision, reconnect semantics, output capture, resize/input
handling, and concurrent viewer rules. It should not be the first remote branch.

### SSH And Container Hosts

Defer these until the host abstraction, event model, and local remote API are
stable. They are execution-environment extensions, not prerequisites for the
control plane.

## Revised Implementation Order

1. **Runtime Host Model V1**
   - Add runtime host metadata and capability vocabulary.
   - Formalize the existing tmux path as one runtime host.
   - Ensure public surfaces expose broker terms, not tmux-specific terms.

2. **Adopted Native Session Host V1**
   - Add explicit import/adopt flow for externally launched provider sessions.
   - Persist provider session ids, cwd, adapter, model, and fidelity limits.
   - Prefer tracking and inspection first; remote write control can remain
     limited.

3. **Event Normalization V1**
   - Normalize per-adapter events into one broker schema.
   - Include `session_started`, `prompt_submitted`, `tool_started`,
     `tool_completed`, `permission_requested`, `permission_replied`,
     `tokens_reported`, `session_idle`, `session_stopped`, and `session_error`.
   - Document adapter gaps explicitly, especially Codex notification and token
     reporting limits.

4. **Remote API V1**
   - Expose roots, children, rooms, tasks, assignments, usage, and runtime
     status over runtime-neutral HTTP/MCP routes.
   - Bind locally by default.
   - Do not expose raw shell control without auth and audit logging.

5. **Approval, Diff, And Input Queue V1**
   - Add remote-safe approval and denial flows.
   - Add durable input queue states: `pending`, `held_for_approval`,
     `delivered`, `expired`, and `cancelled`.
   - Add session control modes: `observer`, `operator`, and `exclusive`.

6. **Remote Web UI V1**
   - Build a broker dashboard over event streams and inspection APIs.
   - Prioritize task status, diffs, approvals, usage, and summaries over raw
     terminal streaming.

7. **Direct PTY Host V1**
   - Add native-feeling `cliagents`-owned roots only after event capture,
     permissions, and input ownership are stable.

8. **Tunnel V1**
   - Add Cloudflare, Tailscale, or relay guidance after local LAN operation is
     stable.

9. **Container And SSH Hosts**
   - Add isolated and remote execution hosts after the broker runtime model is
     proven locally.

## Remote Control Model

Remote clients should control broker objects, not terminal internals:

- list roots and child sessions
- inspect live status and durable history
- send input only when the session mode allows it
- approve or deny blocked actions
- inspect diffs and pending work
- view task, assignment, room, run, memory, and usage state

Terminal output streaming is one view. It is not the core abstraction.

## Hidden Risks

- Event normalization will stay adapter-specific and needs ongoing tests.
- Permission detection is only as reliable as the provider's emitted events.
- Concurrent local and remote input can corrupt a session without explicit
  session modes.
- Token attribution will be incomplete where provider CLIs do not emit usage.
- Resume semantics belong to adapters, not runtime hosts.
- Adopted sessions must not be advertised as fully broker-owned.

## Explicit Non-Goals

- Build a terminal emulator or PTY renderer.
- Replace tmux immediately.
- Build a rich broker TUI separate from the web/mobile control surface.
- Build tunnel/relay infrastructure before local remote control works.
- Own Docker, Podman, or SSH lifecycle beyond launching into those hosts later.
- Promise perfect tracking for arbitrary unmanaged sessions.

## Acceptance Criteria

- A runtime host contract exists and is documented before remote API changes.
- Existing tmux-backed managed roots are represented through the runtime host
  model without behavior regression.
- Adopted sessions are visibly distinct from broker-owned managed sessions.
- Public remote-facing routes use runtime-neutral concepts.
- Event normalization has adapter-specific tests or documented gaps.
- Remote input and approval flows have explicit state transitions.
- Docs clearly state that tmux remains the near-term default for controllable
  background and mobile-steered work.

## Milestone 1 Execution Brief

Implement Runtime Host Model V1 as the next remote/control-plane foundation:

- inspect current terminal/root persistence fields
- add a small runtime host vocabulary without changing launch behavior
- map existing tmux sessions into the new shape
- expose runtime metadata in read-only inspection surfaces
- add focused tests for runtime metadata and backward compatibility
- do not add remote write controls, web UI, tunnels, or direct PTY ownership in
  this milestone

## Milestone 2 Execution Brief

Implement Adopted Native Session Host V1 as an inspection-first provider-session
import slice:

- model provider-session imports as `runtime_host = adopted`
- expose adopted runtime fidelity and control limitations in HTTP and MCP output
- classify imported provider sessions as adopted roots, not generic attached
  roots
- keep imported provider sessions read-only unless their runtime explicitly
  advertises `send_input`
- make root liveness and resume selection respect runtime capabilities so
  inspect-only imports are not mistaken for live controllable tmux roots
- do not add remote write control, PTY ownership, provider lifecycle management,
  or tunnel support in this milestone

## Milestone 3 Execution Brief

Implement Event Normalization V1 as a runtime-neutral observability read model:

- add a single normalized event contract for broker session events and adapter
  event fixtures
- expose normalized events on session-event replay and root-session snapshots
- include normalization diagnostics so unmapped historical events and adapter
  fidelity gaps are visible instead of silently ignored
- cover Codex, Gemini, Claude, OpenCode, and Qwen fixture shapes without
  depending on live Qwen availability
- document provider-specific gaps, especially Codex notification and token
  reporting limits
- do not add a DB migration, remote input handling, approval state machines,
  web UI, tunnels, or direct PTY ownership in this milestone

## Rejected Alternative

Do not follow Warp by building a native terminal renderer inside `cliagents`.
Warp is a terminal product first. `cliagents` should borrow structured events,
role-aware remote access, and session state machines, while remaining a
provider-neutral orchestration broker.
