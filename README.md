# cliagents

A Node.js server that wraps CLI-based AI agents (Claude Code, Gemini CLI, Codex, etc.) and exposes them via HTTP REST API and WebSocket for real-time streaming.

> **Security Notice**: This server has no built-in authentication and is intended for **local development only**. Do not expose to the public internet without adding authentication via a reverse proxy.

## Why?

### Stop Paying for API Keys During Development

Most developers use API keys to integrate AI into their apps, paying per token. But if you already have a **Claude Pro**, **ChatGPT Plus**, or **Google account**, you're paying twice:

| Approach | Cost | What You Get |
|----------|------|--------------|
| **Claude API** | ~$150/mo for heavy use | Pay-per-token billing |
| **Claude Code CLI** (Pro) | $20/mo flat | ~7.5x more value, included with Pro |
| **Gemini API** | Free tier is Flash-only | Severe rate limits |
| **Gemini CLI** | FREE | Blended Pro/Flash with better limits |
| **OpenAI API** | Pay-per-token | No subscription benefits |
| **Codex CLI** (Plus) | $20/mo flat | Included with ChatGPT Plus |

**This server lets you use CLI tools programmatically**, so you can build and test with the generous CLI limits instead of burning through API credits.

### The Problem with CLI Tools

CLI agents like Claude Code are powerful but:
- They're designed for terminal use, not programmatic access
- Each invocation spawns a new process (slow, no session persistence)
- No easy way to integrate into web apps or other services

### What This Server Does

- Maintains **persistent sessions** with CLI agents
- Provides **HTTP and WebSocket APIs** for easy integration
- Supports **multiple adapters** for different AI CLIs
- Handles **session management**, timeouts, and cleanup
- **OpenAI-compatible API** (`/v1/chat/completions`) for easy SDK integration

## OpenAI-Compatible API

cliagents exposes an OpenAI-compatible endpoint, so you can use existing SDKs:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'unused'  // Not needed for CLI agents
});

// Works with Claude, Gemini, or OpenAI models
const response = await client.chat.completions.create({
  model: 'claude-sonnet-4-20250514',  // or 'gemini-2.5-flash', 'gpt-4o'
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Available Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat (streaming & non-streaming) |
| `GET /v1/models` | List available models (based on installed CLIs) |
| `GET /v1/models/:id` | Get specific model info |

### Model Routing

The model name determines which CLI adapter handles the request:

| Model Name | Routes To |
|------------|-----------|
| `gpt-4o`, `gpt-4o-mini`, `o3-mini` | Codex CLI |
| `claude-sonnet-4-20250514`, `claude-opus-4-5-20250514` | Claude Code |
| `gemini-2.5-flash`, `gemini-2.5-pro` | Gemini CLI |

## Switching to Production

cliagents is a **development tool**. When you're ready for production, switch to real APIs with minimal code changes:

### Option 1: Direct API (Single Provider)

```javascript
// DEVELOPMENT
const client = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'unused'
});

// PRODUCTION - Change 2 lines
const client = new OpenAI({
  baseURL: 'https://api.openai.com/v1',  // ← Change
  apiKey: process.env.OPENAI_API_KEY      // ← Change
});

// Same code works!
const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }]
});
```

### Option 2: LiteLLM (Multi-Provider) - Recommended

For production with multiple providers (Claude, GPT, Gemini), use [LiteLLM](https://docs.litellm.ai/):

```javascript
// DEVELOPMENT - cliagents
const client = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'unused'
});

// PRODUCTION - LiteLLM proxy (same OpenAI SDK!)
const client = new OpenAI({
  baseURL: 'http://your-litellm-proxy:4000/v1',
  apiKey: process.env.LITELLM_API_KEY
});

// Add provider prefix for routing
const response = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-20250514',  // ← Add prefix
  messages: [{ role: 'user', content: 'Hello' }]
});
```

### Option 3: Environment-Based Switch

```javascript
import OpenAI from 'openai';

const isDev = process.env.NODE_ENV === 'development';

const client = new OpenAI({
  baseURL: isDev ? 'http://localhost:3001/v1' : 'https://api.openai.com/v1',
  apiKey: isDev ? 'unused' : process.env.OPENAI_API_KEY
});

// Zero code changes between dev and prod
```

## Installation

```bash
git clone https://github.com/suyashb734/cliagents.git
cd cliagents
npm install
npm start
```

## Quick Start

### As a Standalone Server

```bash
npm start
# Server running at http://localhost:3001
# WebSocket at ws://localhost:3001/ws
```

### As a Module

```javascript
const { createSessionManager, AgentServer } = require('cliagents');

// Option 1: Programmatic usage (no HTTP server)
const manager = createSessionManager();
const session = await manager.createSession({ adapter: 'claude-code' });
const response = await manager.send(session.sessionId, 'What is 2+2?');
console.log(response.text);
await manager.terminateSession(session.sessionId);

// Option 2: With HTTP server
const server = new AgentServer({ port: 3001 });
await server.start();
```

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/adapters` | List available adapters |
| POST | `/sessions` | Create a new session |
| GET | `/sessions` | List all sessions |
| GET | `/sessions/:id` | Get session info |
| POST | `/sessions/:id/messages` | Send message to session |
| POST | `/sessions/:id/parse` | Parse response text |
| DELETE | `/sessions/:id` | Terminate session |
| POST | `/ask` | One-shot ask (auto-creates and terminates session) |

### Create Session

```bash
curl -X POST http://localhost:3001/sessions \
  -H "Content-Type: application/json" \
  -d '{"adapter": "claude-code"}'
```

Response:
```json
{
  "sessionId": "abc123...",
  "adapter": "claude-code",
  "status": "ready"
}
```

### Send Message

```bash
curl -X POST http://localhost:3001/sessions/abc123/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the capital of France?"}'
```

Response:
```json
{
  "text": "The capital of France is Paris.",
  "result": "The capital of France is Paris.",
  "metadata": {
    "inputTokens": 12,
    "outputTokens": 8
  }
}
```

### One-Shot Ask

```bash
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 2+2?"}'
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.type, msg);
};

// Create session
ws.send(JSON.stringify({ type: 'create_session', adapter: 'claude-code' }));

// Send message (after session created)
ws.send(JSON.stringify({ type: 'send_message', message: 'Hello!' }));

// Receive streaming chunks
// { type: 'chunk', chunk: { type: 'text', content: '...' } }
// { type: 'complete' }
```

## Supported Adapters

### ✅ Tested & Production-Ready

These adapters are fully tested with the test suite:

| Adapter | CLI | Cost | Install |
|---------|-----|------|---------|
| `claude-code` | `claude` | FREE with Claude Pro ($20/mo) | `npm i -g @anthropic-ai/claude-code` |
| `gemini-cli` | `gemini` | FREE (Google account) | `npm i -g @google/gemini-cli` |

### 🧪 Implemented (Not Yet Tested)

These adapters are implemented but need real-world testing:

| Adapter | CLI | Cost | Install |
|---------|-----|------|---------|
| `codex-cli` | `codex` | FREE with ChatGPT Plus ($20/mo) | `npm i -g @openai/codex` |
| `mistral-vibe` | `vibe` | FREE until Dec 2025 | [GitHub releases](https://github.com/mistralai/mistral-vibe) |
| `amazon-q` | `kiro` | FREE tier available | AWS CLI plugin |
| `plandex` | `plandex` | FREE cloud tier | `curl -sL plandex.ai/install.sh \| bash` |
| `github-copilot` | `gh copilot` | $10/mo (free for students) | `gh extension install github/gh-copilot` |

### 🔌 API Key Routers (Require Your Own Keys)

These wrap CLIs that need your own API keys - no free tier benefit:

| Adapter | CLI | What It Does | Install |
|---------|-----|--------------|---------|
| `aider` | `aider` | AI pair programming with Git | `pip install aider-chat` |
| `goose` | `goose` | Block's open-source agent | `brew install goose` |
| `shell-gpt` | `sgpt` | Shell command generation | `pip install shell-gpt` |
| `aichat` | `aichat` | Multi-provider CLI | `cargo install aichat` |
| `continue-cli` | `cn` | IDE-style coding agent | `npm i -g @continuedev/cli` |

---

### Claude Code
Anthropic's official CLI for Claude. Best for coding tasks.

```bash
# Install
npm i -g @anthropic-ai/claude-code
```

```javascript
const session = await manager.createSession({
  adapter: 'claude-code',
  model: 'claude-sonnet-4-5-20250514',  // Optional
  workDir: '/path/to/project',
  systemPrompt: 'You are a helpful assistant'
});
```

**Models**: `claude-sonnet-4-5-20250514`, `claude-opus-4-5-20250514`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`

---

### Gemini CLI
Google's Gemini models via CLI. FREE with any Google account.

```bash
# Install (requires Node.js 20+)
npm install -g @google/gemini-cli
```

```javascript
const session = await manager.createSession({
  adapter: 'gemini-cli',
  model: 'gemini-2.5-pro',
  temperature: 0.7,  // Generation params
  top_p: 0.9
});
```

**Models**: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-pro-preview`

---

### OpenAI Codex CLI
OpenAI's coding agent. 31K+ GitHub stars.

```bash
# Install
npm i -g @openai/codex
```

```javascript
const session = await manager.createSession({
  adapter: 'codex-cli',
  model: 'o3-mini',  // or 'gpt-4o', 'o4-mini'
  workDir: '/path/to/project'
});
```

**Models**: `o3-mini`, `o4-mini`, `gpt-4o`, `gpt-4o-mini`

---

### Aider
AI pair programming with Git integration. Multi-model support.

```bash
# Install
pip install aider-chat
```

```javascript
const session = await manager.createSession({
  adapter: 'aider',
  model: 'sonnet',  // or 'opus', 'gpt-4o', 'deepseek'
  files: ['src/main.py', 'tests/'],  // Files to include
  autoCommits: false  // Disable auto-commits
});
```

**Models**: `sonnet`, `opus`, `haiku`, `gpt-4o`, `gpt-4o-mini`, `o3-mini`, `deepseek`, `deepseek-r1`

---

### Goose
Block's open-source AI agent with MCP support.

```bash
# Install (macOS)
brew install goose
```

```javascript
const session = await manager.createSession({
  adapter: 'goose',
  model: 'claude-3.5-sonnet',
  workDir: '/path/to/project'
});
```

**Models**: `claude-3.5-sonnet`, `claude-3-opus`, `gpt-4o`, `gpt-4o-mini`, `gemini-2.0-flash`

---

### Amazon Q Developer CLI
AWS's AI-powered coding assistant (Claude 3.7 Sonnet).

```bash
# Install via AWS CLI or Kiro CLI
# Requires AWS credentials
```

```javascript
const session = await manager.createSession({
  adapter: 'amazon-q',
  workDir: '/path/to/project'
});
```

---

### Plandex
Designed for large projects (2M+ tokens context).

```bash
# Install
curl -sL https://plandex.ai/install.sh | bash
```

```javascript
const session = await manager.createSession({
  adapter: 'plandex',
  model: 'openai/gpt-4o',  // OpenRouter format
  workDir: '/path/to/project'
});
```

**Models**: `openai/gpt-4o`, `openai/o3-mini`, `anthropic/claude-3.5-sonnet`, `google/gemini-pro`

---

### Continue CLI
Async coding agents in your terminal.

```bash
# Install
npm i -g @continuedev/cli
```

```javascript
const session = await manager.createSession({
  adapter: 'continue-cli',
  model: 'gpt-4o',
  workDir: '/path/to/project'
});
```

**Models**: `gpt-4o`, `claude-3.5-sonnet`, `gemini-2.5-pro`, `ollama/llama3`

---

### Mistral Vibe CLI
Mistral's coding assistant powered by Devstral (72% SWE-bench).

```bash
# Install from GitHub releases
# https://github.com/mistralai/mistral-vibe
```

```javascript
const session = await manager.createSession({
  adapter: 'mistral-vibe',
  model: 'devstral',  // or 'devstral-small'
  workDir: '/path/to/project'
});
```

**Models**: `devstral-small` (fast, local), `devstral` (full), `codestral`

---

### Shell-GPT
Shell command generation and execution. Uses SessionWrapper for context.

```bash
# Install
pip install shell-gpt
```

```javascript
const session = await manager.createSession({
  adapter: 'shell-gpt',
  model: 'gpt-4o',
  shellMode: true,  // Generate shell commands
  executeMode: false  // Auto-execute (careful!)
});
```

**Models**: `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo`

---

### aichat
All-in-one LLM CLI with multi-provider support.

```bash
# Install (Rust)
cargo install aichat
```

```javascript
const session = await manager.createSession({
  adapter: 'aichat',
  model: 'openai:gpt-4o',  // provider:model format
  role: 'shell'  // Optional: shell, code, etc.
});
```

**Models**: `openai:gpt-4o`, `anthropic:claude-3.5-sonnet`, `google:gemini-2.0-flash`, `mistral:mistral-large`, `groq:llama-3.3-70b`

---

### GitHub Copilot CLI
GitHub's AI assistant in your terminal. Requires Copilot subscription.

```bash
# Install (requires GitHub CLI)
gh extension install github/gh-copilot
```

```javascript
const session = await manager.createSession({
  adapter: 'github-copilot',
  workDir: '/path/to/project'
});
```

**Note**: Requires GitHub Copilot subscription ($10/mo, free for students/OSS maintainers).

---

### Adding Custom Adapters

```javascript
const { AgentAdapter, AgentServer } = require('cliagents');

class MyCustomAdapter extends AgentAdapter {
  constructor(config) {
    super(config);
    this.name = 'my-adapter';
  }

  async isAvailable() {
    // Check if CLI is installed
  }

  async spawn(sessionId, options) {
    // Start the CLI process
  }

  async *send(sessionId, message, options) {
    // Send message and yield response chunks
  }

  async terminate(sessionId) {
    // Kill the process
  }

  // ... implement other required methods
}

const server = new AgentServer();
server.registerAdapter('my-adapter', new MyCustomAdapter());
await server.start();
```

## Configuration

```javascript
const server = new AgentServer({
  port: 3001,                    // HTTP port
  host: '0.0.0.0',               // Bind address
  defaultAdapter: 'claude-code', // Default adapter
  sessionTimeout: 30 * 60 * 1000, // 30 min session timeout
  maxSessions: 10,               // Max concurrent sessions
  claudeCode: {
    timeout: 60000,              // Response timeout
    workDir: '/tmp/agent',       // Working directory
    skipPermissions: true,       // Skip permission prompts
    verbose: true                // Verbose output
  }
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Your Application                    │
│    (claude-browser, web app, script, etc.)      │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│                  cliagents                       │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ HTTP Server  │  │    WebSocket Server      │ │
│  └──────────────┘  └──────────────────────────┘ │
│                      │                          │
│  ┌──────────────────────────────────────────┐  │
│  │           Session Manager                 │  │
│  └──────────────────────────────────────────┘  │
│                      │                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────┐  │
│  │ Claude  │ │ Gemini  │ │ Codex   │ │ ... │  │
│  │ Adapter │ │ Adapter │ │ Adapter │ │     │  │
│  └─────────┘ └─────────┘ └─────────┘ └─────┘  │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              CLI Processes                       │
│  (claude, gemini, codex, etc.)                  │
└─────────────────────────────────────────────────┘
```

## Roadmap

### Completed
- [x] Core server with REST API and SSE streaming
- [x] WebSocket support
- [x] Session status tracking and interrupt capability
- [x] OpenAPI 3.0 specification
- [x] File upload to sessions
- [x] Model selection per session
- [x] 2 fully tested adapters (Claude Code, Gemini CLI)

### In Progress
- [ ] Test remaining 5 free-tier adapters (Codex, Mistral Vibe, Amazon Q, Plandex, GitHub Copilot)
- [ ] Validate API key router adapters (Aider, Goose, Shell-GPT, AIChat, Continue)

### Planned
- [ ] Grok CLI adapter (when official CLI releases)
- [ ] TypeScript definitions
- [ ] Docker support
- [ ] Rate limiting
- [ ] Authentication middleware

## License

MIT
