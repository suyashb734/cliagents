# Adapter Conformance

## Purpose

This document defines the minimum broker contract for the active `cliagents` adapter surface.

It is a Phase 0 gate. Control-plane work should not proceed unless these expectations remain green.

Active supported adapters:

- `codex-cli`
- `gemini-cli`
- `qwen-cli`
- `opencode-cli`
- `claude-code`

## Required Broker Invariants

Every active adapter must:

- register through the active runtime surface
- provide its own implementations of lifecycle and session-state required methods (no reliance on base-class placeholders for `isAvailable`, `spawn`, `send`, `terminate`, `isSessionActive`, or `getActiveSessions`)
- publish explicit capability metadata
- publish an explicit adapter contract
- support broker-managed session creation
- surface the effective `workDir`
- surface the effective `model`
- support broker termination
- expose explicit timeout semantics through broker contract metadata
- implement `classifyFailure(error)` to map provider/runtime failures into broker-visible error classes
- support session liveness tracking (heartbeat and state detection)

## Failure Classification

Adapters must classify failures into the following standard classes defined in `src/adapters/contract.js`:

- `auth`: Credential or permission failures
- `timeout`: Connection or response timeouts
- `rate_limit`: Provider-side quota or capacity limits
- `tool_error`: Tool invocation or tool bridge failures
- `process_exit`: Unexpected CLI termination
- `protocol_parse`: Failure to decode provider responses
- `validation`: Invalid request parameters
- `cancelled`: Explicitly aborted runs
- `unknown`: Unclassified errors

## Run States

Adapters must support the standard lifecycle of a run as defined in the contract:

- `ready`: Session initialized but no messages sent
- `running`: Active message processing
- `completed`: Successfully finished task
- `blocked`: Waiting for external intervention (e.g., human-in-the-loop)
- `failed`: Terminal failure state (should include a `failureClass`)
- `abandoned`: Lost liveness or timeout reached

## Timeout Semantics

Adapters must publish timeout semantics in their contract metadata and support broker introspection through `getTimeoutInfo()`.

Minimum expectations:

- a default timeout in milliseconds
- a default timeout type
- the standard timeout types:
  - `connection`
  - `response`
  - `idle`
  - `spawn`

## Liveness & Heartbeat Semantics

To prevent "zombie" runs and enable robust orchestration, adapters must support:

1. **Heartbeat Recording**: Sessions must support `recordHeartbeat(sessionId)` to update the last-seen timestamp.
2. **Liveness Detection**: `getSessionLiveness(sessionId)` must return one of:
   - `alive`: Process is healthy and heartbeats are recent.
   - `stale`: Heartbeats have lapsed beyond the threshold (e.g., 30s).
   - `dead`: Process has exited or session is unrecoverable.
3. **Active Enumeration**: `isSessionActive(sessionId)` and `getActiveSessions()` must accurately reflect the local process state.

## Runtime Expectations

The runtime conformance gate currently covers:

1. Session metadata
- `POST /sessions` persists and returns the effective `workDir`
- `POST /sessions` persists and returns the effective `model`
- `GET /sessions/:id`
- `GET /sessions/:id/status`
- `GET /sessions`

2. Working-directory behavior
- broker one-shot execution with `workingDirectory`
- adapter can read broker-provided local context from that directory

3. Multi-turn behavior
- if the adapter advertises resume support, it must preserve context across turns in a broker-managed session

## Allowed Runtime Reality

The broker must surface the **effective** model, not just the requested model.

That matters most for `gemini-cli`, where capacity fallback may legitimately move a session from the requested model to another advertised Gemini model during initialization.

## Current Test Gates

Static contract gate:

- [tests/test-adapter-contract.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-adapter-contract.js)

Runtime conformance gate:

- [tests/test-adapter-conformance-runtime.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-adapter-conformance-runtime.js)

Focused suite entrypoint:

- [tests/test-focused-surface.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-focused-surface.js)

Broader broker regression:

- [tests/test-broad-api-surface.js](/Users/mojave/Documents/AI-projects/cliagents/tests/test-broad-api-surface.js)

## Failure Policy

- contract mismatch: fail
- missing active adapter registration: fail
- provider auth/token-expiry/discontinuation/quota/capacity/rate-limit/timeout unavailability: skip
- broker route regression: fail

## Next Conformance Additions

The next Phase 0 additions should be:

- interrupt contract per adapter
- model-selection override behavior for orchestration routes and MCP tools
