# cliagents Roadmap

This file lists the active implementation order. Older roadmap and research
docs remain useful context, but this file is the current entrypoint.

## Active Order

1. **Child adapter reliability hardening**
   - Run the live child reliability matrix.
   - Rate adapters for ephemeral and collaborator readiness.
   - Gate collaborator mode where provider continuity is not reliable.

2. **Task-linked observability follow-through**
   - Keep task, assignment, run, usage, and memory linkage coherent.
   - Execute [Memory Read Model V1](../research/MEMORY-READ-MODEL-V1-PLAN.md)
     as the concrete persistence/query branch.
   - Improve live metadata completeness for model, duration, and cost where
     providers expose it.

3. **Execution isolation follow-through**
   - Harden git worktree preparation and reporting for assignment execution.
   - Keep worktrees attached to task assignments rather than making them the
     primary product object.

4. **Room-native orchestration**
   - Move room UX toward a broker-native moderator model.
   - Keep runs and discussions as audit records underneath the room transcript.

## Deferred

- full task board or team workspace product
- dependency graphs and PR/CI automation
- broad desktop app shell
- replacing tmux transport for managed roots

## Decision Rule

Prefer work that strengthens the broker thesis: durable orchestration,
inspectability, usage, memory, and reliable cheap-to-expensive delegation.
