# Feature Acceptance Matrix

**Date:** May 2, 2026
**Purpose:** Define what "feature works entirely" means in `cliagents`, map the current major features to concrete evidence, and identify the remaining proof gaps.

## Why This Exists

`cliagents` has a large and valuable test suite, but it does not yet have one canonical document that answers this question:

> For a given feature, is it proven at the schema, API, MCP, UI, persistence, and live-provider levels?

This matrix is the answer key for that question.

It should be used to:

- decide whether a feature is actually ready
- choose the next hardening branch
- avoid relying on intuition after one green test run
- separate "code exists" from "feature is fully proven"

## Coverage Dimensions

Every major feature is scored across these dimensions:

- `Unit / Schema`: migrations, DB invariants, service-level logic, or other low-level behavior
- `Route / API`: HTTP route behavior and response contracts
- `MCP`: MCP tool behavior and output contracts
- `UI`: `/console`, `/runs`, or other browser-visible operator surfaces
- `Restart / Persistence`: behavior after process restart or DB reload
- `Live Provider Soak`: real provider-backed execution, not just fakes/stubs

## Status Labels

- `Fully covered`: all applicable dimensions are proven and no material live gap remains
- `Partially covered`: core dimensions are proven, but one or more important dimensions remain open
- `UI gap`: backend behavior is strong, but the operator surface is still incomplete
- `Live gap`: deterministic tests are strong, but real provider-backed proof is missing or thin
- `Degraded path`: feature exists, but provider/auth/capacity issues still limit confidence
- `Adapter-limited`: feature is intentionally implemented for only part of the adapter surface

## Current Matrix

| Feature | Unit / Schema | Route / API | MCP | UI | Restart / Persistence | Live Provider Soak | Current Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rooms | Proven | Proven | Proven | Partial | Proven | Proven | Partially covered, UI gap |
| Review / Consensus / Discussion workflows | Proven | Proven | Partial | Partial | Partial | Partial | Partially covered |
| Run ledger and replay | Proven | Proven | Proven | Proven | Partial | Partial | Partially covered, live gap |
| Persistence / memory snapshots | Proven | Proven | Proven | N/A | Proven | Partial | Partially covered, live gap |
| Root / session control plane | Proven | Proven | Proven | Partial | Proven | Partial | Partially covered |
| Provider-session bridge | Proven | Proven | Proven | N/A | Proven | Partial | Partially covered, adapter-limited |
| MCP delegation / status | Proven | N/A | Proven | N/A | Partial | Partial | Partially covered |
| Usage accounting | Proven | Proven | Proven | Missing | Proven | Partial | Partially covered, UI gap |
| OpenAI-compatible API | Partial | Proven | N/A | N/A | Partial | Partial | Degraded path |
| tmux worker / runtime paths | Partial | Proven | Partial | N/A | Partial | Partial | Degraded path |

## Evidence By Feature

### 1. Rooms

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-provider-sessions-and-rooms.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-room-continuity.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-room-continuity-live.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-console-ui.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-root-session-tools.js`

**What is proven**

- room creation, messaging, and discussion routes
- MCP room tools
- restart continuity
- imported provider-session seeding
- live Claude + Codex room continuity across restart

**Remaining gaps**

- `/console` is read-oriented, not a full room action surface
- room-native discussion is opt-in, not the product default
- no dedicated room-specific event stream yet

### 2. Review / Consensus / Discussion Workflows

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-discussion-runner.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-review-protocols.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-review-routes.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-workflow-time-budgets.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-discussion-replay-routes.js`

**What is proven**

- bounded discussion and review orchestration
- partial-run handling and timing behavior
- replay/readout routes

**Remaining gaps**

- no single canonical live soak suite for all workflow types
- UI is still ledger-oriented, not a full orchestration cockpit
- restart semantics are proven more strongly for rooms than for generic workflows

### 3. Run Ledger And Replay

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-schema.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-service.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-partial-runs.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-routes.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-ui.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-run-ledger-tools.js`

**What is proven**

- schema and service behavior
- route contracts
- MCP access
- basic UI inspection

**Remaining gaps**

- no dedicated restart-focused replay proof beyond broader persistence tests
- live provider-backed replay is exercised indirectly, not by a dedicated ledger soak

### 4. Persistence / Memory Snapshots

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-persistence-v1-slice-b.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-root-session-tools.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-provider-sessions-and-rooms.js`

**What is proven**

- run/root memory snapshot behavior
- durable raw message window retrieval
- repair and retrieval wiring

**Remaining gaps**

- no dedicated live-provider soak for memory surfaces
- no major user-facing UI for memory yet, which is acceptable for v1 but still a visibility gap

### 5. Root / Session Control Plane

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-session-control-plane-schema.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-session-control-plane-runtime.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-direct-session-control-plane.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-managed-root-launch.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-managed-root-recovery.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-root-session-monitor.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-orchestration-introspection-routes.js`

**What is proven**

- schema and runtime semantics
- managed root launch and recovery
- route-level introspection
- MCP surface through root-session tools

**Remaining gaps**

- live broken-session recovery has improved, but still needs more operator-facing proof
- UI surfaces exist, but are still not the final broker-native operator experience

### 6. Provider-Session Bridge

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-provider-sessions-and-rooms.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-managed-root-recovery.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-root-session-tools.js`

**What is proven**

- provider-session listing/import surfaces
- imported attached-root behavior
- reuse in rooms and recovery flows

**Remaining gaps**

- v1 is intentionally Codex-only for local provider-session discovery/import
- no dedicated UI for provider-session browsing/import yet

### 7. MCP Delegation / Status

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-delegate-task.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-batch-status.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-root-session-tools.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-run-ledger-tools.js`

**What is proven**

- delegate and status flows
- batch status behavior
- root-session MCP tools
- stale `PROCESSING` settlement from terminal output

**Remaining gaps**

- no dedicated restart-proof suite for all status transitions
- live MCP behavior depends on the running server picking up the latest patches after restart

### 8. Usage Accounting

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-usage-ledger.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-discussion-runner.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-run-ledger-routes.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-mcp-run-ledger-tools.js`

**What is proven**

- run-linked usage rows from direct-session orchestration outputs
- nested usage metadata parsing
- MCP and route-level usage summaries
- live session validation after restart that `runId`-scoped usage totals are persisted

**Remaining gaps**

- no UI yet for run usage totals
- metadata completeness is still partial in some live paths:
  - `model` may be `unknown`
  - `costUsd` may be `0`
  - `durationMs` may be `0`

### 9. OpenAI-Compatible API

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-openai-compat.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-broad-api-surface.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-runtime-consistency.js`

**What is proven**

- request/response surface exists and is exercised
- broad compatibility is tested

**Remaining gaps**

- provider-specific auth and capacity issues still create degraded paths
- live-provider proof is conditional on adapter health and credentials

### 10. tmux Worker / Runtime Paths

**Evidence**

- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-tmux-client.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-session-manager-recovery.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-cli-commands.js`
- `/Users/mojave/Documents/AI-projects/cliagents/tests/test-runtime-consistency.js`

**What is proven**

- tmux client behavior
- recovery surfaces
- Gemini one-shot stateless worker semantics

**Remaining gaps**

- provider startup and timeout behavior are still the noisiest part of the broker
- live proof is real, but still the least deterministic surface in the system

## Current Manual Live Proofs

These are not replacements for automated tests, but they do matter because several recent bugs only appeared in real broker sessions:

- live Claude + Codex room continuity across restart
- live run usage validation after restart for `runId`-scoped summaries
- live stale-`PROCESSING` delegated-task settlement bug reproduction and fix

## What This Means Right Now

1. `cliagents` has strong feature coverage, but not complete acceptance proof for every major feature.
2. The most common missing dimensions are:
   - operator UI completeness
   - dedicated live-provider soak coverage
   - richer restart/recovery proof for cross-surface behavior
3. The next work should be chosen from the highest-risk uncovered dimensions, not from whatever feature looks most exciting.

## Recommended Near-Term Priority

1. `Usage UX`
   - backend usage capture is now materially better than the UI surface
2. `Rooms V2 Console Actions`
   - the room backend is ahead of the console interaction model
3. `Control-plane live soak hardening`
   - especially around restart, settlement, and provider degradation

