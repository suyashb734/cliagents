# 0002 Session Peek And Status

Status: accepted

## Context

The console needs a cheap way to show what an execution lane is doing without
rendering full terminal scrollback or overloading lifecycle status with UI
diagnostics.

## Decision

Keep `status` as lifecycle state and add `peek` as a bounded read-only
operational snapshot.

- `GET /sessions/:sessionId/status` remains lifecycle-focused.
- `GET /sessions/:sessionId/peek` returns derived `sessionState`, pending input,
  active input lease, and an optional small output tail.
- `peek` accepts either an API session id or a broker terminal id.
- `peek` is derived on read and cacheable only for a very short period.
- `peek` must not become the authoritative lifecycle or audit surface.

Derived `sessionState.task` values are `working`, `needs_input`, `idle`,
`completed`, `failed`, and `stopped`. Derived `sessionState.liveness` values are
`alive`, `exited`, `orphaned`, `evicted`, and `unknown`.

## Consequences

Console and remote clients should use `status` for lifecycle decisions and
`peek` for compact display. Full transcripts, messages, root IO events, and run
details remain separate durable surfaces.

## Links

- `src/services/session-peek.js`
- `src/server/index.js`
- `public/console.html`
