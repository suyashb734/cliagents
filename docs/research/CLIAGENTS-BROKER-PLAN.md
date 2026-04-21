# cliagents Broker Plan

## Decision

`cliagents` should not try to become a general-purpose agent platform or a personal-assistant hub.

It should become a **neutral local broker for official coding CLIs**:

- `codex`
- `gemini`
- `qwen`

The broker should be reachable from:

- MCP clients
- HTTP clients
- a thin local CLI
- future UI surfaces

The core product is:

1. route work to official coding CLIs
2. run structured review / consensus / discussion workflows
3. persist every run in a replayable ledger
4. expose a side-by-side inspection UI

This only works if the broker stays reliable under:

- adapter auth failures
- provider timeouts
- large prompt payloads
- local CPU/RAM contention
- blocked or permission-sensitive tasks

## Why This Scope

### OpenHands is better at:

- sandboxed software-agent execution
- SDK/server architecture
- API- and model-centric deployments
- tracing and production platform concerns

### OpenClaw is better at:

- channel integration
- long-running assistant/gateway behavior
- harness-based spawning across many agent runtimes

### cliagents can still win at:

- brokering **official local coding CLIs**
- being callable from **any other agent over MCP**
- making **consensus/discussion** a first-class workflow
- persisting and inspecting cross-agent runs cleanly

If `cliagents` tries to out-platform OpenHands or out-gateway OpenClaw, it loses.
If it stays focused on **local broker + consensus + inspectability** for the supported active-adapter surface, it still has a real niche.

## Product Thesis

`cliagents` is the system you run locally when you want one agent or tool to consult other official coding CLIs without manually juggling terminals.

Examples:

- Codex asks Gemini and Qwen to critique a plan.
- Qwen launches a Codex implementation task and polls it asynchronously.
- A UI shows reviewer outputs side by side with judge synthesis.
- A failed discussion run is still inspectable later from persisted ledger state.

## Source of Truth

This document is the canonical strategic plan for `cliagents`.

Use the docs set with this hierarchy:

1. `CLIAGENTS-BROKER-PLAN.md`
   Strategic product thesis and phase order.
2. `PHASE0-BROKER-AUDIT.md`
   Current-state evidence and the concrete next-sequence gate.
3. `ROADMAP-CONSENSUS-RUN-LEDGER.md`
   Subordinate implementation roadmap for the run-ledger and inspector slice.
4. `SESSION-CONTROL-PLANE-PLAN.md`
   Later-phase control-plane expansion that should not outrank broker hardening.

If any lower-level plan conflicts with this document, this document wins.

## What cliagents Should Be

### 1. Broker first

The main abstraction is not tmux, not sessions, and not raw CLI wrapping.

The main abstraction is:

- **task ingress**
- **adapter routing**
- **async execution**
- **result persistence**
- **inspection**

### 2. Async by default for long work

Long-running delegated work should prefer:

- enqueue / launch
- return handle
- poll or subscribe
- inspect outputs and failures durably

Short work can still use a bounded sync wait.

### 3. Consensus as a flagship workflow

`cliagents` should treat these as first-class:

- `consensus`
- `plan-review`
- `pr-review`
- `discussion`

This is not a side feature. It is one of the main reasons the system exists.

### 4. Run ledger as product infrastructure

Every orchestration run should have:

- stable `runId`
- message hash
- participants
- prompts
- outputs
- failures
- step timeline
- tool events
- final decision

If a run cannot be inspected later, the broker is not finished.

## What cliagents Should Not Be

- a full personal assistant platform
- a general workflow engine for every tool category
- a competing replacement for OpenHands
- a chat UI product whose main value is chatting
- a tmux-centric system where tmux defines the architecture

## What Is Not Near-Term Product

The following may become valid later, but they are not near-term obligations:

- a first-class task/worktree/PR cockpit
- CI and review-comment reaction automation
- a Maestro-style operator workstation
- a Multica-style team board or agent-assignee model
- broad remote collaboration surfaces

The near-term responsibility is to finish the broker substrate and its flagship workflows first.

## Architecture Direction

### A. Stable adapter contract

Every adapter should implement a common lifecycle:

- `start`
- `send`
- `resume`
- `poll`
- `cancel`
- `extractOutput`
- `classifyFailure`

The contract must also define:

- method inputs and outputs
- error semantics
- retry-safe vs side-effectful behavior
- what counts as `blocked`, `failed`, and `abandoned`
- auth-required signaling
- maximum prompt / payload handling rules

Adapter capability metadata should also be explicit:

- supports multi-turn
- supports streaming
- supports background polling
- supports tools
- supports filesystem mutation
- supports images
- supports JSON mode

### B. Two execution modes, one broker model

Keep:

- direct-session mode for the primary path
- persistent worker mode only where it is truly needed

Do not let the transport mechanism become the product boundary.

### C. MCP + HTTP as primary ingress

The main client-facing interfaces should be:

- MCP tools
- HTTP routes

A thin `cliagents` CLI can be added later, but it should be a frontend to the broker rather than a second orchestration core.

### D. Capability-aware routing

Routing should not just choose by profile name.

It should consider:

- task kind
- required capabilities
- allowed latency
- whether the task is read-only or side-effectful
- whether isolation is required
- adapter health/auth state

The first routing version should stay deliberately simple:

- static capability manifest
- adapter health check
- auth-ready check
- exclude unhealthy adapters
- choose among qualifiers with deterministic fallback

Do not start with opaque scoring or learned routing.

### E. Ledger storage and versioning

The initial ledger storage should stay aligned with the current codebase:

- SQLite-backed
- schema-versioned
- migration-tested
- queryable from both HTTP and MCP

Do not postpone the storage format decision. The UI, replay, export, and recovery work all depend on it.

## Immediate Improvement Plan

## Phase 0: Baseline Audit and Reference Workflow

Priority: highest

1. Audit the current broker state:
   - what adapter features already work
   - what is stubbed
   - what is flaky
   - which tests rely on live providers
2. Produce an explicit subsystem inventory with one disposition per subsystem:
   - `keep`
   - `harden`
   - `rewrite`
   - `delete`
   - output: `docs/research/PHASE0-BROKER-AUDIT.md`
3. The inventory must cover at least:
   - run ledger
   - adapters
   - consensus
   - discussion
   - MCP server
   - shared memory
   - skills
   - tmux/session handling
4. Publish a short matrix for the main adapters:
   - start
   - send
   - resume
   - poll
   - cancel
   - extract output
   - classify failure
5. Freeze one reference workflow as the hardening target:
   - two participants
   - one judge
   - persisted run
   - inspector view
   - degraded-state coverage
6. Use that reference workflow as the gate for future orchestration changes.

Success for Phase 0:

- there is a current-state audit instead of assumptions
- there is a keep/harden/rewrite/delete inventory for the existing broker subsystems
- one reference workflow is proven end to end
- future work can be measured against a concrete baseline

## Phase 1: Reliability First

Priority: highest

1. Formalize adapter health and readiness checks.
2. Formalize adapter contract semantics:
   - error types
   - retry semantics
   - blocked/auth-required behavior
   - payload size handling
3. Add resource management:
   - concurrency limits
   - local throttling
   - runaway process cleanup
4. Make degraded states explicit and expected:
   - `completed`
   - `partial`
   - `failed`
   - `blocked`
   - `abandoned`
5. Harden async lifecycle:
   - heartbeat
   - zombie detection
   - cancellation
   - retry policy
   - crash recovery
6. Add explicit permission/accountability handling for side-effectful tasks.
7. Remove assumptions that live providers always return deterministically in tests.
8. Add more failure-injection tests for:
   - adapter timeout
   - judge timeout
   - one participant failing mid-discussion
   - run interrupted after launch but before synthesis

## Phase 2: Make Consensus the Product

1. Standardize verdict schemas across:
   - plan review
   - PR review
   - discussion judge
   - consensus judge
2. Add discussion configuration options:
   - number of rounds
   - rebuttal strategy
   - convergence mode
   - judge optionality
   - maximum transcript size
3. Add evidence-aware synthesis:
   - cite participant outputs
   - preserve disagreements
   - record why a judge overruled a reviewer
4. Add structured export of run results for later replay and analysis.
5. Harden the simplest consensus workflow first before broadening protocol complexity.

## Phase 3: Make Inspectability Excellent

1. Improve the run inspector:
   - per-round comparison
   - participant prompt lineage
   - failure overlays
   - retries and timing
   - tool-event timeline
2. Add run replay and artifact export.
3. Add filters for:
   - adapter
   - workflow kind
   - status
   - failure class
   - time window
4. Add a "why did this fail?" view based on run ledger metadata.

## Phase 4: Improve the Broker Surface

1. Keep MCP tools sharp and small:
   - `delegate_task`
   - `check_task_status`
   - `get_terminal_output`
   - `run_discussion`
   - `get_run_detail`
   - `list_runs`
2. Add adapter capability introspection over MCP/HTTP:
   - authenticated
   - healthy
   - supports multi-turn
   - supports tools
   - supports writes
   - supports images
3. Add a thin local CLI for humans only after the broker surface stabilizes.

## Phase 5: Optional Later Work

Only after the broker is stable:

- formalize a narrow first-class task model around the existing `taskId` support surfaces
- lightweight playbook or moderator views where they directly improve broker workflows
- container/worktree isolation modes
- scan-enabled repo debate workflows
- A2A compatibility
- remote broker mode
- OpenClaw integration as a client, not as the architecture center

Do not treat task/worktree/product-layer expansion as a Phase 1 obligation. It is later work that depends on Phases 0 through 4 being solid.

## Non-Goals for the Next Iteration

- replacing OpenHands
- replacing OpenClaw
- building a general assistant product
- supporting every possible MCP/API/tooling category immediately
- optimizing UI aesthetics before broker reliability is solid

## Success Criteria

The next version of `cliagents` is successful if:

1. Qwen, Codex, and Gemini can all call the broker through MCP or HTTP.
2. Long-running delegated tasks do not require blocking the caller.
3. Consensus and discussion runs persist cleanly even when one participant fails.
4. The run inspector makes it obvious what each agent saw, said, and failed on.
5. The system feels simpler and more focused after changes, not more sprawling.

## Short Recommendation

Continue improving `cliagents`, but narrow it.

The correct ambition is not:

- "build a bigger agent platform"

The correct ambition is:

- "build the best local broker for official coding CLIs, with first-class consensus and inspectability"
