# Event Normalization

Status: `reference`

Last reviewed: `2026-05-06`

## Purpose

Event normalization gives `cliagents` one broker-facing event vocabulary across
root sessions, child sessions, rooms, runs, and provider adapters.

V1 is a read-model overlay. It does not migrate historical records, replace raw
session events, or claim that every provider exposes the same fidelity.

## Normalized Event Types

- `session_started`: a broker, runtime, or provider session became known.
- `prompt_submitted`: operator or broker input was submitted to a session.
- `tool_started`: a provider reported that a tool call began.
- `tool_completed`: a provider reported that a tool call completed.
- `permission_requested`: a session is blocked waiting for an operator decision.
- `permission_replied`: an operator decision or answer was delivered.
- `tokens_reported`: adapter or provider output included token usage.
- `session_idle`: a turn completed and the session is available again.
- `session_stopped`: a session ended normally or was intentionally destroyed.
- `session_error`: a session failed, became stale, or reported an adapter error.

## Normalized Event Shape

Each normalized event keeps broker lineage plus raw-source traceability:

- `id`: derived normalized id when the source event has an id.
- `type`: one normalized event type.
- `source`: `session_events` or `adapter_event` in V1.
- `sourceEventId` and `sourceEventType`: raw event references.
- `rootSessionId`, `sessionId`, `parentSessionId`: broker session lineage.
- `runId`, `discussionId`, `traceId`: execution lineage when known.
- `sequenceNo`, `occurredAt`, `recordedAt`: ordering and timing fields.
- `originClient`: MCP, CLI, room, adapter, or other source when known.
- `adapter`, `model`, `role`, `status`: execution attribution fields.
- `summary`, `text`, `tool`, `permission`, `usage`: typed event details.
- `providerSessionId`: provider-native resume or thread id when known.
- `confidence`: currently `derived` unless a later source is authoritative.
- `gaps`: explicit missing-fidelity or unmapped-source diagnostics.
- `raw`: optional raw event payload when a caller opts into it.

## Read Surfaces

- `GET /orchestration/session-events?normalized=1` returns raw events plus
  `normalizedEvents` and `eventNormalization` diagnostics.
- `GET /orchestration/session-events?format=normalized` is equivalent.
- `GET /orchestration/root-sessions/:rootSessionId` includes normalized events
  for the bounded root snapshot event window.
- MCP `get_root_session_status` includes normalized event counts and skipped
  event counts in summary output.

## Diagnostics

The `eventNormalization` object reports:

- `inputCount`: raw events considered.
- `normalizedCount`: normalized events emitted.
- `skippedCount`: raw events that did not map to a normalized event.
- `gaps`: per-source diagnostic records for unmapped events and known
  fidelity limits.

Consumers should treat `gaps` as product data. They explain where the broker is
missing adapter coverage or where a provider does not expose enough detail.

## Adapter Coverage

V1 includes deterministic fixture normalization for:

- `codex-cli`: thread starts, tool call item starts/completions, turn completion
  usage when emitted.
- `gemini-cli`: tool calls, tool results, result status, and stats/usage fields.
- `claude-code`: system session ids, assistant tool-use blocks, tool results,
  and result usage.
- `opencode-cli`: step completion token payloads and error events.
- `qwen-cli`: init events, assistant usage, and result usage from fixtures.

## Known Gaps

- Codex CLI may expose completed tool-call items without a matching started
  notification in the available event stream.
- Codex token reporting depends on whether the CLI emits usage metadata for the
  turn; screen output alone is not enough for reliable token attribution.
- Gemini and Claude tool result details vary by CLI version and event shape.
- OpenCode step events can report usage while omitting detailed tool names.
- Qwen is covered by deterministic fixtures in V1; live Qwen paths are skipped
  when the local provider CLI is not operational.
- Provider CLIs can change event payloads without schema guarantees, so adapter
  tests should use representative fixtures and explicit gap assertions.

## Non-Goals

- No new remote input or approval API is added here.
- No raw terminal renderer or PTY event stream is introduced here.
- No historical DB rows are rewritten.
- No provider claims perfect token or permission fidelity.
