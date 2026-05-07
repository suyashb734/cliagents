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
# Track A implement+review proof across two adapters
node scripts/run-with-supported-node.js scripts/track-a-launch-smoke.js \
  --adapters codex-cli,claude-code \
  --work-dir "$(pwd)" \
  --json

# Cross-adapter child reliability matrix (live)
CLIAGENTS_READINESS_JSON=1 node scripts/run-with-supported-node.js \
  tests/test-child-adapter-reliability-live.js
```

Observed results:

- Launch smoke: `success=true`, `passedAdapters=2/2` (`codex-cli`, `claude-code`)
- `codex-cli`: implement/review both passed in 1 attempt each
- `claude-code`: implement/review both passed in 1 attempt each
- Reliability matrix: `gemini-cli`, `opencode-cli`, and `claude-code` were `ready`; `codex-cli` was `partial` (subagent continuity), and `qwen-cli` required auth migration
- Qwen note from live run: OAuth discontinuation message references **2026-04-15** and recommends `qwen auth` migration
