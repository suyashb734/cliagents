# Track A Threat-Model Remediation Map

This map links Track A threat IDs from [KD-5 threat model](/KD/issues/KD-5#document-threat-model) to concrete implementation points and verification.

## TM-01 — Privileged command execution via unvetted delegated input

- Enforcement:
  - `src/server/orchestration-router.js`
  - `detectSensitiveTerminalInput(...)` enforces a shell-command allowlist for unapproved input.
  - `POST /orchestration/terminals/:id/input` rejects shell-style commands unless routed through explicit approval.
  - `POST /orchestration/terminals/:id/input-queue` requires `approvalRequired=true` for any non-allowlisted shell-style command (including payloads outside legacy denylist regex coverage, e.g. `find ... -delete`).
- Verification:
  - `tests/test-terminal-input-queue.js`

## TM-02 — Approval bypass in queued terminal input workflow

- Enforcement:
  - `src/server/orchestration-router.js`
  - `POST /orchestration/input-queue/:inputId/approve` requires `approvedBy`.
  - `POST /orchestration/input-queue/:inputId/deny` requires `deniedBy`.
  - `POST /orchestration/input-queue/:inputId/deliver` rejects approval-required items without explicit approved decision + actor identity.
- Verification:
  - `tests/test-terminal-input-queue.js`

## TM-03 — Secret leakage in logs, transcripts, and persisted artifacts

- Enforcement:
  - `src/security/secret-redaction.js`
    - Added JWT and Google-key redaction and object-field redaction helper.
  - `src/database/db.js`
    - `addMessage(...)` redacts all persisted message roles and redacts metadata fields.
  - `src/orchestration/run-ledger.js`
    - Redacts persisted run inputs/outputs/tool-event content and associated metadata before storage.
  - `src/utils/conversation-logger.js`
    - Redacts prompt/response/error/stats before file logging.
- Verification:
  - `tests/test-terminal-input-queue.js`
  - `tests/test-run-ledger-service.js`

## TM-04 — Session reuse cross-task context or permission bleed

- Enforcement:
  - `src/tmux/session-manager.js`
    - Reuse signature now includes `taskId` and `taskAssignmentId` from session metadata.
    - Collaborator sessions require explicit `sessionLabel`.
  - `src/orchestration/task-router.js`
    - Collaborator routing requires explicit `sessionLabel`.
- Verification:
  - `tests/test-session-reuse.js`
  - `tests/test-task-router-readiness.js`

## TM-05 — Dangerous adapter/runtime defaults

- Enforcement:
  - `src/server/orchestration-router.js`
    - Sensitive terminal actions cannot execute directly and require explicit approval workflow.
  - `src/tmux/session-manager.js`
    - Collaborator continuity mode requires explicit label and adapter readiness; no implicit collaborator reuse.
- Verification:
  - `tests/test-terminal-input-queue.js`
  - `tests/test-task-router-readiness.js`
