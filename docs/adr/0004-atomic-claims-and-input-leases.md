# 0004 Atomic Claims And Input Leases

Status: accepted

## Context

Dispatch requests are the durable boundary before terminal spawn, and browser or
remote clients need safe ways to steer terminals. Both surfaces need explicit
ownership semantics before richer Agent Wall or room coordination work builds on
top of them.

## Decision

Dispatch starts use an atomic claim primitive:

- A dispatch request starts as `queued` unless it is intentionally `deferred`.
- A caller claims it with a single conditional update from `queued` or ready
  `deferred` to `claimed`.
- Claimed dispatches record `claimOwner`, `claimedAt`, and `claimExpiresAt`.
- Expired claims can be recovered by a later claimant.
- Coalesced starts do not spawn a second terminal.

Terminal input ownership V1 is a lease:

- A terminal may have one active input lease.
- The lease has `holder`, `expiresAt`, optional `rootSessionId`, optional
  `sessionId`, and optional metadata.
- Heartbeats extend the lease.
- The server may revoke a lease.
- A lease without heartbeat eventually expires; no moderator workflow is part of
  V1.

## Consequences

This adds infrastructure-level coordination without introducing a full room
moderator workflow. Profile and Workspace filters can later layer on top of
atomic claims, but they are not required to claim a dispatch in this phase.

## Links

- `src/database/migrations/0024_agent_control_foundation.sql`
- `src/database/db.js`
- `src/server/orchestration-router.js`
