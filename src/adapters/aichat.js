/**
 * aichat CLI Adapter
 *
 * Implements the AgentAdapter interface for aichat CLI.
 * aichat is an all-in-one LLM CLI tool supporting multiple providers.
 *
 * Install: cargo install aichat (Rust)
 * Docs: https://github.com/sigoden/aichat
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class AichatAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,  // 3 minutes
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: null,  // Uses aichat default
      role: null,  // Optional role (shell, code, etc.)
      ...config
    });

    this.name = 'aichat';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // aichat supports many providers with model:provider format
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses aichat default configuration' },
      { id: 'openai:gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o' },
      { id: 'openai:gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast OpenAI model' },
      { id: 'anthropic:claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic Claude' },
      { id: 'google:gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Google Gemini' },
      { id: 'mistral:mistral-large', name: 'Mistral Large', description: 'Mistral AI' },
      { id: 'groq:llama-3.3-70b', name: 'Llama 3.3 70B', description: 'Llama via Groq' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['aichat']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || this.config.workDir;
    const model = options.model || this.config.model;

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    // aichat supports sessions via --session flag
    const sessionName = `session-${sessionId.slice(0, 8)}`;

    const session = {
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model,
      sessionName,
      role: options.role || this.config.role
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { model: model || 'default', workDir, sessionName });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: model || 'default',
      sessionName
    };
  }

  async *_runAichatCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    const aichatPaths = [
      '/usr/local/bin/aichat',
      '/opt/homebrew/bin/aichat',
      `${process.env.HOME}/.cargo/bin/aichat`,
      'aichat'
    ];

    let aichatPath = 'aichat';
    for (const path of aichatPaths) {
      if (path === 'aichat' || fs.existsSync(path)) {
        aichatPath = path;
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

    console.log('[AichatAdapter] Streaming:', aichatPath, args.join(' '));

    const proc = spawn(aichatPath, args, {
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
        yield { type: 'error', content: `aichat exited with code ${exitCode}: ${stderrOutput}` };
        return;
      }

      yield {
        type: 'result',
        content: fullOutput.trim(),
        stats: {}
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

  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.ready) {
      throw new Error(`Session ${sessionId} not ready`);
    }

    // Build args for aichat
    // aichat --session <name> -m <model> "message"
    const args = [];

    // Add session for context preservation
    if (session.sessionName) {
      args.push('--session', session.sessionName);
    }

    // Add model if specified
    if (session.model && session.model !== 'default') {
      args.push('-m', session.model);
    }

    // Add role if specified (shell, code, etc.)
    if (session.role || options.role) {
      args.push('--role', session.role || options.role);
    }

    // Add system prompt on first message
    if (session.messageCount === 0 && session.systemPrompt) {
      args.push('--prompt', session.systemPrompt);
    }

    // Add the message
    args.push(message);

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runAichatCommandStreaming(args, {
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
            response: finalContent
          });

          yield {
            type: 'result',
            content: finalContent,
            metadata: {
              sessionName: session.sessionName,
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

  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
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

  killAllProcesses() {
    for (const [, proc] of this.activeProcesses.entries()) {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }
    this.activeProcesses.clear();
  }

  isSessionActive(sessionId) {
    return this.sessions.has(sessionId);
  }

  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }

  parseResponse(text) {
    return { text };
  }
}

module.exports = AichatAdapter;
