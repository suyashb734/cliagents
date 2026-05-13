# Failure And Retry Taxonomy (Track A)

This taxonomy defines the top five Track A operational failures with required retry
and operator handling. It is implemented in `scripts/track-a-launch-smoke.js`.

| Failure class | Typical signals | Retry policy | Operator action |
| --- | --- | --- | --- |
| `terminal_busy` | `terminal_busy`, `Terminal ... is busy`, reuse candidate already processing | Retry once after 1s with `forceFreshSession` | Keep the original terminal running; broker retries with a fresh child so the flow can continue. If repeated, inspect concurrent fan-out behavior. |
| `binary_not_found` | `command not found`, adapter not installed, missing binary | No retry | Install the adapter CLI and re-run smoke test. |
| `auth_failed` | `not authenticated`, `401`, `403`, API-key/login failures | No retry | Re-authenticate CLI or fix hosted `CLI_AGENTS_API_KEY`. |
| `rate_limited` | quota/capacity/rate-limit responses | Retry up to 2 times with 15s backoff | Re-run after backoff; if still failing, switch model/window or wait for provider quota reset. |
| `timeout` | request timeout, stalled run, provider deadline exceeded | Retry up to 2 times with 5s backoff | Re-run once local load is reduced; investigate provider/network stability if repeated. |

## Additional Guardrails

- `process_exit` retries once with a fresh terminal and then requires manual log review.
- `permission_required` is non-retryable and requires explicit operator approval/input action.
- `root_attach_required` is non-retryable and requires `ensure_root_session` / `attach_root_session` before delegation.

## Source

- Route-level lifecycle recovery is implemented in `src/orchestration/task-router.js` and `src/mcp/cliagents-mcp-server.js`.
- Smoke-script classification and retry policy live in `scripts/track-a-launch-smoke.js`.
- The smoke script is the execution proof path referenced by [LAUNCH-PROFILE.md](./LAUNCH-PROFILE.md).
