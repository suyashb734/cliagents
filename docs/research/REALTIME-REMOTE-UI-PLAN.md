# Real-Time Conversation + Remote Access Plan

## Goal
Build a broker-native UI layer for `cliagents` that supports:
- live viewing of multi-agent discussions and terminal state
- historical replay of past runs and discussion threads
- mobile/iPad access
- replying to blocked terminals from the UI when human input is required

## Scope Decision
Keep the current broker architecture.
Do not create a second orchestration system.
Do not rewrite to a new framework or database in this phase.
Do not expose the broker publicly without authentication.

The implementation should extend the current assets:
- `src/server/index.js` WebSocket server
- `src/server/orchestration-router.js` orchestration APIs
- `src/orchestration/run-ledger.js` persisted run state
- `public/runs.html` existing inspector
- `src/tmux/session-manager.js` blocked-state detection
- `src/database/db.js` legacy discussion message storage

## External Review Summary
Gemini and Qwen both converged on the same priorities:
1. add a typed event stream instead of relying on raw terminal text only
2. make replay first-class instead of forcing the UI to reconstruct from partial tables
3. treat remote input as a separate phase because PTY/CLI input semantics are the main risk

## Architecture Direction
Use a single browser-facing real-time surface built on the existing WebSocket.

The server should emit structured broker events with stable IDs:
- `terminal.created`
- `terminal.status`
- `terminal.output`
- `terminal.blocked`
- `terminal.input_sent`
- `run.created`
- `run.updated`
- `discussion.message`
- `discussion.summary`
- `discussion.judge`

The UI should use a hybrid model:
- initial snapshot over REST
- incremental updates over WebSocket
- replay from persisted run/discussion data

This avoids a second streaming transport and keeps live and historical views consistent.

## Phase 1: Replay API Normalization
### Objectives
Make one API response sufficient to render a full past conversation.

### Changes
1. Extend `GET /orchestration/runs/:id` to include persisted discussion thread data when `run.discussionId` exists.
2. Add a dedicated endpoint for discussion history if needed:
   - `GET /orchestration/discussions/:id`
3. Include:
   - discussion metadata
   - ordered `discussion_messages`
   - blocked/error markers
   - judge output
4. Add linkage between live terminals and run records where missing.
5. Ensure completed and failed discussions both replay cleanly.

### Acceptance
- selecting a discussion run shows the actual ordered conversation, not just output summaries
- older ledger-backed runs remain readable
- new runs render with no client-side heuristics beyond formatting

## Phase 2: Real-Time Event Layer
### Objectives
Turn the existing WebSocket into a broker event bus for the UI.

### Changes
1. Add typed WebSocket event envelopes with stable schema.
2. Broadcast terminal output deltas for orchestration terminals.
3. Broadcast discussion message inserts when discussion runner appends them.
4. Broadcast run status changes when the run ledger changes.
5. Broadcast blocked-state transitions for:
   - `waiting_permission`
   - `waiting_user_answer`
6. Add lightweight subscription filtering in the browser by run or terminal.

### Acceptance
- a browser opened on `/console` updates without manual refresh during a live discussion
- blocked terminal state appears within a few seconds
- event ordering is deterministic enough for replay panes

## Phase 3: Console UI
### Objectives
Add a new mobile-friendly UI page for live and historical conversations.

### Route
- `/console`

### Views
1. Left rail:
- active terminals
- recent runs
- filter by adapter, kind, status

2. Main pane:
- live terminal stream or discussion thread
- toggle between raw output and structured conversation view
- judge output pinned separately for discussion runs

3. Right rail / bottom sheet on mobile:
- run metadata
- participants
- status badges
- blocked prompt context

### Mobile Requirements
- responsive layout for iPad portrait and landscape
- large tap targets
- sticky reply composer when a terminal is blocked
- no dependency on desktop-only hover states

### Acceptance
- live run can be followed from iPad Safari
- historical run can be opened and replayed from the same page
- discussion messages and participant outputs are readable side-by-side

## Phase 4: Remote Reply Flow
### Objectives
Allow the user to respond to blocked terminals from the UI.

### Changes
1. Reuse `POST /orchestration/terminals/:id/input` as the server-side reply path.
2. Add UI actions only when terminal status is:
- `waiting_permission`
- `waiting_user_answer`
3. Emit `terminal.blocked` with enough prompt context for the user to answer safely.
4. Persist reply actions as discussion or terminal events so they appear in replay.
5. Add optimistic UI state and server acknowledgement.

### Important Constraint
This should only target tmux-backed orchestration terminals first.
Do not promise remote reply for every direct-session adapter path until the path is explicitly wired and tested.

### Acceptance
- a blocked orchestration terminal can be answered from the browser
- the answer is persisted and visible in replay
- status transitions back to `processing` or `completed`

## Phase 5: Remote Access Hardening
### Objectives
Make browser access from iPad safe enough for real use.

### Changes
1. Require API-key auth for browser and WebSocket use when remote access is enabled.
2. Add a small auth bootstrap page or token entry flow for the UI.
3. Document recommended access patterns:
- Tailscale funnel / tailnet access
- reverse proxy with TLS
- local LAN access only for development
4. Do not ship public unauthenticated exposure.

### Acceptance
- iPad access works with authenticated WebSocket + REST
- reconnect behavior is resilient
- remote access instructions are explicit and safe

## Risks
1. Raw tmux output is still a fragile source of truth for some blocked states.
Mitigation: store structured discussion messages and explicit blocked events whenever possible.

2. Remote input can race with state transitions.
Mitigation: only allow reply on known blocked states and require terminal state re-check before writing input.

3. SQLite can become a bottleneck under many clients.
Mitigation: keep this phase single-user or low-concurrency; use WAL; reassess only after usage proves it necessary.

## First Implementation Slice
Implement this before broader UI polish:
1. enrich run detail with discussion messages
2. add WebSocket discussion/run/terminal event envelopes
3. add `/console` with live terminal list and selected-thread viewer
4. support reply from UI to blocked orchestration terminals
5. test on desktop and iPad-sized viewport

## Test Plan
### Automated
- run detail returns discussion messages when discussion-backed
- WebSocket emits typed events for terminal status and discussion messages
- blocked terminal reply endpoint updates status and persists input event
- `/console` page loads and renders live + historical data

### Manual
- create a live discussion and watch it in `/console`
- open the same UI at iPad viewport size
- trigger a blocked orchestration terminal and reply from the UI
- refresh and verify replay still shows the interaction

## Recommendation
Proceed with Phase 1 through Phase 4 in one focused product slice.
Do not expand model/orchestration features until the console and reply loop are working end-to-end.