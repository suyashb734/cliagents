# MCP Tools Reference

The MCP server is the primary agent-facing control surface for `cliagents`.

## Main Tool Groups

- **Root sessions**: launch, attach, resume, recover, inspect, and list roots.
- **Children**: delegate work, reply to known terminals, list child sessions,
  and wait or watch task status.
- **Rooms**: create rooms, send room turns, discuss, list rooms, and inspect
  transcripts.
- **Runs**: list runs, inspect run detail, replay discussion outputs, and review
  persisted execution records.
- **Tasks**: create tasks, create branch-aware assignments, start assignments,
  update assignment branch state, integrate accepted assignment branches, list
  tasks, and inspect task state.
- **Adapter readiness**: list or inspect effective child and collaborator
  readiness before delegating.
- **Usage**: summarize usage by root, terminal, run, task, or assignment.
- **Memory**: retrieve memory bundles for run, root, room, task, or project
  scopes, plus durable message windows.
- **Remote snapshot**: inspect one runtime-neutral broker snapshot for
  remote/web/mobile control surfaces.
- **Terminal input queue**: queue, approve, deny, cancel, and deliver
  remote-safe terminal input.

## Source Of Truth

The executable tool definitions live in
`src/mcp/cliagents-mcp-server.js`. This file is an index for humans and agents;
it is not a generated schema.

## Operating Rule

Use MCP for tracked orchestration. Use raw provider CLIs only for disposable work
that does not need broker persistence, usage, memory, or replay.

`delegate_task` should prefer compatible settled child-session reuse when the
caller is attached to a root session. Its result should expose the broker reuse
decision: whether reuse was preferred, whether it was selected, the candidate
terminal when relevant, and why a new binding was required. Use
`reply_to_terminal` instead when the operator wants exact continuation of one
known terminal.
