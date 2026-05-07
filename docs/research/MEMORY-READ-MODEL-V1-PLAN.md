# Memory Read Model V1 Plan

## Status

Active plan.

## Objective

Make existing broker persistence queryable as one coherent memory surface without
replacing SQLite or rewriting the existing event-store tables.

This branch is the implementation follow-through for task-linked observability:
tasks, assignments, roots, rooms, runs, messages, session events, usage, findings,
artifacts, and context should be discoverable through one read model.

## Scope

- Add database hygiene diagnostics for weak or missing links.
- Add a `projects` anchor derived from workspace roots.
- Add read projections for memory records and lineage edges.
- Add memory query and insight APIs.
- Add tests that prove persisted task, room, run, usage, and message data can be
  queried together.
- Keep existing write paths intact unless a link can be populated safely.

## Non-Goals

- Do not replace SQLite.
- Do not add a graph database.
- Do not infer task links from weak text similarity.
- Do not store private model chain-of-thought.
- Do not make worktrees a primary memory object; keep them assignment metadata.
- Do not build UI in V1 except route/API surfaces required by tests.

## Supervisor Contract

Codex remains the integration supervisor.

The supervisor owns:

- final schema/API contract
- migration ordering
- integration into `db.js`, routers, MCP, docs, and tests
- final review and full-suite validation

Workers may implement bounded slices only after their write scope is explicit.
Workers must not revert unrelated edits or edit outside their assigned files
without asking the supervisor.

## Execution Order

### Phase 0: Contract Freeze

Owner: supervisor.

Deliverables:

- exact `projects` schema
- exact `memory_records_v1` shape
- exact `memory_edges_v1` shape
- route payloads for `/orchestration/memory/query` and
  `/orchestration/memory/insights`
- test fixtures and acceptance criteria

Parallelism: no implementation workers yet.

### Phase 1: DB Hygiene And Project Anchor

Preferred executor: strong coding model.

Write scope:

- `src/database/migrations/*`
- focused DB helpers in `src/database/db.js`
- DB-focused tests

Deliverables:

- `projects` table
- safe workspace-root based project backfill
- diagnostics for missing `root_session_id`, `task_id`, `project_id`, and usage
  linkage
- no destructive cleanup without an explicit repair mode

Acceptance:

- fresh DB and migrated DB both pass
- diagnostics distinguish safe backfills from unknown links
- existing task/usage/session tests do not regress

### Phase 2: Memory Projection Views

Preferred executor: strong or mid-tier coding model after Phase 0.

Write scope:

- ordered migration for views and indexes
- projection helper methods in `src/database/db.js`
- focused read-model tests

Deliverables:

- `memory_records_v1` read projection over current durable tables
- `memory_edges_v1` lineage projection
- optional FTS table only after projection shape is stable

Acceptance:

- records expose source table, source id, record type, timestamps, scope ids, and
  searchable text
- edges expose lineage without inventing weak links
- query results can drill back to source records

### Phase 3: HTTP Query And Insights APIs

Preferred executor: mid-tier coding model.

Write scope:

- `src/routes/memory.js`
- route tests
- OpenAPI/docs only if touched by existing route conventions

Deliverables:

- `GET /orchestration/memory/query`
- `GET /orchestration/memory/insights`

Query filters:

- `project_id`
- `workspace_root`
- `task_id`
- `root_session_id`
- `run_id`
- `room_id`
- `terminal_id`
- `types`
- `q`
- `since`
- `until`
- `limit`

Insights:

- status counts
- latest activity
- adapter/model usage
- token totals
- top findings
- pending items
- missing-link diagnostics

### Phase 4: MCP And Docs

Preferred executor: cheaper coding model after HTTP payloads stabilize.

Write scope:

- `src/mcp/cliagents-mcp-server.js`
- `docs/reference/MCP-TOOLS.md`
- MCP tests

Deliverables:

- MCP tools for memory query and insights
- concise text output that includes source ids and token totals
- docs pointing agents to query before broad code exploration

### Phase 5: Review, Integration, And Full Validation

Preferred reviewers:

- strong Codex or Claude for code review
- Gemini/Qwen for risk and test-gap critique if available

Supervisor gates:

- `git diff --check`
- focused DB/memory/query tests
- `npm test`
- manual route smoke for query and insights
- no new broad-suite regressions except documented provider auth/quota skips

## Worktree Strategy

Use separate git worktrees only for slices with disjoint write sets.

Recommended worktrees:

- `../cliagents-memory-db` for Phase 1
- `../cliagents-memory-projection` for Phase 2
- `../cliagents-memory-api` for Phase 3
- `../cliagents-memory-mcp-docs` for Phase 4

Do not run multiple workers against the same write scope.

## Supervisor Harness

Use `scripts/task-supervisor-harness.js` to run the assignment loop for this
task instead of manually starting each worker.

Default behavior is safe:

- one pass only
- dry-run only
- starts only queued assignments whose `metadata.startPolicy` is allowed
- respects `metadata.dependsOn`, `metadata.phase`, and `metadata.manualHold`
- caps parallel starts with `--concurrency`
- `--auto` advances through an ordered policy sequence only after the current
  policy stage completes

Autonomous execution example:

```bash
pnpm supervise:task -- --task-id task_memory_read_model_v1 \
  --root-session-id d4541c1eaabde31194ac0c082ab98f34 \
  --auto \
  --concurrency 2 \
  --start \
  --loop
```

The default auto policy order is:

1. `start-before-implementation`
2. `after-phase0-contract`
3. `after-phase1-contract-or-integration`
4. `after-phase0-contract-and-db-helpers`
5. `after-phase3-api`
6. `after-integration`

If this task needs a different order, pass `--policy-sequence` explicitly.
The harness stops on failed, blocked, or stalled work unless an operator
chooses an explicit `--continue-on-*` override.

## Model Routing

- Strong Codex/Claude: migrations, DB contract, integration, final review.
- Gemini/Qwen: plan critique, risk discovery, test-gap analysis.
- OpenCode or cheaper coding models: route tests, MCP formatting, docs, isolated
  helpers.

## Key Risks

- weak backfills could create misleading memory links
- projection views could become expensive without indexes
- FTS could hide source provenance if results are not traceable
- MCP output could become too verbose for agent consumption
- room/root snapshot overloading may require a compatibility migration

## First Concrete Next Step

Freeze Phase 0 contracts, then start Phase 1 and Phase 3 planning workers in
parallel as read-only reviewers before any implementation worker edits files.
