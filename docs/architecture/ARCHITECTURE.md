# cliagents Architecture

`cliagents` is a local broker for official coding CLIs. Its core job is to
route work, preserve execution state, and make multi-agent work inspectable.

## Core Objects

- **Root session**: a human-managed broker lane. Managed roots are launched or
  resumed by `cliagents` and own child sessions, rooms, runs, usage, and memory.
- **Child session**: a broker-owned worker lane under a root. Ephemeral children
  are bounded workers; collaborator children preserve provider continuity.
- **Room**: a shared conversation surface for multi-agent discussion. Room
  transcript is user-facing; runs and discussions remain backing audit records.
- **Run**: durable record of an orchestration execution, including participants,
  outputs, failures, usage, and replay metadata.
- **Task**: project-scoped anchor above roots, rooms, runs, assignments, usage,
  and memory.
- **Task assignment**: intent record for a bounded worker or reviewer lane.
  Assignments can carry worktree metadata; run participants remain execution
  truth for a specific run.
- **Usage record**: token and cost metadata linked to run, terminal, task, and
  assignment scopes when known.
- **Root IO event**: redacted, ordered input/output or parsed-message event for
  reconstructing native interactive roots without relying only on raw tmux logs.
- **Memory snapshot**: derived continuity bundle over root, run, or task history.
  Task bundles include runs, assignments, linked rooms, usage, and recent root
  session events.
- **Memory summary edge**: provenance edge from a derived summary to the records
  or scopes it summarizes, supersedes, or derives from.

## Main Surfaces

- **MCP**: primary agent-facing tool surface for delegation, rooms, memory,
  usage, tasks, and inspection.
- **HTTP**: neutral programmatic surface for broker routes and local UI.
- **CLI**: human entrypoint for managed roots and server lifecycle.
- **Console UI**: operator inspection surface for roots, rooms, runs, and usage.

## Execution Modes

- **Direct session adapters** serve simple REST and OpenAI-compatible paths.
- **Tmux-backed persistent sessions** serve managed roots and child workers.
- **Room and discussion runners** coordinate multi-agent turns and persist audit
  records.

## Design Rule

The broker state is the source of truth. Provider-native sessions, tmux panes,
and generated transcripts are runtime details unless they are linked back into
the durable broker model.
