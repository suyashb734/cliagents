/**
 * Goose CLI Adapter
 *
 * Implements the AgentAdapter interface for Block's Goose AI agent.
 * Goose is an open-source extensible AI agent that runs locally.
 *
 * Install: brew install goose (macOS) or download from GitHub releases
 * Docs: https://github.com/block/goose
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class GooseAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 300000,  // 5 minutes - goose can run complex tasks
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: null,  // Uses default model from goose config
      ...config
    });

    this.name = 'goose';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Available models for Goose (configurable via goose config)
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses goose default configuration' },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic Claude' },
      { id: 'claude-3-opus', name: 'Claude 3 Opus', description: 'Most capable Claude' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast OpenAI model' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Google Gemini' }
    ];
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels;
  }

  /**
   * Check if Goose is available
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['goose']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Spawn a new Goose session
   */
  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || this.config.workDir;
    const model = options.model || this.config.model;

    // Ensure work directory exists
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const session = {
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model,
      sessionName: `session-${sessionId}`  // Goose can name sessions
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: model || 'default'
    };
  }

  /**
   * Run Goose CLI with streaming output
   */
  async *_runGooseCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    // Try common installation paths
    const goosePaths = [
      '/usr/local/bin/goose',
      '/opt/homebrew/bin/goose',
      `${process.env.HOME}/.local/bin/goose`,
      `${process.env.HOME}/bin/goose`,
      'goose'
    ];

    let goosePath = 'goose';
    for (const path of goosePaths) {
      if (path === 'goose' || fs.existsSync(path)) {
        goosePath = path;
        break;
      }
    }

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const env = {
      ...process.env,
      NO_COLOR: '1'
    };

    console.log('[GooseAdapter] Streaming:', goosePath, args.join(' '));

    const proc = spawn(goosePath, args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const sessionId = options.sessionId;
    if (sessionId) {
      this.activeProcesses.set(sessionId, proc);
    }

    proc.stdin.end();

    let timedOut = false;
    let exitCode = null;
    let processError = null;
    let fullOutput = '';
    let stderrOutput = '';

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }, timeout);

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

    proc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    try {
      for await (const chunk of proc.stdout) {
        const text = chunk.toString();
        fullOutput += text;

        this.emit('chunk', {
          sessionId: options.sessionId,
          chunk: text,
          partial: true
        });

        yield { type: 'chunk', content: text };
      }

      await processComplete;

      if (timedOut) {
        yield { type: 'error', content: 'Request timed out', timedOut: true };
        return;
      }
      if (processError) {
        yield { type: 'error', content: processError.message };
        return;
      }
      if (exitCode !== 0 && !fullOutput) {
        yield { type: 'error', content: `Goose exited with code ${exitCode}: ${stderrOutput}` };
        return;
      }

      // Try to parse JSON output if goose returns JSON
      let result = null;
      try {
        result = JSON.parse(fullOutput.trim());
      } catch (e) {
        // Plain text output
      }

      yield {
        type: 'result',
        content: result?.response || result?.result || fullOutput.trim(),
        stats: result?.stats || {}
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

    // Build args for goose
    // Goose uses subcommands: goose run, goose session, etc.
    const args = [
      'run',  // Run a single task
      '--text', message
    ];

    // Add model if specified
    if (session.model && session.model !== 'default') {
      args.push('--model', session.model);
    }

    // Add session name for continuity
    if (session.sessionName) {
      args.push('--name', session.sessionName);
    }

    // Resume session if not first message
    if (session.messageCount > 0) {
      args.push('--resume');
    }

    // Add system prompt as instructions
    if (session.messageCount === 0 && session.systemPrompt) {
      args.push('--instructions', session.systemPrompt);
    }

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runGooseCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'chunk') {
          yield chunk;
        } else if (chunk.type === 'result') {
          finalContent = chunk.content;

          logConversation(sessionId, this.name, {
            prompt: message,
            response: finalContent,
            stats: chunk.stats
          });

          yield {
            type: 'result',
            content: finalContent,
            metadata: {
              ...chunk.stats,
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

    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
      console.log(`[GooseAdapter] Killing process for session ${sessionId}`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }
    this.activeProcesses.delete(sessionId);

    this.sessions.delete(sessionId);
    this.emit('terminated', { sessionId });
  }

  /**
   * Kill all active processes
   */
  killAllProcesses() {
    console.log(`[GooseAdapter] Killing ${this.activeProcesses.size} active processes`);
    for (const [, proc] of this.activeProcesses.entries()) {
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
   * Parse Goose response
   */
  parseResponse(text) {
    const lowerText = text.toLowerCase();

    if (lowerText.includes('complete') || lowerText.includes('done') || lowerText.includes('finished')) {
      return { action: 'complete', result: text };
    }

    // Look for tool calls
    const toolMatch = text.match(/using tool:\s*(\w+)/i);
    if (toolMatch) {
      return { action: 'tool_call', tool: toolMatch[1], text };
    }

    return { text };
  }
}

module.exports = GooseAdapter;
