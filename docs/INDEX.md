# cliagents Documentation Index

This is the entrypoint for project documentation. Use it before relying on
older planning notes in `docs/research/`.

## Source Of Truth

- [Architecture](./architecture/ARCHITECTURE.md): core broker objects and how they fit together.
- [State Model](./architecture/STATE-MODEL.md): session kinds, statuses, and task rollups.
- [Adapter Contract](./reference/ADAPTER-CONTRACT.md): adapter lifecycle and collaborator readiness.
- [Event Normalization](./reference/EVENT-NORMALIZATION.md): normalized broker event contract and adapter gaps.
- [Remote API](./reference/REMOTE-API.md): runtime-neutral snapshot and remote access rules.
- [Terminal Input Queue](./reference/INPUT-QUEUE.md): remote-safe input, approval, denial, and control-mode states.
- [MCP Tools](./reference/MCP-TOOLS.md): broker tool surface overview.
- [Alpha Release Checklist](./reference/ALPHA-RELEASE.md): public-alpha release gates and evidence.
- [Roadmap](./roadmap/ROADMAP.md): active implementation order.
- [ADR Index](./adr/README.md): durable architecture decision record rules.
- [Agent Control Taxonomy ADR](./adr/0001-agent-control-taxonomy.md): canonical nouns for providers, profiles, roots, workspaces, sessions, tasks, assignments, rooms, and memory.
- [Session Peek And Status ADR](./adr/0002-session-peek-and-status.md): `status` lifecycle contract and bounded `peek` snapshot contract.
- [Workspace And Worktree ADR](./adr/0003-workspace-and-worktree.md): durable workspace boundary versus git worktree isolation.
- [Atomic Claims And Input Leases ADR](./adr/0004-atomic-claims-and-input-leases.md): dispatch claim and terminal input lease rules.
- [Operator Model](./research/CLIAGENTS-OPERATING-MODEL.md): how humans and agents should use roots, children, rooms, usage, and memory.
- [Feature Acceptance Matrix](./research/FEATURE-ACCEPTANCE-MATRIX.md): proof status by subsystem.
- [Canonical Map](./CANONICAL-MAP.json): machine-readable index for coding agents.

## Active Plans

- [Child Collaboration Implementation Plan](./research/CHILD-COLLABORATION-IMPLEMENTATION-PLAN.md)
- [Child Adapter Reliability](./research/CHILD-ADAPTER-RELIABILITY.md)
- [Memory Read Model V1 Plan](./research/MEMORY-READ-MODEL-V1-PLAN.md)
- [Runtime Host And Remote Control Plan](./research/RUNTIME-HOST-REMOTE-CONTROL-PLAN.md)
- [Broker Native Orchestration UX Proposal](./research/BROKER-NATIVE-ORCHESTRATION-UX-PROPOSAL.md)

## Reference And How-To

- [Knowledge Graph Guidance](./reference/KNOWLEDGE-GRAPH.md)
- [Event Normalization](./reference/EVENT-NORMALIZATION.md)
- [Remote API](./reference/REMOTE-API.md)
- [Terminal Input Queue](./reference/INPUT-QUEUE.md)
- [Alpha Release Checklist](./reference/ALPHA-RELEASE.md)
- [Track A Launch Profile](./reference/LAUNCH-PROFILE.md)
- [Failure And Retry Taxonomy](./reference/FAILURE-RETRY-TAXONOMY.md)
- [Troubleshooting](./TROUBLESHOOTING.md)
- [Adding Adapters](./adding-adapters.md)
- [Historical Adapter Notes](./adapters.md)

## Research Notes

Files in `docs/research/` are useful context, but they are not automatically
canonical. Check [Canonical Map](./CANONICAL-MAP.json) before treating a research
note as current policy.

## Documentation Rules

- Canonical docs describe current project truth.
- Active plans describe approved next work.
- Draft docs are useful but not binding.
- Archived docs are retained for history and should not drive implementation.
- ADRs capture durable decisions and should supersede older conflicting notes.
