/**
 * Plandex CLI Adapter
 *
 * Implements the AgentAdapter interface for Plandex CLI.
 * Plandex is designed for large projects with up to 2M tokens of context.
 *
 * Install: curl -sL https://plandex.ai/install.sh | bash
 * Docs: https://github.com/plandex-ai/plandex
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class PlandexAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 600000,  // 10 minutes - plandex handles large tasks
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: null,  // Uses OpenRouter or configured provider
      autoConfirm: true,  // Auto-confirm changes
      ...config
    });

    this.name = 'plandex';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Plandex supports various models via OpenRouter
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses Plandex default configuration' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o via OpenRouter' },
      { id: 'openai/o3-mini', name: 'o3-mini', description: 'OpenAI o3-mini reasoning model' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic Claude' },
      { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', description: 'Most capable Claude' },
      { id: 'google/gemini-pro', name: 'Gemini Pro', description: 'Google Gemini' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['plandex']);
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

    // Plandex uses plan names for sessions
    const planName = `plan-${sessionId.slice(0, 8)}`;

    const session = {
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model,
      planName,
      initialized: false
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { model: model || 'default', workDir, planName });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: model || 'default',
      planName
    };
  }

  async *_runPlandexCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    const plandexPaths = [
      '/usr/local/bin/plandex',
      `${process.env.HOME}/.local/bin/plandex`,
      `${process.env.HOME}/bin/plandex`,
      'plandex'
    ];

    let plandexPath = 'plandex';
    for (const path of plandexPaths) {
      if (path === 'plandex' || fs.existsSync(path)) {
        plandexPath = path;
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
      PLANDEX_SKIP_UPGRADE_CHECK: '1'
    };

    console.log('[PlandexAdapter] Streaming:', plandexPath, args.join(' '));

    const proc = spawn(plandexPath, args, {
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
        yield { type: 'error', content: `Plandex exited with code ${exitCode}: ${stderrOutput}` };
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

    // Initialize plan if first message
    if (!session.initialized) {
      // Create new plan
      const initArgs = ['new', session.planName];
      if (session.model && session.model !== 'default') {
        initArgs.push('--model', session.model);
      }

      try {
        for await (const chunk of this._runPlandexCommandStreaming(initArgs, {
          timeout: 30000,
          sessionId,
          workDir: session.workDir
        })) {
          // Just consume init output
        }
        session.initialized = true;
      } catch (e) {
        console.log('[PlandexAdapter] Plan init warning:', e.message);
        session.initialized = true;  // Continue anyway
      }
    }

    // Build args for plandex tell command
    const args = ['tell', message];

    // Add no-confirm flag if configured
    if (this.config.autoConfirm) {
      args.push('--no-confirm');
    }

    // Add system prompt context if first message
    if (session.messageCount === 0 && session.systemPrompt) {
      args[1] = `${session.systemPrompt}\n\n${message}`;
    }

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runPlandexCommandStreaming(args, {
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
              planName: session.planName,
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
      console.log(`[PlandexAdapter] Killing process for session ${sessionId}`);
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
    const lowerText = text.toLowerCase();
    if (lowerText.includes('plan complete') || lowerText.includes('applied')) {
      return { action: 'complete', result: text };
    }
    return { text };
  }
}

module.exports = PlandexAdapter;
