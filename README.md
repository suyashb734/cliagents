# cliagents

A Node.js server that wraps CLI-based AI agents (Claude Code, Gemini CLI, Codex, etc.) and exposes them via HTTP REST API and WebSocket for real-time streaming.

## Why?

CLI agents like Claude Code are powerful but:
- They're designed for terminal use, not programmatic access
- Each invocation spawns a new process (slow, no session persistence)
- No easy way to integrate into web apps or other services

This server solves these problems by:
- Maintaining **persistent sessions** with CLI agents
- Providing **HTTP and WebSocket APIs** for easy integration
- Supporting **multiple adapters** for different AI CLIs
- Handling **session management**, timeouts, and cleanup

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

## Supported Adapters (11 Total)

### Quick Reference

| Adapter | CLI Command | Install | Session Support |
|---------|-------------|---------|-----------------|
| `claude-code` | `claude` | npm i -g @anthropic-ai/claude-code | Native |
| `gemini-cli` | `gemini` | pip install gemini-cli | Native |
| `codex-cli` | `codex` | npm i -g @openai/codex | Native |
| `aider` | `aider` | pip install aider-chat | Git-based |
| `goose` | `goose` | brew install goose | Native |
| `amazon-q` | `q` / `kiro` | AWS CLI plugin | Native |
| `plandex` | `plandex` | curl -sL plandex.ai/install.sh \| bash | Native |
| `continue-cli` | `cn` | npm i -g @continuedev/cli | Native |
| `mistral-vibe` | `vibe` | GitHub releases | Wrapper |
| `shell-gpt` | `sgpt` | pip install shell-gpt | Wrapper |
| `aichat` | `aichat` | cargo install aichat | Native |
| `github-copilot` | `gh copilot` | gh extension install github/gh-copilot | Native |

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
Google's Gemini models via CLI.

```bash
# Install
pip install gemini-cli
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
- [x] 12 CLI adapters (Claude, Gemini, Codex, Aider, Goose, Amazon Q, Plandex, Continue, Mistral Vibe, Shell-GPT, AIChat, GitHub Copilot)
- [x] REST API with SSE streaming
- [x] WebSocket support
- [x] Session status tracking
- [x] Interrupt capability
- [x] OpenAPI 3.0 specification
- [x] File upload to sessions
- [x] Model selection per session
- [x] JSON Schema for structured output
- [x] Tool restrictions

### Planned
- [ ] Grok CLI adapter (when official CLI releases)
- [ ] TypeScript definitions
- [ ] Docker support
- [ ] Rate limiting
- [ ] Authentication middleware

## License

MIT
