/**
 * OpenCode CLI Adapter
 *
 * Implements the AgentAdapter interface for OpenCode CLI.
 * Uses `opencode run --format json` with `--session` for persistence.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BaseLLMAdapter = require('../core/base-llm-adapter');
const { createAdapterContract, defineAdapterCapabilities, EXECUTION_MODES } = require('./contract');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_COMMAND_TIMEOUT_MS = 10000;
const SAFE_ALLOWED_TOOL_PATTERN = /^[a-zA-Z0-9_-]+$/;

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function parseOpencodeModelLines(output) {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .filter((line) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@-]+$/.test(line))
    .map((id) => ({
      id,
      name: id,
      description: 'OpenCode-discovered model'
    }));
}

function parseOpencodeProviderLines(output) {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .filter((line) => line.startsWith('● '))
    .map((line) => line.replace(/^●\s+/, ''))
    .map((line) => {
      const [namePart, detailPart] = line.split(/\s{2,}/, 2);
      return {
        name: namePart || line,
        detail: detailPart || null
      };
    });
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

class OpencodeCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 180000,
      workDir: '/tmp/agent',
      maxResponseSize: 10 * 1024 * 1024,
      model: null,
      ...config
    });

    this.name = 'opencode-cli';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();
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
        initTimeoutMs: 45000
      },
      notes: [
        'Spawn-per-message adapter that resumes OpenCode sessions via --session.',
        'Uses newline-delimited JSON events from `opencode run --format json`.'
      ]
    });

    this.availableModels = [
      { id: 'default', name: 'Default', description: 'OpenCode configured default model' }
    ];
    this._discoveredModelsCache = null;
    this._discoveredModelsCacheAt = 0;
    this._discoveredModelsRefreshPromise = null;
    this._providersCache = null;
    this._providersCacheAt = 0;
    this._providersRefreshPromise = null;
  }

  getAvailableModels() {
    return this._discoverAvailableModels();
  }

  getCapabilities() {
    return this.capabilities;
  }

  getContract() {
    return this.contract;
  }

  _appendHistory(session, role, content) {
    if (!content) {
      return;
    }

    if (!Array.isArray(session.history)) {
      session.history = [];
    }

    session.history.push({ role, content: String(content).trim() });

    const maxEntries = 24;
    if (session.history.length > maxEntries) {
      session.history = session.history.slice(-maxEntries);
    }
  }

  _buildPrompt(session, message) {
    const sections = [];

    if (session.systemPrompt) {
      sections.push(session.systemPrompt);
    }

    if (Array.isArray(session.history) && session.history.length > 0) {
      const transcript = session.history
        .slice(-12)
        .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`)
        .join('\n\n');

      sections.push(`Conversation so far:\n${transcript}`);
      sections.push(`Current user message:\n${message}`);
      return sections.join('\n\n');
    }

    sections.push(message);
    return sections.join('\n\n');
  }

  _getOpencodePath() {
    if (this.config.opencodePath) {
      return this.config.opencodePath;
    }

    if (this._opencodePathCache) {
      return this._opencodePathCache;
    }

    const commonPaths = [
      path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
      '/usr/bin/opencode'
    ];

    for (const candidate of commonPaths) {
      if (candidate && fs.existsSync(candidate)) {
        this._opencodePathCache = candidate;
        return candidate;
      }
    }

    return 'opencode';
  }

  _spawnProcess(command, args, options = {}) {
    return spawn(command, args, options);
  }

  _mergeAvailableModels(discovered = []) {
    const combined = [
      ...this.availableModels,
      ...discovered
    ];

    const deduped = [];
    const seen = new Set();
    for (const model of combined) {
      const id = String(model?.id || '').trim();
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      deduped.push(model);
    }

    return deduped;
  }

  _refreshAvailableModels() {
    if (this._discoveredModelsRefreshPromise) {
      return this._discoveredModelsRefreshPromise;
    }

    const opencodePath = this._getOpencodePath();
    this._discoveredModelsRefreshPromise = new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      let timeoutId = null;

      const finish = (discovered, successful) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (successful || !this._discoveredModelsCache) {
          this._discoveredModelsCache = this._mergeAvailableModels(discovered);
        }
        this._discoveredModelsCacheAt = Date.now();
        this._discoveredModelsRefreshPromise = null;
        resolve(this._discoveredModelsCache || this.availableModels);
      };

      try {
        const proc = this._spawnProcess(opencodePath, ['models'], {
          env: {
            ...process.env,
            NO_COLOR: '1'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        timeoutId = setTimeout(() => {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGKILL');
            }
          }, 1000);
          finish([], false);
        }, DISCOVERY_COMMAND_TIMEOUT_MS);

        proc.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        proc.on('error', () => finish([], false));
        proc.on('close', (code) => {
          if (code !== 0) {
            finish([], false);
            return;
          }
          try {
            finish(parseOpencodeModelLines(stdout), true);
          } catch {
            finish([], false);
          }
        });
      } catch {
        finish([], false);
      }
    });

    return this._discoveredModelsRefreshPromise;
  }

  _discoverAvailableModels() {
    const now = Date.now();
    if (this._discoveredModelsCache && now - this._discoveredModelsCacheAt < DISCOVERY_CACHE_TTL_MS) {
      return this._discoveredModelsCache;
    }

    void this._refreshAvailableModels().catch(() => {});
    return this._discoveredModelsCache || this.availableModels;
  }

  _refreshProviderSummary() {
    if (this._providersRefreshPromise) {
      return this._providersRefreshPromise;
    }

    const opencodePath = this._getOpencodePath();
    this._providersRefreshPromise = new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      let timeoutId = null;

      const finish = (providers, successful) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (successful || !this._providersCache) {
          this._providersCache = providers;
        }
        this._providersCacheAt = Date.now();
        this._providersRefreshPromise = null;
        resolve(this._providersCache || []);
      };

      try {
        const proc = this._spawnProcess(opencodePath, ['providers', 'list'], {
          env: {
            ...process.env,
            NO_COLOR: '1'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        timeoutId = setTimeout(() => {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGKILL');
            }
          }, 1000);
          finish([], false);
        }, DISCOVERY_COMMAND_TIMEOUT_MS);

        proc.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        proc.on('error', () => finish([], false));
        proc.on('close', (code) => {
          if (code !== 0) {
            finish([], false);
            return;
          }
          try {
            finish(parseOpencodeProviderLines(stdout), true);
          } catch {
            finish([], false);
          }
        });
      } catch {
        finish([], false);
      }
    });

    return this._providersRefreshPromise;
  }

  getProviderSummary() {
    const now = Date.now();
    if (this._providersCache && now - this._providersCacheAt < DISCOVERY_CACHE_TTL_MS) {
      return this._providersCache;
    }

    void this._refreshProviderSummary().catch(() => {});
    return this._providersCache || [];
  }

  async isAvailable() {
    return new Promise((resolve) => {
      let check = null;
      try {
        check = this._spawnProcess('which', ['opencode']);
      } catch {
        resolve(false);
        return;
      }
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
      opencodeSessionId: null,
      ready: true,
      messageCount: 0,
      history: [],
      systemPrompt: options.systemPrompt || null,
      workDir,
      model,
      agent: options.agent || null
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });
    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      opencodeSessionId: null,
      model: model || 'default'
    };
  }

  async *_runOpencodeCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const workDir = options.workDir || process.cwd();
    const opencodePath = this._getOpencodePath();

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    const proc = this._spawnProcess(opencodePath, args, {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const sessionId = options.sessionId;
    if (sessionId) {
      this.activeProcesses.set(sessionId, proc);
    }

    let timedOut = false;
    let exitCode = null;
    let processError = null;
    let stderrBuffer = '';
    let buffer = '';
    let opencodeSessionId = null;
    let assistantText = '';
    let usageStats = null;
    let eventError = null;

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

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    try {
      for await (const chunk of proc.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let event = null;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (event.sessionID) {
            opencodeSessionId = event.sessionID;
          }

          if (event.type === 'text') {
            const text = event.part?.text || event.text || '';
            if (text) {
              assistantText += text;
              yield {
                type: 'progress',
                progressType: 'assistant',
                content: text
              };
            }
          } else if (event.type === 'step_finish') {
            usageStats = event.part?.tokens || usageStats;
          } else if (event.type === 'error') {
            eventError = event.error?.message || event.message || JSON.stringify(event);
          }
        }
      }

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          if (event.sessionID) {
            opencodeSessionId = event.sessionID;
          }
          if (event.type === 'text') {
            const text = event.part?.text || event.text || '';
            if (text) {
              assistantText += text;
            }
          } else if (event.type === 'step_finish') {
            usageStats = event.part?.tokens || usageStats;
          } else if (event.type === 'error') {
            eventError = event.error?.message || event.message || JSON.stringify(event);
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
      if (eventError) {
        yield { type: 'error', content: eventError };
        return;
      }
      if (exitCode !== 0) {
        const stderrSummary = stderrBuffer.trim();
        yield {
          type: 'error',
          content: stderrSummary
            ? `OpenCode CLI exited with code ${exitCode}: ${stderrSummary}`
            : `OpenCode CLI exited with code ${exitCode}`
        };
        return;
      }

      yield {
        type: 'result',
        content: assistantText.trim(),
        sessionId: opencodeSessionId,
        stats: {
          inputTokens: usageStats?.input || 0,
          outputTokens: usageStats?.output || 0,
          totalTokens: usageStats?.total || 0,
          reasoningTokens: usageStats?.reasoning || 0
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

    const fullPrompt = this._buildPrompt(session, message);
    const allowedTools = validateAllowedTools(options.allowedTools);

    const args = ['run'];
    if (session.model && session.model !== 'default') {
      args.push('--model', session.model);
    }
    if (session.opencodeSessionId) {
      args.push('--session', session.opencodeSessionId);
    }
    if (session.agent) {
      args.push('--agent', session.agent);
    }

    args.push('--format', 'json', '--dangerously-skip-permissions');
    if (allowedTools) {
      for (const tool of allowedTools) {
        args.push('--allowed-tools', tool);
      }
    }
    args.push(fullPrompt);

    session.messageCount += 1;

    try {
      for await (const chunk of this._runOpencodeCommandStreaming(args, {
        timeout: options.timeout || this.config.timeout,
        sessionId,
        workDir: session.workDir
      })) {
        if (chunk.type === 'progress') {
          yield chunk;
          continue;
        }

        if (chunk.type === 'result') {
          if (chunk.sessionId) {
            session.opencodeSessionId = chunk.sessionId;
          }
          this._appendHistory(session, 'user', message);
          this._appendHistory(session, 'assistant', chunk.content);

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
              reasoningTokens: chunk.stats?.reasoningTokens,
              timedOut: false
            }
          };
          return;
        }

        if (chunk.type === 'error') {
          logConversation(sessionId, this.name, {
            prompt: message,
            error: chunk.content
          });

          yield {
            type: 'error',
            content: chunk.content,
            timedOut: chunk.timedOut || false
          };
          return;
        }
      }
    } catch (error) {
      logConversation(sessionId, this.name, {
        prompt: message,
        error: error.message
      });
      yield { type: 'error', content: error.message, timedOut: false };
    }
  }

  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

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

  isSessionActive(sessionId) {
    return this.sessions.has(sessionId);
  }

  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }
}

module.exports = OpencodeCliAdapter;
