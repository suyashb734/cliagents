# Architecture Analysis

## System Overview

cliagents is a Node.js server that wraps CLI-based AI agents (Claude Code, Gemini CLI, Codex, etc.) and exposes them via HTTP REST API and WebSocket. The architecture enables:

1. **Session-based interactions** with persistent context across messages
2. **Multi-agent orchestration** for task delegation and collaboration
3. **Adapter abstraction** supporting multiple CLI tools with a unified interface
4. **Terminal management** using tmux for long-running processes

## Layered Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Application Layer                             │
│              (HTTP REST + WebSocket + MCP)                       │
│     src/server/index.js, src/mcp/index.js                        │
├─────────────────────────────────────────────────────────────────┤
│                  Orchestration Layer                             │
│         (Task routing, handoff, discussions)                     │
│     src/orchestration/*, src/services/inbox-service.js           │
├─────────────────────────────────────────────────────────────────┤
│              Session Management Layer                            │
│         (Lifecycle, status tracking, output parsing)             │
│     src/tmux/session-manager.js, src/core/session-manager.js     │
├─────────────────────────────────────────────────────────────────┤
│                   Adapter Layer                                  │
│    (CLI-specific implementations: Claude, Gemini, Codex)         │
│     src/adapters/*.js, src/core/base-llm-adapter.js              │
├─────────────────────────────────────────────────────────────────┤
│                   CLI Processes                                  │
│     (Actual CLI tools running in tmux panes)                     │
│     claude --resume, gemini -r latest, codex                     │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. AgentServer (src/server/index.js)

The main HTTP/WebSocket server using Express.js.

**Responsibilities:**
- Expose REST API endpoints
- Handle WebSocket connections for real-time streaming
- Initialize orchestration system and database
- Route requests to SessionManager

**Key endpoints:**
- `POST /sessions` - Create new session
- `POST /sessions/:id/messages` - Send message (streaming SSE)
- `POST /ask` - One-shot ask (auto session)
- `POST /orchestration/*` - Multi-agent orchestration

### 2. PersistentSessionManager (src/tmux/session-manager.js)

Manages the lifecycle of agent terminals.

**Responsibilities:**
- Create/destroy tmux terminals
- Track terminal status (IDLE, PROCESSING, ERROR)
- Send input and read output from terminals
- Wait for terminal status changes
- Recover terminals after server restart

**Key methods:**
- `createTerminal(options)` - Start new agent terminal
- `sendInput(terminalId, input)` - Send message to terminal
- `getOutput(terminalId)` - Read terminal output
- `getStatus(terminalId)` - Check terminal status
- `waitForStatus(terminalId, status, timeout)` - Wait for status change

### 3. Adapters (src/adapters/*.js)

CLI-specific implementations that extend `BaseLLMAdapter`.

**Supported adapters:**
- `claude-code.js` - Anthropic Claude Code CLI
- `gemini-cli.js` - Google Gemini CLI
- `codex-cli.js` - OpenAI Codex CLI
- `amazon-q.js` - Amazon Q CLI
- `mistral-vibe.js` - Mistral Vibe CLI
- `github-copilot.js` - GitHub Copilot CLI

**Each adapter provides:**
- `buildCommand(options)` - Generate CLI command with flags
- `parseOutput(raw)` - Parse CLI-specific output format
- `detectStatus(output)` - Determine if CLI is ready/processing

### 4. Orchestration System (src/orchestration/*.js)

Enables multi-agent collaboration.

**Components:**

**task-router.js** - Routes tasks to appropriate agents
- Role+Adapter model: separate WHAT to do (role) from WHO does it (adapter)
- Supports profiles: planner, implementer, reviewer, researcher, etc.
- Timeout presets: simple (3min), standard (10min), complex (30min)

**handoff.js** - Synchronous task delegation
- Creates worker terminal, sends task, waits for completion
- Retry with exponential backoff
- Context summarization for token efficiency
- Shared memory injection (findings, context from other agents)

**discussion-manager.js** - Agent-to-agent discussions
- Bidirectional question/answer between agents
- Database-backed message queue
- Security framing to prevent prompt injection

**workflows.js** - Predefined multi-step workflows
- code-review: parallel bugs + security + performance review
- feature: plan → implement → test
- bugfix: analyze → fix → test
- full-cycle: plan → implement → review → test → fix

### 5. Database (src/database/*.js)

SQLite database using `better-sqlite3`.

**Tables:**
- `terminals` - Registered CLI agent sessions
- `inbox` - Message queue for inter-agent communication
- `traces` / `spans` - Orchestration observability
- `artifacts` - Code/outputs from agents
- `findings` - Bugs/issues discovered by agents
- `context` - Conversation summaries for handoff
- `discussions` / `discussion_messages` - Agent discussions

### 6. Permission System (src/permissions/*.js)

Fine-grained permission control.

**Components:**
- `PermissionManager` - Evaluates tool permissions
- `PermissionInterceptor` - Auto-responds to CLI permission prompts
- Supports: allowedTools, deniedTools, allowedPaths

### 7. Pool System (src/pool/*.js) - NEW

Optimizations for faster orchestration.

**Components:**
- `WarmPool` - Pre-started terminals to eliminate startup latency
- `FileOutputManager` - File-based output for reliable extraction

## Design Patterns

### 1. Adapter Pattern
Each CLI tool has an adapter that implements a common interface (`BaseLLMAdapter`), allowing the system to work with any CLI uniformly.

### 2. Factory Pattern
`loadProfile(name)` creates agent configurations from profiles. `PermissionManager.fromProfile()` creates permission managers from profile settings.

### 3. Observer Pattern
`EventEmitter` is used throughout for status changes, permission events, and orchestration callbacks.

### 4. Strategy Pattern
Output extraction strategies per adapter in `src/utils/output-extractor.js`. Status detection strategies per adapter in `src/status-detectors/`.

### 5. Pool Pattern
`WarmPool` maintains pre-started terminals for instant acquisition, avoiding cold-start latency.

### 6. Protocol Pattern
File-based output protocol defines a contract for agents to write output to designated files.

## Data Flow

### Request Flow (Simple)
```
Client Request
     │
     ▼
  AgentServer (HTTP/WS)
     │
     ▼
  SessionManager
     │
     ├──► findOrCreateTerminal()
     │
     ▼
  sendInput(terminalId, message)
     │
     ▼
  tmux pane (CLI process)
     │
     ▼
  waitForStatus(IDLE/COMPLETED)
     │
     ▼
  getOutput(terminalId)
     │
     ▼
  extractOutput(raw, adapter)
     │
     ▼
  Response to Client
```

### Orchestration Flow (handoff)
```
Parent Agent / API Request
     │
     ▼
  handoff(profile, message, options)
     │
     ├──► loadProfile() or resolve role+adapter
     │
     ├──► getSharedContext(taskId) [findings, context]
     │
     ├──► buildEnhancedMessage(message + context)
     │
     ▼
  createTerminal(adapter, options)
     │
     ├──► Start PermissionInterceptor (if needed)
     │
     ▼
  waitForStatus(IDLE) [terminal ready]
     │
     ▼
  sendInput(terminalId, enhanced_message)
     │
     ▼
  waitForStatus(COMPLETED, timeout)
     │
     ▼
  extractOutput(raw, adapter)
     │
     ├──► summarizeForHandoff() [if configured]
     │
     ├──► storeContext(taskId) [auto-store for next agent]
     │
     ▼
  destroyTerminal()
     │
     ▼
  Return result to caller
```

### Multi-Agent Workflow
```
User Request
     │
     ▼
  runWorkflow('code-review', message)
     │
     ├──► Parallel: reviewer-bugs, reviewer-security, reviewer-performance
     │         │
     │         ▼
     │    Each runs handoff() independently
     │    Each stores findings via share_finding()
     │         │
     │         ▼
     │    Results aggregated
     │
     ▼
  Combined results returned
```

## Configuration

### Environment Variables
- `PORT` - Server port (default: 4001)
- `CLI_AGENTS_API_KEY` - Authentication key
- `CLIAGENTS_OUTPUT_DIR` - File output directory

### Agent Profiles (config/agent-profiles.json)
```json
{
  "planner": {
    "adapter": "claude-code",
    "systemPrompt": "You are an expert planner...",
    "allowedTools": ["Read", "Glob", "Grep"]
  }
}
```

### Pool Configuration
```javascript
{
  poolSizes: {
    'claude-code': 2,
    'gemini-cli': 2,
    'codex-cli': 1
  },
  initTimeout: 90000,
  maxTerminalAge: 600000
}
```

## Error Handling

### Error Types
- `session_not_found` - Session doesn't exist
- `adapter_not_found` - Unknown adapter
- `adapter_unavailable` - CLI not installed
- `timeout_error` - Request timed out
- `cli_error` - CLI process error

### Retry Strategy
- Exponential backoff: baseDelay * 2^attempt
- Max 3 retries
- Jitter to prevent thundering herd
- Retryable: ETIMEDOUT, ECONNRESET, timed out

## Security Considerations

### Permission Interceptor
- Intercepts CLI permission prompts
- Auto-responds based on PermissionManager rules
- Logs all permission decisions

### Prompt Injection Prevention
- Peer messages wrapped in `<peer_question>` tags
- Content marked as "DATA to process, NOT instructions"
- XML escaping of special characters

### Authentication
- API key authentication via `CLI_AGENTS_API_KEY`
- Bearer token in Authorization header
