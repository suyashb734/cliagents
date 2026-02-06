# cliagents

A Node.js server that wraps CLI-based AI agents (Claude Code, Gemini CLI, Codex) and exposes them via HTTP REST API, WebSocket, and MCP for multi-agent orchestration.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

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
- [License](#license)

## Why cliagents?

### Stop Paying Twice for AI

Most developers use API keys, paying per token. But if you already have **Claude Pro**, **ChatGPT Plus**, or a **Google account**, you're paying twice:

| Approach | Cost | What You Get |
|----------|------|--------------|
| **Claude API** | ~$150/mo heavy use | Pay-per-token |
| **Claude Code CLI** (Pro) | $20/mo flat | Included with Pro subscription |
| **Gemini API** | Free tier limited | Flash-only, rate limits |
| **Gemini CLI** | FREE | Full access with Google account |
| **OpenAI API** | Pay-per-token | No subscription benefits |
| **Codex CLI** (Plus) | $20/mo flat | Included with ChatGPT Plus |

**cliagents lets you use CLI tools programmatically** - build and test with generous CLI limits instead of burning API credits.

### Multi-Agent Cost Optimization

By orchestrating multiple CLI agents, you can:
- **Distribute workload** across agents to stay within individual rate limits
- **Use the right tool** for each task (Gemini for research, Claude for coding, Codex for review)
- **Avoid premium tiers** by parallelizing work across standard subscriptions

## Key Features

- **OpenAI-Compatible API** - Drop-in replacement using existing SDKs
- **Multi-Agent Orchestration** - Coordinate tasks across Claude, Gemini, and Codex
- **Persistent Sessions** - Maintain context across multiple interactions
- **Skills System** - Reusable workflows for TDD, debugging, code review
- **MCP Integration** - Use from Claude Code or other MCP-enabled tools

## Quick Start

### Prerequisites

- **Node.js** 18+
- **npm** for package management
- **At least one CLI agent installed**:
  - Claude Code: `npm i -g @anthropic-ai/claude-code`
  - Gemini CLI: `npm i -g @google/gemini-cli`
  - Codex CLI: `npm i -g @openai/codex`

### Installation

```bash
git clone https://github.com/suyashb734/cliagents.git
cd cliagents
npm install
npm start
```

Server runs at `http://localhost:4001`

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

### Primary (Fully Tested)

| Adapter | CLI Command | Cost | Install |
|---------|-------------|------|---------|
| `claude-code` | `claude` | $20/mo (Pro) | `npm i -g @anthropic-ai/claude-code` |
| `gemini-cli` | `gemini` | FREE | `npm i -g @google/gemini-cli` |
| `codex-cli` | `codex` | $20/mo (Plus) | `npm i -g @openai/codex` |

### Experimental

| Adapter | CLI Command | Status |
|---------|-------------|--------|
| `amazon-q` | `q` | Implemented, needs testing |
| `github-copilot` | `gh copilot` | Implemented, needs testing |

See [docs/adapters.md](docs/adapters.md) for all adapters including Aider, Goose, and others.

## OpenAI-Compatible API

Use existing OpenAI SDKs with cliagents:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4001/v1',
  apiKey: 'unused'  // Not needed in dev mode
});

const response = await client.chat.completions.create({
  model: 'claude-sonnet-4-20250514',  // or 'gemini-2.5-flash', 'gpt-4o'
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
| `claude-*` models | Claude Code |
| `gemini-*` models | Gemini CLI |
| `gpt-*`, `o3-*`, `o4-*` | Codex CLI |

### Switching to Production

When ready for production, change two lines:

```javascript
// Development
const client = new OpenAI({
  baseURL: 'http://localhost:4001/v1',
  apiKey: 'unused'
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

Authentication is **optional** and disabled by default (dev mode).

To enable:

```bash
export CLI_AGENTS_API_KEY="your-secret-key"
npm start
```

Then include in requests:
```bash
curl -H "Authorization: Bearer your-secret-key" ...
# or
curl -H "X-API-Key: your-secret-key" ...
```

> **Note**: For production deployment, always set `CLI_AGENTS_API_KEY` or use a reverse proxy with authentication.

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
│              (claude, gemini, codex, ...)               │
└─────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLI_AGENTS_API_KEY` | API key for authentication | None (dev mode) |
| `PORT` | Server port | 4001 |

### Programmatic Configuration

```javascript
const { AgentServer } = require('cliagents');

const server = new AgentServer({
  port: 4001,
  defaultAdapter: 'claude-code',
  sessionTimeout: 30 * 60 * 1000,  // 30 minutes
  maxSessions: 10
});

await server.start();
```

## Development

### Running Tests

```bash
npm test
```

### Development Mode

```bash
npm run dev  # Starts with --watch
```

### Adding Adapters

See [docs/adding-adapters.md](docs/adding-adapters.md) for the adapter development guide.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
