# Long-Horizon Orchestration V1 Plan

## Status

Decision status: `approved-for-execution`

This plan defines the narrowest broker-native execution model that can support
long-running agent teams without turning `cliagents` into a general PM system.

It is intentionally narrower than a generic task board. The goal is not to add
"tasks everywhere." The goal is to make long-horizon multi-agent execution
durable, inspectable, resumable, and operator-controlled.

The persistence goal is broader than restart safety. `cliagents` should become
the broker memory substrate for supervisors such as OpenClaw, Hermes, or a
future desktop/mobile control app. Those supervisors should be able to ask:

- what work was requested
- which roots, children, rooms, and models worked on it
- what prompts, visible responses, tool actions, files, findings, usage, and
  outcomes were produced
- what is currently blocked or needs operator attention
- what summary context should be carried into the next run or resume

Raw event history stays canonical. Summaries are derived memory: brief,
decisions, blockers, next actions, and eventually a tree or graph of
conversation, run, task, and project summaries.

## Problem Statement

`cliagents` already has useful building blocks:

- root sessions and child sessions
- durable run ledger tables
- persisted room state
- shared `taskId` memory for artifacts, findings, and context
- async delegation and grouped task monitoring
- raw terminal logs for managed interactive roots

That is enough for bounded delegation, review loops, and discussion workflows.
It is not enough for true long-horizon team execution.

The current gaps are:

1. no canonical orchestration object for a multi-phase implementation effort
2. no broker-owned phase, gate, or handoff state
3. no data-driven specialist registry for long-running teams
4. no reliable dependency-aware execution model above raw runs
5. `run_workflow` async mode launches all steps immediately, which is not valid
   for dependent implementation phases
6. native interactive roots are mostly raw terminal capture rather than
   normalized messages, tool events, usage, and continuation memory
7. derived memory exists, but there is not yet a clear summary tree or graph
   connecting root conversations, dispatches, runs, tasks, rooms, artifacts,
   findings, and usage

The result is that teams can be approximated, but not supervised cleanly.

## Architecture Direction

The correct center of gravity is:

- `runs` remain the execution-history substrate
- `dispatch_requests` become the pre-run intent and coalescing surface
- `orchestration` becomes the top-level long-horizon object
- `phases`, `gates`, and `handoffs` model execution semantics
- `specialists` define routing and policy
- native interactive roots get their own event-capture path, owned by the Memory
  Read Model plan, so human-managed TUI sessions become queryable broker memory
  instead of only replayable terminal logs
- memory snapshots become layered derived summaries over raw events, suitable
  for external supervisors and future summary-tree/summary-graph navigation

Do not start with a generic first-class `task` object.

For long-horizon coding work, the broker needs an execution model more than it
needs a backlog model.

## Native Interactive Root Persistence Gap

Managed native roots are essential for human-facing fidelity, but they are a
different capture problem than broker-delegated runs.

Today, a native Codex or Claude root can be visible and resumable while the
database only stores terminal metadata, a `session_started` event, and a raw TTY
log. That is not enough for OpenClaw, Hermes, or another supervisor to reliably
understand what happened.

Interactive root persistence should become a first-class branch with this V1
scope:

- persist broker-sent inputs as durable input events
- persist terminal output chunks with timestamps, terminal id, root id, and
  screen/log offsets
- best-effort parse visible user and assistant messages from native TUI output
  into `messages`
- record tool, MCP, shell, browser, and filesystem events when cliagents
  mediates them or when the provider emits machine-readable metadata
- extract model, effort, and usage when the provider exposes it; never invent
  usage when it is not observable
- maintain raw terminal logs as the audit fallback
- generate continuation summaries for roots, tasks, rooms, and projects from
  the persisted raw event stream

Hidden model thoughts are not a persistence target. Providers do not expose
private reasoning. The broker should only persist visible responses, provider
reported summaries, tool events, metadata, and raw terminal output.

This branch is separate from dispatch requests. Dispatch requests control
future work before spawn. Interactive-root persistence records what happened in
human-managed native roots after launch.

## Paperclip-Derived Mechanics To Adopt

Paperclip's strongest orchestration lesson is that run spawning should not be
the first durable event. A broker should record the requested work before it
decides whether to launch, defer, coalesce, retry, or bind to an existing
session.

Add these mechanics to the V1 direction:

- `dispatch_requests`: durable pre-run requests that can be queued, coalesced,
  deferred, cancelled, or converted into a run.
- `run_context_snapshots`: immutable context packets captured at dispatch time
  so a run can be replayed and audited without depending on later memory drift.
- `task_session_bindings`: explicit adapter/model/effort/session bindings for
  a task or phase, so provider continuity is intentional instead of inferred
  from terminal reuse.
- `liveness_policies`: explicit timeout, heartbeat, stale-session, and recovery
  rules for requests, phases, and runtime hosts.
- `adapter_lifecycle_callbacks`: a cleaner contract for execute, log, metadata,
  spawn, result, retry, resume, and failure classification events.

These do not change the product scope. They make the execution model more
deterministic while preserving the broker thesis: durable, inspectable,
operator-controlled agent work rather than a generic project-management board.

## Final Model

### Core Objects

#### 1. Hardened Runs

Runs remain the canonical execution ledger.

Required properties:

- stable `run_id`
- explicit terminal states
- root-session linkage
- optional orchestration linkage
- optional blocked-state linkage
- replayable inputs, outputs, tool events, and participant history

Runs answer:

- what executed
- who executed it
- what happened
- how it ended

Runs do not answer:

- what the overall job is
- what phase is currently active
- which approvals are pending
- which downstream work is now eligible

#### 1a. Dispatch Request

A dispatch request is the durable intent record before a run exists.

It answers:

- what work was requested
- what context packet should be used
- whether equivalent work is already pending or running
- whether the broker should launch now, defer, coalesce, or cancel
- which task, phase, gate, or room requested the work

Runs should be created from dispatch requests, not directly from every API call,
once long-horizon orchestration is active.

#### 1b. Run Context Snapshot

A run context snapshot is an immutable packet captured at dispatch time.

It should include:

- prompt or instruction body
- selected workspace and context mode
- linked task, assignment, phase, room, and root ids
- relevant artifacts, findings, handoffs, and memory excerpts
- selected adapter, model, effort, tool policy, and runtime host constraints

This is the audit boundary for "what the agent saw." Later memory updates should
not silently change the replay context for an already-launched run.

#### 1c. Task Session Binding

A task session binding records the intended execution identity for a task,
assignment, or phase.

It should include:

- task or phase id
- adapter
- model
- reasoning effort
- provider session id when known
- runtime host and fidelity
- reuse policy
- created and last-verified timestamps

This makes session reuse, model changes, and provider continuity explicit.
Changing model or effort can be allowed for roots, but it should create a new
binding event for child/specialist lanes unless the operator deliberately
chooses continuity over strict attribution.

#### 2. Orchestration

An orchestration is one broker-owned long-running job.

Examples:

- implement a feature across backend, frontend, review, and test phases
- run a complex bugfix with research, reproduction, remediation, and validation
- execute a security review with gated remediation and re-review

An orchestration owns:

- title and body
- workspace
- root-session linkage
- current status
- current phase or gate
- execution mode
- operator-visible metadata

#### 3. Phase

A phase is a bounded unit of work inside an orchestration.

Examples:

- design
- implementation planning
- backend implementation
- frontend implementation
- testing
- review
- remediation

Every phase has:

- one assigned specialist profile
- one adapter choice
- status
- dependency list
- linked delegated terminal or run
- retry count
- validation result

#### 4. Gate

A gate is an explicit checkpoint before a state transition.

Examples:

- design approval
- plan approval
- execution mode confirmation
- blocker escalation decision
- unresolved-severity override

Gates prevent silent transitions and make operator control durable.

#### 5. Handoff

A handoff is the structured output from one phase to another.

Required sections:

- summary
- decisions
- files created
- files modified
- blockers
- warnings
- validation commands
- validation result
- downstream context

Freeform chat is not a handoff format.

#### 6. Specialist Registry

The specialist registry is the broker-owned definition of available execution
roles and their routing policy.

Each specialist must define:

- `specialist_id`
- display name
- task classes
- preferred adapters
- fallback adapters
- tool policy
- output contract
- validation policy
- maximum parallelism

The registry should be data-driven, but v1 does not need a database table for
this. A broker-loaded config file is sufficient.

## Execution Semantics

Long-horizon orchestration should support:

- `sequential` execution
- `parallel` execution
- `ask` mode for operator-controlled branching

The required rule set is:

1. classify the orchestration
2. construct planned phases
3. open the design gate if needed
4. open the plan gate if needed
5. dispatch ready phases only
6. block dependent phases until prerequisites reconcile
7. require structured handoff before advancing
8. route review and validation as separate phases
9. finish only after final acceptance gates pass

This is the minimum control plane needed for agent teams.

## Why This Is Better Than A Generic Task Model

A generic task model is tempting but premature.

It creates immediate pressure for:

- priorities
- labels
- assignees
- estimates
- board views
- planning features

That is not the product target.

The product target is a broker-native execution model with:

- bounded specialists
- durable approvals
- blocked-state reply loops
- replayable phase history

For this reason, `orchestration` should be the first new broker-owned object,
not `task`.

## Data Model

The existing run ledger remains canonical for execution history.

Add orchestration-specific state keyed by `run_id`.

### Long-Horizon-Owned Tables

#### `orchestrations`

- `run_id`
- `root_session_id`
- `workspace_path`
- `title`
- `task_body`
- `task_family`
- `complexity`
- `execution_mode`
- `status`
- `current_phase_id`
- `current_gate_id`
- `metadata`
- `created_at`
- `updated_at`
- `completed_at`

#### `dispatch_requests`

- `dispatch_request_id`
- `orchestration_id`
- `phase_id`
- `task_id`
- `assignment_id`
- `room_id`
- `root_session_id`
- `requested_by`
- `request_kind`
- `status`
- `coalesce_key`
- `defer_until`
- `context_snapshot_id`
- `bound_session_id`
- `metadata`
- `created_at`
- `updated_at`
- `dispatched_at`
- `cancelled_at`

#### `run_context_snapshots`

- `context_snapshot_id`
- `dispatch_request_id`
- `workspace_path`
- `context_mode`
- `prompt_summary`
- `prompt_body`
- `linked_context_json`
- `tool_policy_json`
- `adapter`
- `model`
- `reasoning_effort`
- `metadata`
- `created_at`

#### `task_session_bindings`

Append-only. A model, effort, worktree, tool policy, provider-thread, or
compatible-reuse decision change creates a new binding row instead of mutating
historical attribution.

- `binding_id`
- `task_id`
- `assignment_id`
- `orchestration_id`
- `phase_id`
- `adapter`
- `model`
- `reasoning_effort`
- `terminal_id`
- `provider_session_id`
- `runtime_host`
- `runtime_fidelity`
- `reuse_policy`
- `reuse_decision_json`
- `status`
- `metadata`
- `created_at`
- `last_verified_at`

### Prerequisite Memory Read Model Tables

`root_io_events` and `memory_summary_edges` are prerequisites owned by the Memory
Read Model plan, not Long-Horizon execution-control tables. Long-Horizon may
reference them for supervisor reconstruction, continuation summaries, and
orchestration lineage, but it must not introduce competing migrations for them.

#### `root_io_events`

- `root_io_event_id`
- `root_session_id`
- `terminal_id`
- `event_kind` (`input`, `output`, `screen_snapshot`, `parsed_message`,
  `tool_event`, `usage`, `liveness`)
- `source` (`broker`, `terminal_log`, `provider_metadata`, `parser`)
- `sequence_no`
- `content_preview`
- `content_full`
- `content_sha256`
- `log_path`
- `log_offset_start`
- `log_offset_end`
- `screen_rows`
- `screen_cols`
- `parsed_role`
- `confidence`
- `metadata`
- `occurred_at`
- `recorded_at`

Normative contract:

`content_full` and `content_preview` store redacted payloads. Raw terminal bytes
remain in the existing tmux log path and are governed by their own retention
policy. Offsets (`log_offset_start`, `log_offset_end`) plus `content_sha256` are
sufficient to reconstruct provenance while the raw log exists. A workspace may
opt in to a separate raw side store, but that side store is purgeable
independently of `root_io_events`.

#### `memory_summary_edges`

- `edge_id`
- `edge_namespace` (`structural`, `derivation`, `execution`)
- `parent_scope_type`
- `parent_scope_id`
- `child_scope_type`
- `child_scope_id`
- `edge_kind` (`contains`, `continues`, `summarizes`, `supersedes`,
  `derived_from`, `blocks`, `unblocks`)
- `metadata`
- `created_at`

#### `orchestration_phases`

- `phase_id`
- `run_id`
- `phase_key`
- `title`
- `specialist_id`
- `adapter`
- `depends_on_json`
- `status`
- `terminal_id`
- `participant_id`
- `retry_count`
- `started_at`
- `completed_at`
- `metadata`

#### `orchestration_gates`

- `gate_id`
- `run_id`
- `phase_id`
- `gate_kind`
- `status`
- `prompt_text`
- `decision`
- `decided_by`
- `decided_at`
- `metadata`

#### `orchestration_handoffs`

- `handoff_id`
- `run_id`
- `phase_id`
- `producer_terminal_id`
- `consumer_phase_id`
- `summary`
- `downstream_context_json`
- `file_manifest_json`
- `validation_json`
- `blockers_json`
- `created_at`

#### `operator_actions`

- `action_id`
- `run_id`
- `terminal_id`
- `action_kind`
- `payload_json`
- `created_at`

### Reused Tables

Continue using:

- `runs`
- `run_participants`
- `run_steps`
- `run_outputs`
- `run_tool_events`
- `messages`
- `session_events`
- `artifacts`
- `findings`
- `context`
- `memory_snapshots`

`root_io_events` and `memory_summary_edges` should complement these tables, not
replace them. The raw terminal log remains the audit fallback, but query APIs
should prefer normalized event rows and derived summaries.

## Phase Order

### Phase 0: Contract Freeze

Owner: supervisor. No implementation workers.

Deliverables:

- exact schema for `orchestrations`, `dispatch_requests`,
  `run_context_snapshots`, `task_session_bindings`, `orchestration_phases`,
  `orchestration_gates`, `orchestration_handoffs`, and additive
  `operator_actions` semantics
- imported Memory Read Model contracts for `root_io_events` and
  `memory_summary_edges`
- dispatch request state machine, coalescing semantics, defer/cancel behavior,
  idempotency keys, and restart reconciliation rules
- immutable `run_context_snapshots`: redacted on creation, update-blocked after
  insert, and purge-only for post-hoc privacy operations
- append-only `task_session_bindings`, including model/effort/tool/worktree
  changes and compatible-reuse decisions
- redaction contract for `prompt_body`, `content_full`, `content_preview`,
  `parsed_message`, metadata, and every `*_json` field that may carry user
  content; `content_sha256` is computed over redacted bytes
- retention contract: every new table declares a retention class and ships the
  columns needed to enforce it without future migration
- liveness and timeout values for `dispatch_requests`, phases,
  `task_session_bindings`, and runtime hosts
- acceptance fixtures for dispatch coalescing/defer, blocked-state replay,
  root IO capture, and gate approval/rejection

Workers may not edit implementation files until Phase 0 is signed off.

### Phase 1: Harden Runs

Goal:
Make `runs` durable enough to anchor long-horizon orchestration.

Required work:

1. make explicit blocked-state representation first-class in the run ledger
2. record operator replies and overrides as durable actions linked to runs
3. tighten run terminal-state reconciliation after broker restart
4. preserve root linkage and task linkage across retries and delegated reuse
5. expose missing run-state details cleanly over MCP and HTTP

Primary touchpoints:

- `src/orchestration/run-ledger.js`
- `src/server/orchestration-router.js`
- `src/mcp/cliagents-mcp-server.js`
- `src/database/db.js`
- `src/database/migrations`

### Prerequisite: Memory Read Model Phase 2a

Goal:
Make broker-managed native roots inspectable as structured broker memory before
Long-Horizon uses those events for supervisor reconstruction.

Required work:

1. add `root_io_events` persistence and projection helpers in the Memory Read
   Model branch
2. record broker-sent terminal input, permission replies, approvals, denials,
   interrupts, detach, resize, and kill actions as durable events
3. persist terminal output chunks with log offsets and timestamps
4. add best-effort native TUI parsers that extract visible user/assistant
   messages into `messages` without treating parser output as more canonical
   than the raw log
5. record provider-reported model, effort, and usage when observable
6. generate root continuation summaries from root IO plus existing messages,
   session events, artifacts, findings, and usage
7. expose native-root memory through `get_message_window`, `get_memory_bundle`,
   and memory query surfaces

Primary touchpoints:

- `src/orchestration/session-manager.js`
- `src/orchestration/terminal-manager.js`
- `src/database/db.js`
- `src/database/migrations`
- `src/services/memory-snapshot-service.js`
- `src/server/orchestration-router.js`
- `src/mcp/cliagents-mcp-server.js`

### Phase 2: Add Orchestration State

Goal:
Introduce one top-level long-running execution object linked to the run ledger.

Required work:

1. create orchestration tables and persistence helpers
2. add orchestration create/get/list/update broker routes
3. attach orchestrations to root sessions and run ids
4. surface orchestration status in MCP and HTTP
5. allow orchestration creation without immediately launching every phase
6. introduce dispatch requests as queued pre-run intent records
7. capture immutable run context snapshots before launching child work
8. record explicit task/session bindings when a phase selects adapter, model,
   effort, and reuse policy

Primary touchpoints:

- `src/database/migrations`
- `src/database/db.js`
- `src/server/orchestration-router.js`
- new `src/orchestration/orchestration-service.js`

### Phase 3: Add Phases, Gates, and Handoffs

Goal:
Make orchestration execution dependency-aware and operator-controlled.

Required work:

1. add phase planning and ready-set computation
2. add gate creation, approval, rejection, and retry flows
3. require structured handoffs between dependent phases
4. route blocked child prompts back through broker-owned operator actions
5. reconcile child terminal status back into phase status
6. apply coalescing and defer policies before dispatching duplicate or
   dependency-blocked requests
7. model liveness and recovery outcomes explicitly for stale dispatch requests,
   phases, and task-session bindings

Primary touchpoints:

- `src/orchestration/assign.js`
- `src/orchestration/handoff.js`
- `src/server/orchestration-router.js`
- new `src/orchestration/orchestration-engine.js`
- new `src/orchestration/handoff-packet.js`

### Phase 4: Add Specialist Registry

Goal:
Replace hardcoded workflow-step routing with broker-owned execution policy.

Required work:

1. add a registry loader for specialists
2. define role, adapter, tool-policy, and validation-policy fields
3. support bounded parallelism through per-specialist limits
4. select adapters through registry policy rather than workflow-specific maps
5. replace ad hoc workflow step arrays in MCP async workflow mode

Primary touchpoints:

- `src/mcp/cliagents-mcp-server.js`
- `src/orchestration/task-router.js`
- `src/services/agent-profiles.js`
- new `src/orchestration/specialist-registry.js`
- new `config/specialists.json`

## Current Code Reality

The repo already supports part of this direction:

- run ledger tables already include `implementation-run` and `research-run`
- `runs` already carry `root_session_id` and `task_id`
- child sessions already carry parent/root metadata
- rooms already preserve durable multi-agent conversation state

The main mismatch today is the workflow layer.

In current MCP async workflow mode, `run_workflow` starts every declared step
immediately. That is acceptable for fan-out reviews. It is not acceptable for
dependent execution flows like `plan -> implement -> test`.

Long-horizon orchestration must move that logic into a broker-owned engine with
phase readiness checks.

## Long-Horizon Team Pattern

The recommended team model is:

- one human or controller thread
- one attached `cliagents` root session
- one orchestration per long-running objective
- one manager lane that owns scheduling
- bounded child sessions for specialists
- optional room for debate or synthesis

Do not use a free-form peer swarm.

Use bounded parallelism:

- independent phases may run together
- dependent phases must wait on reconciliation
- write ownership stays broker-mediated

## Native Codex Subagent Comparison

`cliagents` child sessions and native Codex subagents are similar in one narrow
sense:

- both are bounded delegated workers beneath a parent controller

They are not the same abstraction.

Native Codex subagents are:

- in-process to the current Codex orchestration
- lightweight
- good for fast sidecar analysis or parallel local work
- not the broker's canonical persisted execution surface

`cliagents` child sessions are:

- broker-owned
- durable and inspectable
- root-bound
- resumable and usage-attributed
- appropriate for long-running externalized execution

The correct mental model is:

- native Codex subagent for fast local sidecar work
- `cliagents` child session for tracked long-horizon specialist execution

Do not pretend they have identical semantics.

If needed, `cliagents` can be wrapped to feel subagent-like from Codex, but the
wrapper must preserve the differences in:

- persistence
- control-plane ownership
- root attachment
- resume semantics
- blocked-input handling

## Acceptance Criteria

This plan is successful when:

1. a long-running orchestration can be created without launching all work at
   once
2. the broker can compute which phases are ready and dispatch only those phases
3. blocked child work can be answered and replayed later from broker state
4. dependent phases do not start without required handoffs and approvals
5. specialist routing is data-driven rather than hardcoded inside one workflow
   function
6. the full execution history is inspectable from the broker after restart
7. native interactive roots produce enough structured broker events for an
   external supervisor to understand visible conversation, actions, status,
   continuation summary, and known usage without reading raw tmux logs directly
8. root, task, room, run, and project summaries can be linked into a derived
   memory tree or graph without overriding raw event truth
9. raw `root_io_events.content_full` storage is bounded by its declared
   retention class; offsets and `content_sha256` remain queryable after raw
   payload purge
10. any new persistence path that captures user prompt or terminal output
    content is covered by redaction-conformance tests, including derived
    summaries and `memory_summary_edges` traversals
11. an operator-initiated purge by `root_session_id` reaches every table that
    stores user content for that root, including derived summaries and reachable
    memory summary edges
12. route and dispatch responses expose compatible-reuse decisions so supervisors
    can tell whether an existing child lane was reused or why a new binding was
    created

## Recommended Initial Implementation Order

1. fix run-state and blocked-state durability
2. finish Memory Read Model Phase 2a for native interactive-root persistence,
   parsed messages, continuation summaries, and summary lineage
3. add orchestration tables and service layer
4. add dispatch request, context snapshot, and task-session binding records
5. add phase and gate state with minimal HTTP routes
6. move async workflow execution to orchestration-engine readiness logic
7. replace hardcoded workflow routing with specialist registry config

## Initial Test Gates

Add or extend tests for:

- run blocked-state persistence and replay
- native root input/output event capture and replay after restart
- best-effort native TUI message parsing with raw-log fallback
- root continuation summary creation and refresh behavior
- memory summary edge creation for root -> run/task/room/project rollups
- dispatch request queue/coalesce/defer/cancel behavior
- immutable run context snapshot creation before launch
- task-session binding behavior for adapter, model, effort, and reuse policy
- orchestration create/get/list lifecycle
- ready-phase computation for sequential and parallel plans
- gate approval and rejection behavior
- handoff validation and phase advancement
- specialist-registry routing and parallelism limits

Existing suites that should remain healthy include:

- [tests/test-run-ledger-service.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-service.js)
- [tests/test-run-ledger-routes.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-routes.js)
- [tests/test-orchestration-introspection-routes.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-orchestration-introspection-routes.js)
- [tests/test-mcp-root-session-tools.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-root-session-tools.js)
