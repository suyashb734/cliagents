/**
 * GitHub Copilot CLI Adapter
 *
 * Implements the AgentAdapter interface for GitHub Copilot CLI.
 * Copilot CLI is a GitHub CLI extension that provides AI assistance.
 *
 * Install: gh extension install github/gh-copilot
 * Auth: gh auth login (GitHub OAuth)
 * Docs: https://github.com/features/copilot/cli
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class GitHubCopilotAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 120000,  // 2 minutes
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      ...config
    });

    this.name = 'github-copilot';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // GitHub Copilot CLI uses one model
    this.availableModels = [
      { id: 'default', name: 'Copilot', description: 'GitHub Copilot model' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      // Check if gh CLI is installed and copilot extension is available
      const check = spawn('gh', ['copilot', '--version']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || this.config.workDir;

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const session = {
      ready: true,
      messageCount: 0,
      workDir
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name
    };
  }

  async *_runCopilotCommandStreaming(subcommand, args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    // gh copilot has subcommands: suggest, explain
    const fullArgs = ['copilot', subcommand, ...args];

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const env = {
      ...process.env,
      NO_COLOR: '1',
      GH_PROMPT: 'disable'  // Disable interactive prompts
    };

    console.log('[GitHubCopilotAdapter] Streaming: gh', fullArgs.join(' '));

    const proc = spawn('gh', fullArgs, {
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
        yield { type: 'error', content: `gh copilot exited with code ${exitCode}: ${stderrOutput}` };
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

    // Determine which subcommand to use based on message
    // gh copilot suggest - for command suggestions
    // gh copilot explain - for explanations
    let subcommand = 'suggest';
    let args = [];

    const lowerMessage = message.toLowerCase();
    if (lowerMessage.startsWith('explain ') || lowerMessage.includes('what does') || lowerMessage.includes('how does')) {
      subcommand = 'explain';
      args = [message.replace(/^explain\s+/i, '')];
    } else {
      subcommand = 'suggest';
      args = ['-t', 'shell', message];  // Default to shell suggestions
    }

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runCopilotCommandStreaming(subcommand, args, {
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
              subcommand,
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

module.exports = GitHubCopilotAdapter;
