# Architecture Decision Records

ADRs record durable architecture decisions for `cliagents`.

## Format

Use one file per decision:

```text
NNNN-short-title.md
```

Each ADR should include:

- status: proposed, accepted, superseded, or rejected
- context
- decision
- consequences
- links to related docs or code

## Rules

- Record one decision per ADR.
- Prefer short ADRs over large essays.
- When a decision changes, add a new ADR and mark the old one superseded.
- ADRs outrank research notes when they conflict.

## Current ADRs

- [0001 Agent Control Taxonomy](./0001-agent-control-taxonomy.md)
- [0002 Session Peek And Status](./0002-session-peek-and-status.md)
- [0003 Workspace And Worktree](./0003-workspace-and-worktree.md)
- [0004 Atomic Claims And Input Leases](./0004-atomic-claims-and-input-leases.md)
