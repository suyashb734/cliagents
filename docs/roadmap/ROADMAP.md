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

3. **Runtime host and remote-control foundation**
   - Execute [Runtime Host And Remote Control](../research/RUNTIME-HOST-REMOTE-CONTROL-PLAN.md)
     before any broad remote API or remote UI branch.
   - Formalize tmux as one runtime host, not the whole architecture.
   - Add adopted native sessions as the first answer to human-facing TUI
     fidelity issues.
   - Keep direct PTY ownership deferred until event capture and supervision are
     stronger.

4. **Execution isolation follow-through**
   - Harden git worktree preparation and reporting for assignment execution.
   - Keep worktrees attached to task assignments rather than making them the
     primary product object.

5. **Room-native orchestration**
   - Move room UX toward a broker-native moderator model.
   - Keep runs and discussions as audit records underneath the room transcript.

6. **Long-horizon orchestration mechanics**
   - Execute [Long-Horizon Orchestration V1](../research/LONG-HORIZON-ORCHESTRATION-V1-PLAN.md)
     after the runtime/control-plane foundation is stable.
   - Adopt Paperclip-style pre-run dispatch requests, immutable run context
     snapshots, task/session bindings, coalescing, defer, and liveness policies.
   - Keep this as an execution-control model, not a generic task-board product.

## Deferred

- full task board or team workspace product
- dependency graphs and PR/CI automation
- broad desktop app shell
- removing tmux as a managed/autonomous runtime host
- full terminal emulator or PTY renderer

## Decision Rule

Prefer work that strengthens the broker thesis: durable orchestration,
inspectability, usage, memory, and reliable cheap-to-expensive delegation.
