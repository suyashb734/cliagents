# cliagents Agent Guide

This file is the stable repo-local policy for coding agents working in `cliagents`.
Keep it short. Do not duplicate transient runtime configuration, MCP server lists, or broad product documentation here.

## Scope

- Use this file for project-specific engineering guidance.
- Start with [`docs/INDEX.md`](./docs/INDEX.md) for canonical architecture, roadmap, reference, and research status.
- Use [`CLAUDE.md`](./CLAUDE.md) and the docs folder for architecture notes, API details, and user-facing documentation.
- Use [`docs/research/CLIAGENTS-OPERATING-MODEL.md`](./docs/research/CLIAGENTS-OPERATING-MODEL.md) as the canonical operator policy for roots, child sessions, rooms, persistence, usage, and broker routing.
- Use [`docs/reference/BRANCH-MANAGEMENT.md`](./docs/reference/BRANCH-MANAGEMENT.md) before starting or delegating broad work.
- If guidance belongs to the current machine, shell session, or MCP profile, it does not belong here.

## Toolchain

- Use Node `22.12.0` from [`.nvmrc`](./.nvmrc).
- Run `nvm use` before interactive work when possible.
- Prefer the package scripts because they already route through [`scripts/run-with-supported-node.js`](./scripts/run-with-supported-node.js).
- If you run a focused Node test directly and native modules fail under the current shell Node, rerun it through the wrapper.

## Default Commands

- Start server: `npm start`
- Dev server: `npm run dev`
- Focused regression suite: `npm test`
- Runtime consistency suite: `npm run test:runtime`
- Broad API surface suite: `npm run test:broad`
- Branch hygiene check: `npm run branch:check`

## Architecture Defaults

- The canonical active broker surface is `claude-code`, `gemini-cli`, `codex-cli`, `qwen-cli`, and `opencode-cli`.
- Treat the broker root identity and the provider's own resume identity as separate concepts.
- Humans should create or explicitly resume top-level roots. Child sessions should be attached beneath a root, not silently turned into new roots.
- Managed roots are the main path for browser supervision. If direct provider sessions are attached later, the binding must stay explicit and consistent.
- Root and child session state should be inspectable from the control plane without depending on raw tmux output alone.
- Rooms are the primary user-facing conversation surface; runs and discussions remain the backing audit surfaces.
- `discuss_room` defaults to summary writeback. Curated transcript artifacts are opt-in and must stay distinguishable from the normal room conversation view.
- Keep `room_busy` single-active-turn semantics unless a branch explicitly widens the room concurrency model.

## Important Surfaces

- Root and tmux lifecycle: [`src/tmux/session-manager.js`](./src/tmux/session-manager.js)
- HTTP orchestration and root binding: [`src/server/orchestration-router.js`](./src/server/orchestration-router.js)
- MCP bridge and root-session tools: [`src/mcp/cliagents-mcp-server.js`](./src/mcp/cliagents-mcp-server.js)
- Orchestration logic and ledgers: [`src/orchestration`](./src/orchestration)
- Browser supervision UI: [`public/console.html`](./public/console.html), [`public/dashboard.html`](./public/dashboard.html)

## Delegation Policy

- Use direct local execution for small or tightly coupled fixes.
- Use delegated agents when a second perspective or parallel work materially improves the result.
- Give delegated workers bounded ownership and verify that their edits actually landed before depending on them.
- Treat reviewer output as advisory until the local code and tests confirm it.

## Editing Rules

- The worktree may already be dirty. Do not revert unrelated changes.
- Keep fixes small, explicit, and easy to verify.
- Add or update focused tests when behavior changes.
- Prefer improving adapter contracts, health checks, and control-plane visibility over one-off provider-specific patches.

## Documentation Rules

- Keep this file concise.
- Use [`docs/CANONICAL-MAP.json`](./docs/CANONICAL-MAP.json) to decide whether a doc is canonical, active, draft, reference, or archived.
- Do not paste MCP inventories, personal workstation paths, or temporary operational notes into this file.
- When a rule becomes adapter-specific or user-facing, move it into the appropriate doc instead of growing this file.
- Runtime and broad suites may skip provider-auth, token-expiry, provider-discontinuation, quota, capacity, or timeout failures when the broker contract itself is still behaving correctly.
