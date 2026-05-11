# Security Policy

`cliagents` is pre-stable alpha software. Report security issues privately; do
not open public issues for vulnerabilities.

## Threat Model

`cliagents` is a local broker that can start, inspect, and send input to coding
CLI processes through tmux and provider CLIs. A valid broker token can control
local execution as the current OS user. Treat `CLIAGENTS_API_KEY`,
`CLI_AGENTS_API_KEY`, and `data/local-api-key` as shell-access secrets.

## In-Scope

- Broker HTTP, WebSocket, OpenAI-compatible, and MCP entrypoints.
- Authentication, local-token handling, and default bind behavior.
- Terminal input, approval, denial, and queued input delivery.
- Dashboard environment mutation controls.
- Secret redaction in persisted broker events and logs.
- Package contents that could accidentally publish local data, logs, DB files,
  or tokens.

## Out-of-Scope

- Vulnerabilities in upstream provider CLIs such as `claude`, `codex`,
  `gemini`, `qwen`, or `opencode`.
- Provider model behavior, hallucinations, or unsafe generated code.
- Local machine compromise outside the broker process.
- Deliberately enabling full-trust provider or shell modes on a machine you do
  not control.

## Default Bindings

The broker binds to `127.0.0.1` by default. Remote or LAN exposure requires an
explicit host override such as `CLIAGENTS_HOST=0.0.0.0` or `--host 0.0.0.0`.

Authentication is required by default. If no explicit API key is configured, the
broker creates a same-machine local token in `$CLIAGENTS_DATA_DIR/local-api-key`.
Unauthenticated localhost mode is available only through the explicit
development override `CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1` and must not
be used with tunnels or non-loopback hosts.

## Token Handling

- Prefer a long random `CLIAGENTS_API_KEY` for any shared or remote client.
- Never commit `.env`, `data/local-api-key`, DB files, terminal logs, or local
  diagnostic bundles.
- Rotate the broker token if it appears in logs, screenshots, shell history, or
  issue reports.
- Use `pnpm run release:check` plus a full-history secret scan before making a
  repository public.

## Remote Exposure Guidance

Remote clients should use broker APIs and capability-gated input queues, not raw
tmux or shell control. If exposing the broker through LAN, Tailscale,
Cloudflare, SSH tunnels, or a future mobile app, keep API-key auth enabled and
restrict network access to trusted operators.

## Reporting

Email security reports to the project owner or repository maintainer. Include:

- affected version or commit
- reproduction steps
- impact assessment
- whether local tokens, logs, DBs, or provider credentials were exposed

We will coordinate disclosure timing for confirmed vulnerabilities.
