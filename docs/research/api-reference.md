# API Reference

Base URL: `http://localhost:4001`

Authentication:
`CLIAGENTS_API_KEY` (or legacy alias `CLI_AGENTS_API_KEY`) enables API-key auth. Provide `Authorization: Bearer <key>` or `X-API-Key: <key>`. Auth is fail-closed by default. When no env API key is configured, the broker creates a same-machine local token in its data directory for local CLI clients. Set `CLIAGENTS_DATA_DIR` when running multiple brokers or non-default broker locations. To opt into fully unauthenticated local-only mode, set `CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1` and bind to a loopback host. WebSocket auth uses `?apiKey=...` or the `Sec-WebSocket-Protocol` header.

## Core Endpoints

### GET /health
Health check.
**Response:**
```json
{ "status": "ok", "timestamp": 1730000000000 }
```
**Example:**
```bash
curl http://localhost:4001/health
```

### GET /openapi.json
Serve the OpenAPI spec file if present.
**Response:** `application/json`
**Example:**
```bash
curl http://localhost:4001/openapi.json
```

### GET /adapters
List available adapters and their availability.
**Response:**
```json
{
  "adapters": [
    {
      "name": "claude-code",
      "version": "0.1.0-alpha.0",
      "config": { "timeout": 60000, "workDir": "/tmp/agent" },
      "available": true,
      "models": ["claude-3-5-sonnet-20241022"]
    }
  ]
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/adapters
```

### POST /sessions
Create a new session.
**Request:**
```json
{
  "adapter": "claude-code",
  "systemPrompt": "You are helpful",
  "allowedTools": ["bash", "rg"],
  "workDir": "/Users/me/project",
  "model": "claude-3-5-sonnet-20241022",
  "jsonSchema": { "type": "object", "properties": { "ok": { "type": "boolean" } } },
  "temperature": 0.2,
  "top_p": 0.9,
  "top_k": 40,
  "max_output_tokens": 2048
}
```
**Response:**
```json
{ "sessionId": "...", "adapter": "claude-code", "status": "ready" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/sessions \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"adapter":"claude-code","systemPrompt":"You are helpful"}'
```

### GET /sessions
List sessions.
**Response:**
```json
{
  "sessions": [
    {
      "sessionId": "...",
      "adapter": "claude-code",
      "active": true,
      "createdAt": 1730000000000,
      "lastActivity": 1730000000000,
      "ageMs": 120000,
      "idleMs": 30000
    }
  ]
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/sessions
```

### GET /sessions/:sessionId
Get session info.
**Response:**
```json
{
  "sessionId": "...",
  "adapterName": "claude-code",
  "createdAt": 1730000000000,
  "lastActivity": 1730000000000,
  "status": "stable",
  "messageCount": 1
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/sessions/$SESSION_ID
```

### GET /sessions/:sessionId/status
Get session status.
**Response:**
```json
{
  "sessionId": "...",
  "status": "stable",
  "lastActivity": 1730000000000,
  "messageCount": 1,
  "adapterName": "claude-code",
  "hasActiveProcess": false,
  "idleMs": 5000
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/sessions/$SESSION_ID/status
```

### POST /sessions/:sessionId/interrupt
Interrupt a running session.
**Response:**
```json
{ "interrupted": true, "previousStatus": "running" }
```
**Example:**
```bash
curl -X POST -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/sessions/$SESSION_ID/interrupt
```

### POST /sessions/:sessionId/messages
Send a message to a session. Supports non-streaming and SSE streaming.
**Request:**
```json
{
  "message": "Explain this repo",
  "timeout": 60000,
  "stream": false,
  "jsonSchema": { "type": "object" },
  "allowedTools": ["rg", "cat"]
}
```
**Response (non-streaming):**
```json
{
  "text": "...",
  "result": "...",
  "metadata": { "inputTokens": 10, "outputTokens": 120, "truncated": false },
  "structuredOutput": { "ok": true }
}
```
**Streaming (SSE):**
Event types: `chunk`, `result`, `error`, `done`.
Each `chunk` payload is `{ "content": "..." }`.
Each `result` payload includes the final chunk object.
**Example (non-streaming):**
```bash
curl -X POST http://localhost:4001/sessions/$SESSION_ID/messages \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```
**Example (streaming):**
```bash
curl -N -X POST http://localhost:4001/sessions/$SESSION_ID/messages \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Stream this","stream":true}'
```

### POST /sessions/:sessionId/parse
Parse a response string using adapter-specific parsing.
**Request:**
```json
{ "text": "{\"ok\": true}" }
```
**Response:**
```json
{ "ok": true }
```
**Example:**
```bash
curl -X POST http://localhost:4001/sessions/$SESSION_ID/parse \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"{\"ok\": true}"}'
```

### DELETE /sessions/:sessionId
Terminate a session.
**Response:**
```json
{ "status": "terminated" }
```
**Example:**
```bash
curl -X DELETE -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/sessions/$SESSION_ID
```

### POST /sessions/:sessionId/files
Upload files to the session working directory.
**Request:**
```json
{
  "files": [
    { "name": "notes.txt", "content": "Hello", "encoding": "utf8" },
    { "name": "data.bin", "content": "AAAA", "encoding": "base64" }
  ]
}
```
**Response:**
```json
{
  "sessionId": "...",
  "workDir": "/tmp/agent",
  "files": [
    { "name": "notes.txt", "path": "/tmp/agent/notes.txt", "size": 5, "status": "uploaded" },
    { "name": "data.bin", "error": "File size exceeds maximum allowed (10MB)", "status": "failed" }
  ]
}
```
**Example:**
```bash
curl -X POST http://localhost:4001/sessions/$SESSION_ID/files \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"name":"notes.txt","content":"Hello","encoding":"utf8"}]}'
```

### GET /sessions/:sessionId/files
List files in the session working directory.
**Response:**
```json
{
  "sessionId": "...",
  "workDir": "/tmp/agent",
  "files": [
    { "name": "notes.txt", "path": "/tmp/agent/notes.txt", "size": 5, "isDirectory": false, "modified": "2026-02-03T00:00:00.000Z" }
  ]
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/sessions/$SESSION_ID/files
```

### POST /ask
One-shot ask: creates session, sends message, returns response, terminates session.
**Request:**
```json
{
  "message": "Summarize this repo",
  "adapter": "claude-code",
  "systemPrompt": "Be concise",
  "timeout": 60000,
  "jsonSchema": { "type": "object" },
  "allowedTools": ["rg"],
  "model": "claude-3-5-sonnet-20241022"
}
```
**Response:**
```json
{
  "text": "...",
  "result": "...",
  "metadata": { "truncated": false },
  "structuredOutput": null
}
```
**Example:**
```bash
curl -X POST http://localhost:4001/ask \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

## OpenAI-Compatible API

### POST /v1/chat/completions
OpenAI-compatible chat completions.
**Request:**
```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are helpful" },
    { "role": "user", "content": "Hello" }
  ],
  "temperature": 0.2,
  "top_p": 0.9,
  "max_tokens": 256,
  "stream": false
}
```
**Response (non-streaming):**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "gpt-4o",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "..." }, "logprobs": null, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```
**Streaming (SSE):**
`data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}` and terminates with `data: [DONE]`.
**Example:**
```bash
curl -X POST http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

### GET /v1/models
List available models based on installed CLIs.
**Response:**
```json
{ "object": "list", "data": [ { "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "codex-cli" } ] }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/v1/models
```

### GET /v1/models/:model
Get model details.
**Response:**
```json
{ "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "codex-cli", "available": true }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/v1/models/gpt-4o
```

## Orchestration Endpoints

### POST /orchestration/handoff
Synchronous task delegation.
Supports legacy `{ agentProfile, message }` and new `{ role, adapter, systemPrompt, message }` APIs.
**Request:**
```json
{
  "role": "plan",
  "adapter": "gemini-cli",
  "message": "Create a plan",
  "timeout": 60000,
  "returnSummary": true,
  "maxSummaryLength": 500,
  "taskId": "task-123",
  "includeSharedContext": true
}
```
**Response:**
```json
{
  "success": true,
  "taskId": "task-123",
  "traceId": "...",
  "response": "...",
  "summary": "..."
}
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/handoff \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role":"plan","message":"Create a plan"}'
```

### POST /orchestration/assign
Asynchronous task delegation.
**Request:**
```json
{ "agentProfile": "planner", "message": "Do this", "callbackTerminalId": "term-1" }
```
**Response:**
```json
{ "success": true, "taskId": "...", "terminalId": "..." }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/assign \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentProfile":"planner","message":"Do this"}'
```

### POST /orchestration/send_message
Send a message to a terminal.
`senderId` can be in `X-Terminal-Id` header or in body.
**Request:**
```json
{ "receiverId": "term-2", "message": "Ping", "priority": "normal" }
```
**Response:**
```json
{ "success": true, "messageId": "..." }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/send_message \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Terminal-Id: term-1" \
  -d '{"receiverId":"term-2","message":"Ping"}'
```

### POST /orchestration/broadcast
Send a message to multiple terminals.
**Request:**
```json
{ "receiverIds": ["term-1","term-2"], "message": "Hello", "priority": "normal" }
```
**Response:**
```json
{ "success": true, "messageIds": ["..."] }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/broadcast \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"receiverIds":["term-1","term-2"],"message":"Hello"}'
```

### GET /orchestration/terminals
List persistent terminals.
**Response:**
```json
{
  "count": 1,
  "terminals": [
    { "terminalId": "term-1", "adapter": "claude-code", "agentProfile": "planner", "role": "plan", "status": "stable", "createdAt": 1730000000000, "lastActive": 1730000000000 }
  ]
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/terminals
```

### GET /orchestration/terminals/:id
Get terminal info.
**Response:**
```json
{ "terminalId": "term-1", "adapter": "claude-code", "status": "stable", "attachCommand": "tmux attach -t ..." }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/terminals/term-1
```

### GET /orchestration/terminals/:id/output
Get terminal output.
**Query:** `lines` (default 200)
**Response:**
```json
{ "terminalId": "term-1", "lines": 200, "output": "..." }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" "http://localhost:4001/orchestration/terminals/term-1/output?lines=50"
```

### GET /orchestration/terminals/:id/messages
Get terminal conversation history.
**Query:** `limit`, `offset`, `traceId`, `role`
**Response:**
```json
{
  "terminalId": "term-1",
  "messages": [ { "id": 1, "role": "assistant", "content": "..." } ],
  "pagination": { "limit": 100, "offset": 0, "total": 1, "hasMore": false }
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" "http://localhost:4001/orchestration/terminals/term-1/messages?limit=50"
```

### POST /orchestration/terminals/:id/input
Send input to terminal.
**Request:**
```json
{ "message": "ls -la" }
```
**Response:**
```json
{ "success": true, "terminalId": "term-1", "status": "running" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/terminals/term-1/input \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"ls -la"}'
```

### DELETE /orchestration/terminals/:id
Destroy terminal.
**Response:**
```json
{ "success": true, "message": "Terminal term-1 destroyed" }
```
**Example:**
```bash
curl -X DELETE -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/terminals/term-1
```

### POST /orchestration/terminals
Create a persistent terminal.
**Request:**
```json
{ "adapter": "claude-code", "agentProfile": "planner", "role": "plan", "workDir": "/Users/me/project", "systemPrompt": "You are helpful", "model": "claude-3-5-sonnet-20241022", "allowedTools": ["rg"] }
```
**Response:**
```json
{ "terminalId": "term-1", "adapter": "claude-code", "status": "stable" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/terminals \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"adapter":"claude-code","agentProfile":"planner"}'
```

### GET /orchestration/profiles
List agent profiles.
**Response:**
```json
{ "count": 2, "profiles": { "planner": { "role": "plan", "adapter": "gemini-cli" } } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/profiles
```

### GET /orchestration/roles
List available roles.
**Response:**
```json
{ "count": 1, "roles": { "plan": { "description": "Planning", "defaultAdapter": "gemini-cli", "timeout": 60000 } } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/roles
```

### GET /orchestration/adapters
List available adapters (v3 config).
**Response:**
```json
{ "count": 2, "adapters": { "gemini-cli": { "description": "...", "capabilities": ["plan"] } } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/adapters
```

### GET /orchestration/profiles/:name
Get a profile by name.
**Response:**
```json
{ "name": "planner", "role": "plan", "adapter": "gemini-cli" }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/profiles/planner
```

### GET /orchestration/inbox/:terminalId
Get pending inbox messages.
**Query:** `limit` (default 10)
**Response:**
```json
{ "terminalId": "term-1", "stats": { "pending": 0 }, "messages": [] }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/inbox/term-1
```

### GET /orchestration/stats
Get orchestration stats.
**Response:**
```json
{ "terminals": { "total": 1, "byStatus": { "stable": 1 }, "byAdapter": { "claude-code": 1 } }, "database": { "messages": 10 } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/stats
```

### POST /orchestration/route
Route a task to a profile.
Supports legacy `{ forceProfile }` and new `{ forceRole, forceAdapter }`.
**Request:**
```json
{ "message": "Fix this bug", "forceRole": "code", "forceAdapter": "codex-cli" }
```
**Response:**
```json
{ "profile": "code_codex-cli", "type": "code" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/route \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Fix this bug"}'
```

### GET /orchestration/route/detect
Detect task type.
**Query:** `message`
**Response:**
```json
{ "type": "code", "confidence": 0.9 }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" "http://localhost:4001/orchestration/route/detect?message=Fix%20this"
```

### GET /orchestration/route/types
List task types.
**Response:**
```json
{ "code": { "defaultProfile": "coder" }, "plan": { "defaultProfile": "planner" } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/route/types
```

### POST /orchestration/workflows/:name
Execute a workflow.
**Request:**
```json
{ "message": "Ship release" }
```
**Response:**
```json
{ "workflowId": "wf-1", "status": "running" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/workflows/release \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Ship release"}'
```

### GET /orchestration/workflows
List workflows.
**Response:**
```json
{ "release": { "steps": 3 } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/workflows
```

### GET /orchestration/workflows/:id/status
Get workflow status.
**Response:**
```json
{ "workflowId": "wf-1", "status": "running" }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/workflows/wf-1/status
```

## Memory Endpoints

All memory routes are mounted under `/orchestration/memory`.

### POST /orchestration/memory/artifacts
Store an artifact.
**Request:**
```json
{ "taskId": "task-1", "key": "readme", "content": "...", "type": "text", "agentId": "term-1", "metadata": { "path": "README.md" } }
```
**Response:**
```json
{ "id": 1, "taskId": "task-1", "key": "readme" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/memory/artifacts \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"task-1","key":"readme","content":"..."}'
```

### GET /orchestration/memory/artifacts/:taskId
Get artifacts for a task.
**Query:** `type`
**Response:**
```json
{ "artifacts": [ { "taskId": "task-1", "key": "readme", "content": "..." } ] }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/artifacts/task-1
```

### GET /orchestration/memory/artifacts/:taskId/:key
Get a specific artifact.
**Response:**
```json
{ "artifact": { "taskId": "task-1", "key": "readme", "content": "..." } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/artifacts/task-1/readme
```

### DELETE /orchestration/memory/artifacts/:taskId/:key
Delete a specific artifact.
**Response:**
```json
{ "success": true, "taskId": "task-1", "key": "readme" }
```
**Example:**
```bash
curl -X DELETE -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/artifacts/task-1/readme
```

### POST /orchestration/memory/findings
Store a finding.
**Request:**
```json
{ "taskId": "task-1", "agentId": "term-1", "content": "Issue found", "type": "bug", "severity": "high", "agentProfile": "planner", "metadata": { "file": "src/app.js" } }
```
**Response:**
```json
{ "id": 1, "taskId": "task-1" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/memory/findings \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"task-1","agentId":"term-1","content":"Issue found"}'
```

### GET /orchestration/memory/findings/:taskId
Get findings for a task.
**Query:** `type`, `severity`
**Response:**
```json
{ "findings": [ { "taskId": "task-1", "agentId": "term-1", "content": "Issue found" } ] }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/findings/task-1
```

### GET /orchestration/memory/findings/by-id/:id
Get a finding by ID.
**Response:**
```json
{ "finding": { "id": 1, "taskId": "task-1", "content": "Issue found" } }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/findings/by-id/1
```

### DELETE /orchestration/memory/findings/:id
Delete a finding.
**Response:**
```json
{ "success": true, "id": 1 }
```
**Example:**
```bash
curl -X DELETE -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/findings/1
```

### POST /orchestration/memory/context
Store context summary.
**Request:**
```json
{ "taskId": "task-1", "agentId": "term-1", "summary": "...", "keyDecisions": ["A"], "pendingItems": ["B"] }
```
**Response:**
```json
{ "id": 1, "taskId": "task-1" }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/memory/context \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"task-1","agentId":"term-1","summary":"..."}'
```

### GET /orchestration/memory/context/:taskId
Get context summaries for a task.
**Response:**
```json
{ "context": [ { "taskId": "task-1", "summary": "..." } ] }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/context/task-1
```

### GET /orchestration/memory/tasks/:taskId
Get complete shared memory for a task.
**Response:**
```json
{ "artifacts": [], "findings": [], "context": [] }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/tasks/task-1
```

### DELETE /orchestration/memory/tasks/:taskId
Clear all memory for a task.
**Response:**
```json
{ "success": true, "taskId": "task-1", "deleted": 10 }
```
**Example:**
```bash
curl -X DELETE -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/tasks/task-1
```

### GET /orchestration/memory/stats
Get memory stats.
**Response:**
```json
{ "artifacts": 10, "findings": 5, "context": 2 }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/orchestration/memory/stats
```

### POST /orchestration/memory/cleanup
Cleanup old memory entries.
**Request:**
```json
{ "olderThanHours": 24 }
```
**Response:**
```json
{ "success": true, "deleted": 42 }
```
**Example:**
```bash
curl -X POST http://localhost:4001/orchestration/memory/cleanup \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"olderThanHours":24}'
```

## Dashboard Endpoints

### GET /dashboard
Serve the dashboard UI.
**Example:**
```bash
curl http://localhost:4001/dashboard
```

### GET /dashboard/adapters/status
Get adapter auth/install status.
**Response:**
```json
{
  "adapters": [
    {
      "name": "claude-code",
      "displayName": "Claude Code",
      "authType": "api_key",
      "installed": true,
      "authStatus": "authenticated",
      "envVarsSet": true,
      "configFileExists": true,
      "configFilePath": "~/.config/...",
      "loginCommand": "...",
      "loginInstructions": "...",
      "docsUrl": "..."
    }
  ]
}
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/dashboard/adapters/status
```

### POST /dashboard/adapters/:name/test
Test adapter authentication.
**Response:**
```json
{ "success": true, "error": null }
```
**Example:**
```bash
curl -X POST -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/dashboard/adapters/claude-code/test
```

### POST /dashboard/adapters/:name/env
Set environment variables for adapter.

Security behavior:
- Endpoint can be disabled with `CLIAGENTS_DISABLE_DASHBOARD_ENV_MUTATION=1` (returns `403`).
- Only adapter allowlisted keys are accepted (`ADAPTER_AUTH_CONFIG[adapter].envVars`), plus optional extras from `CLIAGENTS_DASHBOARD_ENV_MUTATION_EXTRA_KEYS`.
- Unknown keys are rejected with `400` and `rejectedKeys`.

**Request:**
```json
{ "envVars": { "ANTHROPIC_API_KEY": "..." } }
```
**Response:**
```json
{ "success": true, "message": "Environment variables set", "acceptedKeys": ["ANTHROPIC_API_KEY"] }
```
**Example:**
```bash
curl -X POST http://localhost:4001/dashboard/adapters/claude-code/env \
  -H "Authorization: Bearer $CLI_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"envVars":{"ANTHROPIC_API_KEY":"..."}}'
```

### GET /dashboard/adapters/:name/auth-config
Get adapter auth configuration.
**Response:**
```json
{ "name": "claude-code", "authType": "api_key" }
```
**Example:**
```bash
curl -H "Authorization: Bearer $CLI_AGENTS_API_KEY" http://localhost:4001/dashboard/adapters/claude-code/auth-config
```

## WebSocket API

**Endpoint:** `ws://localhost:4001/ws`

Authentication:
Use `?apiKey=<key>` or `Sec-WebSocket-Protocol: <key>`.

### Client → Server Messages

`create_session`
```json
{
  "type": "create_session",
  "adapter": "claude-code",
  "systemPrompt": "You are helpful",
  "allowedTools": ["rg"],
  "workDir": "/Users/me/project",
  "model": "claude-3-5-sonnet-20241022",
  "jsonSchema": { "type": "object" },
  "temperature": 0.2,
  "top_p": 0.9,
  "top_k": 40,
  "max_output_tokens": 2048
}
```

`join_session`
```json
{ "type": "join_session", "sessionId": "..." }
```

`send_message`
```json
{ "type": "send_message", "message": "Hello", "timeout": 60000 }
```

`terminate_session`
```json
{ "type": "terminate_session" }
```

`ping`
```json
{ "type": "ping" }
```

### Server → Client Messages

`connected`
```json
{ "type": "connected", "message": "cliagents" }
```

`session_created`
```json
{ "type": "session_created", "session": { "sessionId": "...", "adapter": "claude-code", "status": "ready" } }
```

`session_joined`
```json
{ "type": "session_joined", "sessionId": "..." }
```

`thinking`
```json
{ "type": "thinking" }
```

`chunk`
```json
{ "type": "chunk", "chunk": { "type": "text", "content": "..." } }
```

`complete`
```json
{ "type": "complete" }
```

`session_terminated`
```json
{ "type": "session_terminated" }
```

`pong`
```json
{ "type": "pong", "timestamp": 1730000000000 }
```

`error`
```json
{ "type": "error", "error": "..." }
```

### Orchestration Event Broadcasts

When orchestration is enabled, the server broadcasts:

`orchestration:terminal-created`
`orchestration:terminal-destroyed`
`orchestration:status-change`
`orchestration:message-queued`
`orchestration:message-delivered`
`orchestration:message-failed`

Payload format:
```json
{ "type": "orchestration:status-change", "timestamp": 1730000000000, "terminalId": "...", "status": "running" }
```

## Error Codes

Standard errors (HTTP status is in parentheses):

`invalid_request_error` (400)
`missing_parameter` (400)
`invalid_parameter` (400)
`session_not_found` (404)
`adapter_not_found` (404)
`adapter_unavailable` (503)
`authentication_required` (401)
`authentication_failed` (403)
`internal_error` (500)
`cli_error` (500)
`timeout_error` (504)
`rate_limit_exceeded` (429)
`max_sessions_reached` (429)

Orchestration/memory-specific errors:

`profile_not_found` (404)
`terminal_not_found` (404)
`routing_error` (500)
`detection_error` (500)
`workflow_error` (500)
`workflow_not_found` (404)
`db_unavailable` (503)
`not_found` (404)

OpenAI-compat errors (subset):

`invalid_request_error` (400)
`model_not_found` (404)
`model_unavailable` (503)

Error response format:
```json
{ "error": { "code": "invalid_parameter", "message": "...", "param": "message", "type": "invalid_parameter" } }
```
