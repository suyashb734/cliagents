# cliagents Operating Model

## Status

Proposal status: `draft`

## Purpose

This document is the canonical operating model for using `cliagents` effectively across coding sessions.

It exists to keep these behaviors consistent:

- when work should enter the broker
- which surface should be used for roots, child sessions, rooms, and runs
- how to route expensive vs cheaper models
- how persistence, memory, and usage should be treated

This is the shared source of truth for:

- humans using `cliagents`
- Codex skills and wrappers
- future Claude, Gemini, or OpenCode wrappers

## Product Thesis

`cliagents` is not mainly a chat UI and not mainly a provider wrapper.

It is a local broker/control plane for coding work with these goals:

1. keep top-level work durable and inspectable
2. route bounded execution to cheaper models where possible
3. use stronger models for planning, review, synthesis, and escalation
4. preserve run history, usage, and memory across sessions

The target outcome is not "many agents talk together."

The target outcome is:

- cheaper models do more execution
- stronger models enforce quality
- the broker preserves enough state to inspect, resume, and improve that workflow over time

## When Work Should Use cliagents

Use `cliagents` when the work should be any of:

- persisted
- resumable
- usage-tracked
- queryable later
- delegated across multiple models
- discussed in a room
- summarized into broker memory

Use direct provider CLI only when the work is disposable and none of those properties matter.

## Core Objects

### Operator Thread

The top-level human or controller context.

This is not just another root session. It supervises:

- roots
- rooms
- runs
- later, tasks

### Root Session

A human-managed execution lane for one adapter/runtime identity.

Use a root when you want:

- a durable main lane
- direct reply and resume
- broker-owned persistence and usage

Create tracked top-level roots through `cliagents launch <adapter>`.

### Child Session

A bounded delegated execution lane under a root.

Use child sessions for:

- sidecar implementation work
- parallel research or review
- focused bounded subtasks

Do not treat child sessions as silent new roots.

Compatible reuse is the default posture for child sessions attached to a root.
The broker should reuse a settled child when the lane shape matches: adapter,
model, effort, workdir or worktree, role, session kind, session label, tool
policy, permission mode, system prompt, and task or assignment scope. If any of
those change, the broker should create a new binding and report why reuse was
skipped.

Exact continuation is different from compatible reuse. Use the known terminal id
when continuing one specific child conversation. Use a collaborator child with a
stable `sessionLabel` when provider-thread continuity is part of the lane
contract.

### Room

A multi-agent conversation surface.

Use rooms for:

- debate
- synthesis
- cross-model review
- persistent collaborative conversation

Rooms are the primary user-facing conversation surface. Runs and discussions remain the backing audit surfaces.

### Run / Discussion / Review

The durable audit objects for actual execution.

These exist so work is:

- replayable
- inspectable
- attributable

### Memory Bundle

The compact derived recall surface over runs, roots, and tasks.

Use memory for:

- brief continuity
- key decisions
- pending items

Do not treat memory as a replacement for raw run history.

### Usage

Usage exists to measure broker behavior, not just raw token totals.

Primary metrics:

- input tokens
- output tokens
- total tokens
- role-aware attribution
- model and adapter breakdowns

Cost is secondary to tokens unless the provider reports cost directly.

## Default Surface Selection

### For Humans

Use the `cliagents` CLI for top-level root lifecycle:

- `cliagents launch <adapter>`
- root/session attach or resume commands

### For Agent-Driven Orchestration

Use MCP or HTTP for:

- child session delegation
- rooms
- discussions
- memory
- usage
- durable inspection

### For Disposable Work

Use direct provider CLI only if:

- the work does not need broker persistence
- the work does not need summaries or usage accounting
- the work does not need to be resumed or reviewed later

## Delegation Hierarchy

The default routing model is hierarchical, not egalitarian.

### Stronger Models Should Prefer

- planning
- decomposition
- review
- synthesis
- escalation handling

### Cheaper Models Should Prefer

- bounded implementation
- repetitive edits
- mechanical debugging
- narrow research
- transformations

### Acceptance Pattern

1. stronger model scopes a bounded task
2. cheaper model executes it
3. stronger model reviews the result
4. if accepted, continue
5. if rejected, retry or escalate

This is the main broker pattern to optimize.

## Inspection Defaults

Use these durable surfaces first:

- `get_run_detail` for raw run history
- `get_memory_bundle` for compact context
- `get_message_window` for durable message history
- `get_usage_summary` for usage and role-aware attribution

Do not rely only on live terminal output when a durable broker surface exists.

## Recovery Defaults

When broker state and provider state disagree:

- trust durable broker records first for replay and usage
- verify whether the provider lane is still live before resuming
- prefer explicit resume or import over silent provider-local assumptions

When a feature appears broken, first ask:

1. is the work actually running outside the broker?
2. has the broker process or MCP helper been restarted onto the current code?
3. is the missing state durable, or only absent from the live surface?

## Anti-Patterns

- launching tracked top-level work outside `cliagents`
- using the strongest model for every execution step
- treating rooms as the same thing as runs
- treating child sessions as free-floating roots
- assuming usage totals alone prove broker quality
- creating broad multi-agent discussions when a bounded reviewer loop would do

## Current Priority Metrics

Use these to judge whether the broker strategy is working:

- execution tokens vs review and judge tokens
- broker overhead share
- acceptance rate of cheaper-agent outputs
- retry rate
- escalation rate
- premium-model token share

The goal is not merely lower total tokens.

The goal is lower expensive-model dependence without unacceptable quality loss.

## Relationship To Other Docs

This document is the operator policy companion to:

- [CLIAGENTS-BROKER-PLAN.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/CLIAGENTS-BROKER-PLAN.md)
- [BROKER-NATIVE-ORCHESTRATION-UX-PROPOSAL.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/BROKER-NATIVE-ORCHESTRATION-UX-PROPOSAL.md)
- [FEATURE-ACCEPTANCE-MATRIX.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/FEATURE-ACCEPTANCE-MATRIX.md)

If a wrapper skill or prompt disagrees with this file, update the wrapper and keep this file canonical.
