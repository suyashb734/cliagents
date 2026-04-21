---
name: token-efficient-context
description: Use when reducing prompt size for roots and child sessions without losing the information needed to execute well
adapters: [codex-cli, gemini-cli, opencode-cli, claude-code, qwen-cli]
tags: [tokens, prompting, context, workflow]
---

# Token-Efficient Context

Use this skill when you want better cost and latency without weakening execution quality.

## Core Principle

Spend tokens on task-relevant state, not on re-explaining process boilerplate.

## What To Reuse

- skill instructions for repeatable workflows
- stored artifacts for plans, code summaries, or outputs
- shared findings for issues and risks already discovered
- compact summaries of prior work

## What To Avoid

- pasting long transcripts into every child prompt
- attaching all available skills to every session
- repeating repo-wide background for narrowly scoped tasks
- copying logs when a 2 to 5 line summary will do

## Compact Context Packet

Prefer this handoff structure:

```markdown
Goal: [single sentence]
Scope: [files, modules, or command surface]
Current state: [what already exists]
Constraints: [permissions, models, deadlines, non-goals]
Acceptance: [what a successful result looks like]
Artifacts/findings: [keys or short references]
```

## Root Guidance

- Keep the root bootstrap small
- Discover capabilities with tools instead of embedding catalogs in prompts
- Invoke only the one relevant skill for the current decision or workflow
- Summarize the current state before delegating instead of replaying the whole history

## Child Guidance

- Start with the narrowest possible scope
- Include only the files and acceptance criteria that matter
- Reference stored artifacts or findings instead of pasting them in full
- Return concise summaries that the root can integrate quickly

## Escalation Rule

Add more context only when a child is blocked or has already failed with the smaller packet.
