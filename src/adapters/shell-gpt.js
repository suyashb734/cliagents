/**
 * Shell-GPT CLI Adapter
 *
 * Implements the AgentAdapter interface for Shell-GPT (sgpt).
 * Shell-GPT is a command-line tool for generating shell commands and code.
 *
 * NOTE: Shell-GPT is stateless - uses SessionWrapper for conversation context.
 *
 * Install: pip install shell-gpt
 * Docs: https://github.com/TheR1D/shell_gpt
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const SessionWrapper = require('../utils/session-wrapper');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class ShellGptAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 120000,  // 2 minutes
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      shellMode: false,  // Generate shell commands
      executeMode: false,  // Execute generated commands
      ...config
    });

    this.name = 'shell-gpt';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();
    this.sessionWrapper = new SessionWrapper({ maxHistory: 5 });  // Limited history for shell-gpt

    // Shell-GPT uses OpenAI models by default
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Uses Shell-GPT default (gpt-4)' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'Fast legacy model' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['sgpt']);
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

    // Create wrapped session for context management
    this.sessionWrapper.createSession(sessionId, {
      systemPrompt: options.systemPrompt
    });

    const session = {
      ready: true,
      messageCount: 0,
      workDir,
      model,
      shellMode: options.shellMode || this.config.shellMode,
      executeMode: options.executeMode || this.config.executeMode
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

  async *_runSgptCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    const sgptPaths = [
      '/usr/local/bin/sgpt',
      '/opt/homebrew/bin/sgpt',
      `${process.env.HOME}/.local/bin/sgpt`,
      'sgpt'
    ];

    let sgptPath = 'sgpt';
    for (const path of sgptPaths) {
      if (path === 'sgpt' || fs.existsSync(path)) {
        sgptPath = path;
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

    console.log('[ShellGptAdapter] Streaming:', sgptPath, args.join(' '));

    const proc = spawn(sgptPath, args, {
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
        yield { type: 'error', content: `Shell-GPT exited with code ${exitCode}: ${stderrOutput}` };
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

    // Build prompt with context from session wrapper
    // Use minimal context since shell-gpt is meant for quick queries
    const contextMessage = this.sessionWrapper.buildMinimalContext(sessionId, message);

    // Build args for sgpt
    const args = [contextMessage];

    // Add model if specified
    if (session.model && session.model !== 'default') {
      args.unshift('--model', session.model);
    }

    // Shell mode - generate shell commands
    if (session.shellMode || options.shellMode) {
      args.push('--shell');
    }

    // Execute mode - run generated commands
    if (session.executeMode || options.executeMode) {
      args.push('--execute');
    }

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runSgptCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'chunk') {
          yield chunk;
        } else if (chunk.type === 'result') {
          finalContent = chunk.content;

          // Add to session wrapper history
          this.sessionWrapper.addTurn(sessionId, message, finalContent);

          logConversation(sessionId, this.name, {
            prompt: message,
            response: finalContent
          });

          yield {
            type: 'result',
            content: finalContent,
            metadata: {
              shellMode: session.shellMode,
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

    // Clean up session wrapper
    this.sessionWrapper.terminateSession(sessionId);

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
    // Shell-GPT often returns shell commands
    const shellMatch = text.match(/^[a-z][\w-]*\s/);
    if (shellMatch) {
      return { action: 'shell_command', command: text.trim() };
    }
    return { text };
  }
}

module.exports = ShellGptAdapter;
