# 0001 Agent Control Taxonomy

Status: accepted

## Context

`cliagents` exposes provider CLIs, broker-managed roots, child terminals, rooms,
tasks, assignments, memory, and usage. UI copy can say "agents", but API and code
need stable nouns so orchestration work does not conflate provider identity,
runtime identity, project scope, and executable sessions.

## Decision

Use these canonical terms:

- `Provider`: external agent CLI or model surface, such as Codex CLI, Claude Code, Gemini CLI, OpenCode, or Qwen CLI.
- `Profile`: reusable intent/configuration for a provider lane, including role, model, effort, tools, permission policy, and system prompt. In this phase it may remain metadata.
- `Root`: human or supervisor managed top-level broker lane.
- `Workspace`: durable project/runtime boundary. It is not the same as a git worktree.
- `Session`: controllable execution lane. For API sessions, `sessionId` is the API session id. For broker terminals, `sessionId` is the terminal id.
- `Task`: durable project-scoped work anchor.
- `Assignment`: bounded worker/reviewer intent under a task.
- `Room`: persistent multi-participant discussion surface.
- `Memory`: derived recall surfaces over raw runs, messages, events, artifacts, findings, usage, and summaries.

The UI may continue to use "Agent Wall" and "agents" where that is clearer for
humans. Public APIs and durable docs should use the canonical nouns above.

## Consequences

New code should avoid using `agent`, `terminal`, `root`, `profile`, and
`workspace` interchangeably. Existing `terminal` APIs remain compatible, but
new session-facing APIs must state whether they accept API session ids, broker
terminal ids, or both.

## Links

- `docs/architecture/STATE-MODEL.md`
- `src/server/index.js`
- `src/server/orchestration-router.js`
