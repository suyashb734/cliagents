# Claude Code Feature Inventory & Analysis

## 1. Subagents & Task Tool

Claude Code employs a hierarchical agent architecture to manage complexity and parallelization.

### Task Tool (Ephemeral Workers)
*   **Mechanism:** The `Task` tool allows Claude to spawn ephemeral "worker" instances.
*   **Context:** Each task runs with its own isolated 200k token context window, preventing main context pollution.
*   **Concurrency:** Supports up to 10 concurrent parallel tasks.
*   **Lifecycle:** These are "fire-and-forget" or "result-gathering" workers that exist only for the duration of the specific task (e.g., "search these 50 files").
*   **Implementation:** Native tool built into the Claude Code runtime.

### Subagents (Persistent Experts)
*   **Mechanism:** Specialized, persistent agents that maintain their own configuration and history.
*   **Roles:** Typical roles include *Product Spec*, *Architect*, *Implementer*, and *Tester*.
*   **Configuration:** Defined via Markdown files with YAML frontmatter.
    *   **Fields:** Name, Description, Tools (allowlist), Model (e.g., Opus for reasoning, Haiku for speed).
*   **Delegation:**
    *   The main agent delegates to a subagent when a prompt matches its specific expertise.
    *   **Constraint:** Delegation is limited to one level depth (Subagents cannot spawn their own subagents).
*   **Tooling:** Subagents can be restricted to read-only tools (e.g., a "Reviewer" agent) or given full write access.

## 2. Skills & Slash Commands

Extensibility in Claude Code is handled through custom commands that can be invoked by users or the agent itself.

### Slash Commands
*   **Format:** Markdown files located in `.claude/commands` (project-specific) or `~/.claude/commands` (global).
*   **Invocation:** Triggered by typing `/command_name` in the input prompt.
*   **Function:** Act as shortcuts for complex prompts or multi-step procedures (e.g., `/deploy`, `/review`).
*   **Agent Use:** The host agent can intelligently decide to "fire" a slash command if it determines it solves the user's problem.

### Skills (Standardized Capabilities)
*   **Definition:** An evolution of slash commands conforming to the "Agent Skills" open standard.
*   **Structure:**
    *   **Metadata:** Enhanced YAML frontmatter defining arguments, description, and usage examples.
    *   **Supporting Files:** Can reside in dedicated directories with auxiliary scripts or assets.
*   **Discovery:** Automatically indexed and exposed to the model as potential actions it can take.

## 3. MCP (Model Context Protocol)

Claude Code uses MCP as the universal bridge to external tools and data, treating local resources as just another MCP server.

### Architecture
*   **Client-Server:** The CLI acts as an MCP Client. Tools (filesystem, git) are provided by MCP Servers.
*   **Local Resources:** Operations like `read_file` or `grep` are typically provided by a built-in "Filesystem" MCP server.

### Configuration
*   **Adding Servers:**
    *   Interactive: `claude mcp add` (wizard-style).
    *   Manual: Editing `~/.claude.json` or `.claude/config.json`.
    *   CLI: Loading specific configs via `--mcp-config <path>`.
*   **Built-in/Common Servers:**
    *   **Filesystem:** File manipulation and search.
    *   **Git:** Repository management (via GitHub MCP or local git wrapper).
    *   **Browser:** Headless browser control (Puppeteer/Playwright) for web interaction.
    *   **Brave Search:** For web research.

## 4. Hooks System

A robust event-driven system for enforcing policy and automation.

### Trigger Events
*   **`PreToolUse`:** Fires *before* a tool execution.
    *   **Use Case:** Security policies (blocking specific commands), linting checks before edits, enforcing "Ask" permissions programmatically.
    *   **Control:** Returning exit code `2` blocks the tool execution.
*   **`PostToolUse`:** Fires *after* a tool execution completes.
    *   **Use Case:** Auto-formatting code after writes, running tests after builds, notifications.

### Configuration
*   **Location:** Defined in `settings.json` (global or project-level).
*   **Interface:** Hooks are executable scripts. Claude pipes JSON event data to the script's `stdin`.
*   **Response:** The script's exit code determines success (0) or failure/blocking (non-zero).

## 5. Permission Model

Claude Code follows a strict "Ask by Default" security model, configurable via `settings.json`.

### Permission Tiers
1.  **Deny:** (Highest Priority) Explicitly blocks commands or paths (e.g., `Deny(rm -rf *)`, `Deny(Read .env)`).
2.  **Allow:** Auto-approves actions without prompting (e.g., `Allow(git status)`, `Allow(npm test)`).
3.  **Ask:** (Default) Requires user confirmation for the action.

### Granularity
*   **Glob Patterns:** Supports fine-grained paths like `Read(src/**)`.
*   **Tool-Specific:** Can restrict specific tools (e.g., `Bash(npm install *)`).
*   **Modes:**
    *   **Sandbox:** Running in a container/VM is recommended for high-risk tasks.
    *   **Accept All:** Session-level flag to bypass prompts (risky).

## 6. Memory & Context

Context management relies on file conventions and hierarchical loading.

### `CLAUDE.md`
*   **Purpose:** The "Mini-Documentation" for the agent.
*   **Behavior:** Automatically loaded into the context window at session start.
*   **Content:**
    *   Architectural overviews.
    *   Coding style guides.
    *   Common testing/build commands.
    *   Project-specific "gotchas".
*   **Hierarchy:** `CLAUDE.md` files are loaded recursively from the root down to the current directory.
*   **`CLAUDE.local.md`:** A git-ignored variant for user-specific context (e.g., "I prefer verbose logging").

## 7. Session Management

Features for long-running workflows and context persistence.

### Persistence
*   **Resume:**
    *   `claude -c`: Continue the most recent session.
    *   `claude -r <session_id>`: Resume a specific past session.
    *   **State:** Restores conversation history, variable state, and tool outputs.
*   **Background Tasks:**
    *   **Async Execution:** Commands can run in the background.
    *   **Buffering:** Output is buffered and presented to the agent when the task completes or when queried.
    *   **Lifespan:** Background processes persist across session resumes (if the daemon/process is still alive), though typically tied to the CLI process lifecycle.
