# Track A Launch Profile

This profile is the reproducible setup path for external design-partner onboarding.
It validates two orchestration flows (`implement` + `review`) across at least two adapters.

## Success Condition

- Clean-machine bootstrap finishes without undocumented manual steps.
- `scripts/track-a-launch-smoke.js` passes `implement` and `review` flows for at least two adapters.
- Failure classes and retry behavior are captured in [FAILURE-RETRY-TAXONOMY.md](./FAILURE-RETRY-TAXONOMY.md).

## Clean Machine Prerequisites

```bash
# Node + package manager
nvm install 22.12.0
nvm use 22.12.0
npm i -g pnpm

# Required adapters for Track A proof
npm i -g @openai/codex
npm i -g @google/gemini-cli

# Verify binaries
codex --version
gemini --version

# Authenticate once per machine/session
codex auth login
gemini auth login
```

## Local Broker Profile

```bash
git clone https://github.com/suyashb734/cliagents.git
cd cliagents
pnpm install

# Smoke validation starts an isolated local broker automatically.
node scripts/run-with-supported-node.js scripts/track-a-launch-smoke.js \
  --adapters codex-cli,gemini-cli \
  --work-dir "$(pwd)"
```

When no `CLIAGENTS_API_KEY` (or `CLI_AGENTS_API_KEY`) is configured, the local smoke script
automatically enables `CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1` for its temporary loopback
broker and restores the environment afterward.

Expected result:

- `codex-cli` and `gemini-cli` show `implement: pass` and `review: pass`
- Summary ends with `overall=PASS`

## Hosted Broker Profile

Use this when validating a deployed `cliagents` instance.

```bash
export CLIAGENTS_BASE_URL="https://<your-hosted-cliagents>"
export CLIAGENTS_API_KEY="<hosted-api-key>"

node scripts/run-with-supported-node.js scripts/track-a-launch-smoke.js \
  --base-url "$CLIAGENTS_BASE_URL" \
  --adapters codex-cli,gemini-cli \
  --work-dir "$(pwd)"
```

`scripts/track-a-launch-smoke.js` automatically reads `CLIAGENTS_API_KEY` (or `CLI_AGENTS_API_KEY`) from the environment in hosted mode.

## Evidence Capture

```bash
node scripts/run-with-supported-node.js scripts/track-a-launch-smoke.js \
  --adapters codex-cli,gemini-cli \
  --json > launch-smoke-result.json
```

Store the JSON result in your issue or release checklist with:

- timestamp
- adapter pass/fail
- per-flow attempts and failure class (if any)
- overall pass/fail

## Latest Validation Evidence

Validation date: **2026-05-07**

Commands run:

```bash
# KD-59 corrected repro: no API key env aliases configured
env -u CLIAGENTS_API_KEY -u CLI_AGENTS_API_KEY \
  node scripts/run-with-supported-node.js scripts/track-a-launch-smoke.js \
    --adapters codex-cli,gemini-cli \
    --work-dir "$(pwd)" \
    --json --quiet
```

Observed results:

- Local smoke auto-enabled loopback-only unauth mode (`CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1`) for the temporary broker, so requests no longer failed at `GET /adapters` with `401`.
- Launch smoke completed with `success=true` and `passedAdapters=2/2` (`codex-cli`, `gemini-cli`).
- `codex-cli`: implement passed in 1 attempt (~11.5s), review passed in 1 attempt (~10.6s).
- `gemini-cli`: implement passed in 2 attempts (~260.0s), review passed in 1 attempt (~42.9s).
