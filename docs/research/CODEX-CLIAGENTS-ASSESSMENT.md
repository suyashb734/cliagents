# cliagents assessment

Date: 2026-04-07

Method:
- I attempted the requested live checks (`curl http://localhost:4001/...`), but this sandbox denies `listen()` on local sockets, so `localhost:4001` could not be bound here.
- I still exercised the server in-process through `AgentServer.app`, `SessionManager`, `PersistentSessionManager`, `OrchestrationDB`, and direct adapter calls.
- `npm start` initially failed because `better-sqlite3` was built for a different Node ABI. After `npm rebuild better-sqlite3`, `AgentServer` constructed successfully in-process.
- `curl http://localhost:11434/api/tags` failed, so Ollama was not running in this environment.

## What works

- `GET /health` returns `200` with `{ status: "ok", timestamp }`.
- `GET /adapters` returns `200` and registers 8 adapters in this environment: `claude-code`, `gemini-cli`, `gemini-api`, `codex-cli`, `amazon-q`, `mistral-vibe`, `github-copilot`, `ollama`.
- `GET /orchestration/roles`, `GET /orchestration/adapters`, and `GET /orchestration/memory/stats` all returned `200` in-process.
- Shared-memory persistence works at the DB layer: `storeFinding`, `storeArtifact`, `storeContext`, and `getTaskMemory` all worked and returned the stored records.
- `OpenAICompatAdapter.getAvailableModels()` works when called directly for static-model adapters like Ollama.
- `claude`, `gemini`, `codex`, and `tmux` binaries are installed on this machine.

## What’s broken

- Out-of-the-box startup is broken until `better-sqlite3` is rebuilt for the active Node version.
- A `github-copilot` session breaks `GET /sessions` with `500 isSessionActive() must be implemented by subclass`.
- `SessionManager.interruptSession()` reports `github-copilot` sessions as interrupted even when no process is running.
- `/adapters` serializes OpenAI-compatible model lists as `{}` instead of arrays because it stores unresolved Promises.
- `server.stop()` does not stop the inbox delivery loop; the process remains alive after shutdown unless the caller stops `inboxService` or forces exit.
- Ollama session creation correctly fails early here because the local Ollama server is not reachable.

## What’s incomplete / stub

- `src/orchestration/discussion-manager.js` exists and has tests, but it is not wired into the runtime orchestration path. It is effectively a standalone component today.
- `DiscussionManager`’s “event-driven” wakeup path is not implemented: `waiters` and `maxPendingQuestions` are unused, and `_waitWithNotification()` is still timeout polling.
- `amazon-q` and `github-copilot` are advertised as orchestration adapters, but there are no status detectors for them in `src/status-detectors/factory.js`.
- `tests/run-all.js` is stale: it still asserts exactly 7 adapters and assumes an external server is already running on `localhost:4001`.

## Top 10 issues

1. `github-copilot` does not implement the required base adapter lifecycle contract, which breaks session listing and cleanup. `BaseLLMAdapter` requires `isSessionActive()` and `getActiveSessions()` at `src/core/base-llm-adapter.js:134-172`, but `src/adapters/github-copilot.js` never implements them. Result: `SessionManager.listSessions()` calls `adapter.isSessionActive()` at `src/core/session-manager.js:337-344` and throws, and shutdown logs cleanup errors at `src/core/session-manager.js:449`.

2. `github-copilot` returns the wrong type from `interrupt()`. `SessionManager.interruptSession()` expects a boolean at `src/core/session-manager.js:311-313`, but `src/adapters/github-copilot.js:275-281` returns objects like `{ status: 'no_active_process' }`, which are truthy. Result: false-positive “interrupted: true”.

3. `/adapters` does not await async model discovery. At `src/server/index.js:337-350`, `adapterInfo.models = adapter.getAvailableModels();` stores a Promise. That is why `ollama`/`gemini-api` models came back as `{}` in the route response even though `OpenAICompatAdapter.getAvailableModels()` returns a real array when awaited.

4. The chunk protocol is inconsistent across adapters, `sendAndWait()`, and SSE. `OpenAICompatAdapter` emits `type: 'progress'` at `src/adapters/openai-compat.js:188`, but `BaseLLMAdapter.sendAndWait()` only accumulates `type: 'text'` at `src/core/base-llm-adapter.js:79-90`, and the SSE path only forwards `type: 'chunk'` at `src/server/index.js:487-496`. Result: successful progress-streaming adapters can return empty `text`, and SSE won’t stream incremental tokens for them.

5. The MCP server drops query strings. `callCliagents()` builds a URL at `src/mcp/cliagents-mcp-server.js:59` but only sends `url.pathname` at `src/mcp/cliagents-mcp-server.js:64`. `handleGetSharedFindings()` builds `?type=...&severity=...` at `src/mcp/cliagents-mcp-server.js:751-754`, but those filters never reach the server.

6. The MCP server’s async workflow implementation contradicts its own contract. The docs say `feature` and `bugfix` are sequential at `src/mcp/cliagents-mcp-server.js:194-197`, but async mode explicitly “Start[s] all steps in parallel” at `src/mcp/cliagents-mcp-server.js:560-598`. That can run test/fix steps before planning or implementation finishes.

7. Orchestration advertises adapters that it cannot actually track. `config/agent-profiles.json:23-30` exposes `amazon-q` and `github-copilot`, but `src/status-detectors/factory.js:11-15` only registers detectors for `claude-code`, `gemini-cli`, and `codex-cli`. `PersistentSessionManager.getStatus()` falls back to cached state when no detector exists at `src/tmux/session-manager.js:692-710`, so wait/completion semantics are unreliable for those adapters.

8. The tmux/status failure path can misreport dead panes as idle. `TmuxClient.getHistory()` returns `''` on capture failure at `src/tmux/client.js:268-269`, and `BaseStatusDetector.detectStatus()` defaults unknown/empty output to `idle` at `src/status-detectors/base.js:83-89`. That can make broken or detached terminals look ready/completed.

9. Tmux readiness is over-optimistic. Server init only checks `which tmux` at `src/server/index.js:197-199` and then reports orchestration enabled at `src/server/index.js:252`, but actual tmux use can still fail immediately on socket creation. In this environment, `tmux new-session` failed with `error creating /private/tmp/tmux-501/default (Operation not permitted)`. There is no preflight that validates tmux is actually usable.

10. `OpenAICompatAdapter.isAvailable()` is not a real health check for remote providers. At `src/adapters/openai-compat.js:63-74`, local/no-key providers probe `/models`, but any remote provider with a non-empty API key returns `true` without validating DNS, base URL, or auth. I verified that a fake adapter pointed at `https://invalid.example/v1` still reported `available: true`.

## Recommended fix order

1. Fix the `github-copilot` adapter contract first: implement `isSessionActive()` and `getActiveSessions()`, and make `interrupt()` return a boolean. This removes the current `/sessions` 500s, false interrupts, and shutdown errors.

2. Normalize the streaming contract next. Pick one chunk vocabulary (`chunk` vs `progress` vs `text`) and make adapters, `BaseLLMAdapter.sendAndWait()`, and SSE all agree. Fix `/adapters` to `await` model discovery while you are in that area.

3. Harden orchestration status handling: add detectors for every advertised orchestration adapter, stop defaulting empty/unknown output to `idle`, and add a real tmux usability preflight instead of only `which tmux`.

4. Fix the MCP transport bugs: preserve `url.search` in `callCliagents()`, and make async workflows honor the documented sequencing for `feature`/`bugfix`.

5. Clean up the unfinished pieces: stop `InboxService` inside `server.stop()`, either integrate `DiscussionManager` or remove it from the supported surface, and update the test suite to the current adapter set and startup model.
