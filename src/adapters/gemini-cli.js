/**
 * Gemini CLI Adapter
 *
 * Implements the AgentAdapter interface for Gemini CLI.
 * Uses spawn-per-message with session resume (-r) for persistent sessions.
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const BaseLLMAdapter = require('../core/base-llm-adapter');

const { createAdapterContract, defineAdapterCapabilities, EXECUTION_MODES } = require('./contract');
const { logConversation, logSessionStart } = require('../utils/conversation-logger');
const { updateGenerationParams, getGenerationParams } = require('../utils/gemini-config');

const DEFAULT_GEMINI_MODEL_FALLBACKS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-pro-preview'
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferGeminiBrokerDefaultModel() {
  if (process.env.CLIAGENTS_GEMINI_MODEL) {
    return process.env.CLIAGENTS_GEMINI_MODEL;
  }

  try {
    const settingsPath = path.join(process.env.HOME || '', '.gemini', 'settings.json');
    if (!settingsPath || !fs.existsSync(settingsPath)) {
      return null;
    }

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const configuredModel = settings?.model?.name;

    if (!configuredModel || typeof configuredModel !== 'string') {
      return null;
    }

    const knownModelMap = {
      'auto-gemini-3': 'gemini-3-pro-preview',
      'gemini-3-pro-preview': 'gemini-3-pro-preview',
      'gemini-2.5-pro': 'gemini-2.5-pro',
      'gemini-2.5-flash': 'gemini-2.5-flash'
    };

    return knownModelMap[configuredModel] || null;
  } catch {
    return null;
  }
}

function parseGeminiFallbackModels() {
  const configured = process.env.CLIAGENTS_GEMINI_FALLBACK_MODELS
    ? process.env.CLIAGENTS_GEMINI_FALLBACK_MODELS.split(',')
    : DEFAULT_GEMINI_MODEL_FALLBACKS;

  return Array.from(new Set(
    configured
      .map((model) => String(model || '').trim())
      .filter(Boolean)
  ));
}

function isGeminiCapacityErrorMessage(message) {
  const text = String(message || '');
  return /terminalquotaerror|resourceexhausted|quota(?:_exhausted)?|exhausted your capacity|capacity on this model|quota will reset|rate.?limit/i.test(text);
}

class GeminiCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    const resolvedConfig = { ...config };
    if (!Object.prototype.hasOwnProperty.call(resolvedConfig, 'model')) {
      resolvedConfig.model = inferGeminiBrokerDefaultModel();
    }

    super({
      timeout: 180000,  // 3 minutes for image analysis tasks
      workDir: '/tmp/agent',
      yoloMode: true,        // Auto-approve all actions
      maxResponseSize: 10 * 1024 * 1024, // 10MB max response buffer
      model: null,           // null = use default, or specify model like 'gemini-3-pro-preview'
      // Generation parameters (written to ~/.gemini/config.yaml)
      temperature: null,     // 0.0-2.0, null = use default
      top_p: null,           // 0.0-1.0, null = use default
      top_k: null,           // integer, null = use default
      max_output_tokens: null, // integer, null = use default
      ...resolvedConfig
    });

    this.name = 'gemini-cli';
    this.version = '1.0.0';
    this.sessions = new Map(); // sessionId -> { geminiSessionId, ready, messageCount, model, generationParams }
    this.activeProcesses = new Map(); // Track running CLI processes: sessionId -> process
    this.modelFallbackOrder = parseGeminiFallbackModels();
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
      supportsFilesystemWrite: true,
      supportsJsonMode: true
    });
    this.contract = createAdapterContract({
      capabilities: this.capabilities,
      readiness: {
        initTimeoutMs: 60000,
        promptHandlers: [
          {
            matchAny: ['Do you trust this folder', 'Trust folder'],
            actions: ['Enter'],
            description: 'accept-gemini-trust-folder'
          }
        ]
      },
      notes: [
        'Spawn-per-message adapter that resolves Gemini session UUIDs back to resume indices before sending.',
        'JSON mode is a constrained single-shot path with sandbox and extensions disabled to force structured output.'
      ]
    });

    // Available models for Gemini CLI
    const brokerDefaultModel = this.config.model || 'Gemini CLI configured default';
    this.availableModels = [
      { id: 'default', name: 'Broker Default', description: `Uses ${brokerDefaultModel}` },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast and efficient model' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable 2.5 model' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', description: 'Latest and most intelligent model' }
    ];

    // Apply initial generation params from config if provided
    this._applyGenerationParams({
      temperature: this.config.temperature,
      top_p: this.config.top_p,
      top_k: this.config.top_k,
      max_output_tokens: this.config.max_output_tokens
    });
  }

  /**
   * Get the path to the gemini CLI binary
   * Supports config override, PATH lookup, and common installation locations
   */
  _getGeminiPath() {
    // Use config override if provided
    if (this.config.geminiPath) {
      return this.config.geminiPath;
    }

    // Return cached path if available
    if (this._geminiPathCache) {
      return this._geminiPathCache;
    }

    // Prefer the gemini binary installed alongside the current Node runtime.
    // This keeps the adapter aligned with the version selected by nvm/wrappers.
    const siblingGeminiPath = path.join(path.dirname(process.execPath), 'gemini');
    if (fs.existsSync(siblingGeminiPath)) {
      this._geminiPathCache = siblingGeminiPath;
      return siblingGeminiPath;
    }

    // Try to find gemini using 'which'
    try {
      const result = cp.execSync('which gemini', { encoding: 'utf8', timeout: 5000 }).trim();
      if (result) {
        this._geminiPathCache = result;
        return result;
      }
    } catch (e) {
      // which failed, try common paths
    }

    // Check common installation paths
    const commonPaths = [
      '/opt/homebrew/bin/gemini',      // macOS ARM (Homebrew)
      '/usr/local/bin/gemini',         // macOS Intel / Linux
      '/usr/bin/gemini',               // Linux system
      `${process.env.HOME}/.local/bin/gemini`, // pip install --user
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        this._geminiPathCache = p;
        return p;
      }
    }

    // Fall back to bare command (relies on PATH)
    return 'gemini';
  }

  /**
   * Apply generation parameters to Gemini config file
   */
  _applyGenerationParams(params) {
    // Filter out null/undefined values
    const validParams = {};
    if (params.temperature !== null && params.temperature !== undefined) {
      validParams.temperature = params.temperature;
    }
    if (params.top_p !== null && params.top_p !== undefined) {
      validParams.top_p = params.top_p;
    }
    if (params.top_k !== null && params.top_k !== undefined) {
      validParams.top_k = params.top_k;
    }
    if (params.max_output_tokens !== null && params.max_output_tokens !== undefined) {
      validParams.max_output_tokens = params.max_output_tokens;
    }

    if (Object.keys(validParams).length > 0) {
      const success = updateGenerationParams(validParams);
      if (success) {
        console.log('[GeminiAdapter] Applied generation params:', validParams);
      }
    }
  }

  /**
   * Get current generation parameters
   */
  getGenerationParams() {
    return getGenerationParams();
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels;
  }

  getCapabilities() {
    return this.capabilities;
  }

  getContract() {
    return this.contract;
  }

  _normalizeModel(model) {
    return model && model !== 'default' ? model : null;
  }

  _getModelAttempts(preferredModel) {
    const primaryModel = this._normalizeModel(preferredModel) || this._normalizeModel(this.config.model);

    if (process.env.CLIAGENTS_GEMINI_DISABLE_MODEL_FALLBACK === '1') {
      return primaryModel ? [primaryModel] : [null];
    }

    const attempts = [];
    if (primaryModel) {
      attempts.push(primaryModel);
    }

    for (const candidate of this.modelFallbackOrder) {
      if (candidate && !attempts.includes(candidate)) {
        attempts.push(candidate);
      }
    }

    return attempts.length > 0 ? attempts : [null];
  }

  _buildArgsWithModel(baseArgs, model) {
    const args = [...baseArgs];
    if (model && model !== 'default') {
      args.unshift('-m', model);
    }
    return args;
  }

  _isRetryableModelFailure(errorOrMessage) {
    if (process.env.CLIAGENTS_GEMINI_DISABLE_MODEL_FALLBACK === '1') {
      return false;
    }

    const message = typeof errorOrMessage === 'string'
      ? errorOrMessage
      : errorOrMessage?.message || errorOrMessage?.content || '';
    return isGeminiCapacityErrorMessage(message);
  }

  _logModelFallback(fromModel, toModel, context) {
    console.warn(
      `[GeminiAdapter] ${context}. Switching model from ${fromModel || 'default'} to ${toModel || 'default'}`
    );
  }

  /**
   * Check if Gemini CLI is available
   */
  async isAvailable() {
    const geminiPath = this._getGeminiPath();
    if (geminiPath && geminiPath !== 'gemini') {
      try {
        fs.accessSync(geminiPath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }

    return new Promise((resolve) => {
      const check = cp.spawn('which', ['gemini']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Get list of Gemini sessions
   */
  async _listGeminiSessions(workDir = process.cwd(), options = {}) {
    const {
      deadline = null,
      maxAttempts = 3,
      timeoutMs = 30000
    } = options;
    const geminiPath = this._getGeminiPath();
    let lastError = null;
    const attemptLimit = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0
      ? Math.floor(Number(maxAttempts))
      : 3;
    const baseTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : 30000;

    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const remainingBudget = deadline == null ? null : Math.max(0, deadline - Date.now());
      if (remainingBudget !== null && remainingBudget <= 0) {
        break;
      }

      const commandTimeoutMs = remainingBudget == null
        ? baseTimeoutMs
        : Math.max(1, Math.min(baseTimeoutMs, remainingBudget));

      try {
        const { stdout } = await new Promise((resolve, reject) => {
          cp.execFile(geminiPath, ['--list-sessions'], {
            cwd: workDir,
            env: {
              ...process.env,
              NO_COLOR: '1'
            },
            encoding: 'utf-8',
            timeout: commandTimeoutMs
          }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });

        if (!stdout) return [];

        return stdout
          .split('\n')
          .map((line) => line.match(/^\s*(\d+)\.\s+.*?\[([^\]]+)\]/))
          .filter(Boolean)
          .map((match) => ({
            index: Number(match[1]),
            sessionId: match[2].trim()
          }));
      } catch (e) {
        lastError = e;
        if (attempt < attemptLimit) {
          const remainingAfterFailure = deadline == null ? null : Math.max(0, deadline - Date.now());
          if (remainingAfterFailure !== null && remainingAfterFailure <= 0) {
            break;
          }
          const backoffMs = attempt * 200;
          await sleep(remainingAfterFailure == null ? backoffMs : Math.min(backoffMs, remainingAfterFailure));
        }
      }
    }

    if (lastError) {
      console.warn(`[GeminiAdapter] _listGeminiSessions failed after ${attemptLimit} attempts: ${lastError.message}`);
    }
    return [];
  }

  /**
   * Resolve a stored Gemini session UUID to the current project-local resume index.
   */
  async _resolveGeminiResumeRef(session, options = {}) {
    const {
      timeoutMs = 20000,
      pollIntervalMs = 750
    } = options;

    if (!session.geminiSessionId) {
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    let attemptCount = 0;

    while (Date.now() <= deadline) {
      attemptCount++;
      const sessions = await this._listGeminiSessions(session.workDir, { deadline });
      const match = sessions.find((entry) => entry.sessionId === session.geminiSessionId);
      if (match) {
        if (attemptCount > 1) {
          console.log(`[GeminiAdapter] Resolved session ${session.geminiSessionId} after ${attemptCount} attempts`);
        }
        return String(match.index);
      }

      const remainingBudget = Math.max(0, deadline - Date.now());
      if (remainingBudget === 0) {
        break;
      }
      await sleep(Math.min(pollIntervalMs, remainingBudget));
    }

    console.warn(`[GeminiAdapter] Failed to resolve Gemini session ${session.geminiSessionId} after ${timeoutMs}ms`);
    return null;
  }

  /**
   * Detect a newly created Gemini session UUID by diffing --list-sessions output.
   * Some Gemini CLI versions omit session_id in JSON output; this provides a robust fallback.
   */
  async _detectNewGeminiSessionId(workDir, sessionsBefore = [], options = {}) {
    const {
      deadline: requestedDeadline = null,
      timeoutMs = 20000,
      pollIntervalMs = 750
    } = options;

    const normalizedSessionsBefore = Array.isArray(sessionsBefore) ? sessionsBefore : [];
    const beforeSet = new Set(normalizedSessionsBefore.map((entry) => entry.sessionId));
    const timeoutDeadline = Date.now() + timeoutMs;
    const deadline = Number.isFinite(requestedDeadline)
      ? Math.min(requestedDeadline, timeoutDeadline)
      : timeoutDeadline;
    let latestSessions = [];
    let attemptCount = 0;

    while (Date.now() <= deadline) {
      attemptCount++;
      latestSessions = await this._listGeminiSessions(workDir, { deadline });

      const created = latestSessions.slice().reverse().find((entry) => !beforeSet.has(entry.sessionId));
      if (created?.sessionId) {
        if (attemptCount > 1) {
          console.log(`[GeminiAdapter] Detected new session ${created.sessionId} after ${attemptCount} attempts`);
        }
        return created.sessionId;
      }

      const remainingBudget = Math.max(0, deadline - Date.now());
      if (remainingBudget === 0) {
        break;
      }
      await sleep(Math.min(pollIntervalMs, remainingBudget));
    }

    // Fallback only when the workDir had no prior sessions; otherwise the
    // newest visible session may belong to an older conversation.
    if (beforeSet.size === 0 && latestSessions.length > 0) {
      const fallbackId = latestSessions[latestSessions.length - 1].sessionId;
      console.warn(`[GeminiAdapter] Detection timeout. Falling back to newest session: ${fallbackId}`);
      return fallbackId || null;
    }

    return null;
  }

  /**
   * Spawn a new Gemini session
   */
  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const workDir = options.workDir || path.join(this.config.workDir, sessionId);
    const model = options.model || this.config.model; // null = default

    // Apply generation parameters if provided (writes to ~/.gemini/config.yaml)
    const generationParams = {
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      max_output_tokens: options.max_output_tokens
    };
    this._applyGenerationParams(generationParams);

    // JSON mode: lazy init (no API call until first message, like Codex)
    if (options.jsonMode) {
      const session = {
        geminiSessionId: null,
        ready: true,
        messageCount: 0,
        systemPrompt: options.systemPrompt,
        workDir,
        model,
        jsonMode: true,
        allowedTools: options.allowedTools,
        generationParams
      };
      this.sessions.set(sessionId, session);
      this.emit('ready', { sessionId });
      logSessionStart(sessionId, this.name, { model: model || 'default', workDir, jsonMode: true });
      return {
        sessionId,
        status: 'ready',
        adapter: this.name,
        geminiSessionId: null,
        model: model || 'default'
      };
    }

    // Non-JSON mode: normal init with session creation
    const spawnDeadline = Date.now() + this.config.timeout;
    const sessionsBeforeInit = await this._listGeminiSessions(workDir, {
      deadline: spawnDeadline,
      timeoutMs: Math.min(this.config.timeout, 15000)
    });

    const initPrompt = options.systemPrompt
      ? `You are starting a new session. ${options.systemPrompt}. Acknowledge with "Ready."`
      : 'You are starting a new session. Acknowledge with "Ready."';

    // Use json for init (not stream-json since we're not streaming for spawn)
    const baseArgs = [
      '-p', initPrompt,
      '-o', 'json'
    ];

    // Add allowed tools if specified (Gemini uses --allowed-tools flag)
    if (options.allowedTools && Array.isArray(options.allowedTools)) {
      baseArgs.push('--allowed-tools', options.allowedTools.join(','));
    }

    if (this.config.yoloMode) {
      baseArgs.push('-y');
    }

    let initResult = null;
    let resolvedModel = model;
    const modelAttempts = this._getModelAttempts(model);

    for (let attemptIndex = 0; attemptIndex < modelAttempts.length; attemptIndex++) {
      const attemptModel = modelAttempts[attemptIndex];
      const args = this._buildArgsWithModel(baseArgs, attemptModel);

      try {
        initResult = await this._runGeminiCommand(args, {
          workDir,
          timeout: this.config.timeout
        });
        resolvedModel = attemptModel;
        break;
      } catch (error) {
        const nextModel = modelAttempts[attemptIndex + 1];
        if (!nextModel || !this._isRetryableModelFailure(error)) {
          throw error;
        }
        this._logModelFallback(attemptModel, nextModel, 'Session initialization hit Gemini capacity limits');
      }
    }

    if (initResult.timedOut) {
      throw new Error('Gemini CLI session initialization timed out');
    }

    let geminiSessionId =
      initResult.raw?.session_id ||
      initResult.raw?.sessionId ||
      initResult.raw?.session?.id;

    if (!geminiSessionId) {
      geminiSessionId = await this._detectNewGeminiSessionId(workDir, sessionsBeforeInit, {
        deadline: spawnDeadline,
        timeoutMs: 12000,
        pollIntervalMs: 500
      });
    }

    if (!geminiSessionId) {
      throw new Error('Gemini CLI did not return a session_id for the new session');
    }

    const session = {
      geminiSessionId,
      ready: true,
      messageCount: 1,
      systemPrompt: options.systemPrompt,
      workDir,
      model: resolvedModel, // Store the model for this session
      allowedTools: options.allowedTools, // Store allowed tools list
      generationParams // Store generation params for reference
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    // Log session start
    logSessionStart(sessionId, this.name, { model: model || 'default', workDir });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      geminiSessionId,
      model: resolvedModel || 'default'
    };
  }

  /**
   * Run a Gemini CLI command and collect response (non-streaming, for init)
   */
  async _runGeminiCommand(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const geminiPath = this._getGeminiPath();

    // Ensure work directory exists
    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    console.log('[GeminiAdapter] Running (async):', geminiPath, args.join(' '));
    console.log('[GeminiAdapter] Working directory:', workDir);
    console.log('[GeminiAdapter] Timeout:', timeout);

    return new Promise((resolve, reject) => {
      const proc = cp.spawn(geminiPath, args, {
        cwd: workDir,
        env: {
          ...process.env,
          NO_COLOR: '1'
        }
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let closed = false;
      let forceKillTimer = null;
      let settleTimer = null;
      let earlyExitRequested = false;
      let parsedResult = null;

      const scheduleSettleExit = () => {
        if (!parsedResult?.response || timedOut || closed) {
          return;
        }
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        settleTimer = setTimeout(() => {
          if (closed) {
            return;
          }
          earlyExitRequested = true;
          proc.kill('SIGTERM');
          forceKillTimer = setTimeout(() => {
            if (!closed) {
              proc.kill('SIGKILL');
            }
          }, 2000);
        }, 1500);
      };

      // Set timeout
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (!closed) {
            proc.kill('SIGKILL');
          }
        }, 2000);
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }

        const jsonStart = stdout.indexOf('{');
        if (jsonStart !== -1) {
          try {
            parsedResult = JSON.parse(stdout.substring(jsonStart));
            scheduleSettleExit();
          } catch {
            // JSON output may still be incomplete while data is arriving.
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        closed = true;
        clearTimeout(timeoutId);
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }

        if (timedOut) {
          console.log('[GeminiAdapter] Timeout reached');
          resolve({
            text: stdout,
            timedOut: true,
            error: 'Request timed out'
          });
          return;
        }

        if (code !== 0 && !(earlyExitRequested && parsedResult?.response)) {
          console.log('[GeminiAdapter] Error exit code:', code);
          reject(new Error(`Gemini CLI exited with code ${code}: ${stderr}`));
          return;
        }

        console.log('[GeminiAdapter] Response received:', stdout.length, 'bytes');

        // Try to parse JSON response
        if (!parsedResult) {
          const jsonStart = stdout.indexOf('{');
          if (jsonStart !== -1) {
            try {
              const jsonStr = stdout.substring(jsonStart);
              parsedResult = JSON.parse(jsonStr);
            } catch (e) {
              console.log('[GeminiAdapter] JSON parse error, using raw output');
            }
          }
        }

        // Extract stats from the nested stats object
        const stats = parsedResult?.stats?.models;
        let totalTokens = 0;
        let promptTokens = 0;
        let candidateTokens = 0;

        if (stats) {
          for (const model of Object.values(stats)) {
            promptTokens += model.tokens?.prompt || 0;
            candidateTokens += model.tokens?.candidates || 0;
            totalTokens += model.tokens?.total || 0;
          }
        }

        resolve({
          text: parsedResult?.response || stdout,
          stats: {
            inputTokens: promptTokens,
            outputTokens: candidateTokens,
            totalTokens: totalTokens,
            toolCalls: parsedResult?.stats?.tools?.totalCalls || 0
          },
          exitCode: 0,
          raw: parsedResult
        });
      });

      proc.on('error', (err) => {
        closed = true;
        clearTimeout(timeoutId);
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        console.log('[GeminiAdapter] Process error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Run Gemini CLI with streaming output (async spawn)
   * Yields chunks as they arrive from stdout
   */
  async *_runGeminiCommandStreaming(args, options = {}) {
    const timeout = options.timeout || this.config.timeout;
    const geminiPath = this._getGeminiPath();

    const workDir = options.workDir || process.cwd();
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    console.log('[GeminiAdapter] Streaming:', geminiPath, args.join(' '));

    const proc = cp.spawn(geminiPath, args, {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });

    // Track this process for cleanup
    const sessionId = options.sessionId;
    if (sessionId) {
      this.activeProcesses.set(sessionId, proc);
    }

    let fullOutput = '';
    let timedOut = false;
    let exitCode = null;
    let processError = null;
    let settleTimer = null;
    let settleForceKillTimer = null;
    let earlyExitRequested = false;
    let finalResult = null;

    const scheduleSettleExit = () => {
      if (!finalResult || timedOut) {
        return;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        if (exitCode !== null || processError) {
          return;
        }
        earlyExitRequested = true;
        proc.kill('SIGTERM');
        settleForceKillTimer = setTimeout(() => {
          if (exitCode === null && !processError) {
            proc.kill('SIGKILL');
          }
        }, 2000);
      }, 1500);
    };

    // Set timeout with force kill fallback
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Force kill after 2 seconds if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }, timeout);

    // Track process completion
    const processComplete = new Promise((resolve) => {
      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        if (settleForceKillTimer) {
          clearTimeout(settleForceKillTimer);
        }
        exitCode = code;
        // Remove from active processes
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        if (settleForceKillTimer) {
          clearTimeout(settleForceKillTimer);
        }
        processError = err;
        // Remove from active processes
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        resolve();
      });
    });

    // Process streaming JSON output in real-time
    let buffer = '';  // Buffer for incomplete JSON lines
    let lastAssistantContent = '';

    try {
      for await (const chunk of proc.stdout) {
        const text = chunk.toString();
        buffer += text;
        fullOutput += text;
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }

        // Process complete lines (newline-delimited JSON)
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line);
            const isThoughtChunk = msg?.thought === true || msg?.isThought === true || msg?.metadata?.thought === true;

            // Handle different message types for real-time progress
            // Gemini format: {"type":"message","role":"assistant","content":"..."}
            if (msg.type === 'message' && msg.role === 'assistant') {
              if (isThoughtChunk) {
                continue;
              }
              // Assistant is speaking/thinking
              const content = msg.content;
              if (content) {
                lastAssistantContent += content;  // Concatenate all chunks
                yield {
                  type: 'progress',
                  progressType: 'assistant',
                  content: content
                };
                this.emit('chunk', {
                  sessionId: options.sessionId,
                  chunk: content,
                  progressType: 'assistant',
                  partial: true
                });
              }
            } else if (msg.type === 'tool_use' || msg.type === 'function_call') {
              // Agent is calling a tool
              const toolName = msg.name || msg.tool?.name || 'unknown';
              const toolInput = msg.args || msg.input || {};
              yield {
                type: 'progress',
                progressType: 'tool_use',
                tool: toolName,
                input: toolInput
              };
              this.emit('chunk', {
                sessionId: options.sessionId,
                progressType: 'tool_use',
                tool: toolName,
                partial: true
              });
            } else if (msg.type === 'tool_result' || msg.type === 'function_result') {
              // Tool returned a result
              yield {
                type: 'progress',
                progressType: 'tool_result',
                result: msg.result || msg.content
              };
            } else if (msg.type === 'result') {
              // Final result - Gemini format: {"type":"result","status":"success","stats":{...}}
              finalResult = msg;
              scheduleSettleExit();
            }
          } catch (e) {
            // Not valid JSON, emit as raw chunk
            this.emit('chunk', {
              sessionId: options.sessionId,
              chunk: line,
              partial: true
            });
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          const isThoughtChunk = msg?.thought === true || msg?.isThought === true || msg?.metadata?.thought === true;
          if (msg.type === 'result') {
            finalResult = msg;
            scheduleSettleExit();
          }
          // Also capture last assistant content from buffer
          if (!isThoughtChunk && msg.type === 'message' && msg.role === 'assistant' && msg.content) {
            lastAssistantContent += msg.content;  // Concatenate
          }
        } catch (e) {
          // Ignore incomplete JSON
        }
      }

      // Wait for process to fully complete
      await processComplete;

      // Handle errors
      if (timedOut) {
        yield { type: 'error', content: 'Request timed out', timedOut: true };
        return;
      }
      if (processError) {
        yield { type: 'error', content: processError.message };
        return;
      }

      const structuredErrorMessage =
        finalResult?.status === 'error'
          ? (
              finalResult?.error?.message
              || finalResult?.error?.content
              || finalResult?.error?.type
              || null
            )
          : null;

      if (structuredErrorMessage) {
        yield {
          type: 'error',
          content: structuredErrorMessage
        };
        return;
      }

      if (exitCode !== 0 && !(earlyExitRequested && finalResult)) {
        yield { type: 'error', content: `Process exited with code ${exitCode}` };
        return;
      }

      // Extract stats from the final result
      // Gemini stream-json format: {"type":"result","stats":{"total_tokens":X,"input_tokens":Y,"output_tokens":Z}}
      const stats = finalResult?.stats;

      // Yield final result
      yield {
        type: 'result',
        content: lastAssistantContent || '',
        stats: {
          inputTokens: stats?.input_tokens || 0,
          outputTokens: stats?.output_tokens || 0,
          totalTokens: stats?.total_tokens || 0,
          toolCalls: stats?.tool_calls || 0,
          durationMs: stats?.duration_ms || 0
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
   * Send a message and yield response chunks (with streaming)
   */
  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.ready) {
      throw new Error(`Session ${sessionId} not ready`);
    }

    // JSON mode: single-shot, no tools, no session resume
    if (session.jsonMode) {
      // Build prompt with system prompt prepended
      let fullPrompt = message;
      if (session.systemPrompt) {
        fullPrompt = `${session.systemPrompt}\n\n${fullPrompt}`;
      }
      const baseArgs = [
        '-p', fullPrompt,
        '-o', 'json', // JSON output format
        '-s', 'false', // No sandbox (disables file system tools)
        '-e', '',     // No extensions (disables MCP tools)
      ];

      // No -y needed since tools are disabled, but add it for safety
      baseArgs.push('-y');

      session.messageCount++;

      const modelAttempts = this._getModelAttempts(session.model);

      for (let attemptIndex = 0; attemptIndex < modelAttempts.length; attemptIndex++) {
        const attemptModel = modelAttempts[attemptIndex];
        const args = this._buildArgsWithModel(baseArgs, attemptModel);

        try {
          const result = await this._runGeminiCommand(args, {
            timeout: options.timeout || this.config.timeout,
            workDir: session.workDir
          });

          session.model = attemptModel;

          let content = result.text || '';
          // Strip markdown code blocks if model wraps JSON in ```json blocks
          content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          logConversation(sessionId, this.name, { prompt: message, response: content, stats: result.stats });

          yield {
            type: 'result',
            content: content,
            metadata: {
              inputTokens: result.stats?.inputTokens,
              outputTokens: result.stats?.outputTokens,
              totalTokens: result.stats?.totalTokens,
              toolCalls: 0,
              timedOut: result.timedOut || false
            }
          };
          return;
        } catch (error) {
          const nextModel = modelAttempts[attemptIndex + 1];
          if (nextModel && this._isRetryableModelFailure(error)) {
            this._logModelFallback(attemptModel, nextModel, 'JSON-mode request hit Gemini capacity limits');
            continue;
          }

          logConversation(sessionId, this.name, { prompt: message, error: error.message });
          yield { type: 'error', content: error.message };
          return;
        }
      }
      return;
    }

    const resumeRef = await this._resolveGeminiResumeRef(session);
    if (!resumeRef) {
      throw new Error(
        `Gemini session ${session.geminiSessionId || sessionId} could not be resolved for workDir ${session.workDir}`
      );
    }

    // Normal (non-JSON) mode: resume session, stream output
    const baseArgs = [
      '-r', resumeRef,
      '-p', message,
      '-o', 'stream-json'
    ];

    // Add allowed tools if specified (per-message or session-level)
    const allowedTools = options.allowedTools || session.allowedTools;
    if (allowedTools && Array.isArray(allowedTools)) {
      baseArgs.push('--allowed-tools', allowedTools.join(','));
    }

    if (this.config.yoloMode) {
      baseArgs.push('-y');
    }

    session.messageCount++;
    const modelAttempts = this._getModelAttempts(session.model);

    for (let attemptIndex = 0; attemptIndex < modelAttempts.length; attemptIndex++) {
      const attemptModel = modelAttempts[attemptIndex];
      const args = this._buildArgsWithModel(baseArgs, attemptModel);
      let emittedProgress = false;

      try {
        for await (const chunk of this._runGeminiCommandStreaming(args, {
          timeout: options.timeout || this.config.timeout,
          sessionId,
          workDir: session.workDir
        })) {
          if (chunk.type === 'chunk' || chunk.type === 'progress') {
            emittedProgress = true;
            yield chunk;
          } else if (chunk.type === 'result') {
            session.model = attemptModel;

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
                toolCalls: chunk.stats?.toolCalls,
                timedOut: false
              }
            };
            return;
          } else if (chunk.type === 'error') {
            const nextModel = modelAttempts[attemptIndex + 1];
            if (!emittedProgress && nextModel && this._isRetryableModelFailure(chunk.content)) {
              this._logModelFallback(attemptModel, nextModel, 'Streaming request hit Gemini capacity limits');
              break;
            }

            logConversation(sessionId, this.name, {
              prompt: message,
              error: chunk.content
            });

            yield {
              type: 'error',
              content: chunk.content,
              timedOut: chunk.timedOut
            };
            return;
          }
        }
      } catch (error) {
        const nextModel = modelAttempts[attemptIndex + 1];
        if (nextModel && !emittedProgress && this._isRetryableModelFailure(error)) {
          this._logModelFallback(attemptModel, nextModel, 'Streaming request threw a Gemini capacity error');
          continue;
        }

        logConversation(sessionId, this.name, {
          prompt: message,
          error: error.message
        });

        yield {
          type: 'error',
          content: error.message
        };
        return;
      }
    }
  }

  /**
   * Terminate a session
   */
  async terminate(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Kill any active process for this session
    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) {
      console.log(`[GeminiAdapter] Killing process for session ${sessionId}`);
      proc.kill('SIGTERM');
      // Force kill after 2 seconds if still alive
      setTimeout(() => {
        if (!proc.killed) {
          console.log(`[GeminiAdapter] Force killing process for session ${sessionId}`);
          proc.kill('SIGKILL');
        }
      }, 2000);
    }
    this.activeProcesses.delete(sessionId);

    // Remove from tracking
    this.sessions.delete(sessionId);
    this._clearHeartbeat(sessionId);
    this.emit('terminated', { sessionId });
  }

  /**
   * Kill all active processes (for cleanup)
   */
  killAllProcesses() {
    console.log(`[GeminiAdapter] Killing ${this.activeProcesses.size} active processes`);
    for (const [sessionId, proc] of this.activeProcesses.entries()) {
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
   * Parse Gemini response for action extraction
   */
  parseResponse(text) {
    // Try to find JSON action
    const jsonMatches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    if (jsonMatches) {
      for (const jsonMatch of jsonMatches) {
        try {
          const parsed = JSON.parse(jsonMatch);
          if (parsed.action) return parsed;
        } catch (e) {
          // Continue
        }
      }
    }

    // Check for common patterns
    const lowerText = text.toLowerCase();

    if (lowerText.includes('task is done') || lowerText.includes('task complete') ||
        lowerText.includes('finished') || lowerText.includes('completed')) {
      return { action: 'complete', thinking: text.substring(0, 200), result: text };
    }

    // URL navigation
    const urlMatch = text.match(/https?:\/\/[^\s"'<>\]]+/);
    if (urlMatch && (lowerText.includes('navigate') || lowerText.includes('go to'))) {
      return { action: 'navigate', url: urlMatch[0], thinking: 'Navigating' };
    }

    // Click patterns
    const clickMatch = text.match(/click(?:ing)?(?:\s+on)?(?:\s+element)?(?:\s+#)?(?:\s+number)?\s*(\d+)/i);
    if (clickMatch) {
      return { action: 'click', element: parseInt(clickMatch[1]), thinking: `Clicking element ${clickMatch[1]}` };
    }

    // Scroll
    if (lowerText.includes('scroll')) {
      const direction = lowerText.includes('up') ? 'up' : 'down';
      return { action: 'scroll', direction, thinking: `Scrolling ${direction}` };
    }

    return { text };
  }
}

module.exports = GeminiCliAdapter;
module.exports.inferGeminiBrokerDefaultModel = inferGeminiBrokerDefaultModel;
module.exports.parseGeminiFallbackModels = parseGeminiFallbackModels;
module.exports.isGeminiCapacityErrorMessage = isGeminiCapacityErrorMessage;
