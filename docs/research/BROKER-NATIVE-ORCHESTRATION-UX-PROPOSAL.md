# cliagents Feature Proposal: Broker-Native Orchestration and Multi-Agent Desktop/Web UX

## Status

Proposal status: `draft`

## Decision Summary

`cliagents` should stay broker-first and grow into a full operator-facing product by adding:

1. a broker-native orchestration engine with Maestro-grade workflow semantics
2. a first-party browser/desktop operator UX for multi-agent work
3. thin runtime-native entrypoints that call into the broker instead of becoming separate orchestration systems

The product should **borrow Maestro's orchestration ideas** but **not adopt Maestro's plugin-native architecture as the system of record**.

## Roadmap Position

This proposal is subordinate to:

1. `CLIAGENTS-BROKER-PLAN.md`
2. `PHASE0-BROKER-AUDIT.md`
3. `ROADMAP-CONSENSUS-RUN-LEDGER.md`
4. `SESSION-CONTROL-PLANE-PLAN.md`
5. `REALTIME-REMOTE-UI-PLAN.md`

This document is the product-level synthesis for the next expansion layer after:

- adapter conformance
- broker reliability
- run-ledger maturity
- typed event contracts

If priorities conflict, broker reliability and inspectability still win over UX breadth.

## Problem

Today `cliagents` has strong broker plumbing but weak orchestration semantics and a limited operator-facing product surface.

Current strengths:

- HTTP, WebSocket, MCP, and OpenAI-compatible ingress
- managed roots, child sessions, rooms, discussions, findings, artifacts, and usage
- durable broker state and good broker-side observability primitives

Current gaps:

- implementation workflows are shallow compared with a real orchestration engine
- `feature`, `bugfix`, and `research` flows are mostly role-routing shortcuts, not gated multi-phase workflows
- no canonical operator console that feels like a multi-agent desktop app
- no unified approval, replay, and blocked-input loop for implementation work
- runtime plugins can call the broker, but the broker does not yet offer a first-class orchestration product above its transport layer

The product target is not "just a broker" and not "just a plugin." It is:

- a local multi-agent control plane
- with a desktop/web experience similar in coherence to Claude Desktop
- but built for multi-agent orchestration across several official coding CLIs

## Product Thesis

`cliagents` should become the canonical local control plane for multi-agent coding work:

- one broker process
- one canonical run/task ledger
- one browser/desktop operator console
- many runtime adapters and thin host integrations

The user should be able to:

1. launch or attach a main coding session
2. start an orchestration from desktop, web, MCP, or HTTP
3. watch specialists work live
4. approve or reject gates
5. reply to blocked agents
6. inspect results later with replay and comparison
7. continue the same orchestration from any supported surface

## Why Not Copy Maestro's Architecture

Maestro is stronger than current `cliagents` at workflow semantics, but its architecture is optimized for runtime-native plugins and generated host-specific entrypoints.

That is not the best center of gravity for this product.

Reasons:

1. `cliagents` already has the better control-plane substrate.
   - canonical broker process
   - durable database
   - managed roots and children
   - network surfaces for UI and other clients

2. A multi-agent desktop/web app needs one source of truth.
   - state should not fragment across Codex, Claude, Gemini, and Qwen plugin folders
   - the browser and desktop app need one canonical model for tasks, phases, approvals, and replay

3. Plugin-native orchestration makes host runtime constraints primary.
   - hook availability differs
   - policy enforcement differs
   - session semantics differ
   - packaging differs

4. Broker-native orchestration keeps external integration possible.
   - MCP clients
   - HTTP clients
   - automation
   - future mobile and remote surfaces

The correct path is:

- keep orchestration state in the broker
- keep plugins/extensions thin
- use plugins as ingress and context bridges
- import Maestro's workflow model above the broker

## Goals

### Primary Goals

1. Add a first-class orchestration engine for implementation work.
2. Add a first-class operator console for live and historical multi-agent work.
3. Preserve `cliagents` as the canonical system of record for sessions, runs, phases, and approvals.
4. Keep all major flows callable from:
   - desktop/web UI
   - MCP
   - HTTP
   - thin local CLI
5. Make replay and operator intervention first-class.

### Secondary Goals

1. Provide runtime-native entrypoints for Claude, Codex, Gemini, and Qwen that map cleanly into broker orchestration.
2. Export enough structured workspace state for auditability and portability.
3. Support iPad/remote access for read/reply workflows after auth hardening.

## Non-Goals

This proposal does not make `cliagents` into:

- a Multica-style team board or SaaS collaboration product
- a Gastown-style repo-native merge queue and swarm OS
- a full worktree/PR cockpit in the first phases
- a general workflow engine for non-coding tasks
- a passive terminal sniffer for arbitrary external sessions

Those may be adjacent directions later, but they are not the first execution target.

## User Experience Target

### Core User Story

A solo developer opens the `cliagents` desktop app, launches a `codex-cli` root session, asks for a feature, and watches `qwen-cli`, `codex-cli`, and `gemini-cli` collaborate through a structured flow. The user can:

- approve the design
- approve the plan
- monitor execution phases
- answer blocked prompts
- review final findings
- reopen the same orchestration later with full replay

### Supported Entry Surfaces

1. Desktop app
2. Browser UI
3. MCP client
4. HTTP API
5. Thin `cliagents` CLI

### Required UX Flows

1. Root session launch and attach
2. New orchestration composer
3. Live execution console
4. Approval and gate actions
5. Blocked terminal reply
6. Replay and comparison
7. Resume or retry from failure

## Product Boundary

`cliagents` should own:

- root session lifecycle
- child session lifecycle
- orchestration definition and execution
- specialist registry
- approvals and gate state
- structured handoffs
- replayable event and run history
- operator UX

`cliagents` should not rely on host plugins for:

- canonical task state
- canonical approval state
- canonical replay history
- cross-runtime orchestration logic

## Proposed Architecture

The architecture should be organized into four layers.

### 1. Broker Core

Existing and evolving responsibilities:

- adapter lifecycle and routing
- session creation, polling, cancellation, teardown
- root/child session graph
- run ledger and durable event stream
- rooms, discussions, findings, artifacts, usage
- WebSocket and HTTP surfaces

This remains the product foundation.

### 2. Orchestration Engine

New layer above the broker core:

- task classification
- workflow template selection
- design and plan gates
- phase DAG execution
- specialist selection
- structured handoff parsing
- validation and review gating
- retry, pause, resume, abort, and reconciliation

This is where Maestro-style orchestration semantics belong.

### 3. Operator UX

New browser/desktop layer:

- compose and launch
- live multi-agent console
- phase timeline
- approval prompts
- blocked-input actions
- replay and comparison
- root session and child tree

This should use:

- REST for initial state
- WebSocket for live updates
- shared broker event and run models for replay

### 4. Thin Host Integrations

Claude/Codex/Gemini/Qwen integrations should:

- expose runtime-native entrypoints
- pass workspace and session context into the broker
- optionally provide hooks for context injection and policy hints
- never become the source of truth for orchestration state

## Core Concepts

### Root Session

The top-level interactive session anchored to one runtime and workspace.

### Orchestration

A top-level implementation workflow created by a user or another client.

Fields:

- task title
- task body
- mode
- complexity
- execution mode
- workspace
- root session linkage
- current phase
- current gate
- status

### Workflow Template

A named orchestration pattern.

Initial templates:

- `express`
- `standard`
- `review-only`
- `debug-only`
- `security-audit`
- `performance-check`

### Phase

A bounded step in an orchestration.

Examples:

- design
- implementation planning
- backend implementation
- frontend implementation
- testing
- review
- remediation

### Gate

A mandatory state transition checkpoint.

Examples:

- design approval
- plan approval
- execution mode confirmation
- review severity threshold
- blocker escalation decision

### Specialist

A named orchestration profile with:

- canonical role
- primary and fallback adapters
- tool restrictions
- expected output contract
- validation expectations
- preferred task classes

### Handoff Packet

A structured output from one specialist phase to the next.

Required sections:

- task report
- downstream context
- file manifest
- validation result
- blockers or warnings

### Replay Timeline

The ordered historical record of:

- orchestration lifecycle
- phase transitions
- agent outputs
- approvals
- operator replies
- blocked states
- final outcome

## Workflow Model

### Express Mode

For simple bounded work.

Properties:

- minimal clarifying questions
- one implementation phase
- one main specialist
- single review gate
- fast finish

Use cases:

- small fix
- localized implementation
- small documentation or refactor task

### Standard Mode

For medium and complex work.

Required lifecycle:

1. classify
2. design
3. design approval
4. implementation plan
5. plan approval
6. execution
7. review
8. remediation if needed
9. completion and archive

This should be the default mode for substantial implementation work.

### Standalone Entry Points

These run outside the full implementation lifecycle but use the same broker primitives:

- review
- debug
- security audit
- performance check
- research

## Orchestration Engine Design

### Classification

The engine should classify:

- task complexity: simple, medium, complex
- task family: feature, bugfix, review, debug, research
- mutation profile: read-only, bounded write, broad write
- coordination shape: single agent, sequential phases, parallel phases

Classification should be observable and overridable by the user.

### Execution Modes

Supported modes:

- `sequential`
- `parallel`
- `ask`

Rules:

- `ask` remains the default for non-trivial flows
- the engine may recommend a mode
- the final mode is recorded in orchestration state

### Specialist Registry

The current role model should evolve into a richer specialist registry.

Initial required fields:

- `specialist_id`
- `display_name`
- `task_classes`
- `preferred_adapters`
- `fallback_adapters`
- `tool_class_policy`
- `output_schema`
- `validation_policy`
- `max_parallelism`

This registry should be data-driven rather than hardcoded in workflow handlers.

### Hard Gates

Minimum hard gates for `standard`:

1. design approval before planning
2. plan validation before plan approval
3. plan approval before execution
4. per-phase reconciliation before dependent phases start
5. final review before completion
6. automatic block on unresolved `critical` or `high` findings unless explicitly overridden

### Structured Handoffs

Every implementation phase must end with a normalized handoff packet.

The engine should parse agent output into:

- summary
- decisions
- files created
- files modified
- integration points
- warnings
- blockers
- validation commands run
- validation result

If parsing fails:

- classify it as a protocol error
- request repair or retry
- do not silently treat freeform output as equivalent structured state

### Validation

Validation should be explicit per phase and per project type.

The engine should support:

- optional commands proposed by the workflow
- workspace-specific commands supplied by the caller or config
- agent-reported validation results
- operator-visible validation logs

Validation results should be separate from raw terminal output.

### Recovery

The engine should support:

- pause
- resume
- retry phase
- skip with operator approval
- abort
- reroute to different specialist

Failure classes should use the normalized broker taxonomy wherever possible.

## Data Model Proposal

The existing run ledger should remain canonical for execution history.

Add orchestration-specific state keyed by `run_id`.

### New or Extended Run Kinds

Extend run kinds to include:

- `implementation-run`
- `research-run`

### New Tables

#### `orchestrations`

One row per top-level orchestration.

Suggested fields:

- `run_id`
- `root_session_id`
- `workspace_path`
- `title`
- `task_body`
- `mode`
- `task_family`
- `complexity`
- `execution_mode`
- `status`
- `current_phase_id`
- `current_gate_id`
- `created_at`
- `updated_at`
- `completed_at`
- `metadata`

#### `orchestration_phases`

One row per planned phase.

Suggested fields:

- `phase_id`
- `run_id`
- `phase_key`
- `title`
- `specialist_id`
- `adapter`
- `dependency_depth`
- `depends_on_json`
- `status`
- `terminal_id`
- `retry_count`
- `started_at`
- `completed_at`
- `metadata`

#### `orchestration_gates`

Approval and blocking checkpoints.

Suggested fields:

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

Structured phase outputs.

Suggested fields:

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

Human approvals, replies, and overrides.

Suggested fields:

- `action_id`
- `run_id`
- `terminal_id`
- `action_kind`
- `payload_json`
- `created_at`

### Reuse Existing Tables

Keep using:

- `messages`
- `artifacts`
- `findings`
- `usage_records`
- `discussions`
- `discussion_messages`

The new orchestration layer should reference them, not replace them.

## API Surface Proposal

### REST

#### Orchestration

- `POST /orchestration/tasks`
- `GET /orchestration/tasks`
- `GET /orchestration/tasks/:runId`
- `POST /orchestration/tasks/:runId/approve`
- `POST /orchestration/tasks/:runId/reject`
- `POST /orchestration/tasks/:runId/retry-phase`
- `POST /orchestration/tasks/:runId/abort`
- `POST /orchestration/tasks/:runId/resume`

#### Root Sessions

- `POST /orchestration/root-sessions/launch`
- `POST /orchestration/root-sessions/attach`
- `GET /orchestration/root-sessions`
- `GET /orchestration/root-sessions/:id`

#### Console and Replay

- `GET /orchestration/runs/:id`
- `GET /orchestration/runs/:id/timeline`
- `GET /orchestration/runs/:id/replay`
- `GET /orchestration/terminals/:id/window`

### WebSocket

Extend the typed event stream with orchestration events:

- `orchestration.created`
- `orchestration.updated`
- `orchestration.phase.created`
- `orchestration.phase.started`
- `orchestration.phase.completed`
- `orchestration.gate.opened`
- `orchestration.gate.resolved`
- `orchestration.handoff.recorded`
- `operator.action.recorded`

And reuse existing session/run/terminal events.

### MCP

Add broker-native orchestration tools:

- `start_orchestration`
- `get_orchestration_status`
- `approve_gate`
- `reject_gate`
- `retry_phase`
- `list_root_sessions`
- `reply_blocked_session`

These should complement, not replace, the current delegation and workflow tools.

## Operator UX Proposal

### UX Principle

The browser and desktop app should not be a second product. They should be a visual client for the same broker state and actions.

### Primary Screens

#### 1. Home / Launch

Shows:

- available adapters
- active root sessions
- recent orchestrations
- quick actions

Actions:

- launch root session
- attach or adopt root session
- create new orchestration

#### 2. Composer

Lets the user:

- enter task prompt
- choose root session or start a new one
- choose `express` or `standard`
- set execution mode
- optionally pin preferred adapters

#### 3. Live Console

Shows:

- root session tree
- orchestration timeline
- phase list with statuses
- specialist outputs
- raw terminal stream toggle
- blocked-state composer
- approval panel

This is the core "Claude Desktop for many agents" screen.

#### 4. Replay and Compare

Shows:

- past orchestrations
- per-phase outputs
- findings and artifacts
- judge/reviewer summaries
- side-by-side participant comparison

#### 5. Attention View

Shows:

- blocked terminals
- failed phases
- pending approvals
- stale orchestrations
- rate-limit or auth failures

### Mobile and iPad

The UX must support:

- read-only monitoring
- blocked prompt reply
- approval and rejection
- replay

It does not need full composition or heavy diff inspection in the first mobile pass.

## Desktop Shell Proposal

### Recommendation

Build browser-first, then package the same local experience as a thin desktop shell.

### Shell Model

1. launch local `cliagents` broker process
2. open the same operator UI used in the browser
3. manage auth/bootstrap locally
4. provide system tray, notifications, and deep links

### Packaging Recommendation

Use an Electron shell first.

Reason:

- the broker is already Node-based
- local process management is easier
- PTY/session integrations are already local-process heavy
- the desktop shell can remain thin and mostly reuse browser UI code

This should be treated as packaging, not as a separate application architecture.

## Runtime Integration Proposal

Runtime integrations should become thin launch and context surfaces.

Examples:

- Claude plugin command calls `start_orchestration`
- Codex plugin skill calls `start_orchestration`
- Gemini extension command calls `start_orchestration`
- Qwen extension command calls `start_orchestration`

Runtime-specific hooks may still be used for:

- context injection
- policy hints
- session bootstrap
- blocked-state surfacing

But orchestration decisions, phases, and approvals should be broker-owned.

## Rollout Plan

### Phase 0: Foundation

Prerequisites already defined elsewhere:

- adapter conformance
- typed event contract
- run-ledger maturity
- session graph stability
- feature flags

### Phase 1: Orchestration Core

Deliver:

- `implementation-run` support
- `express` and `standard` workflow engine
- orchestration tables
- specialist registry
- structured handoffs
- hard gates

Acceptance:

- a `standard` feature flow persists phases and gates durably
- phase handoffs are structured and replayable
- unresolved high-severity review findings block completion by default

### Phase 2: Browser Console

Deliver:

- orchestration composer
- live console
- replay screen
- attention view
- blocked-session reply

Acceptance:

- user can follow a live orchestration end-to-end in browser
- user can approve gates and answer blocked prompts
- completed orchestrations replay cleanly

### Phase 3: Desktop Shell

Deliver:

- packaged app
- broker lifecycle management
- local auth bootstrap
- notifications
- deep links to runs and blocked actions

Acceptance:

- desktop app can launch broker and open the console reliably
- operator can work without visiting localhost manually

### Phase 4: Thin Runtime Entry Surfaces

Deliver:

- runtime-native commands/skills mapped into broker APIs
- shared orchestration semantics across runtimes
- minimal runtime-specific branching

Acceptance:

- the same orchestration started from Claude, Codex, Gemini, or Qwen creates the same broker-side state model

## Risks

### 1. Over-building before broker hardening

Mitigation:

- keep this proposal subordinate to the broker plan
- gate each phase behind conformance and run-ledger milestones

### 2. Creating a second orchestration system

Mitigation:

- keep orchestration state broker-owned
- make host plugins thin
- do not duplicate workflow logic in runtime packages

### 3. Event and state model drift

Mitigation:

- define orchestration event contract before UI dependence
- reuse run-ledger IDs and session graph identifiers everywhere

### 4. UX complexity explosion

Mitigation:

- build around five core screens only
- keep first release focused on solo operator workflows

### 5. Desktop packaging drag

Mitigation:

- treat browser UX as primary
- defer shell packaging until browser flows are stable

## Success Metrics

### Product Metrics

- operator can launch and complete a `standard` orchestration from UI alone
- operator can approve every required gate from UI
- blocked input can be answered from UI with replay preserved
- replay fidelity is sufficient to debug failures without reopening raw logs

### Technical Metrics

- phase transitions are deterministic and idempotent
- orchestration events are replay-safe
- root-session and child-session linkage is stable
- UI reads do not require terminal scraping heuristics

## Open Questions

1. How much workspace state should be mirrored to files versus remaining database-only?
2. Should operator approvals support multiple named identities or remain single-user initially?
3. When should worktree-aware orchestration enter scope?
4. Should a lightweight local CLI ship before or after the desktop shell?
5. Which review severities should block completion by default for implementation runs?

## Recommendation

Proceed with a broker-native orchestration and operator UX program with this sequence:

1. finish broker hardening and event contracts
2. add Maestro-grade orchestration semantics inside the broker
3. build browser console on that model
4. package the browser console as a thin desktop shell
5. keep runtime-native plugins and extensions thin

This path preserves `cliagents`' best differentiator, its broker/control-plane architecture, while fixing its current biggest weakness: shallow orchestration semantics and missing operator UX.
