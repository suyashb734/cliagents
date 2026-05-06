# Session Control Plane Plan

## Status

Review status: `revise`

Current sequencing note: for runtime-host and remote-control execution, use
[Runtime Host And Remote Control Plan](./RUNTIME-HOST-REMOTE-CONTROL-PLAN.md).
That plan supersedes this document's earlier managed-root-first and attach-mode
sequencing. This file remains useful historical context for session graph,
event, and remote UI concerns.

This direction is still correct, but the review consensus is that the plan is not safe to execute as written. The control-plane architecture should proceed only after a Phase 0 foundation is in place.

## Roadmap Position

This plan is subordinate to `CLIAGENTS-BROKER-PLAN.md`.

It is a later-phase expansion plan, not the current top priority.

Before this plan becomes a major execution focus, `cliagents` should first finish:

- adapter conformance and broker reliability
- reference workflow hardening
- run-ledger and run-inspector maturity

If priorities conflict, prefer broker reliability and bounded workflow inspectability over session-tree or remote-workstation expansion.

Reviewer outcome through live `cliagents`:

- `qwen-cli`: `revise`
- `gemini-cli`: `revise`
- `opencode-cli`: completed separately through `cliagents` after the initial inline review timeout and file-path issue
- `codex-cli` judge: `revise`

Consensus summary:

- managed launch is the right model
- passive terminal scraping should stay out of scope
- adapter conformance must be treated as a prerequisite
- schema migration and event semantics need to be explicit before implementation
- rollout needs more gates and feature flags

## Goal

Make `cliagents` the control plane for:

- main interactive agent sessions
- broker-spawned subagents
- multi-agent discussions and consensus
- final decisions and reviewer/judge outputs
- remote monitoring and reply from browser/iPad

The key constraint is simple:

- If a session starts outside `cliagents`, visibility is partial.
- If a session starts through `cliagents`, visibility can be complete.

So the path forward is not generic terminal scraping. It is control-plane ownership.

## Product Boundary

`cliagents` should own:

- session launch
- session identity
- parent/child relationships
- event logging
- discussion and consensus persistence
- remote operator controls

`cliagents` should not try to be:

- a universal terminal sniffer
- a generic OS-wide tmux dashboard
- a passive observer of arbitrary external sessions with perfect fidelity

## Desired Experience

From any client, the user should be able to:

1. launch a main session through `cliagents`
2. see that main session in the UI immediately
3. see all child sessions spawned from it
4. watch discussion rounds, disagreements, and conclusions in realtime
5. inspect the same run later
6. reply to blocked sessions remotely
7. understand which agent produced which conclusion and why

## Phase 0 Prerequisites

Do not implement the control-plane tree/UI first. First make the broker safe to use as a source of truth.

### 0.1 Adapter Conformance

Before any session graph work, define a conformance harness for every active adapter:

- `codex-cli`
- `qwen-cli`
- `gemini-cli`
- `opencode-cli`

Each adapter must pass:

- create session
- send message
- timeout behavior
- termination behavior
- heartbeat behavior
- error classification
- model selection behavior
- working-directory behavior

Reference:

- [ADAPTER-CONFORMANCE.md](/Users/mojave/Documents/AI-projects/cliagents/docs/ADAPTER-CONFORMANCE.md)

This is mandatory because the current broker already has known adapter inconsistencies:

- `gemini-cli` has had inconsistent `/ask` behavior versus direct CLI use
- `opencode-cli` initial review failed in `/ask` because `workingDirectory` was ignored and inline review later timed out

### 0.2 Schema Migration Plan

Before adding session graph fields, define:

- migration files
- backfill rules for old rows
- null/default strategy for legacy sessions
- indexes for `session_id`, `root_session_id`, `parent_session_id`, `run_id`, `discussion_id`
- rollback procedure
- compatibility behavior for existing routes

References:

- [SESSION-GRAPH-CONTRACT.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/SESSION-GRAPH-CONTRACT.md)
- [SESSION-EVENT-CONTRACT.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/SESSION-EVENT-CONTRACT.md)

### 0.3 Event Contract

Before websocket/UI work, define a durable event contract:

- canonical event envelope
- event sequence semantics
- idempotency key
- accepted state transitions
- replay/read model
- snapshot vs delta rules
- batching/downsampling behavior
- reconnect cursor semantics

References:

- [SESSION-EVENT-CONTRACT.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/SESSION-EVENT-CONTRACT.md)

### 0.4 Rollout Gates

Before enabling any new tree UI by default, define feature flags for:

- schema writes
- event writes
- websocket event stream
- session tree UI
- attach mode
- remote auth

## Core Model

Phase 0 schema scaffold status:

- session graph contract defined
- session event contract defined
- schema scaffold lands before writers, stream APIs, or tree UI become authoritative

### 1. Managed Root Sessions

Add first-class launch commands such as:

```bash
cliagents launch codex
cliagents launch qwen
cliagents launch gemini
cliagents launch opencode
```

Each launched session becomes a tracked root session with:

- `session_id`
- `root_session_id`
- `parent_session_id = null`
- `kind = main`
- `adapter`
- `model`
- `origin_client`
- `work_dir`
- `status`

This is the only reliable way to guarantee full observability of the user's main working session.

### 2. Session Graph

Extend terminal/session records to support:

- `root_session_id`
- `parent_session_id`
- `kind`
  - `main`
  - `subagent`
  - `reviewer`
  - `judge`
  - `discussion`
  - `workflow`
- `external_session_ref`
- `title`
- `owner`

This enables a tree view:

- main session
  - delegated worker
  - delegated worker
  - discussion judge

### 3. Event Log

Add a durable event stream table and websocket payload model.

Minimum event types:

- `session_started`
- `session_resumed`
- `session_terminated`
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
- `session_stale`
- `session_destroyed`

Additional contract requirements from review:

- every event must have an `idempotency_key`
- ordering must be defined per session/root session
- replay must not create impossible state transitions

This is the backbone for both realtime UI and historical replay.

### 4. Attach Mode

If the user still wants to begin in an external CLI, add opt-in attachment:

```bash
cliagents attach --client codex --kind main
```

Important constraints:

- attach mode should be explicit, not magical
- it should register a sidecar-tracked session with the broker
- it should not promise full fidelity for arbitrary unmanaged sessions
- the UI must label attach-mode fidelity limits clearly

Attach mode is a fallback, not the primary model.

## UI Direction

Upgrade the console into a control-plane view with:

### Left column

- session tree
- root sessions
- child sessions
- stale/blocked markers

### Center column

- selected session transcript/output
- reply box
- lifecycle events

### Right column

- discussion rounds
- reviewer outputs
- judge output
- final decision card

### Historical mode

- replayable timeline by run/session tree
- filters by root session, adapter, discussion, failure class, date

## Data Model Additions

### Session table

Add fields:

- `root_session_id`
- `parent_session_id`
- `kind`
- `origin_client`
- `external_session_ref`
- `title`

### Event table

Add:

- `event_id`
- `session_id`
- `root_session_id`
- `run_id`
- `discussion_id`
- `event_type`
- `idempotency_key`
- `sequence_number`
- `payload_json`
- `created_at`

### Optional links

Add mapping between:

- root session <-> run
- session <-> discussion
- session <-> terminal

## Realtime Transport

Current websocket updates are sufficient for basic refreshes, but not for a rich session graph.

Upgrade websocket payloads to include:

- event type
- root session id
- session id
- run id
- discussion id
- sequence number
- status deltas
- short payload preview

Also define explicitly:

- snapshot vs delta policy
- reconnect behavior
- replay endpoint behavior
- batching/backpressure rules

The browser should stop relying on frequent broad polling once this event model is in place.

## Remote Access

For iPad/browser use:

- run the broker as a persistent service
- require API key auth outside trusted local development
- keep `reply to terminal` available for blocked or live sessions
- allow filtered views by root session so a mobile screen stays usable
- scope remote credentials and rotation rules before exposing the service outside localhost

## Execution Plan

### Phase 0: Foundation

- build the adapter conformance harness
- fix active adapter contract failures before tree work
- write schema migration and rollback plan
- define websocket/event contract
- define feature flags and rollout gates

### Phase 1: Session Identity

- add root/parent/kind fields
- add `cliagents launch`
- ensure spawned subagents inherit root session identity
- add compatibility handling for legacy session rows

### Phase 2: Event Backbone

- add event table
- emit lifecycle/delegation/discussion events
- add idempotency and ordering guarantees
- expose replay/read APIs
- stream events over websocket behind a feature flag

### Phase 3: UI Tree

- replace flat terminal list with session tree
- link sessions to runs and discussions
- show final decision nodes
- expose fidelity labels for managed vs attached sessions

### Phase 4: Attach Mode

- add explicit external attach path
- document its limits
- add attach-mode fidelity tests

### Phase 5: Hardening

- crash recovery for root/child graphs
- stale session detection
- load testing for event throughput
- remote auth and service install

## Risks

### 1. Overreaching into passive monitoring

Trying to observe arbitrary external sessions perfectly will create brittle behavior and unclear guarantees.

### 2. Event volume

Full event logging can get noisy quickly. Summaries, retention, and pagination need to be explicit.

### 3. Ownership confusion

If users mix unmanaged sessions and managed sessions without a clear label, the UI will be misleading.

### 4. Adapter inconsistency

The current broker cannot be treated as a source of truth unless the active adapters pass a conformance harness consistently.

### 5. Replay and ordering ambiguity

Without idempotency and ordering guarantees, the session graph can display impossible states after retries, reconnects, or crash recovery.

## Recommendation

Proceed with a control-plane architecture where:

- `cliagents launch` is the primary entrypoint for main sessions
- subagents always inherit root session identity
- discussions and consensus remain broker-owned
- attach mode exists, but is explicitly secondary
- Phase 0 adapter/schema/event work is mandatory before the tree UI becomes the main control surface

That is the cleanest way to get:

- full main-session visibility
- subagent visibility
- debate/conclusion visibility
- reliable remote operation
