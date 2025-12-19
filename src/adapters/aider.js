/**
 * Aider CLI Adapter
 *
 * Implements the AgentAdapter interface for Aider CLI.
 * Aider is an AI pair programming tool that works with git.
 *
 * Install: pip install aider-chat
 * Docs: https://aider.chat/docs/
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class AiderAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 300000,  // 5 minutes - aider can take longer for complex tasks
      workDir: '/tmp/agent',
      autoCommits: false,  // Disable auto-commits by default for server use
      maxResponseSize: 10 * 1024 * 1024,
      model: 'sonnet',  // Default to Claude Sonnet
      ...config
    });

    this.name = 'aider';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Available models for Aider
    this.availableModels = [
      { id: 'sonnet', name: 'Claude Sonnet', description: 'Claude 3.7 Sonnet (default)' },
      { id: 'opus', name: 'Claude Opus', description: 'Most capable Claude model' },
      { id: 'haiku', name: 'Claude Haiku', description: 'Fast and affordable Claude' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast OpenAI model' },
      { id: 'o3-mini', name: 'o3-mini', description: 'OpenAI reasoning model' },
      { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek Chat V3' },
      { id: 'deepseek-r1', name: 'DeepSeek R1', description: 'DeepSeek reasoning model' }
    ];
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels;
  }

  /**
   * Check if Aider is available
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['aider']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Spawn a new Aider session
   * Note: Aider doesn't have native session resume, but maintains context in the git repo
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

    // Initialize git repo if not exists (aider requires git)
    const gitDir = `${workDir}/.git`;
    if (!fs.existsSync(gitDir)) {
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: workDir, stdio: 'ignore' });
        execSync('git config user.email "agent@local"', { cwd: workDir, stdio: 'ignore' });
        execSync('git config user.name "Agent"', { cwd: workDir, stdio: 'ignore' });
      } catch (e) {
        console.log('[AiderAdapter] Git init warning:', e.message);
      }
    }

    const session = {
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model,
      files: options.files || [],  // Files to include in context
      apiKey: options.apiKey  // Optional API key override
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { model: model || 'sonnet', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: model || 'sonnet'
    };
  }

  /**
   * Run Aider CLI with streaming output
   */
  async *_runAiderCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    // Try common installation paths
    const aiderPaths = [
      '/usr/local/bin/aider',
      '/opt/homebrew/bin/aider',
      `${process.env.HOME}/.local/bin/aider`,
      'aider'
    ];

    let aiderPath = 'aider';
    for (const path of aiderPaths) {
      if (path === 'aider' || fs.existsSync(path)) {
        aiderPath = path;
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

    // Add API keys from options if provided
    if (options.apiKey) {
      if (options.model?.includes('sonnet') || options.model?.includes('opus') || options.model?.includes('haiku')) {
        env.ANTHROPIC_API_KEY = options.apiKey;
      } else if (options.model?.includes('gpt') || options.model?.includes('o3')) {
        env.OPENAI_API_KEY = options.apiKey;
      } else if (options.model?.includes('deepseek')) {
        env.DEEPSEEK_API_KEY = options.apiKey;
      }
    }

    console.log('[AiderAdapter] Streaming:', aiderPath, args.join(' '));

    const proc = spawn(aiderPath, args, {
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

    // Collect stderr for error messages
    proc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    try {
      for await (const chunk of proc.stdout) {
        const text = chunk.toString();
        fullOutput += text;

        // Aider outputs progressively, emit chunks
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
        yield { type: 'error', content: `Aider exited with code ${exitCode}: ${stderrOutput}` };
        return;
      }

      // Aider outputs plain text, not JSON
      yield {
        type: 'result',
        content: fullOutput.trim(),
        stats: {
          // Aider doesn't provide token counts in CLI output
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

    // Build args for aider
    const args = [
      '--message', message,
      '--yes',  // Auto-confirm changes
      '--no-pretty'  // Disable formatting for easier parsing
    ];

    // Add model
    if (session.model && session.model !== 'default') {
      args.push('--model', session.model);
    }

    // Disable auto-commits if configured
    if (!this.config.autoCommits) {
      args.push('--no-auto-commits');
    }

    // Add files to context
    if (session.files && session.files.length > 0) {
      args.push(...session.files);
    }

    // Add system prompt as a message prefix if first message
    let fullMessage = message;
    if (session.messageCount === 0 && session.systemPrompt) {
      fullMessage = `${session.systemPrompt}\n\n${message}`;
      // Replace the message in args
      const msgIndex = args.indexOf('--message') + 1;
      args[msgIndex] = fullMessage;
    }

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runAiderCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir,
        model: session.model,
        apiKey: session.apiKey
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

  /**
   * Terminate a session
   */
  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
      console.log(`[AiderAdapter] Killing process for session ${sessionId}`);
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
    console.log(`[AiderAdapter] Killing ${this.activeProcesses.size} active processes`);
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
   * Parse Aider response
   */
  parseResponse(text) {
    const lowerText = text.toLowerCase();

    if (lowerText.includes('done') || lowerText.includes('complete') || lowerText.includes('finished')) {
      return { action: 'complete', result: text };
    }

    // Look for file changes
    const fileMatch = text.match(/(?:created?|modified?|updated?)\s+([^\s]+\.\w+)/i);
    if (fileMatch) {
      return { action: 'file_change', file: fileMatch[1], text };
    }

    return { text };
  }
}

module.exports = AiderAdapter;
