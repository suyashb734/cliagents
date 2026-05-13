# cliagents Changelog

All notable release-facing changes are documented here. `cliagents` is currently
pre-stable; public APIs and storage shapes may change between alpha releases.

## [0.1.0-alpha.0] - 2026-05-11

### Added

- Local broker/control-plane surface for Claude Code, Codex CLI, Gemini CLI,
  Qwen CLI, and OpenCode.
- HTTP, WebSocket, OpenAI-compatible, and MCP entrypoints for local agent work.
- Broker-managed roots, child sessions, rooms, runs, tasks, assignments, memory
  bundles, usage summaries, and runtime-neutral remote snapshots.
- SQLite-backed run ledger, task assignment state, terminal/session events,
  root IO events, dispatch requests, run context snapshots, and task/session
  bindings.
- Local-token authentication by default when no explicit API key is configured.
- Release-hardening checks for canonical docs, package contents, tracked local
  artifacts, focused tests, runtime consistency, and auth fail-closed behavior.

### Changed

- Release posture is GitHub-only alpha. The package is marked private and is not
  intended for npm publication in this release.
- Adapter documentation now distinguishes alpha support from experimental or
  degraded provider paths.
- Public docs now point to the canonical documentation map and describe active
  alpha caveats rather than older planning claims.

### Known Alpha Caveats

- Native provider TUIs inside tmux do not always match direct CLI UI fidelity.
- Live provider tests depend on local auth, quota, capacity, and upstream CLI
  behavior.
- Qwen CLI is experimental/degraded until the live reliability matrix proves the
  current auth and continuity path.
- MCP stdio clients may need restart after broker restarts so they pick up the
  current broker/token state.
- Usage metadata is limited to what provider CLIs expose or what the broker can
  observe.
