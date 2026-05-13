/**
 * OpenAI Codex CLI Adapter
 *
 * Implements the AgentAdapter interface for OpenAI Codex CLI.
 * Uses spawn-per-message with session resume for persistent sessions.
 *
 * Install: npm i -g @openai/codex
 * Docs: https://github.com/openai/codex
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { createAdapterContract, defineAdapterCapabilities, EXECUTION_MODES } = require('./contract');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

const DEFAULT_CODEX_EXEC_MODEL = process.env.CLIAGENTS_CODEX_EXEC_MODEL || 'gpt-5.4';
const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 2500;
const CODEX_MODEL_ALIASES = Object.freeze({
  gpt5: 'gpt-5.5',
  gpt5mini: 'gpt-5.4-mini',
  codex: 'gpt-5.5',
  codexmini: 'gpt-5.4-mini'
});

function normalizeCodexModelAlias(model) {
  const normalized = String(model || '').trim();
  if (!normalized) {
    return null;
  }
  return CODEX_MODEL_ALIASES[normalized.toLowerCase()] || normalized;
}

function normalizeReasoningEffort(effort) {
  const normalized = String(effort || '').trim().toLowerCase();
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(normalized)
    ? normalized
    : null;
}

class CodexCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,  // 3 minutes default
      workDir: '/tmp/agent',
      skipPermissions: true,  // Use --dangerously-skip-permissions equivalent
      maxResponseSize: 10 * 1024 * 1024, // 10MB max response buffer
      model: DEFAULT_CODEX_EXEC_MODEL,  // Pin non-interactive runs away from unsupported user CLI defaults.
      ...config
    });

    this.name = 'codex-cli';
    this.version = '1.0.0';
    this.sessions = new Map(); // sessionId -> { codexSessionId, ready, messageCount, model }
    this.activeProcesses = new Map(); // Track running CLI processes
    this.capabilities = defineAdapterCapabilities({
      usesOfficialCli: true,
      executionMode: EXECUTION_MODES.DIRECT_SESSION,
      supportsMultiTurn: true,
      supportsResume: true,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsSystemPrompt: true,
      supportsModelSelection: true,
      supportsTools: true,
      supportsFilesystemRead: true,
      supportsFilesystemWrite: true,
      supportsJsonMode: true
    });
    this.contract = createAdapterContract({
      capabilities: this.capabilities,
      readiness: {
        initTimeoutMs: 90000,
        promptHandlers: [
          {
            matchAny: ['Update now', 'Skip until next version'],
            actions: ['Down', 'Enter'],
            description: 'skip-codex-update-menu'
          },
          {
            matchAny: ['Press enter to continue', 'Update available'],
            actions: ['Enter'],
            description: 'dismiss-codex-update-info'
          }
        ]
      },
      notes: [
        'Spawn-per-message adapter that resumes provider-native Codex threads between sends.',
        'JSON mode uses the Codex read-only sandbox path; full-auto mode enables tool and filesystem mutation.'
      ]
    });

    // Fallback models for Codex CLI. getAvailableModels() prefers the live
    // `codex debug models` catalog when supported by the installed CLI.
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses the broker-safe Codex execution default' },
      { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Frontier Codex model for complex coding work' },
      { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Supported high-capability Codex model' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Efficient GPT-5.4 model' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Codex-optimized GPT-5.3 model' },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', description: 'Fast Codex-optimized GPT-5.3 model' },
      { id: 'o3-mini', name: 'o3-mini', description: 'Fast and efficient reasoning model' },
      { id: 'o4-mini', name: 'o4-mini', description: 'Latest efficient model' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable GPT-4 model' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable GPT-4' }
    ];
    this._modelsCache = null;
    this._modelsCacheAt = 0;
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCacheAt < 5 * 60 * 1000) {
      return this._modelsCache;
    }

    try {
      const result = spawnSync('codex', ['debug', 'models'], {
        encoding: 'utf8',
        timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
        env: {
          ...process.env,
          NO_COLOR: '1'
        }
      });
      if (result.status === 0 && result.stdout) {
        const parsed = JSON.parse(result.stdout);
        const models = Array.isArray(parsed.models)
          ? parsed.models
              .map((model) => {
                const id = String(model?.slug || model?.id || '').trim();
                if (!id) {
                  return null;
                }
                return {
                  id,
                  name: model.display_name || id,
                  description: model.description || '',
                  defaultReasoningLevel: model.default_reasoning_level || null,
                  supportedReasoningLevels: Array.isArray(model.supported_reasoning_levels)
                    ? model.supported_reasoning_levels
                    : []
                };
              })
              .filter(Boolean)
          : [];
        if (models.length > 0) {
          this._modelsCache = [
            { id: 'default', name: 'Default', description: 'Uses the broker-safe Codex execution default' },
            ...models
          ];
          this._modelsCacheAt = now;
          return this._modelsCache;
        }
      }
    } catch {
      // Fall back to the bundled list below.
    }

    return this.availableModels;
  }

  getCapabilities() {
    return this.capabilities;
  }

  getContract() {
    return this.contract;
  }

  /**
   * Check if Codex CLI is available
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['codex']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Spawn a new Codex session
   * Uses LAZY initialization - no API call until first message
   */
  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || this.config.workDir;
    const model = normalizeCodexModelAlias(options.model || this.config.model);
    const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort || options.effort || this.config.reasoningEffort);
    const providerSessionId = String(options.providerSessionId || '').trim() || null;

    // Ensure work directory exists
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // Create session metadata without making an API call
    const session = {
      codexSessionId: providerSessionId,  // May be pre-seeded for exact resume
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model,
      reasoningEffort,
      allowedTools: options.allowedTools,
      jsonMode: options.jsonMode || false
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    // Log session start
    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      codexSessionId: providerSessionId,
      providerSessionId,
      model: model || 'default'
    };
  }

  /**
   * Run Codex CLI with streaming output
   */
  async *_runCodexCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    // Try common installation paths
    const codexPaths = [
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      `${process.env.HOME}/.npm-global/bin/codex`,
      'codex'  // Fallback to PATH
    ];

    let codexPath = 'codex';
    for (const path of codexPaths) {
      if (path === 'codex' || fs.existsSync(path)) {
        codexPath = path;
        break;
      }
    }

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const env = {
      ...process.env,
      NO_COLOR: '1',
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
    };

    console.log('[CodexAdapter] Streaming:', codexPath, args.join(' '));

    const proc = spawn(codexPath, args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Track this process for cleanup
    const sessionId = options.sessionId;
    if (sessionId) {
      this.activeProcesses.set(sessionId, proc);
    }

    // Close stdin immediately
    proc.stdin.end();

    let timedOut = false;
    let exitCode = null;
    let processError = null;
    let fullOutput = '';

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

    // Process JSONL output (Codex outputs newline-delimited JSON with --json)
    let buffer = '';
    let threadId = null;
    let agentMessages = [];
    let usageStats = null;

    try {
      for await (const chunk of proc.stdout) {
        const text = chunk.toString();
        buffer += text;

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line);

            // Extract thread ID (session ID)
            if (msg.type === 'thread.started' && msg.thread_id) {
              threadId = msg.thread_id;
            }

            // Extract agent messages
            if (msg.type === 'item.completed' && msg.item?.type === 'agent_message') {
              agentMessages.push(msg.item.text);
              yield {
                type: 'progress',
                progressType: 'assistant',
                content: msg.item.text
              };
              this.emit('chunk', {
                sessionId: options.sessionId,
                chunk: msg.item.text,
                progressType: 'assistant',
                partial: true
              });
            }

            // Extract reasoning (thinking)
            if (msg.type === 'item.completed' && msg.item?.type === 'reasoning') {
              yield {
                type: 'progress',
                progressType: 'thinking',
                content: msg.item.text
              };
            }

            // Extract tool calls
            if (msg.type === 'item.completed' && msg.item?.type === 'tool_call') {
              yield {
                type: 'progress',
                progressType: 'tool_use',
                tool: msg.item.name || 'unknown',
                input: msg.item.args || {}
              };
            }

            // Extract usage stats
            if (msg.type === 'turn.completed' && msg.usage) {
              usageStats = msg.usage;
            }
          } catch (e) {
            // Not valid JSON, ignore
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          if (msg.type === 'item.completed' && msg.item?.type === 'agent_message') {
            agentMessages.push(msg.item.text);
          }
          if (msg.type === 'turn.completed' && msg.usage) {
            usageStats = msg.usage;
          }
        } catch (e) {
          // Ignore
        }
      }

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

      // Yield final result - combine all agent messages
      const finalContent = agentMessages.join('\n') || '';
      yield {
        type: 'result',
        content: finalContent,
        sessionId: threadId,
        stats: {
          inputTokens: usageStats?.input_tokens || 0,
          cachedInputTokens: usageStats?.cached_input_tokens || 0,
          outputTokens: usageStats?.output_tokens || 0
        }
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
   * Send a message and yield response chunks
   */
  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.ready) {
      throw new Error(`Session ${sessionId} not ready`);
    }

    // Build full prompt with context
    let fullPrompt = message;

    // Add system prompt for first message
    if (!session.codexSessionId && session.systemPrompt) {
      fullPrompt = `${session.systemPrompt}\n\n${fullPrompt}`;
    }

    const isResume = Boolean(session.codexSessionId);
    const args = isResume ? ['exec', 'resume'] : ['exec'];

    // Add model flag if specified
    if (session.model && session.model !== 'default') {
      args.push('-m', session.model);
    }
    if (session.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${session.reasoningEffort}"`);
    }

    // JSON mode: read-only sandbox (no tool use, pure LLM response)
    // Normal mode: full-auto (workspace-write sandbox + auto-approve)
    if (session.jsonMode) {
      args.push('--sandbox', 'read-only');
    } else {
      args.push('--full-auto');
    }

    // JSON output for structured response
    args.push('--json');

    // Skip git repo check for non-git directories (like /tmp/agent)
    args.push('--skip-git-repo-check');

    if (isResume) {
      args.push(session.codexSessionId);
    }

    // Add prompt as the final argument
    args.push(fullPrompt);

    session.messageCount++;

    let finalContent = '';
    let finalStats = null;

    try {
      for await (const chunk of this._runCodexCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'chunk') {
          yield chunk;
        } else if (chunk.type === 'progress') {
          yield chunk;
        } else if (chunk.type === 'result') {
          finalContent = chunk.content;
          finalStats = chunk.stats;

          // Update session ID if returned
          if (chunk.sessionId) {
            session.codexSessionId = chunk.sessionId;
          }

          // Log conversation
          logConversation(sessionId, this.name, {
            prompt: message,
            response: finalContent,
            stats: finalStats
          });

          yield {
            type: 'result',
            content: finalContent,
            metadata: {
              providerSessionId: session.codexSessionId || null,
              costUsd: finalStats?.costUsd,
              durationMs: finalStats?.durationMs,
              inputTokens: finalStats?.inputTokens,
              outputTokens: finalStats?.outputTokens,
              timedOut: false
            }
          };
        } else if (chunk.type === 'error') {
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

    // Kill any active process
    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
      console.log(`[CodexAdapter] Killing process for session ${sessionId}`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }
    this.activeProcesses.delete(sessionId);

    this.sessions.delete(sessionId);
    this._clearHeartbeat(sessionId);
    this.emit('terminated', { sessionId });
  }

  /**
   * Kill all active processes
   */
  killAllProcesses() {
    console.log(`[CodexAdapter] Killing ${this.activeProcesses.size} active processes`);
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
   * Parse Codex response for action extraction
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

    return { text };
  }
}

module.exports = CodexCliAdapter;
