/**
 * Gemini CLI Adapter
 *
 * Implements the AgentAdapter interface for Gemini CLI.
 * Uses spawn-per-message with session resume (-r) for persistent sessions.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');
const { updateGenerationParams, getGenerationParams } = require('../utils/gemini-config');

class GeminiCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,  // 3 minutes for image analysis tasks
      workDir: '/tmp/agent',
      yoloMode: true,        // Auto-approve all actions
      maxResponseSize: 10 * 1024 * 1024, // 10MB max response buffer
      model: null,           // null = use default, or specify model like 'gemini-3-pro-preview'
      // Generation parameters (written to ~/.gemini/config.yaml)
      temperature: null,     // 0.0-2.0, null = use default
      top_p: null,           // 0.0-1.0, null = use default
      top_k: null,           // integer, null = use default
      max_output_tokens: null, // integer, null = use default
      ...config
    });

    this.name = 'gemini-cli';
    this.version = '1.0.0';
    this.sessions = new Map(); // sessionId -> { geminiSessionIndex, ready, messageCount, model, generationParams }
    this.activeProcesses = new Map(); // Track running CLI processes: sessionId -> process

    // Available models for Gemini CLI
    this.availableModels = [
      { id: 'default', name: 'Default (2.5 Flash)', description: 'Uses gemini-2.5-flash and gemini-2.5-flash-lite' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast and efficient model' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable 2.5 model' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', description: 'Latest and most intelligent model' }
    ];

    // Apply initial generation params from config if provided
    this._applyGenerationParams({
      temperature: this.config.temperature,
      top_p: this.config.top_p,
      top_k: this.config.top_k,
      max_output_tokens: this.config.max_output_tokens
    });
  }

  /**
   * Apply generation parameters to Gemini config file
   */
  _applyGenerationParams(params) {
    // Filter out null/undefined values
    const validParams = {};
    if (params.temperature !== null && params.temperature !== undefined) {
      validParams.temperature = params.temperature;
    }
    if (params.top_p !== null && params.top_p !== undefined) {
      validParams.top_p = params.top_p;
    }
    if (params.top_k !== null && params.top_k !== undefined) {
      validParams.top_k = params.top_k;
    }
    if (params.max_output_tokens !== null && params.max_output_tokens !== undefined) {
      validParams.max_output_tokens = params.max_output_tokens;
    }

    if (Object.keys(validParams).length > 0) {
      const success = updateGenerationParams(validParams);
      if (success) {
        console.log('[GeminiAdapter] Applied generation params:', validParams);
      }
    }
  }

  /**
   * Get current generation parameters
   */
  getGenerationParams() {
    return getGenerationParams();
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels;
  }

  /**
   * Check if Gemini CLI is available
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['gemini']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Get list of Gemini sessions
   */
  _listGeminiSessions() {
    try {
      const output = execFileSync('/usr/local/bin/gemini', ['--list-sessions'], {
        encoding: 'utf-8',
        timeout: 5000
      });
      const lines = output.trim().split('\n').filter(l => l.trim());
      return lines.length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Spawn a new Gemini session
   */
  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || this.config.workDir;
    const model = options.model || this.config.model; // null = default

    // Apply generation parameters if provided (writes to ~/.gemini/config.yaml)
    const generationParams = {
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      max_output_tokens: options.max_output_tokens
    };
    this._applyGenerationParams(generationParams);

    // Create a new Gemini session by sending an init message
    const initPrompt = options.systemPrompt
      ? `You are starting a new session. ${options.systemPrompt}. Acknowledge with "Ready."`
      : 'You are starting a new session. Acknowledge with "Ready."';

    // Use json for init (not stream-json since we're not streaming for spawn)
    const args = [
      '-p', initPrompt,
      '-o', 'json'
    ];

    // Add model flag if specified and not 'default'
    if (model && model !== 'default') {
      args.unshift('-m', model);
    }

    // Add allowed tools if specified (Gemini uses --allowed-tools flag)
    if (options.allowedTools && Array.isArray(options.allowedTools)) {
      args.push('--allowed-tools', options.allowedTools.join(','));
    }

    if (this.config.yoloMode) {
      args.push('-y');
    }

    // Run init message to create session
    const initResult = await this._runGeminiCommand(args, { workDir });

    // Use "latest" to refer to the most recently created session
    // This is more reliable than trying to track indices
    const session = {
      geminiSessionRef: 'latest', // Will always use "latest" for resuming the most recent session
      ready: true,
      messageCount: 1,
      systemPrompt: options.systemPrompt,
      workDir,
      model, // Store the model for this session
      allowedTools: options.allowedTools, // Store allowed tools list
      generationParams // Store generation params for reference
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    // Log session start
    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      geminiSessionRef: 'latest',
      model: model || 'default'
    };
  }

  /**
   * Run a Gemini CLI command and collect response (non-streaming, for init)
   */
  async _runGeminiCommand(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const geminiPath = '/usr/local/bin/gemini';

    // Ensure work directory exists
    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    console.log('[GeminiAdapter] Running (async):', geminiPath, args.join(' '));
    console.log('[GeminiAdapter] Working directory:', workDir);
    console.log('[GeminiAdapter] Timeout:', timeout);

    return new Promise((resolve, reject) => {
      const proc = spawn(geminiPath, args, {
        cwd: workDir,
        env: {
          ...process.env,
          NO_COLOR: '1'
        }
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
          console.log('[GeminiAdapter] Timeout reached');
          resolve({
            text: stdout,
            timedOut: true,
            error: 'Request timed out'
          });
          return;
        }

        if (code !== 0) {
          console.log('[GeminiAdapter] Error exit code:', code);
          reject(new Error(`Gemini CLI exited with code ${code}: ${stderr}`));
          return;
        }

        console.log('[GeminiAdapter] Response received:', stdout.length, 'bytes');

        // Try to parse JSON response
        let result = null;
        const jsonStart = stdout.indexOf('{');
        if (jsonStart !== -1) {
          try {
            const jsonStr = stdout.substring(jsonStart);
            result = JSON.parse(jsonStr);
          } catch (e) {
            console.log('[GeminiAdapter] JSON parse error, using raw output');
          }
        }

        // Extract stats from the nested stats object
        const stats = result?.stats?.models;
        let totalTokens = 0;
        let promptTokens = 0;
        let candidateTokens = 0;

        if (stats) {
          for (const model of Object.values(stats)) {
            promptTokens += model.tokens?.prompt || 0;
            candidateTokens += model.tokens?.candidates || 0;
            totalTokens += model.tokens?.total || 0;
          }
        }

        resolve({
          text: result?.response || stdout,
          stats: {
            inputTokens: promptTokens,
            outputTokens: candidateTokens,
            totalTokens: totalTokens,
            toolCalls: result?.stats?.tools?.totalCalls || 0
          },
          exitCode: 0,
          raw: result
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        console.log('[GeminiAdapter] Process error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Run Gemini CLI with streaming output (async spawn)
   * Yields chunks as they arrive from stdout
   */
  async *_runGeminiCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const geminiPath = '/usr/local/bin/gemini';

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    console.log('[GeminiAdapter] Streaming:', geminiPath, args.join(' '));

    const proc = spawn(geminiPath, args, {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });

    // Track this process for cleanup
    const sessionId = options.sessionId;
    if (sessionId) {
      this.activeProcesses.set(sessionId, proc);
    }

    let fullOutput = '';
    let timedOut = false;
    let exitCode = null;
    let processError = null;

    // Set timeout with force kill fallback
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Force kill after 2 seconds if SIGTERM doesn't work
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
        // Remove from active processes
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        processError = err;
        // Remove from active processes
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
    });

    // Process streaming JSON output in real-time
    let buffer = '';  // Buffer for incomplete JSON lines
    let finalResult = null;
    let lastAssistantContent = '';

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

            // Handle different message types for real-time progress
            // Gemini format: {"type":"message","role":"assistant","content":"..."}
            if (msg.type === 'message' && msg.role === 'assistant') {
              // Assistant is speaking/thinking
              const content = msg.content;
              if (content) {
                lastAssistantContent = content;
                yield {
                  type: 'progress',
                  progressType: 'assistant',
                  content: content
                };
                this.emit('chunk', {
                  sessionId: options.sessionId,
                  chunk: content,
                  progressType: 'assistant',
                  partial: true
                });
              }
            } else if (msg.type === 'tool_use' || msg.type === 'function_call') {
              // Agent is calling a tool
              const toolName = msg.name || msg.tool?.name || 'unknown';
              const toolInput = msg.args || msg.input || {};
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
            } else if (msg.type === 'tool_result' || msg.type === 'function_result') {
              // Tool returned a result
              yield {
                type: 'progress',
                progressType: 'tool_result',
                result: msg.result || msg.content
              };
            } else if (msg.type === 'result') {
              // Final result - Gemini format: {"type":"result","status":"success","stats":{...}}
              finalResult = msg;
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
          if (msg.type === 'result') {
            finalResult = msg;
          }
          // Also capture last assistant content from buffer
          if (msg.type === 'message' && msg.role === 'assistant' && msg.content) {
            lastAssistantContent = msg.content;
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

      // Extract stats from the final result
      // Gemini stream-json format: {"type":"result","stats":{"total_tokens":X,"input_tokens":Y,"output_tokens":Z}}
      const stats = finalResult?.stats;

      // Yield final result
      yield {
        type: 'result',
        content: lastAssistantContent || '',
        stats: {
          inputTokens: stats?.input_tokens || 0,
          outputTokens: stats?.output_tokens || 0,
          totalTokens: stats?.total_tokens || 0,
          toolCalls: stats?.tool_calls || 0,
          durationMs: stats?.duration_ms || 0
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

    // Build args for resume
    // Use stream-json for real-time streaming of agent progress
    const args = [
      '-r', session.geminiSessionRef, // Resume by "latest" or session reference
      '-p', message,
      '-o', 'stream-json'
    ];

    // Add model flag if session has a specific model
    if (session.model && session.model !== 'default') {
      args.unshift('-m', session.model);
    }

    // Add allowed tools if specified (per-message or session-level)
    const allowedTools = options.allowedTools || session.allowedTools;
    if (allowedTools && Array.isArray(allowedTools)) {
      args.push('--allowed-tools', allowedTools.join(','));
    }

    if (this.config.yoloMode) {
      args.push('-y');
    }

    session.messageCount++;

    let finalContent = '';
    let finalStats = null;

    try {
      // Use streaming version
      for await (const chunk of this._runGeminiCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
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

          // Log the full conversation turn
          logConversation(sessionId, this.name, {
            prompt: message,
            response: finalContent,
            stats: finalStats
          });

          // Yield final result
          yield {
            type: 'result',
            content: finalContent,
            metadata: {
              inputTokens: finalStats?.inputTokens,
              outputTokens: finalStats?.outputTokens,
              totalTokens: finalStats?.totalTokens,
              toolCalls: finalStats?.toolCalls,
              timedOut: false
            }
          };
        } else if (chunk.type === 'error') {
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
      console.log(`[GeminiAdapter] Killing process for session ${sessionId}`);
      proc.kill('SIGTERM');
      // Force kill after 2 seconds if still alive
      setTimeout(() => {
        if (!proc.killed) {
          console.log(`[GeminiAdapter] Force killing process for session ${sessionId}`);
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
    console.log(`[GeminiAdapter] Killing ${this.activeProcesses.size} active processes`);
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
   * Parse Gemini response for action extraction
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

module.exports = GeminiCliAdapter;
