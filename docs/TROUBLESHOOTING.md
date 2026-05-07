# Troubleshooting Guide

This guide provides solutions for common issues encountered when using `cliagents`.

## 1. CLI Not Found Errors

**Issue**: The server starts but fails to execute commands with errors like `command not found: gemini`, `codex`, or `qwen`.

**Solutions**:
- **Verify Installation**: Ensure the CLI tools are installed globally.
  - Gemini CLI: `npm i -g @google/gemini-cli`
  - Codex CLI: `npm i -g @openai/codex`
  - Qwen CLI: `npm install -g @qwen-code/qwen-code`
- **Check PATH**: Ensure your global npm binaries directory is in your system's `PATH`.
  - On macOS/Linux: `export PATH=$PATH:$(npm config get prefix)/bin`
- **Test Manually**: Try running the command (e.g., `gemini --version`) directly in your terminal to confirm it works outside of `cliagents`.

## 2. Authentication Issues

**Issue**: Receiving `401 Unauthorized` or `403 Forbidden` responses.

**Solutions**:
- **Check Environment Variables**: If you set `CLIAGENTS_API_KEY` (or `CLI_AGENTS_API_KEY`), all requests must include it.
- **Header Format**: Ensure you are using the correct header format:
  - `Authorization: Bearer YOUR_API_KEY`
  - OR `X-API-Key: YOUR_API_KEY`
- **Local CLI**: If `cliagents launch` fails with `Authentication required`, restart the broker after this version; it will create a local token in its data directory. Set `CLIAGENTS_DATA_DIR` when running multiple brokers or non-default broker locations.
- **Localhost Override**: For local-only development without auth, set `CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST=1` and bind to `127.0.0.1`, `::1`, or `localhost`.
- **Restart Server**: After changing environment variables, you must restart the `cliagents` server.

## 3. Model Routing Errors

**Issue**: Requests to the OpenAI-compatible endpoint (`/v1/chat/completions`) fail with "Model not found" or route to the wrong agent.

**Solutions**:
- **Check Model Mapping**: `cliagents` routes models based on prefixes:
  - `gemini-*` → Gemini CLI
  - `gpt-*`, `o3-*`, `o4-*` → Codex CLI
  - `qwen-*` → Qwen CLI
- **Supported Adapters**: Ensure the adapter corresponding to the model prefix is installed and configured.
- **Custom Models**: If using a custom model name, ensure it maps correctly in `src/server/openai-compat.js`.

## 4. Session Timeout Problems

**Issue**: Sessions expire unexpectedly or "Session not found" errors occur during long conversations.

**Solutions**:
- **REST Session Timeout**: Standard REST sessions (`/sessions`) expire after **30 minutes of inactivity**. Send a message or a heartbeat to keep them alive.
- **Max Sessions**: The server keeps a maximum of 10 concurrent REST sessions. Creating an 11th session will evict the oldest one.
- **Use Orchestration**: For long-running tasks, use the **Orchestration** system (`/orchestration/*`), which uses `tmux` and SQLite to persist sessions even across server restarts.

## 5. Connection Refused Errors

**Issue**: `curl` or client applications fail to connect with `ECONNREFUSED` or "Failed to connect to localhost port 4001".

**Solutions**:
- **Check Port**: The default port is `4001`. Ensure no other process is using this port: `lsof -i :4001`.
- **Change Port**: You can change the port using the `PORT` environment variable: `PORT=5000 npm start`.
- **Server Status**: Verify the server is actually running and didn't crash on startup. Check the console output for errors.
- **Host Binding**: By default, the server binds to `localhost`. If connecting from a container or remote machine, ensure it's configured to bind to `0.0.0.0`.

## Still Having Issues?

- **Check Logs**: Look at the server console output for detailed error messages and stack traces.
- **Run Tests**: Execute `npm test` to ensure the core components are functioning correctly on your system.
- **Reset Database**: For orchestration issues, you can try resetting the SQLite database: `rm data/cliagents.db`.
- **Reset tmux**: If orchestration terminals are stuck, kill all tmux sessions: `tmux kill-server`.
