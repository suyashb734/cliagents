/**
 * Claude Code CLI Adapter
 *
 * Implements the AgentAdapter interface for Claude Code CLI.
 * Uses spawn-per-message with session resume for persistent sessions.
 */

const { spawn, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class ClaudeCodeAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,  // 3 minutes default - allows for complex prompts and tool use
      workDir: '/tmp/agent',
      skipPermissions: true,  // Use --dangerously-skip-permissions
      verbose: false,
      maxResponseSize: 10 * 1024 * 1024, // 10MB max response buffer
      model: null,  // null = use default, or specify model
      max_output_tokens: null, // null = use default, set via CLAUDE_CODE_MAX_OUTPUT_TOKENS env var
      lazyInit: true,  // Don't make API call on session creation
      claudePath: null,  // Allow explicit path override
      ...config
    });

    this.name = 'claude-code';
    this.version = '1.0.0';
    this.sessions = new Map(); // sessionId -> { claudeSessionId, ready, messageCount, model, jsonSchema, allowedTools, maxOutputTokens }
    this.activeProcesses = new Map(); // Track running CLI processes: sessionId -> process
    this._claudePathCache = null;  // Cache resolved claude path

    // Available models for Claude Code CLI
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses Claude default model' },
      { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', description: 'Latest Sonnet model' },
      { id: 'claude-opus-4-5-20250514', name: 'Claude Opus 4.5', description: 'Most capable Claude model' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', description: 'Balanced performance and speed' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', description: 'Fast and cost-effective' }
    ];
  }

  /**
   * Get the path to the claude CLI binary
   * Checks: config override > cache > which command > common paths
   */
  _getClaudePath() {
    // Use config override if provided
    if (this.config.claudePath) {
      return this.config.claudePath;
    }

    // Return cached path if available
    if (this._claudePathCache) {
      return this._claudePathCache;
    }

    // Try to find claude using 'which'
    try {
      const result = execSync('which claude', { encoding: 'utf8', timeout: 5000 }).trim();
      if (result) {
        this._claudePathCache = result;
        return result;
      }
    } catch (e) {
      // which failed, try common paths
    }

    // Check common installation paths
    const commonPaths = [
      '/opt/homebrew/bin/claude',      // macOS ARM (Homebrew)
      '/usr/local/bin/claude',         // macOS Intel / Linux
      '/usr/bin/claude',               // Linux system
      path.join(process.env.HOME || '', '.npm-global/bin/claude'),  // npm global
      path.join(process.env.HOME || '', 'node_modules/.bin/claude') // local node_modules
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        this._claudePathCache = p;
        return p;
      }
    }

    // Default fallback (will fail if not found, but gives clear error)
    return 'claude';
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels;
  }

  /**
   * Check if Claude Code CLI is available
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['claude']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Spawn a new Claude Code session
   *
   * Uses LAZY initialization - no API call is made until the first message.
   * This avoids the unnecessary "Ready." init message that was wasting an API call.
   */
  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || this.config.workDir;
    const model = options.model || this.config.model; // null = default
    const maxOutputTokens = options.max_output_tokens || this.config.max_output_tokens; // null = default

    // Ensure work directory exists
    const fs = require('fs');
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Create session metadata without making an API call
    // The actual Claude session ID will be obtained on the first message
    const session = {
      claudeSessionId: null,  // Will be set after first message
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model, // Store the model for this session
      jsonSchema: options.jsonSchema, // Store JSON schema for structured output
      allowedTools: options.allowedTools, // Store allowed tools list
      maxOutputTokens // Store max output tokens for this session
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    // Log session start
    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      claudeSessionId: null,  // Not yet assigned
      model: model || 'default'
    };
  }

  /**
   * Run a Claude CLI command and collect response (non-streaming, for init)
   */
  async _runClaudeCommand(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const claudePath = this._getClaudePath();

    // Ensure work directory exists
    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Build environment with optional max_output_tokens
    // Include common binary paths for cross-platform support
    const env = {
      ...process.env,
      NO_COLOR: '1',
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:${process.env.PATH}`
    };

    // Set CLAUDE_CODE_MAX_OUTPUT_TOKENS if specified
    if (options.maxOutputTokens) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxOutputTokens);
      console.log('[ClaudeAdapter] Setting max_output_tokens:', options.maxOutputTokens);
    }

    console.log('[ClaudeAdapter] Running (async):', claudePath, args.join(' '));
    console.log('[ClaudeAdapter] Working directory:', workDir);
    console.log('[ClaudeAdapter] Timeout:', timeout);

    return new Promise((resolve, reject) => {
      const proc = spawn(claudePath, args, {
        cwd: workDir,
        env
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Set timeout
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        if (timedOut) {
          console.log('[ClaudeAdapter] Timeout reached');
          resolve({
            text: stdout,
            timedOut: true,
            error: 'Request timed out'
          });
          return;
        }

        if (code !== 0) {
          console.log('[ClaudeAdapter] Error exit code:', code);
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        console.log('[ClaudeAdapter] Response received:', stdout.length, 'bytes');

        // Try to parse JSON response
        let result = null;
        try {
          result = JSON.parse(stdout.trim());
        } catch (e) {
          // Not JSON, return raw text
        }

        resolve({
          text: result?.result || stdout,
          sessionId: result?.session_id,
          stats: {
            durationMs: result?.duration_ms,
            costUsd: result?.total_cost_usd,
            inputTokens: result?.usage?.input_tokens,
            outputTokens: result?.usage?.output_tokens
          },
          exitCode: 0,
          raw: result,
          structuredOutput: result?.structured_output  // JSON schema output
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        console.log('[ClaudeAdapter] Process error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Run Claude CLI with async spawn and REAL-TIME streaming
   * With --output-format stream-json, Claude outputs newline-delimited JSON
   * showing tool calls, thinking, and progress as it happens
   */
  async *_runClaudeCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const claudePath = this._getClaudePath();

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Build environment with optional max_output_tokens
    // Include common binary paths for cross-platform support
    const env = {
      ...process.env,
      NO_COLOR: '1',
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:${process.env.PATH}`
    };

    // Set CLAUDE_CODE_MAX_OUTPUT_TOKENS if specified
    if (options.maxOutputTokens) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxOutputTokens);
    }

    console.log('[ClaudeAdapter] Streaming spawn:', claudePath, args.join(' '));

    const proc = spawn(claudePath, args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Track this process for cleanup
    const sessionId = options.sessionId;
    if (sessionId) {
      this.activeProcesses.set(sessionId, proc);
    }

    // Close stdin immediately since we're not sending any input
    proc.stdin.end();

    let timedOut = false;
    let exitCode = null;
    let processError = null;
    let buffer = '';  // Buffer for incomplete JSON lines
    let finalResult = null;
    let claudeSessionId = null;
    let lastAssistantContent = '';

    // Set timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }, timeout);

    // Track process completion
    const processComplete = new Promise((resolve) => {
      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        exitCode = code;
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        processError = err;
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
    });

    // Process streaming JSON output in real-time
    try {
      for await (const chunk of proc.stdout) {
        const text = chunk.toString();
        buffer += text;

        // Process complete lines (newline-delimited JSON)
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line);

            // Extract session ID from any message that has it
            if (msg.session_id) {
              claudeSessionId = msg.session_id;
            }

            // Handle different message types for real-time progress
            if (msg.type === 'assistant' && msg.message?.content) {
              // Assistant is speaking/thinking - content is array of content blocks
              const contentBlocks = msg.message.content;
              for (const block of contentBlocks) {
                if (block.type === 'text' && block.text) {
                  lastAssistantContent = block.text;
                  yield {
                    type: 'progress',
                    progressType: 'assistant',
                    content: block.text
                  };
                  this.emit('chunk', {
                    sessionId: options.sessionId,
                    chunk: block.text,
                    progressType: 'assistant',
                    partial: true
                  });
                } else if (block.type === 'tool_use') {
                  // Tool use within assistant message
                  yield {
                    type: 'progress',
                    progressType: 'tool_use',
                    tool: block.name,
                    input: block.input
                  };
                  this.emit('chunk', {
                    sessionId: options.sessionId,
                    progressType: 'tool_use',
                    tool: block.name,
                    partial: true
                  });
                }
              }
            } else if (msg.type === 'tool_use') {
              // Agent is calling a tool
              const toolName = msg.tool?.name || msg.name || 'unknown';
              const toolInput = msg.tool?.input || msg.input || {};
              yield {
                type: 'progress',
                progressType: 'tool_use',
                tool: toolName,
                input: toolInput
              };
              this.emit('chunk', {
                sessionId: options.sessionId,
                progressType: 'tool_use',
                tool: toolName,
                partial: true
              });
            } else if (msg.type === 'tool_result') {
              // Tool returned a result
              yield {
                type: 'progress',
                progressType: 'tool_result',
                result: msg.result || msg.content
              };
            } else if (msg.type === 'result' || msg.result) {
              // Final result
              finalResult = msg;
            } else if (msg.type === 'system' && msg.message?.session_id) {
              claudeSessionId = msg.message.session_id;
            }
          } catch (e) {
            // Not valid JSON, emit as raw chunk
            this.emit('chunk', {
              sessionId: options.sessionId,
              chunk: line,
              partial: true
            });
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          if (msg.type === 'result' || msg.result) {
            finalResult = msg;
          }
          if (msg.session_id) {
            claudeSessionId = msg.session_id;
          }
        } catch (e) {
          // Ignore incomplete JSON
        }
      }

      // Wait for process to fully complete
      await processComplete;

      // Handle errors
      if (timedOut) {
        yield { type: 'error', content: 'Request timed out', timedOut: true };
        return;
      }
      if (processError) {
        yield { type: 'error', content: processError.message };
        return;
      }
      if (exitCode !== 0) {
        yield { type: 'error', content: `Process exited with code ${exitCode}` };
        return;
      }

      // Yield final result
      yield {
        type: 'result',
        content: finalResult?.result || lastAssistantContent || '',
        sessionId: claudeSessionId,
        stats: {
          durationMs: finalResult?.duration_ms,
          costUsd: finalResult?.total_cost_usd,
          inputTokens: finalResult?.usage?.input_tokens,
          outputTokens: finalResult?.usage?.output_tokens
        },
        structuredOutput: finalResult?.structured_output
      };

    } catch (error) {
      clearTimeout(timeoutId);
      yield {
        type: 'error',
        content: error.message,
        timedOut: false
      };
    }
  }

  /**
   * Send a message and yield response chunks (with streaming)
   */
  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.ready) {
      throw new Error(`Session ${sessionId} not ready`);
    }

    // Build args - resume session if we have a session ID
    // Use stream-json for real-time streaming of agent progress (tool calls, thinking, etc.)
    // Note: --verbose is REQUIRED when using stream-json
    const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'];

    // For the first message, add system prompt via --system-prompt flag if configured
    if (!session.claudeSessionId && session.systemPrompt) {
      args.push('--system-prompt', session.systemPrompt);
    }

    // Add model flag if session has a specific model
    if (session.model) {
      args.unshift('--model', session.model);
    }

    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }

    args.push('--add-dir', session.workDir);

    // Add JSON schema for structured output if specified (per-message or session-level)
    const jsonSchema = options.jsonSchema || session.jsonSchema;
    if (jsonSchema) {
      const schemaStr = typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema);
      args.push('--json-schema', schemaStr);
    }

    // Add allowed tools if specified (per-message or session-level)
    const allowedTools = options.allowedTools || session.allowedTools;
    if (allowedTools && Array.isArray(allowedTools)) {
      args.push('--allowed-tools', allowedTools.join(','));
    }

    if (this.config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    session.messageCount++;

    let finalContent = '';
    let finalStats = null;
    let hasError = false;

    try {
      // Use streaming version
      for await (const chunk of this._runClaudeCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir,
        maxOutputTokens: session.maxOutputTokens  // Pass session's max_output_tokens
      })) {
        if (chunk.type === 'chunk') {
          // Yield chunk immediately for real-time display
          yield chunk;
        } else if (chunk.type === 'progress') {
          // Real-time progress updates (tool calls, assistant messages)
          yield chunk;
        } else if (chunk.type === 'result') {
          finalContent = chunk.content;
          finalStats = chunk.stats;

          // Update session ID if returned
          if (chunk.sessionId) {
            session.claudeSessionId = chunk.sessionId;
          }

          // Log the full conversation turn
          logConversation(sessionId, this.name, {
            prompt: message,
            response: finalContent,
            stats: finalStats
          });

          // Yield final result
          // If structured output is available (from --json-schema), return it as the result
          const resultContent = chunk.structuredOutput
            ? JSON.stringify(chunk.structuredOutput)
            : finalContent;

          yield {
            type: 'result',
            content: resultContent,
            structuredOutput: chunk.structuredOutput,  // Pass through for clients that want it
            metadata: {
              costUsd: finalStats?.costUsd,
              durationMs: finalStats?.durationMs,
              inputTokens: finalStats?.inputTokens,
              outputTokens: finalStats?.outputTokens,
              timedOut: false
            }
          };
        } else if (chunk.type === 'error') {
          hasError = true;

          // Log error
          logConversation(sessionId, this.name, {
            prompt: message,
            error: chunk.content
          });

          yield {
            type: 'error',
            content: chunk.content,
            timedOut: chunk.timedOut
          };
        }
      }
    } catch (error) {
      // Log error
      logConversation(sessionId, this.name, {
        prompt: message,
        error: error.message
      });

      yield {
        type: 'error',
        content: error.message
      };
    }
  }

  /**
   * Terminate a session
   */
  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Kill any active process for this session
    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
      console.log(`[ClaudeAdapter] Killing process for session ${sessionId}`);
      proc.kill('SIGTERM');
      // Force kill after 2 seconds if still alive
      setTimeout(() => {
        if (!proc.killed) {
          console.log(`[ClaudeAdapter] Force killing process for session ${sessionId}`);
          proc.kill('SIGKILL');
        }
      }, 2000);
    }
    this.activeProcesses.delete(sessionId);

    // Remove from tracking
    this.sessions.delete(sessionId);
    this.emit('terminated', { sessionId });
  }

  /**
   * Kill all active processes (for cleanup)
   */
  killAllProcesses() {
    console.log(`[ClaudeAdapter] Killing ${this.activeProcesses.size} active processes`);
    for (const [sessionId, proc] of this.activeProcesses.entries()) {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }
    this.activeProcesses.clear();
  }

  /**
   * Check if session is active
   */
  isSessionActive(sessionId) {
    return this.sessions.has(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }

  /**
   * Parse Claude response for action extraction
   */
  parseResponse(text) {
    // Try to find JSON action
    const jsonMatches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    if (jsonMatches) {
      for (const jsonMatch of jsonMatches) {
        try {
          const parsed = JSON.parse(jsonMatch);
          if (parsed.action) return parsed;
        } catch (e) {
          // Continue
        }
      }
    }

    // Check for common patterns
    const lowerText = text.toLowerCase();

    if (lowerText.includes('task is done') || lowerText.includes('task complete') ||
        lowerText.includes('finished') || lowerText.includes('completed')) {
      return { action: 'complete', thinking: text.substring(0, 200), result: text };
    }

    // URL navigation
    const urlMatch = text.match(/https?:\/\/[^\s"'<>\]]+/);
    if (urlMatch && (lowerText.includes('navigate') || lowerText.includes('go to'))) {
      return { action: 'navigate', url: urlMatch[0], thinking: 'Navigating' };
    }

    // Click patterns
    const clickMatch = text.match(/click(?:ing)?(?:\s+on)?(?:\s+element)?(?:\s+#)?(?:\s+number)?\s*(\d+)/i);
    if (clickMatch) {
      return { action: 'click', element: parseInt(clickMatch[1]), thinking: `Clicking element ${clickMatch[1]}` };
    }

    // Scroll
    if (lowerText.includes('scroll')) {
      const direction = lowerText.includes('up') ? 'up' : 'down';
      return { action: 'scroll', direction, thinking: `Scrolling ${direction}` };
    }

    return { text };
  }
}

module.exports = ClaudeCodeAdapter;
