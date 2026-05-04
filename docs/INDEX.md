# cliagents Documentation Index

This is the entrypoint for project documentation. Use it before relying on
older planning notes in `docs/research/`.

## Source Of Truth

- [Architecture](./architecture/ARCHITECTURE.md): core broker objects and how they fit together.
- [State Model](./architecture/STATE-MODEL.md): session kinds, statuses, and task rollups.
- [Adapter Contract](./reference/ADAPTER-CONTRACT.md): adapter lifecycle and collaborator readiness.
- [MCP Tools](./reference/MCP-TOOLS.md): broker tool surface overview.
- [Roadmap](./roadmap/ROADMAP.md): active implementation order.
- [ADR Index](./adr/README.md): durable architecture decision record rules.
- [Operator Model](./research/CLIAGENTS-OPERATING-MODEL.md): how humans and agents should use roots, children, rooms, usage, and memory.
- [Feature Acceptance Matrix](./research/FEATURE-ACCEPTANCE-MATRIX.md): proof status by subsystem.
- [Canonical Map](./CANONICAL-MAP.json): machine-readable index for coding agents.

## Active Plans

- [Child Collaboration Implementation Plan](./research/CHILD-COLLABORATION-IMPLEMENTATION-PLAN.md)
- [Child Adapter Reliability](./research/CHILD-ADAPTER-RELIABILITY.md)
- [Broker Native Orchestration UX Proposal](./research/BROKER-NATIVE-ORCHESTRATION-UX-PROPOSAL.md)

## Reference And How-To

- [Knowledge Graph Guidance](./reference/KNOWLEDGE-GRAPH.md)
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
