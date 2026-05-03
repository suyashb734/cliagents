---
name: broker-collaboration
description: Use when operating as a supervised root that delegates work to child sessions through cliagents
adapters: [codex-cli, gemini-cli, opencode-cli, claude-code, qwen-cli]
tags: [orchestration, root, supervision, workflow]
---

# Broker Collaboration

Use this when you are the main supervised root coordinating child sessions through cliagents.

The canonical shared operator policy lives in:

- [`docs/research/CLIAGENTS-OPERATING-MODEL.md`](/Users/mojave/Documents/AI-projects/cliagents/docs/research/CLIAGENTS-OPERATING-MODEL.md)

Use this skill as the compact workflow layer on top of that policy, not as a competing source of truth.

## First Step

Before delegating, align with the canonical operating model:

- tracked top-level work should enter through broker-owned roots
- MCP and HTTP are the default orchestration surfaces
- stronger models should plan and review
- cheaper models should execute bounded slices
- usage and memory should be inspected through durable broker surfaces

## Goals

- Keep the root prompt and state lean
- Discover broker capabilities instead of guessing
- Delegate only when the task genuinely benefits from specialization or parallel work
- Preserve enough context for child sessions without replaying whole transcripts

## Root Workflow

### 1. Discover Before Delegating

Use the broker discovery tools first:

- `list_agents` for available roles and adapters
- `list_models` for exact model catalogs on a chosen adapter
- `list_skills`, `get_skill`, and `invoke_skill` for reusable workflow guidance
- `get_root_session_status` to inspect current child activity or attention states

Do not assume which adapters, models, or skills are available.

### 2. Keep One Root, Spawn Children On Demand

- Prefer one human-supervised root per workspace
- Do not create another root unless the human explicitly asks
- Delegate only bounded subtasks with clear ownership or review scope
- Reuse an existing child session only when continuity materially helps

### 3. Route Intentionally

- Use the lightest capable adapter/model for the task
- Keep research, review, implementation, and testing responsibilities separate when that improves quality
- Prefer direct root work for urgent blocking steps
- Prefer child sessions for sidecar work that can run in parallel

### 4. Pass Compact Context Packets

When delegating, send only:

- the task goal
- the relevant files or module scope
- the acceptance criteria
- the current constraints or open risks
- references to stored artifacts or findings when available

Avoid replaying full conversations or large irrelevant logs.

### 5. Use Shared State for Handoffs

When children discover something worth preserving:

- `share_finding` for bugs, risks, or advice
- `store_artifact` for plans, outputs, or handoff summaries

Use these instead of repeating the same context in every prompt.

## Decision Rules

- If the next step is blocked on the answer, do it locally unless a child adds clear value
- If multiple independent questions exist, delegate in parallel
- If two child tasks would touch the same files, do not run them in parallel unless ownership is explicit
- If a child needs human intervention, monitor and reply only to that child instead of re-running the whole task

## Anti-Patterns

- Auto-spawning children for every task
- Sending giant transcripts as child prompts
- Guessing available models instead of checking
- Using the root as a passive dashboard instead of an integrating decision-maker
