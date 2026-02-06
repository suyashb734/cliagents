# cliagents Adapters

Complete documentation for all supported CLI adapters.

## Primary Adapters (Fully Tested)

These adapters are fully tested and recommended for production use.

### Claude Code

Anthropic's official CLI for Claude. Best for coding tasks with file editing capabilities.

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

**Cost**: Included with Claude Pro ($20/mo)

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

**Cost**: FREE with Google account

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

**Cost**: Included with ChatGPT Plus ($20/mo)

---

## Experimental Adapters

These adapters are implemented but need more real-world testing.

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

**Status**: Experimental - needs testing

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

**Cost**: $10/mo (free for students/OSS maintainers)

**Status**: Experimental - needs testing

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

**Status**: Experimental - FREE until Dec 2025

---

## API Key Required Adapters

These adapters require your own API keys - no free tier benefit from subscriptions.

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

### Shell-GPT

Shell command generation and execution.

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

## Adding Custom Adapters

Create a new adapter by extending `AgentAdapter`:

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
}

const server = new AgentServer();
server.registerAdapter('my-adapter', new MyCustomAdapter());
await server.start();
```

See [adding-adapters.md](adding-adapters.md) for the complete adapter development guide.
