# Phase 0 Broker Audit

## Scope

This audit translates the judged broker plan into a current-state inventory for the code that actually exists today.

Focus:

- official coding CLI broker scope
- consensus and discussion workflows
- run persistence and inspection
- MCP and HTTP ingress
- async execution and degraded-state handling

Evidence base:

- source files under `src/`
- current docs under `docs/`
- existing live and regression tests in `tests/`
- live judged discussion run `run_9e9c9595e899ba0b`

## Roadmap Position

This audit is the evidence gate for the next sequence in `CLIAGENTS-BROKER-PLAN.md`.

Interpret it this way:

- broker reliability comes before product-layer expansion
- direct-session review and consensus hardening comes before task/worktree/PR abstractions
- run-ledger and inspector work comes before broader operator UI ambitions

This audit does not authorize near-term expansion into:

- task/worktree/PR cockpit features
- CI reaction engine work
- team or board semantics
- broad remote workstation UX

## Current State Summary

1. `cliagents` already has the right product-shaped pieces:
   - direct-session adapters
   - tmux-backed async orchestration
   - consensus/review/discussion workflows
   - run ledger persistence
   - inspector UI
   - MCP surface
2. The main architectural problem is overlap:
   - `BaseLLMAdapter` defines one lifecycle
   - `SessionManager` assumes direct spawn-per-message semantics
   - `PersistentSessionManager` owns a separate terminal/status model
3. The main operational problem is reliability, not missing features:
   - fixed waits still exist in orchestration paths
   - readiness/completion are still partly heuristic
   - abandoned runs are still possible
   - large inline prompts degrade some providers, especially Qwen
4. The main product risk is sprawl:
   - legacy inbox/discussion mechanics, skills, and generic platform ideas can easily dilute the broker thesis

## Reference Workflow

Freeze one workflow as the hardening gate for future work:

- workflow: `pr-review` as the initial "code review" reference flow
- participants: `codex-cli` + `gemini-cli`
- judge: `codex-cli` or `qwen-cli`
- execution path: direct-session first
- persistence: run ledger required
- inspection: `/runs` detail required
- degraded-state coverage: one participant failure must still yield persisted partial run detail

Reason:

- it matches the judged recommendation to prove one hardened code-review workflow
- it is narrower and more repeatable than fully open-ended discussion
- it still exercises the broker's core differentiators: fanout, synthesis, persistence, and inspection

## Keep / Harden / Rewrite / Delete Inventory

| Subsystem | Current state | Disposition | Why |
| --- | --- | --- | --- |
| `src/core/base-llm-adapter.js` | Real common base, but only defines part of the broker contract | `harden` | Keep the abstraction, but stop relying on undocumented behavior hidden in individual adapters |
| `src/core/session-manager.js` | Clean direct-session path for spawn/resume/send/terminate | `keep` | This should remain the primary execution model for broker workflows |
| `src/tmux/session-manager.js` + `src/tmux/*` | Valuable for async terminals and long-running work, but architecture has grown around tmux-specific assumptions | `harden` | Keep as fallback worker runtime and async terminal layer, not as the product center |
| `src/status-detectors/*` | Useful, but still heuristic and adapter-specific | `harden` | Required while tmux exists, but needs better readiness and stuck-run semantics |
| `src/orchestration/consensus.js` | Working bounded consensus fanout plus optional judge | `keep` | Core differentiator |
| `src/orchestration/review-protocols.js` | Working structured plan/PR review with verdict normalization | `keep` | Best candidate for the hardened reference workflow |
| `src/orchestration/discussion-runner.js` | Working multi-round direct-session discussion with ledger persistence | `keep` | Core differentiator for adversarial review and consensus building |
| `src/orchestration/discussion-manager.js` | Older inbox-style discussion model tied to message passing and DB discussion tables | `delete` | Superseded by bounded direct-session discussion; keep only until compatibility window closes |
| `src/orchestration/send-message.js` + inbox-based messaging | Useful for generic terminal messaging, but not central to the broker thesis | `rewrite` | If kept, it should become a narrow support primitive rather than a product surface |
| `src/orchestration/handoff.js` | Real and useful, but still contains fixed waits and tmux-driven assumptions | `harden` | Needed, but should align with async-first broker semantics |
| `src/orchestration/assign.js` | Async task launch path with polling | `harden` | Important for non-blocking delegation |
| `src/orchestration/run-ledger.js` | Real persistent run record layer with APIs and UI wiring | `harden` | It is the right foundation, but needs stronger abandoned-run and replay semantics |
| `src/server/orchestration-router.js` | Good broker surface, now includes consensus/review/discussion routes and run inspection | `keep` | Primary HTTP ingress |
| `src/mcp/cliagents-mcp-server.js` | Working MCP bridge with async delegation and discussion/run tools | `keep` | Primary cross-agent ingress |
| `src/routes/memory.js` | Shared artifacts/findings/context routes | `keep` | Useful support surface, but do not expand it ahead of ledger hardening |
| `src/services/skills-service.js` | Functional skills loader | `keep` | Non-core. Preserve, but do not make it a Phase 1 center |
| `src/database/db.js` + migrations | Real persistence layer with migrations and ledger tables | `keep` | The right storage foundation already exists |
| `public/runs.html` | Minimal but working run inspector | `harden` | Good enough to keep; improve for round-by-round inspection after runtime hardening |

## Main Adapter Matrix

This matrix describes the current real shape, not the target shape.

| Adapter | Start | Send | Resume | Poll | Cancel | Extract output | Classify failure |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `codex-cli` | yes | yes | implicit via `codex exec resume` | no adapter-level primitive | interrupt/terminate only | yes | no explicit adapter contract yet, classified higher up |
| `gemini-cli` | yes | yes | implicit via session UUID to resume-index resolution | no adapter-level primitive | interrupt/terminate only | yes | no explicit adapter contract yet, classified higher up |
| `qwen-cli` | yes | yes | implicit via Qwen session ID resume | no adapter-level primitive | interrupt/terminate only | yes | no explicit adapter contract yet, classified higher up |
| `opencode-cli` | yes | yes | implicit via `--session` resume | no adapter-level primitive | interrupt/terminate only | yes | no explicit adapter contract yet, classified higher up |

Key finding:

- The current adapters are stronger than the contract says.
- They already support multi-turn/resume patterns in practice.
- What they do not expose cleanly is a standard broker-visible capability and failure contract.

Current contract reference:

- [ADAPTER-CONFORMANCE.md](/Users/mojave/Documents/AI-projects/cliagents/docs/ADAPTER-CONFORMANCE.md)

## High-Confidence Findings

1. Direct-session orchestration is already the cleanest primary path for consensus and review workflows.
2. Tmux is still useful for async terminal control, but it should no longer define the product architecture.
3. Large review payloads should prefer file-based context handoff over giant inline prompts.
4. Run persistence is real enough to build on now.
5. Abandoned-run and zombie-run handling are still incomplete.

## Concrete Gaps To Close Next

1. Publish an explicit adapter contract and capability surface.
2. Remove or isolate fixed startup delays from `handoff` and related orchestration paths.
3. Formalize run abandonment, stuck judge, and heartbeat semantics in the ledger.
4. Harden one reference `pr-review` workflow end to end.
5. Delay broader protocol invention until that reference flow is stable.

## Recommended Next Sequence

1. Land `src/adapters/contract.js` and publish capability metadata for the main official CLI adapters.
2. Replace blind waits in orchestration startup with explicit readiness checks where possible.
3. Add abandoned-run cleanup and stale-judge detection to the run ledger path.
4. Stress the reference `pr-review` workflow under:
   - participant timeout
   - judge timeout
   - one participant auth failure
   - oversized context handoff
5. Only then expand discussion and UI depth further.
