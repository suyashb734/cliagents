# cliagents

A Node.js server that brokers Codex CLI, Gemini CLI, Qwen CLI, OpenCode CLI, and Claude Code over HTTP, WebSocket, and MCP for multi-agent orchestration.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Alpha status: `cliagents` is a GitHub-only alpha. The current package is not
> intended for npm publication and public APIs/storage shapes may change.

## Table of Contents

- [Alpha Caveats](#alpha-caveats)
- [How this differs](#how-this-differs)
- [Why cliagents?](#why-cliagents)
- [Key Features](#key-features)
- [Quick Start](#quick-start)
- [Use Cases](#use-cases)
- [Core Adapters](#core-adapters)
- [OpenAI-Compatible API](#openai-compatible-api)
- [Multi-Agent Orchestration](#multi-agent-orchestration)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Alpha Caveats

- `cliagents` controls local CLI and tmux processes. A valid broker token should be treated as local shell access for the current user.
- The server binds to `127.0.0.1` by default. Exposing it on a LAN or through a tunnel is an explicit operator decision and requires authentication.
- Native provider TUIs inside broker-managed tmux roots may not perfectly match direct Codex, Claude, Gemini, Qwen, or OpenCode UI fidelity.
- MCP stdio clients may need restart after broker restarts so they pick up the current broker and local-token state.
- Live provider tests depend on local auth, quotas, provider capacity, and upstream CLI behavior. Deterministic tests are the release gate; live tests are adapter-readiness evidence.
- Qwen CLI is experimental/degraded unless the child adapter reliability matrix proves current auth, follow-up, and resume behavior.
- Usage and cost fields are limited to provider-reported or broker-observable metadata. `unknown` models, zero costs, or missing durations can be valid alpha outputs.

## How this differs

`cliagents` is a local broker/control plane, not a hosted product, terminal
replacement, or chat UI. It exposes installed coding CLIs over HTTP, WebSocket,
OpenAI-compatible APIs, and MCP so other programs can drive durable roots,
children, rooms, tasks, memory, usage, and replay.

Compared with Chorus, `cliagents` is broader than multi-LLM review templates and
focuses on persistent broker state. Compared with CAO, it emphasizes memory,
usage attribution, root/session lineage, and remote-supervision-ready broker
objects. Compared with Warp, it is not trying to replace the terminal UI.
Compared with Multica, it is local broker infrastructure rather than a team task
board or hosted agent platform.

## Why cliagents?

### 1. Stop Paying Twice for AI

Most developers use API keys, paying per token. But if you already have **ChatGPT Plus**, **Claude Pro**, a **Google account**, or **Qwen Code CLI access**, you're paying twice:

| Approach | Cost | What You Get |
|----------|------|--------------|
| **Claude API** | ~$150/mo heavy use | Pay-per-token |
| **Claude Code CLI** (Pro) | $20/mo flat | Included with Pro subscription |
| **Gemini API** | Free tier limited | Flash-only, rate limits |
| **Gemini CLI** | FREE | Full access with Google account |
| **OpenAI API** | Pay-per-token | No subscription benefits |
| **Codex CLI** (Plus) | $20/mo flat | Included with ChatGPT Plus |
| **Qwen API** | Pay-per-token | Separate hosted billing |
| **Qwen CLI** | Subscription/OAuth | Uses your local CLI auth |

**cliagents lets you use CLI tools programmatically** - build and test with generous CLI limits instead of burning API credits.

### 2. Better Output Through Multi-Agent Collaboration

Even if token cost isn't your concern, **three agents thinking about the same problem find more issues than one agent spending 3x the time**. Different models have different strengths and blind spots:

| Agent | Strengths | Typical Catches |
|-------|-----------|-----------------|
| **Qwen** | Planning, architecture, alternative approaches | Design flaws, coordination gaps |
| **Gemini** | Security analysis, breadth | Injection vectors, auth gaps |
| **Codex** | Code correctness, edge cases | Crash bugs, resource leaks |

In our own testing, we ran all three agents reviewing the same PR:
- Gemini found shell injection bypasses that others missed
- Codex found crash bugs in timeout handling that Gemini missed
- Qwen pushed back on planning assumptions and surfaced architectural gaps

**The value is in diversity of analysis, not just parallelism.**

### 3. Multi-Agent Cost Optimization

By orchestrating multiple CLI agents, you can:
- **Distribute workload** across agents to stay within individual rate limits
- **Use the right tool** for each task (Gemini for research, Claude for coding, Codex for review)
- **Avoid premium tiers** by parallelizing work across standard subscriptions

### What cliagents Is Good For

- **Multi-agent code reviews** - 3 agents reviewing from different angles catch more bugs
- **Plan-implement-review workflows** - One agent plans, another implements, a third reviews
- **Parallel task execution** - Independent tasks run on different agents simultaneously
- **Code generation and editing** - Subagents write focused, file-level changes
- **Research and analysis** - Agents explore codebases, read docs, summarize findings
- **Collaborative problem solving** - Agents debate approaches via shared artifacts/findings

### What cliagents Is NOT Good For

- **Running tests or build commands** - Subagents run inside tmux; shell operations like `pnpm test` should be run by the orchestrator, not delegated
- **Git operations** - Commits, pushes, and PR creation affect shared state and need orchestrator control
- **Server management** - Starting/stopping services requires host-level access
- **Real-time interactive tasks** - tmux-based communication has inherent latency
- **Tasks requiring GUI interaction** - CLI agents are text-only

## Key Features

- **OpenAI-Compatible API** - Drop-in replacement using existing SDKs
- **Multi-Agent Orchestration** - Coordinate tasks across local CLI agents including Claude Code, Gemini, Codex, Qwen, and OpenCode
- **Persistent Sessions** - Maintain context across multiple interactions
- **Managed-Root Notifications** - macOS, webhook, and Telegram completion/attention alerts for broker-managed roots
- **Skills System** - Reusable workflows for TDD, debugging, code review
- **MCP Integration** - Use from Claude Code or other MCP-enabled tools

## Quick Start

### Prerequisites

- **Node.js** 22.12.0 (the supported alpha runtime; see [`.nvmrc`](./.nvmrc))
- **pnpm** for package management
- **tmux** for managed roots and child sessions
- **At least one supported CLI agent installed**:
  - Claude Code: `npm i -g @anthropic-ai/claude-code`
  - Gemini CLI: `npm i -g @google/gemini-cli`
  - Codex CLI: `npm i -g @openai/codex`
  - Qwen CLI: install `qwen` and authenticate locally
  - OpenCode CLI: install `opencode` and authenticate locally

### Installation

```bash
git clone https://github.com/suyashb734/cliagents.git
cd cliagents
pnpm install
pnpm start
```

Server runs at `http://localhost:4001`

Run an isolated broker instance with separate state and tmux namespace:

```bash
cliagents serve \
  --port 4011 \
  --data-dir /tmp/cliagents-a/data \
  --log-dir /tmp/cliagents-a/logs \
  --tmux-socket /tmp/cliagents-a/broker.sock
```

### First Request

```bash
# One-shot ask
curl -X POST http://localhost:4001/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 2+2?", "adapter": "gemini-cli"}'

# OpenAI-compatible endpoint
curl -X POST http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Use Cases

### 1. Planning & Review Workflows
Use Claude as a supervisor to create plans, then have Gemini and Codex review and refine before implementation.

### 2. Orchestrated Implementation
Claude breaks down a feature into tasks, delegates implementation to Gemini, and monitors progress. Codex reviews each piece for security.

### 3. Code Review Ensemble
Run code through multiple agents in parallel - each catches different issues:
- Claude: Logic bugs, architecture concerns
- Gemini: Documentation, API design
- Codex: Security vulnerabilities, performance

### 4. AI-Driven TDD
One agent writes failing tests, another implements code to pass them, a third refactors. Full Red-Green-Refactor cycle.

### 5. Automated Documentation
Agents monitor code changes and automatically update READMEs, API docs, and inline comments.

## Core Adapters

### Alpha Adapter Status

| Adapter | CLI Command | Alpha status | Install |
|---------|-------------|--------------|---------|
| `claude-code` | `claude` | Experimental until 3-run child reliability evidence is recorded | `npm i -g @anthropic-ai/claude-code` |
| `gemini-cli` | `gemini` | Experimental until 3-run child reliability evidence is recorded | `npm i -g @google/gemini-cli` |
| `codex-cli` | `codex` | Experimental until 3-run child reliability evidence is recorded | `npm i -g @openai/codex` |
| `qwen-cli` | `qwen` | Experimental/degraded by default | install `qwen` and authenticate |
| `opencode-cli` | `opencode` | Experimental until 3-run child reliability evidence is recorded | install `opencode` and authenticate |

See [docs/adapters.md](docs/adapters.md) for the timestamped adapter status table and [docs/reference/ADAPTER-CONTRACT.md](docs/reference/ADAPTER-CONTRACT.md) for the active broker contract. The active alpha surface is `claude-code`, `gemini-cli`, `codex-cli`, `qwen-cli`, and `opencode-cli`, but each adapter's public status depends on the child reliability matrix.

## OpenAI-Compatible API

Use existing OpenAI SDKs with cliagents:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4001/v1',
  apiKey: process.env.CLIAGENTS_API_KEY
});

const response = await client.chat.completions.create({
  model: 'gpt-4o',  // or 'gemini-2.5-flash', 'qwen-max'
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Model Routing

| Model Name | Routes To |
|------------|-----------|
| `gemini-*` models | Gemini CLI |
| `gpt-*`, `o3-*`, `o4-*` | Codex CLI |
| `qwen-*` models | Qwen CLI |

### Switching to Production

When ready for production, change two lines:

```javascript
// Development
const client = new OpenAI({
  baseURL: 'http://localhost:4001/v1',
  apiKey: process.env.CLIAGENTS_API_KEY
});

// Production - just change baseURL and apiKey
const client = new OpenAI({
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY
});
```

## Multi-Agent Orchestration

cliagents includes an orchestration layer for coordinating multiple agents.

### MCP Tools

When using cliagents as an MCP server with Claude Code:

```javascript
// Delegate task to another agent
delegate_task({
  role: "implement",
  adapter: "gemini-cli",
  message: "Implement the login form based on the design spec"
});

// Run a predefined workflow
run_workflow({
  workflow: "code-review",  // Parallel: bugs + security + performance
  message: "Review src/auth/"
});

// List available skills
list_skills({ tag: "debugging" });
```

### Available Workflows

| Workflow | Description |
|----------|-------------|
| `code-review` | Parallel review for bugs, security, performance |
| `feature` | Plan → Implement → Test |
| `bugfix` | Analyze → Fix → Test |
| `research` | Research → Document |

### Skills System

Skills are reusable workflows loaded from `SKILL.md` files:

```bash
# List available skills
curl http://localhost:4001/orchestration/skills

# Invoke a skill
curl -X POST http://localhost:4001/orchestration/skills/invoke \
  -H "Content-Type: application/json" \
  -d '{"skill": "test-driven-development", "message": "Add user logout"}'
```

Built-in skills: `test-driven-development`, `debugging`, `code-review`, `multi-agent-workflow`, `agent-handoff`

## Authentication

Authentication is **required by default** (fail-closed).

If no API key is configured, `cliagents serve` creates a local broker token at
`$CLIAGENTS_DATA_DIR/local-api-key` (default `./data/local-api-key`). Local
`cliagents` CLI commands read that token automatically, so commands like
`cliagents launch codex` work on the same machine while unauthenticated HTTP
requests still receive `401`.

For explicit shared or remote clients, set either API-key environment variable:

```bash
export CLIAGENTS_API_KEY="your-secret-key"
# or legacy alias:
# export CLI_AGENTS_API_KEY="your-secret-key"
pnpm start
```

Then include in requests:
```bash
curl -H "Authorization: Bearer your-secret-key" ...
# or
curl -H "X-API-Key: your-secret-key" ...
```

### Local Development Override (Explicit Opt-In)

For localhost-only development, you can disable auth explicitly:

```bash
export CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1
cliagents serve --host 127.0.0.1
```

When `CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1` is set without an API key, `cliagents` enforces loopback-only bind hosts (`127.0.0.1`, `::1`, or `localhost`) and refuses non-loopback binds.

### API CORS + Localhost Threat Model

API routes use an explicit origin policy to reduce localhost browser abuse:

- By default, only loopback origins (`localhost`, `127.0.0.1`, `::1`) are accepted for API CORS.
- Add non-loopback origins explicitly with `CLIAGENTS_API_CORS_ALLOWED_ORIGINS` (comma-separated exact origins).
- Set `CLIAGENTS_API_CORS_ALLOW_LOOPBACK=0` to disable implicit loopback-origin allowlisting and require explicit origins only.

This is browser-layer defense in depth, not an authentication replacement. Keep API-key auth enabled for non-local use.

### Dashboard Env Mutation Security

`POST /dashboard/adapters/:name/env` is restricted to adapter-approved auth keys (`ADAPTER_AUTH_CONFIG[adapter].envVars`) plus optional operator-reviewed extras in `CLIAGENTS_DASHBOARD_ENV_MUTATION_EXTRA_KEYS`.

To disable this endpoint entirely, set `CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION=1`.

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/adapters` | List available adapters |
| POST | `/sessions` | Create session |
| POST | `/sessions/:id/messages` | Send message |
| DELETE | `/sessions/:id` | Terminate session |
| POST | `/ask` | One-shot ask |
| GET | `/v1/models` | List models (OpenAI-compatible) |
| POST | `/v1/chat/completions` | Chat (OpenAI-compatible) |

### Orchestration Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/orchestration/handoff` | Delegate task to agent |
| GET | `/orchestration/terminals` | List active terminals |
| GET | `/orchestration/skills` | List available skills |
| POST | `/orchestration/skills/invoke` | Invoke a skill |

Full API documentation: [openapi.json](openapi.json)

## Architecture

Canonical architecture and roadmap documentation starts at [docs/INDEX.md](docs/INDEX.md).
Use that index to distinguish current source-of-truth docs from research notes.

```
┌─────────────────────────────────────────────────────────┐
│                    Client Applications                   │
│         (Web apps, scripts, Claude Code via MCP)        │
└─────────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         HTTP/REST    WebSocket    MCP Server
              │            │            │
┌─────────────┴────────────┴────────────┴─────────────────┐
│                     cliagents Server                     │
│  ┌─────────────────────────────────────────────────────┐│
│  │              Orchestration Layer                     ││
│  │    (Task routing, workflows, skills, handoffs)      ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │              Session Manager                         ││
│  │         (Lifecycle, timeouts, cleanup)              ││
│  └─────────────────────────────────────────────────────┘│
│  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
│  │  Claude   │  │  Gemini   │  │  Codex    │  ...      │
│  │  Adapter  │  │  Adapter  │  │  Adapter  │           │
│  └───────────┘  └───────────┘  └───────────┘           │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│                    CLI Processes                         │
│        (claude, gemini, codex, qwen, opencode)         │
└─────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLIAGENTS_API_KEY` | API key for authentication (preferred) | None |
| `CLI_AGENTS_API_KEY` | API key for authentication (legacy alias) | None |
| `CLIAGENTS_LOCAL_API_KEY_FILE` | Local broker token file used when no env API key is configured | `$CLIAGENTS_DATA_DIR/local-api-key` |
| `CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST` | Allow unauthenticated access only on loopback host when set to `1` | `0` |
| `CLIAGENTS_API_CORS_ALLOWED_ORIGINS` | Comma-separated explicit API CORS origins | None |
| `CLIAGENTS_API_CORS_ALLOW_LOOPBACK` | Allow loopback API CORS origins when set to `1` | `1` |
| `CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION` | Disable `POST /dashboard/adapters/:name/env` when set to `1` | `0` |
| `CLIAGENTS_DASHBOARD_ENV_MUTATION_EXTRA_KEYS` | Optional comma-separated extra env keys allowed by dashboard env mutation route | None |
| `PORT` | Server port | 4001 |
| `CLIAGENTS_HOST` | Server bind host | `127.0.0.1` |
| `CLIAGENTS_DATA_DIR` | Broker data directory | `./data` |
| `CLIAGENTS_LOG_DIR` | Broker terminal log directory | `./logs` |
| `CLIAGENTS_TMUX_SOCKET` | Broker-specific tmux socket path | shared default tmux server |
| `CLIAGENTS_WORK_DIR` | Default orchestration working directory | current working directory |
| `CLIAGENTS_DESTROY_TERMINALS_ON_STOP` | Destroy broker terminals on shutdown when set to `1` | `0` |
| `CLIAGENTS_NOTIFICATIONS` | Managed-root notification channels: `off`, `macos`, `webhook`, `telegram`, `all` | `macos` on macOS |
| `CLIAGENTS_NOTIFY_ON` | Notification status aliases or statuses: `done`, `blocked`, `error`, `idle`, `completed`, `waiting_permission`, `waiting_user_answer` | `idle,completed,waiting_permission,waiting_user_answer,error` |
| `CLIAGENTS_NOTIFY_WEBHOOK_URL` | Optional webhook URL for managed-root notification JSON payloads | None |
| `CLIAGENTS_TELEGRAM_BOT_TOKEN` | Optional Telegram bot token for direct Telegram notifications | None |
| `CLIAGENTS_TELEGRAM_CHAT_ID` | Optional Telegram chat id for direct Telegram notifications | None |
| `CLIAGENTS_NOTIFY_POLL_MS` | Managed-root status polling interval for notification detection | `3000` |

### Programmatic Configuration

```javascript
const { AgentServer } = require('cliagents');

const server = new AgentServer({
  port: 4001,
  host: '127.0.0.1',
  defaultAdapter: 'codex-cli',
  sessionTimeout: 30 * 60 * 1000,  // 30 minutes
  maxSessions: 10,
  orchestration: {
    dataDir: '/tmp/cliagents-a/data',
    logDir: '/tmp/cliagents-a/logs',
    tmuxSocketPath: '/tmp/cliagents-a/broker.sock',
    workDir: process.cwd()
  }
});

await server.start();
```

### CLI Server Startup

```bash
cliagents serve --port 4011 --data-dir /tmp/cliagents-a/data --log-dir /tmp/cliagents-a/logs --tmux-socket /tmp/cliagents-a/broker.sock

# bare flags work too
cliagents --port 4011 --data-dir /tmp/cliagents-a/data --log-dir /tmp/cliagents-a/logs --tmux-socket /tmp/cliagents-a/broker.sock
```

## Development

### Running Tests

```bash
pnpm test
pnpm run test:runtime
pnpm run test:broad
pnpm run smoke:deterministic
pnpm run release:check
```

`pnpm test` runs the focused supported broker suite for `claude-code`, `gemini-cli`, `codex-cli`, `qwen-cli`, and `opencode-cli`.
Use the package scripts instead of ad-hoc `node` invocations when possible; they route through the supported Node `22.12.0` wrapper from [`.nvmrc`](./.nvmrc).
`pnpm run test:runtime` and `pnpm run test:broad` may report provider-auth, token-expiry, provider-discontinuation, quota, capacity, or timeout conditions as skips when the broker contract itself is still correct.
`pnpm run smoke:deterministic` runs a deterministic smoke suite for delegated lifecycle success/failure/timeout/retry plus core route health checks, and writes machine-readable + markdown evidence to `artifacts/deterministic-smoke/latest.json` and `artifacts/deterministic-smoke/latest.md`.
`pnpm run release:check` is the deterministic public-alpha gate. It does not replace the full-history secret scan or opt-in live adapter matrix.

### Development Mode

```bash
pnpm run dev  # Starts with --watch
```

### Adding Adapters

See [docs/adding-adapters.md](docs/adding-adapters.md) for the adapter development guide.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Documentation

- [docs/INDEX.md](docs/INDEX.md) is the canonical documentation entrypoint.
- [docs/reference/ALPHA-RELEASE.md](docs/reference/ALPHA-RELEASE.md) is the public-alpha release checklist.
- [docs/CANONICAL-MAP.json](docs/CANONICAL-MAP.json) classifies docs for agents and humans.
- Files in `docs/research/` are context unless the canonical map marks them as canonical or active.

## License

MIT
