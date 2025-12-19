/**
 * GitHub Copilot CLI Adapter
 *
 * Implements the AgentAdapter interface for GitHub Copilot CLI.
 * The new Copilot CLI (2025) is a standalone coding agent.
 *
 * Install: npm install -g @github/copilot
 * Auth: copilot (then /login on first run)
 * Docs: https://github.com/github/copilot-cli
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

class GitHubCopilotAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 120000,  // 2 minutes
      workDir: '/tmp/agent',
      allowAllTools: true,  // Auto-approve actions
      maxResponseSize: 10 * 1024 * 1024,
      model: null,  // Use default model
      ...config
    });

    this.name = 'github-copilot';
    this.version = '2.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();

    // Available models for Copilot CLI
    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Default Copilot model (Claude Sonnet 4.5)' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: 'Anthropic Claude Sonnet 4' },
      { id: 'gpt-5', name: 'GPT-5', description: 'OpenAI GPT-5' }
    ];
  }

  /**
   * Get the path to the copilot CLI binary
   */
  _getCopilotPath() {
    if (this.config.copilotPath) {
      return this.config.copilotPath;
    }

    if (this._copilotPathCache) {
      return this._copilotPathCache;
    }

    try {
      const result = execSync('which copilot', { encoding: 'utf8', timeout: 5000 }).trim();
      if (result) {
        this._copilotPathCache = result;
        return result;
      }
    } catch (e) {
      // which failed, try common paths
    }

    const commonPaths = [
      '/usr/local/bin/copilot',
      '/opt/homebrew/bin/copilot',
      `${process.env.HOME}/.npm-global/bin/copilot`,
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        this._copilotPathCache = p;
        return p;
      }
    }

    return 'copilot';
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const copilotPath = this._getCopilotPath();
      const check = spawn(copilotPath, ['--version']);
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
      workDir,
      model: options.model || this.config.model
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    logSessionStart(sessionId, this.name, { workDir, model: session.model });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name
    };
  }

  async *_runCopilotCommandStreaming(prompt, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const copilotPath = this._getCopilotPath();

    // Build args for non-interactive mode
    const args = [
      '-p', prompt,              // Non-interactive prompt mode
      '--allow-all-tools',       // Auto-approve all actions
      '--allow-all-paths',       // Allow access to any path
    ];

    // Only add model if explicitly specified and not 'default'
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const env = {
      ...process.env,
      NO_COLOR: '1',
    };

    console.log('[GitHubCopilotAdapter] Streaming:', copilotPath, args.join(' '));

    const proc = spawn(copilotPath, args, {
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
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeout);

    proc.on('error', (err) => {
      processError = err;
    });

    proc.on('close', (code) => {
      exitCode = code;
      clearTimeout(timeoutId);
      if (sessionId) {
        this.activeProcesses.delete(sessionId);
      }
    });

    // Handle stdout chunks
    for await (const chunk of proc.stdout) {
      const text = chunk.toString();
      fullOutput += text;
      yield { type: 'text', content: text };
    }

    // Collect stderr
    for await (const chunk of proc.stderr) {
      stderrOutput += chunk.toString();
    }

    // Wait for process to close
    await new Promise((resolve) => {
      if (exitCode !== null) resolve();
      else proc.on('close', resolve);
    });

    if (timedOut) {
      throw new Error('Request timed out');
    }

    if (processError) {
      throw processError;
    }

    if (exitCode !== 0 && exitCode !== null) {
      const errorMsg = stderrOutput || fullOutput || `Exit code ${exitCode}`;
      throw new Error(`Copilot exited with code ${exitCode}: ${errorMsg}`);
    }
  }

  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.messageCount++;
    let fullResult = '';

    for await (const chunk of this._runCopilotCommandStreaming(message, {
      ...options,
      sessionId,
      workDir: session.workDir,
      model: options.model || session.model
    })) {
      if (chunk.type === 'text') {
        fullResult += chunk.content;
      }
      yield chunk;
    }

    logConversation(sessionId, this.name, {
      role: 'user',
      content: message
    });
    logConversation(sessionId, this.name, {
      role: 'assistant',
      content: fullResult
    });

    yield {
      type: 'result',
      result: fullResult.trim(),
      sessionId,
      messageCount: session.messageCount
    };
  }

  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { sessionId, status: 'not_found' };
    }

    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    return { sessionId, status: 'terminated' };
  }

  async interrupt(sessionId) {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill('SIGINT');
      return { sessionId, status: 'interrupted' };
    }
    return { sessionId, status: 'no_active_process' };
  }

  getStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 'not_found' };
    }

    const isRunning = this.activeProcesses.has(sessionId);
    return {
      status: isRunning ? 'running' : 'stable',
      messageCount: session.messageCount,
      workDir: session.workDir,
      model: session.model
    };
  }
}

module.exports = GitHubCopilotAdapter;
