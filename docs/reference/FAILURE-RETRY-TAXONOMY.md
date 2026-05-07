# Failure And Retry Taxonomy (Track A)

This taxonomy defines the top five failure modes used by `scripts/track-a-launch-smoke.js`.
Each mode has an explicit retry policy and required operator action.

| Failure class | Typical signals | Retry policy | Operator action |
| --- | --- | --- | --- |
| `binary_not_found` | `command not found`, adapter not installed, missing binary | No retry | Install the adapter CLI and re-run smoke test. |
| `auth_failed` | `not authenticated`, `401`, `403`, API-key/login failures | No retry | Re-authenticate CLI or fix hosted `CLI_AGENTS_API_KEY`. |
| `rate_limited` | quota/capacity/rate-limit responses | Retry up to 2 times with 15s backoff | Re-run after backoff; if still failing, switch model/window or wait for provider quota reset. |
| `timeout` | request timeout, stalled run, provider deadline exceeded | Retry up to 2 times with 5s backoff | Re-run once local load is reduced; investigate provider/network stability if repeated. |
| `process_exit` | terminal exits unexpectedly or non-zero process exit | Retry once with a fresh terminal | Inspect terminal output/logs and adapter version, then restart broker/adapters if recurring. |

## Additional Guardrail

- `permission_required` is treated as a non-retryable blocked state.
- Operator must explicitly resolve approval/input queue requirements before rerunning.

## Source

- Retry policy and classification live in `scripts/track-a-launch-smoke.js`.
- The smoke script is the execution proof path referenced by [LAUNCH-PROFILE.md](./LAUNCH-PROFILE.md).
