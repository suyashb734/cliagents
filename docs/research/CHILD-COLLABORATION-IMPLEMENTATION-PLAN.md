# Child Collaboration Implementation Plan

## Status

Decision status: `approved-for-execution`

This plan turns the current root/child discussion into a concrete execution path.
It is narrower than the full session-control-plane roadmap. The purpose here is
to make child sessions reliable enough for real collaborative coding before
expanding UI and remote supervision further.

## Problem Statement

`cliagents` currently has the beginnings of child-session reuse, but it mixes two
different behaviors under one mental model:

- ephemeral workers for bounded delegated tasks
- long-lived collaborator children for multi-turn back-and-forth work

Today, `sessionLabel` and terminal reuse make this look like a collaborator
feature, but the implementation mostly reuses the shell process while resetting
provider conversation state for non-root sessions. That is useful for startup
latency, but it is not the same as preserving AI conversation continuity.

This mismatch creates confusion in three places:

1. roots cannot reliably know which child sessions are available to continue
2. `delegate_task` can reuse a terminal without continuing the same AI
   conversation
3. `reply_to_terminal` is the actual continuity mechanism, but it is not the
   primary mental model exposed to roots

## Final Architecture Direction

`cliagents` remains the control plane.

It should explicitly support three session kinds:

- `main`
  Interactive root launched or attached through `cliagents`
- `ephemeral`
  Fire-and-forget delegated child optimized for bounded work
- `collaborator`
  Named, reusable child that preserves provider continuity and is intended for
  ongoing back-and-forth collaboration with the root

The core rule is:

- ephemeral reuse may recycle the shell process and reset provider state
- collaborator reuse must preserve provider state and continue the same AI
  conversation

## Out Of Scope

This plan does not attempt to:

- scrape unmanaged terminals with perfect fidelity
- solve the full browser/mobile supervision UI in the same phase
- make every adapter use the same transport immediately
- replace roots with direct subprocess execution

## Current Implementation Facts

These observations come from the current code and tests:

- MCP `delegate_task` already routes through attached root context
- child reuse already exists and is keyed by root session plus reuse signature
- `reply_to_terminal` already targets the existing child terminal by `terminalId`
- reuse of non-root sessions currently resets provider state in the general case
- Claude has stronger pre-send provider-thread synchronization than the other
  child adapters
- roots are told to use `delegate_task`, `run_workflow`, and
  `get_root_session_status`, but there is no clean child enumeration tool

## Phase 1: Make Current Semantics Explicit

Priority: highest

Goal:
Expose the current model clearly and remove the most immediate supervision gaps
without changing reuse semantics yet.

### Deliverables

1. Add `list_child_sessions` MCP tool
   Return child sessions for the current root with:
   - `terminalId`
   - `sessionLabel`
   - `sessionKind`
   - `adapter`
   - `status`
   - `lastActive`
   - `providerThreadRefPresent`

   Implementation requirement:
   - this must be DB-backed rather than in-memory only
   - the route should use `db.listTerminals({ rootSessionId })` semantics so it
     still works after a broker restart

2. Add an HTTP route for root child enumeration
   Recommended shape:
   - `GET /orchestration/root-sessions/:rootSessionId/children`

3. Guard `sendInput` on busy terminals
   If a terminal is `PROCESSING`, do one of:
   - reject with a clear error and retry hint
   - or queue explicitly with visible state

   Default recommendation for the first implementation:
   reject rather than queue

   Required behavior for the first implementation:
   - HTTP status: `409`
   - error code: `terminal_busy`
   - implementation sites:
     - `sendInput()` in `src/tmux/session-manager.js`
     - `POST /orchestration/terminals/:id/input` in
       `src/server/orchestration-router.js`

4. Fix `sessionLabel` documentation and user-facing text
   Current semantics must be stated accurately:
   - it is stable shell reuse today
   - it is not guaranteed conversation continuity today
   - `reply_to_terminal` is the continuity primitive today

5. Update managed-root bootstrap instructions
   Root sessions should be told:
   - how to enumerate children
   - how to continue a child
   - when to use `delegate_task` versus `reply_to_terminal`

   Primary implementation site:
   - `src/orchestration/managed-root-launch.js`

### Acceptance Criteria

- a root can list all its current child terminals after an LLM context reset
- the same child enumeration still works after a broker restart because it is
  backed by persisted terminal records
- the list includes enough metadata for a human or root agent to choose a child
  to continue
- sending a follow-up into a still-running child does not silently corrupt the
  interaction
- docs and tool descriptions no longer imply that `sessionLabel` preserves AI
  continuity when it does not

### Test Gates

Add or update tests for:

- MCP `list_child_sessions`
- root child enumeration HTTP route
- `sendInput` rejected while `PROCESSING`
- managed-root bootstrap prompt mentions child enumeration and reply flow

Existing tests that must continue to pass:

- [tests/test-session-reuse.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-session-reuse.js)
- [tests/test-task-router-session-reuse.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-task-router-session-reuse.js)
- [tests/test-mcp-root-session-tools.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-root-session-tools.js)
- [tests/test-session-control-plane-runtime.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-session-control-plane-runtime.js)

## Phase 2: Introduce True Collaborator Children

Priority: highest after Phase 1

Goal:
Make long-lived collaborator children first-class rather than implied through
`sessionLabel`.

### Deliverables

1. Add `collaborator` session kind
   Extend:
   - session-kind derivation
   - reuse context/signature
   - root/session tree reporting

2. Split reuse behavior into two explicit paths
   Recommended structure:

```js
_reuseTerminalFresh(terminal, options)
_reuseTerminalContinue(terminal, options)
```

Behavior:

- fresh reuse
  - resets `providerThreadRef`
  - resets `messageCount`
  - keeps shell reuse benefits
- continue reuse
  - preserves `providerThreadRef`
  - preserves `messageCount`
  - preserves AI conversation continuity

3. Extend MCP `delegate_task`
   Add a `collaborator` boolean.

   If `collaborator: true`:
   - `sessionLabel` is required
   - session kind becomes `collaborator`
   - reuse of same label under same root uses continue semantics
   - `delegate_task` and `reply_to_terminal` both continue the same child

   Required implementation sites:
   - `src/mcp/cliagents-mcp-server.js`
   - `src/server/orchestration-router.js`
   - `src/orchestration/task-router.js`
   - `src/tmux/session-manager.js`
   - `deriveControlPlaneSessionKind(...)` must recognize `collaborator` as a
     first-class value rather than falling back to `subagent`

4. Preserve explicit `reply_to_terminal`
   This remains valid even after collaborator mode exists.
   It should be treated as the exact-target continuation API.

5. Strengthen provider-thread sync parity across adapters
   Before a follow-up send, every multi-turn adapter should refresh
   `providerThreadRef` from recent output if possible.

### Acceptance Criteria

- two calls to `delegate_task(... collaborator=true, sessionLabel=\"arch\" ...)`
  under the same root continue the same child conversation
- the collaborator child keeps the same `terminalId`
- after the first collaborator turn, `providerThreadRef` is present
- on the second collaborator turn, the generated one-shot command contains the
  adapter-specific resume flag with the preserved provider thread/session id
- `reply_to_terminal` and collaborator reuse have identical continuation
  semantics
- ephemeral workers still start fresh on reuse
- roots can inspect whether a child is ephemeral or collaborator

### Test Gates

Add or update tests for:

- collaborator child created on first `delegate_task`
- collaborator child reused on same `sessionLabel`
- provider thread preserved across collaborator reuse
- ephemeral child resets provider state on reuse
- `reply_to_terminal` and collaborator `delegate_task` produce equivalent resume
  commands
- non-Claude adapters resync provider-thread references before follow-up sends

## Phase 3: Tighten Adapter Reliability For Child Continuity

Priority: medium-high

Goal:
Make collaborator continuity real across the active adapter surface, not just in
the session manager abstraction.

### Deliverables

1. Run and enforce the child reliability matrix from
   [CHILD-ADAPTER-RELIABILITY.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/CHILD-ADAPTER-RELIABILITY.md)

2. Raise the required bar for collaborator-ready adapters
   To be considered collaborator-ready, an adapter must pass:
   - `route_launch`
   - `root_attachment`
   - `first_output`
   - `followup_input`
   - `session_continuity`

3. Gate collaborator mode per adapter if necessary
   If an adapter cannot yet preserve continuity reliably, it should remain:
   - `ephemeral-ready`
   - not `collaborator-ready`

4. Explicitly defer transport refactors
   Moving adapters from tmux-shell injection to direct subprocess execution is
   a separate follow-on plan. It should not block collaborator semantics landing
   first.

### Acceptance Criteria

- each active adapter has an explicit child-session rating
- collaborator mode is only enabled by default for adapters that pass continuity
  checks
- after simulated broker restart, child enumeration still returns the same child
  records for a root
- a collaborator child with known `providerThreadRef` resumes correctly after
  in-memory recovery
- a slow adapter response does not cause the broker to mark a child completed
  before usable output is available

### Test Gates

Mandatory live check:

```bash
node scripts/run-with-supported-node.js tests/test-child-adapter-reliability-live.js
```

Recommended targeted live coverage:

- collaborator follow-up after broker restart
- collaborator follow-up after root context reset
- provider-thread sync from live child output

## Phase 4: Remote Supervision Surfaces

Priority: after Phases 1-3

Goal:
Make the root/child model remotely understandable from browser, tablet, and
phone.

### Deliverables

1. Root-centric child tree in the UI
2. notifications for blocked or waiting children
3. quick switch from root to selected child
4. clear separation between:
   - roots
   - collaborator children
   - ephemeral children

Notes:

- `list_root_sessions` already exists and should be reused rather than rebuilt
- existing settled `subagent` terminals will not be migrated in place to
  `collaborator`; new collaborator requests should create new collaborator
  terminals instead

This phase should build on the stable child model, not invent it.

## Order Of Execution

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 3
4. then UI work from Phase 4

Do not start remote supervision UI work before Phase 1 and Phase 2 land.

## Practical Decision Table

| Use case | API | Session kind | Continuity expected |
|---|---|---|---|
| Quick bounded side task | `delegate_task` | `ephemeral` | no |
| Named long-lived architectural partner | `delegate_task(... collaborator=true, sessionLabel=...)` | `collaborator` | yes |
| Exact follow-up to known child | `reply_to_terminal` | existing child | yes |
| Human-facing primary terminal | managed root launch / root attach | `main` | yes |

## Immediate Next Step

Execute Phase 1 first.

It is the smallest change set that:

- improves supervision immediately
- removes current semantic confusion
- gives the root a way to rediscover and continue child sessions
- prepares the codebase for collaborator-mode implementation without committing
  to transport changes prematurely
