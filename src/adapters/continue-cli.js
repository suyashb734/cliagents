/**
 * Continue CLI Adapter
 *
 * Implements the AgentAdapter interface for Continue CLI.
 * Continue CLI is an async coding agent that runs in your terminal.
 *
 * Install: npm i -g @continuedev/cli
 * Docs: https://github.com/continuedev/continue
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class ContinueCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 300000,  // 5 minutes
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: null,  // Uses Continue's configured model
      ...config
    });

    this.name = 'continue-cli';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Continue supports multiple model providers
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses Continue default configuration' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o' },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic Claude' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google Gemini' },
      { id: 'ollama/llama3', name: 'Llama 3 (Ollama)', description: 'Local Llama via Ollama' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['cn']);
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

    const session = {
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model
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

  async *_runContinueCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    const cnPaths = [
      '/usr/local/bin/cn',
      '/opt/homebrew/bin/cn',
      `${process.env.HOME}/.npm-global/bin/cn`,
      'cn'
    ];

    let cnPath = 'cn';
    for (const path of cnPaths) {
      if (path === 'cn' || fs.existsSync(path)) {
        cnPath = path;
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

    console.log('[ContinueAdapter] Streaming:', cnPath, args.join(' '));

    const proc = spawn(cnPath, args, {
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
        yield { type: 'error', content: `Continue CLI exited with code ${exitCode}: ${stderrOutput}` };
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

    // Build args for Continue CLI
    // cn --headless --prompt "..."
    const args = [
      '--headless',  // Non-interactive mode
      '--prompt', message
    ];

    // Add model if specified
    if (session.model && session.model !== 'default') {
      args.push('--model', session.model);
    }

    // Add system prompt as context
    if (session.messageCount === 0 && session.systemPrompt) {
      args[3] = `${session.systemPrompt}\n\n${message}`;
    }

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runContinueCommandStreaming(args, {
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

module.exports = ContinueCliAdapter;
