/**
 * Qwen CLI Adapter
 *
 * Implements the AgentAdapter interface for Qwen Code CLI.
 * Uses spawn-per-message with session resume (-r <session_id>) for persistence.
 *
 * Install: npm i -g @qwen-code/qwen-code
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { createAdapterContract, defineAdapterCapabilities, EXECUTION_MODES } = require('./contract');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

const SAFE_ALLOWED_TOOL_PATTERN = /^[a-zA-Z0-9_-]+$/;
const QWEN_PATH_NOT_FOUND = Symbol('qwen_path_not_found');

function classifyQwenProviderFailure(content = '') {
  const text = String(content || '').trim();
  const normalized = text.toLowerCase();

  if (!text) {
    return null;
  }

  if (
    normalized.includes('invalid access token')
    || normalized.includes('token expired')
    || normalized.includes('authentication failed')
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
    || normalized.includes('no active subscription')
  ) {
    return {
      failureClass: 'auth',
      message: `Qwen provider authentication failed: ${text}`
    };
  }

  if (
    normalized.includes('quota')
    || normalized.includes('rate limit')
    || normalized.includes('resourceexhausted')
    || normalized.includes('capacity')
    || normalized.includes('overloaded')
  ) {
    return {
      failureClass: 'rate_limit',
      message: `Qwen provider rate limit or capacity failure: ${text}`
    };
  }

  return null;
}

function validateAllowedTools(allowedTools) {
  if (!Array.isArray(allowedTools)) {
    return null;
  }

  const normalized = [];
  for (const tool of allowedTools) {
    const value = String(tool || '').trim();
    if (!value) {
      continue;
    }
    if (!SAFE_ALLOWED_TOOL_PATTERN.test(value)) {
      throw new Error(`Invalid tool name: ${tool}`);
    }
    normalized.push(value);
  }

  return normalized.length > 0 ? normalized : null;
}

class QwenCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: null,
      ...config
    });

    this.name = 'qwen-cli';
    this.version = '1.0.0';
    this.sessions = new Map(); // sessionId -> { qwenSessionId, ... }
    this.activeProcesses = new Map();
    this._qwenPathCache = undefined;
    this._qwenPathResolvePromise = null;
    this.capabilities = defineAdapterCapabilities({
      usesOfficialCli: true,
      executionMode: EXECUTION_MODES.DIRECT_SESSION,
      supportsMultiTurn: true,
      supportsResume: true,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsSystemPrompt: true,
      supportsAllowedTools: true,
      supportsModelSelection: true,
      supportsTools: true,
      supportsFilesystemRead: true,
      supportsFilesystemWrite: true
    });
    this.contract = createAdapterContract({
      capabilities: this.capabilities,
      readiness: {
        initTimeoutMs: 60000
      },
      notes: [
        'Spawn-per-message adapter that resumes Qwen sessions via the provider session ID.',
        'Current adapter always uses stream-json output and does not yet expose a separate structured JSON-only mode.'
      ]
    });

    this.availableModels = [
      { id: 'default', name: 'Default', description: 'Qwen CLI default model' },
      { id: 'qwen-max', name: 'Qwen Max', description: 'High-capability Qwen model' },
      { id: 'qwen-plus', name: 'Qwen Plus', description: 'Balanced latency and quality' }
    ];
  }

  getAvailableModels() {
    return this.availableModels;
  }

  getCapabilities() {
    return this.capabilities;
  }

  getContract() {
    return this.contract;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      let check = null;
      try {
        check = this._spawnProcess('which', ['qwen']);
      } catch {
        resolve(false);
        return;
      }
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  _spawnProcess(command, args, options = {}) {
    return spawn(command, args, options);
  }

  async _getQwenPath() {
    if (this._qwenPathCache !== undefined) {
      return this._qwenPathCache === QWEN_PATH_NOT_FOUND ? null : this._qwenPathCache;
    }
    if (this._qwenPathResolvePromise) {
      return this._qwenPathResolvePromise;
    }

    this._qwenPathResolvePromise = new Promise((resolve) => {
      let check = null;
      try {
        check = this._spawnProcess('which', ['qwen']);
      } catch {
        this._qwenPathCache = QWEN_PATH_NOT_FOUND;
        this._qwenPathResolvePromise = null;
        resolve(null);
        return;
      }
      let resolvedPath = null;
      check.stdout.on('data', (data) => {
        resolvedPath = data.toString().trim();
      });
      check.on('close', (code) => {
        this._qwenPathCache = code === 0 ? (resolvedPath || null) : QWEN_PATH_NOT_FOUND;
        this._qwenPathResolvePromise = null;
        resolve(this._qwenPathCache === QWEN_PATH_NOT_FOUND ? null : this._qwenPathCache);
      });
      check.on('error', () => {
        this._qwenPathCache = QWEN_PATH_NOT_FOUND;
        this._qwenPathResolvePromise = null;
        resolve(null);
      });
    });

    const result = await this._qwenPathResolvePromise;

    if (result === null && this._qwenPathCache !== QWEN_PATH_NOT_FOUND) {
      const available = await this.isAvailable();
      if (available) {
        this._qwenPathCache = 'qwen';
        return this._qwenPathCache;
      }
    }

    return result;
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
      qwenSessionId: null,
      ready: true,
      messageCount: 0,
      systemPrompt: options.systemPrompt,
      workDir,
      model,
      allowedTools: options.allowedTools,
      jsonMode: options.jsonMode || false
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });
    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      qwenSessionId: null,
      model: model || 'default'
    };
  }

  async *_runQwenCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const workDir = options.workDir || process.cwd();
    const qwenPath = await this._getQwenPath();

    if (!qwenPath) {
      yield { type: 'error', content: 'Qwen CLI not found in PATH' };
      return;
    }

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const proc = spawn(qwenPath, args, {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: '1'
      },
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
      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        processError = error;
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
    });

    let buffer = '';
    let qwenSessionId = null;
    let assistantMessages = [];
    let usageStats = null;
    let finalResult = null;
    const handleEvent = (event) => {
      if (!event) return;

      if (Array.isArray(event)) {
        for (const item of event) handleEvent(item);
        return;
      }

      if (typeof event !== 'object') {
        return;
      }

      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        qwenSessionId = event.session_id;
      }

      if (event.type === 'assistant') {
        const content = event.message?.content;
        const parts = Array.isArray(content) ? content : [];
        const textParts = parts
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .filter(Boolean);

        if (textParts.length > 0) {
          const text = textParts.join('\n');
          assistantMessages.push(text);
        }

        const usage = event.message?.usage;
        if (usage) {
          usageStats = {
            input_tokens: usage.input_tokens ?? usage.inputTokens ?? usageStats?.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? usage.outputTokens ?? usageStats?.output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? usage.totalTokens ?? usageStats?.total_tokens ?? 0
          };
        }
      }

      if (event.type === 'result') {
        if (typeof event.result === 'string') {
          finalResult = event.result;
        } else if (event.result != null && finalResult == null) {
          // Keep a string representation if result is non-string structured content.
          finalResult = JSON.stringify(event.result);
        }
        usageStats = event.usage || usageStats;
        if (event.session_id) {
          qwenSessionId = event.session_id;
        }
      }
    };

    try {
      for await (const chunk of proc.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          const beforeCount = assistantMessages.length;
          handleEvent(event);
          if (assistantMessages.length > beforeCount) {
            const text = assistantMessages[assistantMessages.length - 1];
            yield {
              type: 'progress',
              progressType: 'assistant',
              content: text
            };
          }
        }
      }

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          const beforeCount = assistantMessages.length;
          handleEvent(event);
          if (assistantMessages.length > beforeCount) {
            const text = assistantMessages[assistantMessages.length - 1];
            yield {
              type: 'progress',
              progressType: 'assistant',
              content: text
            };
          }
        } catch {}
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
      if (exitCode !== 0) {
        yield { type: 'error', content: `Qwen CLI exited with code ${exitCode}` };
        return;
      }

      const content = String(finalResult || assistantMessages.join('\n') || '').trim();
      const providerFailure = classifyQwenProviderFailure(content);
      if (providerFailure) {
        yield {
          type: 'error',
          content: providerFailure.message,
          timedOut: false,
          failureClass: providerFailure.failureClass
        };
        return;
      }

      yield {
        type: 'result',
        content,
        sessionId: qwenSessionId,
        stats: {
          inputTokens: usageStats?.input_tokens || 0,
          outputTokens: usageStats?.output_tokens || 0,
          totalTokens: usageStats?.total_tokens || 0
        }
      };
    } catch (error) {
      clearTimeout(timeoutId);
      yield { type: 'error', content: error.message, timedOut: false };
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

    let fullPrompt = message;
    if (!session.qwenSessionId && session.systemPrompt) {
      fullPrompt = `${session.systemPrompt}\n\n${fullPrompt}`;
    }

    const args = [];
    if (session.model && session.model !== 'default') {
      args.push('-m', session.model);
    }

    if (session.qwenSessionId) {
      args.push('-r', session.qwenSessionId);
    }

    args.push('-p', fullPrompt, '-o', 'stream-json', '-y');

    const allowedTools = validateAllowedTools(options.allowedTools || session.allowedTools);
    if (allowedTools) {
      for (const tool of allowedTools) {
        args.push('--allowed-tools', tool);
      }
    }

    session.messageCount += 1;

    try {
      for await (const chunk of this._runQwenCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'progress') {
          yield chunk;
          continue;
        }

        if (chunk.type === 'result') {
          const providerFailure = classifyQwenProviderFailure(chunk.content);
          if (providerFailure) {
            logConversation(sessionId, this.name, {
              prompt: message,
              error: providerFailure.message
            });
            yield {
              type: 'error',
              content: providerFailure.message,
              timedOut: false,
              failureClass: providerFailure.failureClass
            };
            continue;
          }

          if (chunk.sessionId) {
            session.qwenSessionId = chunk.sessionId;
          }

          logConversation(sessionId, this.name, {
            prompt: message,
            response: chunk.content,
            stats: chunk.stats
          });

          yield {
            type: 'result',
            content: chunk.content,
            metadata: {
              inputTokens: chunk.stats?.inputTokens,
              outputTokens: chunk.stats?.outputTokens,
              totalTokens: chunk.stats?.totalTokens,
              timedOut: false
            }
          };
          continue;
        }

        if (chunk.type === 'error') {
          logConversation(sessionId, this.name, {
            prompt: message,
            error: chunk.content
          });
          yield {
            type: 'error',
            content: chunk.content,
            timedOut: chunk.timedOut,
            failureClass: chunk.failureClass || this.classifyFailure(chunk.content)
          };
        }
      }
    } catch (error) {
      logConversation(sessionId, this.name, {
        prompt: message,
        error: error.message
      });
      yield { type: 'error', content: error.message };
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
    this._clearHeartbeat(sessionId);
    this.emit('terminated', { sessionId });
  }

  killAllProcesses() {
    for (const proc of this.activeProcesses.values()) {
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

module.exports = QwenCliAdapter;
