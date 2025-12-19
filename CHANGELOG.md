# cliagents Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-12-19

### Added

- **12 AI CLI Adapters**
  - Claude Code (`claude-code`)
  - Gemini CLI (`gemini-cli`)
  - OpenAI Codex CLI (`codex-cli`)
  - Aider (`aider`)
  - Goose (`goose`)
  - Amazon Q (`amazon-q`)
  - Plandex (`plandex`)
  - Continue CLI (`continue-cli`)
  - Mistral Vibe (`mistral-vibe`)
  - Shell-GPT (`shell-gpt`)
  - AIChat (`aichat`)
  - GitHub Copilot CLI (`github-copilot`)

- **REST API Endpoints**
  - `GET /health` - Health check
  - `GET /openapi.json` - OpenAPI 3.0 specification
  - `GET /adapters` - List available adapters with models
  - `POST /sessions` - Create new session
  - `GET /sessions` - List all sessions
  - `GET /sessions/:id` - Get session info
  - `GET /sessions/:id/status` - Get session status (running/stable/error)
  - `POST /sessions/:id/interrupt` - Interrupt active process
  - `POST /sessions/:id/messages` - Send message (with SSE streaming)
  - `POST /sessions/:id/files` - Upload files to session
  - `GET /sessions/:id/files` - List files in session
  - `DELETE /sessions/:id` - Terminate session
  - `POST /ask` - One-shot ask (auto session management)

- **Core Features**
  - Real-time streaming via Server-Sent Events (SSE)
  - WebSocket support for bidirectional communication
  - Session management with automatic cleanup
  - Model selection per session/adapter
  - JSON Schema for structured output (Claude)
  - Generation parameters (temperature, top_p, top_k)
  - Tool restrictions (`allowedTools`)
  - File upload to session working directory
  - Cost and token usage tracking
  - Standardized error responses

- **Developer Tools**
  - OpenAPI 3.0 specification
  - Web dashboard for adapter status
  - Comprehensive test suite (23 tests)
  - Setup script for CLI authentication

### Technical Details

- Spawn-per-message architecture with native CLI resume
- JSON streaming output (no terminal scraping)
- Process isolation per message
- Automatic orphan process cleanup

## [Unreleased]

### Planned
- MCP (Model Context Protocol) server support
- Grok CLI adapter
- SSE event IDs for reconnection
- Docker support
