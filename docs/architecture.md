# cliagents Architecture

This document explains the architecture of cliagents, focusing on the two parallel session management systems.

## Overview

cliagents has **two separate session management systems** that serve different purposes:

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentServer                               │
└─────────────────────────────────────────────────────────────┘
              │                              │
              │                              │
    ┌─────────▼──────────┐        ┌─────────▼───────────────┐
    │  SessionManager    │        │ PersistentSessionManager│
    │  (REST API)        │        │  (Orchestration)        │
    └─────────┬──────────┘        └─────────┬───────────────┘
              │                              │
    ┌─────────▼──────────┐        ┌─────────▼───────────────┐
    │  Adapter Layer     │        │  tmux + Status Detectors│
    │  (spawn-per-msg)   │        │  (persistent terminals) │
    └─────────┬──────────┘        └─────────┬───────────────┘
              │                              │
              └──────────────┬───────────────┘
                             │
                    ┌────────▼────────┐
                    │   CLI Processes │
                    │ (claude, gemini,│
                    │  codex, etc.)   │
                    └─────────────────┘
```

## System A: SessionManager (REST API)

**Location**: `src/core/session-manager.js`

**Purpose**: Lightweight session management for simple REST API interactions.

**Characteristics**:
- **In-memory only** - Sessions lost on server restart
- **Spawn-per-message** - Each message spawns a new CLI process
- **3 states**: running, stable, error
- **Auto-timeout**: 30 minutes inactivity
- **Max sessions**: 10 concurrent (oldest evicted)

**Use Cases**:
- Simple one-shot requests (`POST /ask`)
- Interactive chat sessions (`POST /sessions/:id/messages`)
- OpenAI-compatible API (`POST /v1/chat/completions`)

**Endpoints**:
```
POST /sessions           - Create session
GET  /sessions           - List sessions
GET  /sessions/:id       - Get session info
POST /sessions/:id/messages - Send message
DELETE /sessions/:id     - Terminate session
POST /ask               - One-shot ask
```

## System B: PersistentSessionManager (Orchestration)

**Location**: `src/tmux/session-manager.js`

**Purpose**: Robust terminal management for multi-agent orchestration workflows.

**Characteristics**:
- **Persistent** - SQLite database + tmux sessions survive restarts
- **Always-running** - CLI processes stay open in tmux
- **6 states**: idle, processing, completed, waiting_permission, waiting_user_answer, error
- **Status detection** - Pattern-based detection from CLI output
- **Agent profiles** - Role-based configuration (planner, reviewer, implementer, etc.)

**Use Cases**:
- Multi-agent workflows (code-review, feature, bugfix)
- Agent-to-agent delegation (handoff, assign, send_message)
- Long-running autonomous tasks

**Endpoints**:
```
POST /orchestration/handoff     - Sync delegation to agent
POST /orchestration/assign      - Async delegation with callback
POST /orchestration/send_message - Inter-agent messaging
GET  /orchestration/terminals   - List terminals
GET  /orchestration/profiles    - List agent profiles
```

## Why Two Systems?

The systems evolved to serve different needs:

| Requirement | SessionManager | PersistentSessionManager |
|-------------|---------------|-------------------------|
| Simple API integration | ✅ Perfect | ❌ Overkill |
| OpenAI compatibility | ✅ Yes | ❌ No |
| Crash recovery | ❌ Lost | ✅ Survives |
| Multi-agent workflows | ❌ No | ✅ Yes |
| Low overhead | ✅ Minimal | ❌ tmux + SQLite |
| Status detection | ❌ Basic | ✅ Pattern-based |

## Key Differences

### Session IDs
- **SessionManager**: 32-char hex (`crypto.randomBytes(16)`)
- **PersistentSessionManager**: 8-char hex (`crypto.randomBytes(4)`)

These are **not interchangeable**. A REST session cannot be referenced in orchestration and vice versa.

### Message Paths
- **REST**: `POST /sessions/:id/messages` → `Adapter.send()` → spawn CLI → capture output
- **Orchestration**: `POST /orchestration/handoff` → `createTerminal()` → `sendInput()` → status detection

The paths are completely separate. A message sent via REST won't appear in orchestration terminals.

### Process Lifecycle
- **REST**: Process spawned per message, terminated after response
- **Orchestration**: Process started once in tmux, reused for multiple messages

## When to Use Which

### Use REST API (SessionManager) when:
- Building simple integrations
- Need OpenAI-compatible API
- Single-agent interactions
- Don't need crash recovery
- Want minimal setup

### Use Orchestration (PersistentSessionManager) when:
- Running multi-agent workflows
- Need agent-to-agent communication
- Want crash recovery
- Using agent profiles (planner, reviewer, etc.)
- Building complex pipelines

## Future Considerations

### Unification Options

1. **Keep Separate** (Current)
   - Document clearly
   - Accept limitation
   - Simplest path

2. **Unify to Orchestration**
   - Make REST API use tmux
   - Higher overhead but consistent
   - Breaking change

3. **Bridge Layer**
   - Add translation between systems
   - Complex but backward compatible

**Current decision**: Keep Separate. Unification is a larger refactor. The systems serve different needs effectively.

### Potential Improvements

1. **Persist REST sessions** - Add SQLite backing to SessionManager
2. **Cross-system routing** - Allow REST to create orchestration terminals
3. **Unified status model** - Map 3 states to 6 states

## MCP Integration

The MCP server (`src/mcp/cliagents-mcp-server.js`) exposes orchestration to external clients:

```
delegate_task  → /orchestration/handoff
run_workflow   → /orchestration/workflows/:name
list_agents    → /orchestration/profiles
```

This enables the broker to orchestrate other agents via natural language.

## Status Detection

Status detectors (`src/status-detectors/`) parse CLI output to determine state:

```
├── base.js           - Base detector with priority order
├── claude-code.js    - Claude-specific patterns on the active broker surface
├── gemini-cli.js     - Gemini-specific patterns
├── codex-cli.js      - Codex-specific patterns
├── qwen-cli.js       - Qwen-specific patterns
├── opencode-cli.js   - OpenCode-specific patterns
└── factory.js        - Creates detector by adapter name
```

Priority order: ERROR > WAITING_PERMISSION > WAITING_USER_ANSWER > PROCESSING > COMPLETED > IDLE

## Agent Profiles

Defined in `config/agent-profiles.json`:

| Profile | Adapter | Purpose |
|---------|---------|---------|
| planner | qwen-cli | Creates implementation plans |
| implementer | codex-cli | Writes code |
| reviewer-bugs | qwen-cli | Finds bugs (read-only) |
| reviewer-security | gemini-cli | Security analysis |
| reviewer-performance | codex-cli | Performance review |
| tester | codex-cli | Writes tests |
| fixer | codex-cli | Applies fixes |
| researcher | gemini-cli | Research & documentation |
| architect | qwen-cli | Architecture analysis |
| documenter | qwen-cli | Documentation |
