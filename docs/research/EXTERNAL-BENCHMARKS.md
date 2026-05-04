# cliagents External Benchmarks

## Status

Proposal status: `draft`

## Purpose

This document defines the external benchmark set that should be used when making product and roadmap decisions for `cliagents`.

It exists because the repo currently has:

- partial Maestro and Multica references across several proposal docs
- light Gastown notes
- stronger comparison material in older external research notes, but not normalized inside `cliagents`

The goal is not to copy competitors blindly. The goal is to keep one canonical answer to these questions:

1. Which nearby systems are actually relevant?
2. What is each system better at than `cliagents`?
3. What should `cliagents` import from each one?
4. What should `cliagents` explicitly not copy?

## Decision Summary

`cliagents` should treat these as the primary external benchmark set:

1. `Maestro`
2. `Multica`
3. `Paperclip`
4. `Composio Agent Orchestrator`
5. `AWS CLI Agent Orchestrator`
6. `Gastown / Beads`

These are not equivalent products.

They matter because they cover the major product gaps around:

- room and moderator UX
- task and workspace workflow
- goal, budget, heartbeat, and governance orchestration
- issue and PR reaction loops
- tmux and control-plane orchestration
- durable large-scale agent state

Secondary systems worth watching, but not treating as primary design anchors yet:

- `Contrabass`
- `Optio`
- `Quester`
- `OpenCastle`
- `ClauBoard`
- `OctoAlly`
- `agentmux`
- `Fusion`

## Benchmark Roles

### 1. Maestro

**Role in the benchmark set**

`Maestro` is the primary benchmark for:

- room and group-chat UX
- moderator-driven multi-agent conversation
- operator-facing multi-session desktop experience

**What it does better than `cliagents`**

- room-first user experience
- moderator-guided group discussion
- better day-to-day operator UX for many active sessions
- packaged playbook and auto-run workflow surfaces

**What `cliagents` should import**

- room transcript as a first-class operator surface
- moderator-style room semantics
- cleaner multi-agent session supervision UX
- lightweight playbook-style workflow packaging later

**What not to copy**

- plugin-native architecture as the system of record
- provider/runtime-local state as the canonical persistence layer

**Why it matters**

`cliagents` already has strong broker substrate. Maestro is the clearest proof that the next missing layer is productized room and operator UX, not more ad hoc orchestration plumbing.

**Sources**

- [Maestro Overview](https://docs.runmaestro.ai/about/overview)
- [Maestro Group Chat](https://docs.runmaestro.ai/group-chat)
- [Maestro Features](https://docs.runmaestro.ai/features)

### 2. Multica

**Role in the benchmark set**

`Multica` is the primary benchmark for:

- task and issue workflow
- workspace and runtime inventory
- human plus AI team operating model

**What it does better than `cliagents`**

- agents-as-assignees product model
- workspace and board semantics
- runtime and daemon inventory model
- issue, comment, and mention-driven work triggers

**What `cliagents` should import**

- stronger task identity
- better workspace-scoped task grouping
- cleaner human-plus-agent operating model once tasks exist

**What not to copy**

- full team board and teammate product scope in the near term
- broad SaaS workflow surface before broker and task truth are tighter

**Why it matters**

Multica is not the benchmark for broker semantics. It is the benchmark for what a task-centric human plus AI operating model looks like when it is fully productized.

**Sources**

- [Multica Docs](https://multica.ai/docs)
- [Multica Changelog](https://multica.ai/changelog)

### 3. Paperclip

**Role in the benchmark set**

`Paperclip` is the primary benchmark for:

- goal hierarchy and task context inheritance
- org-chart-style agent roles, reporting lines, and budgets
- heartbeat-driven autonomous execution
- governance, approvals, rollback, and audit trails
- work products, comments, documents, attachments, and ticket surfaces

**What it does better than `cliagents`**

- product-level task, goal, and company operating model above raw agent sessions
- budget and policy controls attached to agents and work
- recurring heartbeat execution for autonomous work
- broader governance model for approvals, pause, resume, termination, and rollback
- multi-company isolation and portable company templates

**What `cliagents` should import**

- goal ancestry attached to tasks and assignments
- scoped token and budget policies above usage attribution
- heartbeat-style recurring task execution
- governance gates and approval records for high-risk actions
- work-product records above run output, artifacts, and findings

**What not to copy**

- broad zero-human-company product scope inside the broker core
- treating org charts as the only task model for coding orchestration
- duplicating agent runtimes when broker adapters and existing CLIs are sufficient
- replacing `cliagents` root, child, room, run, and usage semantics with a business-OS abstraction

**Why it matters**

Paperclip is the strongest benchmark for the outer desktop or super-app layer around `cliagents`: goals, budgets, heartbeats, governance, and work products. It is not a better replacement for the broker substrate. It is a benchmark for the product layer that can sit above it.

**Sources**

- [Paperclip GitHub](https://github.com/paperclipai/paperclip)
- [Paperclip Agent Adapters Overview](https://paperclip.inc/docs/adapters/overview/)

### 4. Composio Agent Orchestrator

**Role in the benchmark set**

`Composio Agent Orchestrator` is the primary benchmark for:

- issue-to-worker-to-PR automation
- CI and review reaction loops
- worktree fan-out around software delivery workflows

**What it does better than `cliagents`**

- issue and PR lifecycle as a first-class product
- config-driven CI, review, and merge reactions
- strong event and reaction model around delivery loops

**What `cliagents` should import**

- PR and CI reaction loops after tasks are real objects
- clearer event-to-action workflow packaging
- issue and review feedback routing on top of broker state

**What not to copy**

- narrow issue and PR automation as the whole product identity
- product assumptions that bypass the broader broker/control-plane model

**Why it matters**

This is the clearest benchmark for the branch that comes after first-class tasks: task-driven delivery loops rather than only session orchestration.

**Sources**

- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator)

### 5. AWS CLI Agent Orchestrator

**Role in the benchmark set**

`AWS CLI Agent Orchestrator` is the closest architecture benchmark to `cliagents`.

It should be treated as the primary benchmark for:

- tmux-backed orchestration
- hierarchical CLI control
- operator-facing broker semantics over multiple agent lanes

**What it does better than `cliagents`**

- closer reference point for CLI-first multi-agent orchestration
- clearer comparison for session lifecycle, worker fan-out, and operator control patterns
- stronger direct benchmark for broker-native CLI ergonomics

**What `cliagents` should import**

- practical human-facing CLI orchestration patterns
- clearer top-level CLI command design for delegation and monitoring
- better comparison points for root and child lane semantics

**What not to copy**

- AWS-specific assumptions if they conflict with `cliagents`' neutral local broker thesis
- architecture choices that weaken MCP and generic broker surfaces

**Why it matters**

Among current external systems, this is the strongest benchmark for the parts of `cliagents` that are already closest to being a real broker product.

**Sources**

- [AWS CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)

### 6. Gastown / Beads

**Role in the benchmark set**

`Gastown` and `Beads` are secondary-to-primary benchmarks for:

- durable agent state
- explicit coordination state
- swarm-scale execution and persistence patterns

They are not primary room or operator UX benchmarks.

**What they do better than `cliagents`**

- durable state abstractions for large agent graphs
- explicit coordination artifacts
- stronger inspiration for long-lived agent memory and swarm-scale state management

**What `cliagents` should import**

- ideas for durable state models beyond transient orchestration runs
- more explicit memory and coordination primitives later

**What not to copy**

- swarm-style complexity before `cliagents` has finished its task and room model
- product identity drift away from the local coding broker thesis

**Why they matter**

They are useful as a state and coordination influence, not as the primary end-user product benchmark.

**Sources**

- [Gastown](https://github.com/gastownhall/gastown)
- [Beads](https://github.com/gastownhall/beads)
- [Gas Town Docs](https://gastown.dev/)

## Secondary Watchlist

These systems are worth tracking, but they should not outrank the primary benchmark set:

### Contrabass

Useful for:

- CLI, TUI, and dashboard operator surfaces
- phased execution pipelines
- retries, stall detection, and state snapshots

Source:

- [Contrabass](https://www.contrabass.dev/)

### Optio

Useful for:

- ticket-to-PR workflow packaging
- scheduled workflow execution
- cost and deployment visibility

Source:

- [Optio](https://optio.host/)

### Quester

Useful for:

- issue-driven software-agent workflow
- dashboarded agent coordination around tickets

Source:

- [Quester](https://quester.dev/)

### OpenCastle

Useful for:

- workflow and quality-gate packaging
- multi-agent coding product ideas

Source:

- [OpenCastle](https://www.opencastle.dev/)

### ClauBoard

Useful for:

- control-plane visualization
- live event and pipeline UI ideas

Source:

- [ClauBoard](https://clauboard.dev/)

### OctoAlly

Useful for:

- operator dashboard UX for persisted CLI sessions

Source:

- [OctoAlly](https://www.octoally.com/)

### agentmux

Useful for:

- lightweight tmux-first human operator ergonomics

Source:

- [agentmux](https://agentmux.app/)

### Fusion

Useful for:

- broader multi-node agent coordination ideas

Source:

- [Fusion](https://runfusion.ai/)

## How This Should Affect The Roadmap

Use the benchmark set like this:

1. `Maestro`
   - shapes the future room and moderator model
2. `Multica`
   - shapes the future task and workspace operating model
3. `Paperclip`
   - shapes the later goal, budget, heartbeat, governance, and work-product layer
4. `Composio Agent Orchestrator`
   - shapes the later PR and CI reaction-loop branch
5. `AWS CLI Agent Orchestrator`
   - shapes human-facing CLI orchestration and control-plane ergonomics
6. `Gastown / Beads`
   - shapes later memory and durable coordination ideas

## Priority Guidance

If only one benchmark influence should be elevated next, it should be:

1. `AWS CLI Agent Orchestrator` for broker and CLI control-plane comparison
2. `Maestro` for room and moderator semantics
3. `Paperclip` for the outer goal, governance, budget, and heartbeat layer

If only one benchmark should be kept as explicitly secondary, it should be:

- `Gastown / Beads`

Reason:

They are valuable, but they are farther from the immediate product surface than Maestro, Multica, Paperclip, Composio Agent Orchestrator, or AWS CLI Agent Orchestrator.

## Relationship To Existing Docs

This document does not replace:

- [CLIAGENTS-BROKER-PLAN.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/CLIAGENTS-BROKER-PLAN.md)
- [BROKER-NATIVE-ORCHESTRATION-UX-PROPOSAL.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/BROKER-NATIVE-ORCHESTRATION-UX-PROPOSAL.md)
- [FEATURE-ACCEPTANCE-MATRIX.md](/Users/mojave/Documents/AI-projects/cliagents/docs/research/FEATURE-ACCEPTANCE-MATRIX.md)

It is the external comparison companion for those documents.

## Existing Internal Research Sources

The strongest existing local comparison notes are:

- [deep-research-comparison.md](/Users/mojave/Documents/Codex/2026-04-20-analyze-https-github-com-beehiveinnovations-pal/deep-research-comparison.md)
- [cliagents-roadmap.md](/Users/mojave/Documents/Codex/2026-04-20-analyze-https-github-com-beehiveinnovations-pal/cliagents-roadmap.md)

This document normalizes the useful conclusions from those notes into the `cliagents` repo itself.
