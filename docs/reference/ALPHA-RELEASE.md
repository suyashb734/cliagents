# Alpha Release Checklist

Status: `reference`

Last reviewed: `2026-05-11`

## Purpose

This checklist is the public-alpha release gate for `cliagents`. It proves that
release-facing docs are honest, local secrets are not tracked or packed, and the
deterministic broker contract still passes before the repository is made public.

## Required Deterministic Gate

Run:

```bash
pnpm run release:check
```

The gate checks:

- whitespace and conflict markers via `git diff --check`
- canonical documentation map integrity
- focused supported broker test suite
- auth fail-closed behavior
- runtime consistency
- package contents allowlist
- tracked local artifact audit
- production dependency audit

## Required Manual Gate

Before a public repository switch or release tag:

```bash
gitleaks detect --no-banner
# or:
trufflehog filesystem --no-update .
```

All true positives must be removed from history or documented as remediated
before public release.

## Adapter Status Gate

Update `docs/adapters.md` before release. An adapter may be marked
`supported-alpha` only when the child adapter reliability matrix reports ready
across three consecutive runs in the last 24 hours.

`qwen-cli` remains `experimental/degraded` unless it passes:

- three successful session creates
- three successful follow-up messages
- one successful resume
- all within one hour

## Release Scope

The `0.1.0-alpha.0` release is GitHub-only. `package.json` must keep
`private: true`; npm publication is intentionally disabled.

Deferred after alpha:

- usage UI
- room console actions
- remote/mobile UX
- direct PTY host
- tunnels
- phase DAG orchestration
- summary graph/tree product
