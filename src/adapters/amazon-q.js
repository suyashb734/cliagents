/**
 * Amazon Q Developer CLI Adapter
 *
 * Implements the AgentAdapter interface for Amazon Q Developer CLI.
 * Amazon Q is AWS's AI-powered coding assistant.
 *
 * Install: AWS CLI with Q Developer plugin, or Kiro CLI
 * Docs: https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class AmazonQAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,  // 3 minutes
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      ...config
    });

    this.name = 'amazon-q';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Amazon Q uses Claude 3.7 Sonnet under the hood
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Amazon Q Developer default (Claude 3.7 Sonnet)' }
    ];
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels;
  }

  /**
   * Check if Amazon Q CLI is available
   * Checks for both 'q' (older) and 'kiro' (newer) CLI
   */
  async isAvailable() {
    return new Promise((resolve) => {
      // Try 'q' first (Amazon Q Developer CLI)
      const checkQ = spawn('which', ['q']);
      checkQ.on('close', (code) => {
        if (code === 0) {
          this.cliCommand = 'q';
          resolve(true);
          return;
        }
        // Try 'kiro' (newer Kiro CLI)
        const checkKiro = spawn('which', ['kiro']);
        checkKiro.on('close', (kiroCode) => {
          if (kiroCode === 0) {
            this.cliCommand = 'kiro';
            resolve(true);
          } else {
            resolve(false);
          }
        });
        checkKiro.on('error', () => resolve(false));
      });
      checkQ.on('error', () => {
        const checkKiro = spawn('which', ['kiro']);
        checkKiro.on('close', (kiroCode) => resolve(kiroCode === 0));
        checkKiro.on('error', () => resolve(false));
      });
    });
  }

  /**
   * Spawn a new Amazon Q session
   */
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
      systemPrompt: options.systemPrompt,
      workDir,
      conversationHistory: []  // Amazon Q may need manual history management
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: 'amazon-q'
    };
  }

  /**
   * Run Amazon Q CLI with streaming output
   */
  async *_runQCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const cliCommand = this.cliCommand || 'q';

    const cliPaths = [
      `/usr/local/bin/${cliCommand}`,
      `/opt/homebrew/bin/${cliCommand}`,
      `${process.env.HOME}/.local/bin/${cliCommand}`,
      cliCommand
    ];

    let cliPath = cliCommand;
    for (const path of cliPaths) {
      if (path === cliCommand || fs.existsSync(path)) {
        cliPath = path;
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

    console.log('[AmazonQAdapter] Streaming:', cliPath, args.join(' '));

    const proc = spawn(cliPath, args, {
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
        yield { type: 'error', content: `Amazon Q exited with code ${exitCode}: ${stderrOutput}` };
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

    // Build args for Amazon Q
    // q chat --message "..." or q dev --message "..."
    const args = [
      'chat',  // Use chat subcommand
      '--message', message
    ];

    // Add system prompt context if first message
    let fullMessage = message;
    if (session.messageCount === 0 && session.systemPrompt) {
      fullMessage = `Context: ${session.systemPrompt}\n\nQuestion: ${message}`;
      args[2] = fullMessage;
    }

    session.messageCount++;
    session.conversationHistory.push({ role: 'user', content: message });

    let finalContent = '';

    try {
      for await (const chunk of this._runQCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'chunk') {
          yield chunk;
        } else if (chunk.type === 'result') {
          finalContent = chunk.content;
          session.conversationHistory.push({ role: 'assistant', content: finalContent });

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

  /**
   * Terminate a session
   */
  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
      console.log(`[AmazonQAdapter] Killing process for session ${sessionId}`);
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
    console.log(`[AmazonQAdapter] Killing ${this.activeProcesses.size} active processes`);
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
    if (lowerText.includes('complete') || lowerText.includes('done')) {
      return { action: 'complete', result: text };
    }
    return { text };
  }
}

module.exports = AmazonQAdapter;
