# cliagents Roadmap: Consensus, Run Ledger, Shared Tools, and UI

## Intent

This plan assumes the near-term target is `gemini-cli`, `codex-cli`, and `qwen-cli`.
Other adapters remain out of scope for this pass.

The goal is to turn `cliagents` from "multi-agent execution that works in this environment"
into "auditable multi-agent orchestration with durable run history, recoverability, and a UI."

## Roadmap Position

This is a subordinate implementation roadmap under `CLIAGENTS-BROKER-PLAN.md`.

It should be read as:

- Phase 2 and Phase 3 broker work
- run-ledger and run-inspector hardening
- one of the main implementation slices after broker reliability is tightened

It should not be read as permission to outrank:

- adapter conformance
- child-session reliability
- reference workflow hardening
- broker failure semantics

It is also not a roadmap for:

- first-class task/worktree/PR productization
- team or board semantics
- broad operator workstation UX

## Current State

### What is working now

- Direct-session orchestration routes exist for:
  - `/orchestration/consensus`
  - `/orchestration/plan-review`
  - `/orchestration/pr-review`
- `gemini-cli`, `codex-cli`, and `qwen-cli` are working in:
  - direct `/ask`
  - direct sessions
  - multi-turn where supported
  - long tasks
  - concurrent requests
  - scenario-matrix consensus/review flows
  - live multi-round discussion testing
- Existing persistence already stores:
  - `traces`
  - `spans`
  - `messages`
  - `discussions`
  - `discussion_messages`
  - shared memory tables (`artifacts`, `findings`, `context`)

### What is missing

- No canonical `run ledger` for consensus/review workflows.
- No `GET /orchestration/runs` or `GET /orchestration/runs/:id`.
- No durable linkage between a single orchestration run and:
  - prompt hash
  - participants
  - per-agent outputs
  - retry history
  - failure classification
  - final decision
  - tool usage
- No UI for inspecting how each model responded during a consensus-style run.
- No normalized tool capability contract across MCP, CLI, API, and web tools.
- No recovery model that can resume interrupted orchestration runs from durable state.

## Review Consensus

This roadmap was reviewed by:

- `gemini-cli`
- `qwen-cli`
- Codex as final judge

Consensus outcome:

- Direction is correct.
- The roadmap should be revised before implementation starts.
- The biggest gap is not architecture; it is underspecified P0 contracts.

Reviewed blockers that must be addressed before schema work starts:

1. Define payload size, truncation, compression, and retention policy for `run_outputs` and `run_tool_events`.
2. Define an exact canonical `message_hash` contract.
3. Define run/participant liveness, retry, resumability, and zombie-run semantics.
4. Define foreign keys, indexes, and integrity checks for run-ledger tables.
5. Define rollout, feature-flag, and migration rollback strategy for existing live routes.

## Strategic Decisions

1. Direct-session orchestration is the primary path.
2. Tmux stays as a fallback and observability path, not the main orchestration model.
3. The `run ledger` becomes the source of truth for orchestration history.
4. Existing `traces`, `spans`, and `messages` stay useful, but they become supporting telemetry rather than the main product abstraction.
5. Shared tool access should be modeled as capabilities, not hardcoded provider behavior.
6. Every future consensus/review run must be replayable at the metadata level and inspectable in UI.

## Architecture Target

### 1. Session Layer

Keep a transport-agnostic session contract:

- `create()`
- `attach()`
- `send()`
- `streamOutput()`
- `cancel()`
- `teardown()`
- `getTranscript()`

This preserves current direct-session behavior while keeping tmux available for adapters or workflows that still need it.

### 2. Run Ledger Layer

Introduce a first-class run ledger for orchestration workflows:

- `run_id`
- `kind` (`consensus`, `plan-review`, `pr-review`, `discussion`, later `implementation-run`)
- `status` (`pending`, `running`, `completed`, `failed`, `cancelled`, `partial`)
- `message_hash`
- `input_summary`
- `working_directory`
- `initiator`
- `started_at`
- `completed_at`
- `duration_ms`
- `decision_summary`
- `decision_source`
- `failure_class`
- `retry_count`
- `metadata`

Introduce child tables:

- `run_participants`
- `run_steps`
- `run_outputs`
- `run_tool_events`

The ledger should reference trace IDs where available, but not depend on traces to function.

### 3. Tool Capability Layer

Create a normalized tool capability manifest per role/adapter.

Capabilities should distinguish:

- `mcp`
- `cli`
- `api`
- `web`
- `filesystem`
- `browser`
- `db`

Every run should record which capability class was used by each participant, plus a compact input/output summary for later analysis.

### 4. UI Layer

Build a run-inspector UI for consensus and review flows.

Minimum UI surface:

- run list
- filters by kind / adapter / status / date
- run detail page
- participant cards with outputs side by side
- judge/verdict panel
- timeline of steps and retries
- failure classification
- links to traces / messages / artifacts

This UI is not optional if the system is meant to improve over time.

## Phased Implementation Plan

### Phase 0: Contract Tightening Before Schema

Priority: P0

Files:

- new: `docs/research/RUN-LEDGER-CONTRACT.md`
- new: `docs/research/RUN-LEDGER-STATE-MACHINE.md`
- new: `docs/research/RUN-LEDGER-MIGRATION-PLAN.md`

Tasks:

1. Define canonical request hashing:
   - exact included fields
   - exact excluded fields
   - key ordering
   - UTF-8 encoding
   - whitespace normalization rules
   - test vectors
2. Define payload policy for:
   - `run_outputs`
   - `run_tool_events`
   - oversized participant outputs
   - raw tool payloads
3. Define truncation and retrieval rules:
   - stored preview
   - content hash
   - compression threshold
   - archival threshold
4. Define run state machine:
   - `pending`
   - `running`
   - `completed`
   - `failed`
   - `cancelled`
   - `partial`
   - `abandoned`
5. Define participant state machine:
   - `queued`
   - `running`
   - `completed`
   - `failed`
   - `retrying`
   - `cancelled`
6. Define heartbeat or lease-expiry semantics for zombie runs.
7. Define resumability rules:
   - resumable
   - restart-required
   - retry-safe
   - side-effectful / non-idempotent
8. Define idempotency keys and retry limits.
9. Define schema relationships and composite indexes before migration work begins.
10. Define ledger integrity checks and orphan detection rules.
11. Define feature-flag rollout:
    - dual-write period
    - read-path switch
    - fallback strategy
12. Define migration rollback rules for partially applied deployments.

Success criteria:

- There is a written contract for hash semantics, liveness semantics, and payload handling.
- Schema design decisions are derived from contract docs, not invented during migration.
- The migration plan includes rollback and staged enablement.

### Phase 1: Run Ledger Foundation

Priority: P0

Files:

- `src/database/schema.sql`
- `src/database/db.js`
- `src/server/orchestration-router.js`
- new: `src/orchestration/run-ledger.js`
- new tests for schema and service

Tasks:

1. Add schema for:
   - `runs`
   - `run_participants`
   - `run_steps`
   - `run_outputs`
   - `run_tool_events`
2. Add DB helpers to:
   - create run
   - update run status
   - append participant
   - append step
   - append output
   - append tool event
   - query runs list
   - query run detail
3. Store `message_hash` using the Phase 0 canonicalization contract.
4. Store `failure_class` as normalized enum, not raw provider text.
5. Store `retry_count`, `attempt_index`, and resumability metadata for steps and participants.
6. Add heartbeat / last-seen fields where required by the liveness contract.
7. Add indexes and foreign keys defined in Phase 0.
8. Use file-driven SQL migrations, not shell-escaped inline SQL.

Success criteria:

- A completed run can be queried without reading raw log files.
- A failed run preserves partial participant history.
- DB queries return enough data to reconstruct the run in UI.
- Large outputs obey truncation/compression policy rather than unbounded writes.

### Phase 2: Wire Consensus and Review Routes into Ledger

Priority: P0

Files:

- `src/orchestration/consensus.js`
- `src/orchestration/review-protocols.js`
- `src/server/orchestration-router.js`

Tasks:

1. Create a run record at route entry.
2. Register each participant before execution starts.
3. Record:
   - participant start
   - participant finish
   - participant failure
   - judge start/finish
   - final decision
4. Persist full normalized outputs for each participant and judge.
5. Persist aggregated decision metadata:
   - verdict
   - source
   - success count
   - failed count
6. Return `runId` in every orchestration response.
7. Gate ledger writes behind a rollout flag for the initial release window.

Success criteria:

- `/consensus`, `/plan-review`, and `/pr-review` all emit a durable `runId`.
- A run can be inspected after process exit.
- Route responses and stored records agree on decision and participant data.
- Existing working orchestration routes can be switched back if rollout reveals regressions.

### Phase 3: Run Query APIs

Priority: P0

Files:

- `src/server/orchestration-router.js`
- optionally new route/service helpers

API surface:

- `GET /orchestration/runs`
- `GET /orchestration/runs/:id`
- optional later:
  - `GET /orchestration/runs/:id/transcript`
  - `GET /orchestration/runs/:id/tool-events`

Tasks:

1. Add list endpoint with filters:
   - `kind`
   - `status`
   - `adapter`
   - `from`
   - `to`
   - pagination
2. Add detail endpoint returning:
   - run metadata
   - participants
   - steps
   - outputs
   - tool events
   - linked trace IDs / discussion IDs if present
3. Add stable response schemas for UI use.
4. Freeze a versioned response contract before UI implementation starts.

Success criteria:

- No UI view needs to parse raw DB tables directly.
- A single run detail call returns everything required for inspection.
- Response schemas remain stable during initial UI rollout.

### Phase 4: Tool Capability Contract

Priority: P1

Files:

- new: `src/tools/capability-contract.js`
- new: `config/tool-capabilities.json`
- orchestration files and adapters as needed

Tasks:

1. Define capability descriptors by adapter and role.
2. Support capability classes:
   - MCP
   - CLI
   - API
   - WebSearch
   - Filesystem
   - Browser
   - Database
3. Normalize tool event logging into run ledger.
4. Ensure future participants can use shared MCP servers or local CLIs under one model.
5. Mark tool events as idempotent or side-effectful where known, so retries can respect safety boundaries.

Success criteria:

- Runs show which external capabilities affected the decision.
- New tool integrations do not require orchestration route rewrites.

### Phase 5: Recovery and Failure Injection

Priority: P1

Files:

- orchestration services
- run ledger service
- tests

Tasks:

1. Add failure classification:
   - `timeout`
   - `auth`
   - `rate_limit`
   - `process_exit`
   - `protocol_parse`
   - `tool_error`
   - `unknown`
2. Add deterministic failure injection tests for:
   - hung participant
   - partial participant failure
   - judge failure
   - malformed output
   - corrupted stream chunk
   - retry path
3. Add resumability rules for incomplete runs.
4. Prevent full reruns when only one participant failed and retry is enabled.
5. Add abandoned-run detection using heartbeat/lease expiry.

Success criteria:

- An interrupted run can be resumed from ledger state.
- Failure mode is visible in both API and UI.

### Phase 6: Consensus Run Inspector UI

Priority: P1

Files:

- new UI view under `public/`
- supporting API usage from existing dashboard or a dedicated page

Tasks:

1. Add runs table:
   - date
   - kind
   - adapters
   - status
   - verdict
   - duration
2. Add run detail page:
   - original prompt summary
   - participant outputs side by side
   - judge section
   - disagreement indicators
   - retries/failures
   - tool events
3. Add transcript drilldown per participant.
4. Add links back to message history and artifacts.
5. Show truncation/compression indicators so users know when they are seeing previews instead of full payloads.

Success criteria:

- A user can visually compare model responses in one place.
- A user can explain why a consensus verdict happened without opening log files.

### Phase 7: Optional Rich Discussion Mode

Priority: P2

Files:

- `src/orchestration/discussion-manager.js`
- consensus/review routes
- UI

Tasks:

1. Decide whether consensus remains single-round fanout + judge, or can escalate into structured multi-round discussion.
2. If enabled, store discussion-to-run links.
3. Represent rounds and replies in UI timeline.

Success criteria:

- Discussion mode is explicit, bounded, and auditable.
- Multi-round debates do not disappear into logs.

## Testing Plan

### Must-pass suites

- `tests/test-runtime-consistency.js`
- `tests/test-scenario-matrix.js`
- `tests/test-live-multi-agent-discussion.js`
- `tests/test-long-running.js`
- `tests/test-review-routes.js`
- new:
  - `tests/test-run-ledger.js`
  - `tests/test-run-ledger-routes.js`
  - `tests/test-run-ledger-recovery.js`

### New coverage required

- run ledger persistence for:
  - success
  - partial success
  - total failure
  - retry
  - cancelled run
- correctness of `runId` linkage across:
  - route response
  - DB rows
  - UI detail page
- participant output comparison rendering in UI
- tool event logging correctness
- migration rollback correctness
- deterministic `message_hash` normalization vectors
- concurrent run isolation at realistic load
- abandoned-run detection and recovery
- large-payload truncation/compression behavior

## Immediate Next Steps

1. Write the Phase 0 contract docs:
   - hash semantics
   - payload policy
   - run/participant state machines
   - migration rollout and rollback
2. Finalize schema, indexes, and integrity rules from those docs.
3. Implement schema and DB helpers for `runs`, `run_participants`, `run_steps`, `run_outputs`, and `run_tool_events`.
4. Wire `/consensus`, `/plan-review`, and `/pr-review` to emit and persist `runId`.
5. Add `GET /orchestration/runs` and `GET /orchestration/runs/:id`.
6. Add run-ledger tests before building UI.
7. Build the run-inspector UI only after the run APIs are stable.

## Non-Goals for This Pass

- Expanding the supported adapter surface beyond `gemini-cli`, `codex-cli`, and `qwen-cli`.
- Full transport rewrite.
- Removing tmux immediately.
- Building autonomous self-improvement loops before the ledger exists.

## Final Recommendation

The next milestone should be:

`Phase 0 Contract Tightening -> Run Ledger -> Run APIs -> Consensus/Review persistence`

That is the smallest change that:

- makes consensus auditable
- makes future UI possible
- makes retries/recovery possible
- makes tool usage inspectable
- turns successful demos into a durable product surface
