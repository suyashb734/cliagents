---
name: adding-adapters
description: Use when creating, modifying, or reviewing a cliagents provider adapter for a CLI tool such as Codex, Claude Code, Gemini CLI, Qwen CLI, or OpenCode.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Adding Adapters

This is a thin repo-local skill. Do not treat this file as the adapter
specification.

## Canonical Docs

Read these first:

- `docs/INDEX.md` for canonical documentation status.
- `docs/adding-adapters.md` for the adapter implementation guide.
- `docs/reference/ADAPTER-CONTRACT.md` for required lifecycle and capability
  metadata.
- `docs/research/CHILD-ADAPTER-RELIABILITY.md` for live child/collaborator
  readiness expectations.

## Workflow

1. Identify whether the change is a direct-session adapter, persistent runtime
   path, child-session behavior, or model-routing change.
2. Inspect the nearest existing adapter with the same execution style.
3. Implement against `src/core/base-llm-adapter.js` and publish capabilities
   through `src/adapters/contract.js` when applicable.
4. Wire registration and routing only after the adapter has availability,
   launch/send/resume, failure classification, and usage behavior documented.
5. Add focused tests for availability, command construction, working directory,
   model selection, timeout/error behavior, and child readiness.

## Guardrails

- Do not duplicate adapter documentation here.
- Do not advertise collaborator readiness until provider-thread continuity is
  tested.
- Do not add an adapter to broad routing surfaces if status detection,
  availability/auth checks, or working-directory behavior is unknown.
- Keep provider-specific hacks behind the adapter boundary.
