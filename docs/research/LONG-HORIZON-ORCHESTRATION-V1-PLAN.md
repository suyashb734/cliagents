# Long-Horizon Orchestration V1 Plan

## Status

Decision status: `approved-for-execution`

This plan defines the narrowest broker-native execution model that can support
long-running agent teams without turning `cliagents` into a general PM system.

It is intentionally narrower than a generic task board. The goal is not to add
"tasks everywhere." The goal is to make long-horizon multi-agent execution
durable, inspectable, resumable, and operator-controlled.

## Problem Statement

`cliagents` already has useful building blocks:

- root sessions and child sessions
- durable run ledger tables
- persisted room state
- shared `taskId` memory for artifacts, findings, and context
- async delegation and grouped task monitoring

That is enough for bounded delegation, review loops, and discussion workflows.
It is not enough for true long-horizon team execution.

The current gaps are:

1. no canonical orchestration object for a multi-phase implementation effort
2. no broker-owned phase, gate, or handoff state
3. no data-driven specialist registry for long-running teams
4. no reliable dependency-aware execution model above raw runs
5. `run_workflow` async mode launches all steps immediately, which is not valid
   for dependent implementation phases

The result is that teams can be approximated, but not supervised cleanly.

## Architecture Direction

The correct center of gravity is:

- `runs` remain the execution-history substrate
- `orchestration` becomes the top-level long-horizon object
- `phases`, `gates`, and `handoffs` model execution semantics
- `specialists` define routing and policy

Do not start with a generic first-class `task` object.

For long-horizon coding work, the broker needs an execution model more than it
needs a backlog model.

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

### New Tables

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
- `artifacts`
- `findings`
- `context`
- `memory_snapshots`
- `session_events`

## Phase Order

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

### Phase 2: Add Orchestration State

Goal:
Introduce one top-level long-running execution object linked to the run ledger.

Required work:

1. create orchestration tables and persistence helpers
2. add orchestration create/get/list/update broker routes
3. attach orchestrations to root sessions and run ids
4. surface orchestration status in MCP and HTTP
5. allow orchestration creation without immediately launching every phase

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

## Recommended Initial Implementation Order

1. fix run-state and blocked-state durability
2. add orchestration tables and service layer
3. add phase and gate state with minimal HTTP routes
4. move async workflow execution to orchestration-engine readiness logic
5. replace hardcoded workflow routing with specialist registry config

## Initial Test Gates

Add or extend tests for:

- run blocked-state persistence and replay
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

