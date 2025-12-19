# cliagents

A Node.js server that wraps CLI-based AI agents (Claude Code, Gemini CLI, Codex, etc.) and exposes them via HTTP REST API and WebSocket.

## Quick Start

```bash
# Start server
npm start
# Server at http://localhost:3001
# WebSocket at ws://localhost:3001/ws
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                Application Layer                         │
│              (HTTP REST + WebSocket)                     │
├─────────────────────────────────────────────────────────┤
│              Session Management Layer                    │
│         (SessionManager - handles lifecycle)             │
├─────────────────────────────────────────────────────────┤
│                 Adapter Layer                            │
│    ClaudeCodeAdapter    │    GeminiCliAdapter           │
├─────────────────────────────────────────────────────────┤
│                CLI Processes                             │
│     claude --resume      │    gemini -r latest          │
└─────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.js` | Main entry point, exports |
| `src/server/index.js` | HTTP/WebSocket server |
| `src/core/session-manager.js` | Session lifecycle management |
| `src/core/adapter.js` | Base adapter class |
| `src/adapters/claude-code.js` | Claude Code CLI wrapper |
| `src/adapters/gemini-cli.js` | Gemini CLI wrapper |
| `src/utils/gemini-config.js` | Gemini config.yaml manager (generation params) |
| `src/services/transcriptionService.js` | Whisper audio transcription |

## API Endpoints

```
GET  /health                 - Health check
GET  /openapi.json           - OpenAPI 3.0 specification
GET  /adapters               - List available adapters (includes available models)
POST /sessions               - Create new session
GET  /sessions               - List all sessions
GET  /sessions/:id           - Get session info
GET  /sessions/:id/status    - Get session status (running/stable/error)
POST /sessions/:id/interrupt - Interrupt active process
POST /sessions/:id/messages  - Send message (streaming with SSE)
POST /sessions/:id/files     - Upload files to session working directory
GET  /sessions/:id/files     - List files in session working directory
DELETE /sessions/:id         - Terminate session
POST /ask                    - One-shot ask (auto session)
```

### Session Options (POST /sessions)
```json
{
  "adapter": "claude-code",     // or "gemini-cli"
  "model": "claude-sonnet-4-5-20250514",  // model selection
  "systemPrompt": "You are a helpful assistant",
  "workDir": "/tmp/project",
  "jsonSchema": {"type": "object", ...},  // Claude only - structured output
  "allowedTools": ["Read", "Write"],      // restrict available tools

  // Generation parameters (Gemini only - writes to ~/.gemini/config.yaml)
  "temperature": 0.7,           // 0.0-2.0
  "top_p": 0.9,                 // 0.0-1.0
  "top_k": 40,                  // integer
  "max_output_tokens": 8192     // integer (also works for Claude via env var)
}
```

### Generation Parameters

| Parameter | Claude | Gemini | Notes |
|-----------|--------|--------|-------|
| `temperature` | ❌ | ✅ | Controls randomness (0.0-2.0) |
| `top_p` | ❌ | ✅ | Nucleus sampling threshold |
| `top_k` | ❌ | ✅ | Top-k sampling |
| `max_output_tokens` | ✅ | ✅ | Claude: via `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var; Gemini: via config.yaml |
| `jsonSchema` | ✅ | ❌ | Structured JSON output enforcement |

### Message Options (POST /sessions/:id/messages)
```json
{
  "message": "Your prompt here",
  "stream": true,           // Enable SSE streaming
  "timeout": 120000,        // Custom timeout in ms
  "jsonSchema": {...},      // Per-message schema override (Claude)
  "allowedTools": [...]     // Per-message tools override
}
```

### File Upload (POST /sessions/:id/files)
```json
{
  "files": [
    { "name": "data.txt", "content": "Hello", "encoding": "utf8" },
    { "name": "image.png", "content": "base64...", "encoding": "base64" }
  ]
}
```

### Error Response Format
All errors follow a standardized format:
```json
{
  "error": {
    "code": "session_not_found",
    "message": "The specified session was not found",
    "type": "session_not_found",
    "param": null
  }
}
```

Error codes include:
- `invalid_request_error` (400) - Malformed request
- `missing_parameter` (400) - Required parameter missing
- `session_not_found` (404) - Session doesn't exist
- `adapter_not_found` (404) - Unknown adapter
- `adapter_unavailable` (503) - CLI not installed
- `timeout_error` (504) - Request timed out
- `cli_error` (500) - CLI process error
- `internal_error` (500) - Server error

## Usage Examples

### One-shot ask (simplest)
```bash
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 2+2?", "adapter": "claude-code"}'
```

### Session-based (preserves context)
```bash
# Create session
curl -X POST http://localhost:3001/sessions \
  -d '{"adapter": "claude-code"}'
# Returns: {"sessionId": "abc123", ...}

# Send messages (context preserved)
curl -X POST http://localhost:3001/sessions/abc123/messages \
  -d '{"message": "My name is Suyash"}'

curl -X POST http://localhost:3001/sessions/abc123/messages \
  -d '{"message": "What is my name?"}'
# Returns: "Your name is Suyash" ✓
```

## Integration with AI-Twin

This server is designed to work with the AI-Twin learning loop:

```
┌────────────────────────────────────────────────────────────┐
│ PROMPT TO AGENT                                            │
├────────────────────────────────────────────────────────────┤
│ Task: Book a flight on google.com/flights                  │
│                                                            │
│ ## PAST LEARNINGS FOR google.com:                          │
│ - Search box: role=combobox, aria-label contains "Search"  │
│ - Cookie consent popup appears first                       │
│                                                            │
│ Screenshot attached. What's next?                          │
└────────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| Neo4j | Stores learnings, workflows, patterns |
| AI-Browser | Queries Neo4j, builds prompts, executes actions |
| Agent Server | Translates CLI calls, no knowledge of learnings |
| Agent (Claude/Gemini) | Receives learnings as prompt context |

## Session Management

- Sessions auto-timeout after 30 minutes of inactivity
- Max 10 concurrent sessions (oldest evicted if exceeded)
- Context preserved via CLI resume flags:
  - Claude: `--resume <sessionId>`
  - Gemini: `-r latest`

## Configuration

```javascript
const server = new AgentServer({
  port: 3001,
  sessionTimeout: 30 * 60 * 1000,  // 30 min
  maxSessions: 10,
  claudeCode: {
    timeout: 60000,
    skipPermissions: true
  },
  geminiCli: {
    timeout: 60000,
    yoloMode: true,
    model: 'gemini-2.5-flash'
  }
});
```

## Testing

See `tests/` directory for automated tests:
- `test-health.js` - Server health check
- `test-adapters.js` - Adapter availability
- `test-sessions.js` - Session lifecycle
- `test-context.js` - Context preservation
- `test-actions.js` - Browser action parsing
