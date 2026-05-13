# BPE Integration Scenario Contract

This document defines the `cliagents -> BPE -> target` integration scenario added for Track B1.

## Scope

- `cliagents` drives session orchestration and failure handling.
- BPE (`/v1` gateway) executes browser state/action APIs.
- Target is any navigable web URL that exposes a search-style interaction.

Implementation entry points:

- `src/services/bpe-gateway-client.js`
- `src/services/bpe-integration-scenario.js`
- `scripts/run-bpe-integration-scenario.js`

## End-To-End Scenario

The scenario executes this fixed path:

1. `POST /v1/sessions`
2. `POST /v1/sessions/:sessionId/navigate`
3. `GET /v1/sessions/:sessionId/state`
4. `POST /v1/sessions/:sessionId/resolve-action`
5. `POST /v1/sessions/:sessionId/actions`
6. `POST /v1/sessions/:sessionId/extract`
7. `DELETE /v1/sessions/:sessionId`

The runner returns a timeline payload for each step and always attempts session cleanup on failure.

## Request/Response Contract

### Session Create

Request shape:

```json
{
  "browser": "chromium",
  "viewport": { "width": 1440, "height": 900 },
  "tenantId": "cliagents-bpe-scenario",
  "headless": true,
  "enableVisionFallback": false,
  "connection": { "mode": "launch" }
}
```

Required response fields:

- `sessionId` (string)
- `browserWorkerId` (string)
- `stateVersion` (number)

### Navigate

Request shape:

```json
{ "url": "https://www.wikipedia.org/" }
```

Required response fields:

- `sessionId` (string)
- `url` (string)
- `stateVersion` (number)

### State

Required response fields:

- `sessionId` (string)
- `stateVersion` (number)
- `elements` (array)

### Resolve Action

Request shape:

```json
{ "intent": "Search for \"Alan Turing\" and submit the query" }
```

Required response fields:

- `type` (string)
- `confidence` (number)
- `selectedElementId` (string or null)

### Execute Actions

Request shape:

```json
{
  "actions": [
    { "type": "type", "target": "search-input", "value": "Alan Turing" },
    { "type": "click", "target": "search-submit" }
  ],
  "requireConfirmation": false,
  "expectedStateVersion": 7
}
```

Required response fields:

- `executionId` (string)
- `status` (string)
- `newStateVersion` (number)

### Extract

Request shape:

```json
{
  "schemaName": "cliagents_bpe_search_confirmation",
  "includePage": true,
  "collections": []
}
```

Required response fields:

- `sessionId` (string)
- `schemaName` (string)
- `collections` (array)

### Close Session

Required response fields:

- `closed` (boolean)
- `sessionId` (string)

## Failure Semantics

`BpeGatewayError` normalizes transport and API failures into the schema below:

```json
{
  "name": "BpeGatewayError",
  "stage": "execute_actions",
  "method": "POST",
  "path": "/v1/sessions/:id/actions",
  "statusCode": 409,
  "code": "state_version_conflict",
  "classification": "retryable",
  "retryable": true,
  "recommendedAction": "refresh_state_and_retry"
}
```

Top modes and expected handling:

- `state_version_conflict` (`409`): `retryable`; refresh state and replay action plan.
- `session_not_found` (`404`): non-retryable for in-flight run; recreate session from start.
- request validation (`400`/`422`): non-retryable; fix payload or action selection bug.
- auth/permissions (`401`/`403`): operator action required; rotate credentials or policy.
- gateway/network/timeout (`429`/`5xx`/transport): retryable with bounded backoff.

## Known Limitations

- Scenario is intentionally single-flow (search-style controls), not a generic planner.
- Element heuristics use current BPE semantic state quality; low-quality page labeling can degrade action planning.
- No CAPTCHA/challenge recovery in this lane.
- No automatic multi-attempt replay is baked into the runner yet; callers own retry budget.

## Rollout Guardrails

- Enforce bounded retries (for example, `max=2`) on `retryable` failures.
- Emit scenario timeline + failure metadata to durable logs for triage.
- Keep `expectedStateVersion` set on action execution to avoid stale writes.
- Run smoke validation with a controlled target before enabling new target domains.

## Verification

Mocked end-to-end proof:

```bash
npm run test:bpe-integration
```

Manual runner:

```bash
node scripts/run-with-supported-node.js scripts/run-bpe-integration-scenario.js \
  --gateway-url http://127.0.0.1:4700 \
  --target-url https://www.wikipedia.org/ \
  --search-query "Alan Turing"
```
