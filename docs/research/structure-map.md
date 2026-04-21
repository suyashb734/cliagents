# Codebase Structure

## Directory Tree

```
cliagents/
├── .claude/                # Claude-specific agent configurations
├── .github/                # GitHub workflows and CI
├── .serena/                # Serena agent memory and cache
├── config/                 # Configuration files
├── data/                   # SQLite database storage
├── docs/                   # Documentation and research notes
├── examples/               # Example usage scripts
├── logs/                   # Application logs
├── public/                 # Static frontend assets (dashboard)
├── src/                    # Source code
│   ├── adapters/           # CLI tool adapters (Claude, Gemini, etc.)
│   ├── core/               # Core business logic (SessionManager, BaseAdapter)
│   ├── database/           # Database connection and schema
│   ├── hooks/              # Event hooks system
│   ├── interceptor/        # Request/Response interceptors
│   ├── mcp/                # Model Context Protocol implementation
│   ├── models/             # Data models
│   ├── orchestration/      # Multi-agent coordination logic
│   ├── permissions/        # Permission management system
│   ├── routes/             # Additional API routes
│   ├── scripts/            # Setup and maintenance scripts
│   ├── server/             # HTTP and WebSocket server implementation
│   ├── services/           # Business services (Inbox, Transcription)
│   ├── status-detectors/   # Detectors for agent status
│   ├── tmux/               # Tmux session integration
│   ├── utils/              # Utility functions
│   └── index.js            # Main entry point
└── tests/                  # Test suite
```

## Key Directories

### src/
The core application logic.
- **adapters/**: Contains specific implementations for different AI CLI tools. Each adapter extends the `BaseLLMAdapter`.
- **core/**: Foundational classes like `SessionManager` and `BaseLLMAdapter`.
- **server/**: Express.js server setup, API routes, and WebSocket handling.
- **orchestration/**: Logic for handing off tasks between agents and managing discussions.
- **tmux/**: Manages persistent terminal sessions using `tmux`.
- **database/**: SQLite database interactions for persisting state.

### tests/
Contains the test suite, including unit, integration, and end-to-end tests.
- **fixtures/**: Test data and assets.

### docs/
Project documentation.
- **research/**: Generated research notes and maps.

### public/
Frontend assets for the web dashboard.
- `dashboard.html`: The main dashboard interface.

### config/
Configuration files.
- `agent-profiles.json`: Defines profiles for different agents.

## File Index

### Root
- **package.json**: Project dependencies and scripts.
- **README.md**: Main project documentation.
- **.env.example**: Template for environment variables.
- **openapi.json**: OpenAPI 3.0 specification for the API.

### src/
- **index.js**: Application entry point. Exports the main module and starts the server if run directly.

### src/core/
- **session-manager.js**: Manages active agent sessions, lifecycle, and routing.
- **base-llm-adapter.js**: Base class for all CLI adapters, defining the interface.
- **adapter.js**: Generic adapter interface.

### src/server/
- **index.js**: `AgentServer` class. Sets up Express, WebSockets, and routes.
- **auth.js**: Middleware for API key authentication.
- **openai-compat.js**: Router implementing OpenAI-compatible endpoints (`/v1/chat/completions`).
- **orchestration-router.js**: Routes for the orchestration features.

### src/adapters/
- **gemini-cli.js**: Adapter for the Google Gemini CLI.
- **claude-code.js**: Adapter for the Anthropic Claude Code CLI.
- **codex-cli.js**: Adapter for the OpenAI Codex CLI.

### src/orchestration/
- **index.js**: Exports orchestration primitives (`handoff`, `assign`, `sendMessage`).
- **task-router.js**: Routes tasks to appropriate agents.
- **discussion-manager.js**: Manages multi-agent discussions.

### src/database/
- **db.js**: Database connection logic using `better-sqlite3`.
- **schema.sql**: Database schema definition.

### src/tmux/
- **session-manager.js**: `PersistentSessionManager` for managing long-running `tmux` sessions.
- **client.js**: Client for interacting with `tmux` processes.
