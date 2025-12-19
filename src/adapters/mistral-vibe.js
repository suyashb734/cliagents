/**
 * Mistral Vibe CLI Adapter
 *
 * Implements the AgentAdapter interface for Mistral Vibe CLI.
 * Vibe CLI is Mistral's open-source command-line coding assistant powered by Devstral.
 *
 * Install: Download from GitHub releases
 * Docs: https://github.com/mistralai/mistral-vibe
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class MistralVibeAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 300000,  // 5 minutes
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: 'devstral-small',  // Default to smaller model
      ...config
    });

    this.name = 'mistral-vibe';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Mistral Vibe uses Devstral models
    this.availableModels = [
      { id: 'devstral-small', name: 'Devstral Small 2', description: 'Fast, 68% SWE-bench, runs locally' },
      { id: 'devstral', name: 'Devstral 2', description: 'Full model, 72.2% SWE-bench, 123B params' },
      { id: 'codestral', name: 'Codestral', description: 'Mistral code model' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['vibe']);
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
      vibeSessionId: null,  // Will be set after first message for native resume
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { model: model || 'devstral-small', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: model || 'devstral-small'
    };
  }

  async *_runVibeCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;

    const vibePaths = [
      '/usr/local/bin/vibe',
      '/opt/homebrew/bin/vibe',
      `${process.env.HOME}/.local/bin/vibe`,
      `${process.env.HOME}/bin/vibe`,
      'vibe'
    ];

    let vibePath = 'vibe';
    for (const path of vibePaths) {
      if (path === 'vibe' || fs.existsSync(path)) {
        vibePath = path;
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

    console.log('[MistralVibeAdapter] Streaming:', vibePath, args.join(' '));

    const proc = spawn(vibePath, args, {
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
        yield { type: 'error', content: `Mistral Vibe exited with code ${exitCode}: ${stderrOutput}` };
        return;
      }

      // Parse streaming JSON to extract session ID and final content
      let vibeSessionId = null;
      let lastAssistantContent = '';
      const lines = fullOutput.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          // Extract session ID if present
          if (msg.session_id) {
            vibeSessionId = msg.session_id;
          }
          // Extract content from assistant messages
          if (msg.role === 'assistant' && msg.content) {
            lastAssistantContent = msg.content;
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }

      yield {
        type: 'result',
        content: lastAssistantContent || fullOutput.trim(),
        vibeSessionId,
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

    // Build prompt - add system prompt only for first message
    let fullPrompt = message;
    if (session.messageCount === 0 && session.systemPrompt) {
      fullPrompt = `${session.systemPrompt}\n\n${fullPrompt}`;
    }

    // Build args for Vibe CLI programmatic mode
    const args = ['-p', fullPrompt];

    // Use native --resume for session continuity (instead of manual history injection)
    // This preserves full agent state including tool calls and file edits
    if (session.vibeSessionId) {
      args.push('--resume', session.vibeSessionId);
    }

    // Output format - streaming JSON for real-time output
    args.push('--output', 'streaming');

    // Auto-approve all tool calls
    args.push('--auto-approve');

    // Max turns to prevent runaway
    args.push('--max-turns', '20');

    session.messageCount++;

    let finalContent = '';

    try {
      for await (const chunk of this._runVibeCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'chunk') {
          yield chunk;
        } else if (chunk.type === 'result') {
          finalContent = chunk.content;

          // Capture Vibe session ID for native resume (preserves full agent state)
          if (chunk.vibeSessionId) {
            session.vibeSessionId = chunk.vibeSessionId;
          }

          logConversation(sessionId, this.name, {
            prompt: message,
            response: finalContent
          });

          yield {
            type: 'result',
            content: finalContent,
            metadata: {
              model: session.model,
              vibeSessionId: session.vibeSessionId,
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
    const lowerText = text.toLowerCase();
    if (lowerText.includes('done') || lowerText.includes('complete')) {
      return { action: 'complete', result: text };
    }
    return { text };
  }
}

module.exports = MistralVibeAdapter;
