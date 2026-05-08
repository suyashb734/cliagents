# cliagents Roadmap

This file lists the active implementation order. Older roadmap and research
docs remain useful context, but this file is the current entrypoint.

## Active Order

1. **Child adapter reliability hardening**
   - Run the live child reliability matrix.
   - Rate adapters for ephemeral and collaborator readiness.
   - Gate collaborator mode where provider continuity is not reliable.
   - Make compatible child reuse the default under an attached root, and expose
     the reuse decision whenever the broker reuses or skips a settled lane.

2. **Task-linked observability follow-through**
   - Keep task, assignment, run, usage, and memory linkage coherent.
   - Execute [Memory Read Model V1](../research/MEMORY-READ-MODEL-V1-PLAN.md)
     as the concrete persistence/query branch.
   - Add native interactive-root persistence so broker-managed Codex, Claude,
     Gemini, Qwen, and OpenCode roots are not only raw tmux logs. Persist
     broker-sent inputs, visible terminal output events, best-effort parsed
     messages, continuation summaries, and provider usage where exposed.
   - Treat persistence as the substrate for external supervisors such as
     OpenClaw or Hermes: they should be able to inspect what work happened,
     which workers did it, what changed, what remains blocked, and what context
     should be carried forward.
   - Build derived memory as layered summaries over raw events: brief,
     decisions, blockers, next actions, and eventually a tree or graph of
     conversation/run summaries.
   - Own `root_io_events` and summary-lineage edges in the Memory Read Model
     branch so Long-Horizon orchestration does not introduce competing
     persistence tables. Foundation migration, helpers, projections, broker
     input producers, deduplicated screen snapshots, usage events, tool events,
     liveness events, generated run/root snapshot lineage edges, bounded
     terminal-log output chunks with byte offsets, task memory bundle enrichment,
     root IO fallback bundles, room-scoped snapshots, task/project summary
     producers, and tests landed.
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
   - Current V1 hardening validates that existing registered worktrees are on
     the requested branch before launch and returns the prepared isolation
     summary on task assignment read surfaces.

5. **Room-native orchestration**
   - Move room UX toward a broker-native moderator model.
   - Keep runs and discussions as audit records underneath the room transcript.
   - Current V1 slice stores a structured moderator readout on each discussion
     turn and exposes it through room read surfaces and MCP room tools.

6. **Long-horizon orchestration mechanics**
   - Execute [Long-Horizon Orchestration V1](../research/LONG-HORIZON-ORCHESTRATION-V1-PLAN.md)
     after the runtime/control-plane foundation is stable.
   - Adopt Paperclip-style pre-run dispatch requests, immutable run context
     snapshots, task/session bindings, coalescing, defer, and liveness policies.
   - Use dispatch requests as the durable queue boundary before spawning work,
     but keep native interactive-root capture as the audit boundary for
     human-managed roots.
   - Start with a Phase 0 contract freeze for dispatch state, context snapshot
     immutability, task-session binding history, reuse policy, redaction,
     retention, and benchmark gates before implementation workers edit files.
   - Current foundation migration adds `dispatch_requests`,
     `run_context_snapshots`, and `task_session_bindings` with immutable
     context snapshots and append-only root-scoped session bindings. Task
     assignment start now populates dispatch, context, and binding rows around
     the existing task/router spawn path, and assignment read surfaces expose
     compact dispatch/session-binding summaries. The memory read model also
     projects these records for supervisor query and lineage inspection, and
     task memory bundles expose compact dispatch/context/binding summaries.
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
