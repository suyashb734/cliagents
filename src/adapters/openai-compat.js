/**
 * OpenAI-Compatible Adapter
 *
 * Generic adapter for any provider exposing an OpenAI-compatible chat completions API.
 * Covers: Ollama (local), MiniMax, DeepSeek, Groq, Together AI, OpenRouter, LM Studio, etc.
 *
 * Usage — register named instances in server/index.js:
 *   manager.registerAdapter('ollama', new OpenAICompatAdapter({
 *     baseURL: 'http://localhost:11434/v1',
 *     apiKey: 'unused',
 *     providerName: 'Ollama',
 *     staticModels: [{ id: 'llama3.1:8b', name: 'Llama 3.1 8B' }, ...]
 *   }));
 *
 *   manager.registerAdapter('minimax', new OpenAICompatAdapter({
 *     baseURL: 'https://api.minimaxi.chat/v1',
 *     apiKey: process.env.MINIMAX_API_KEY,
 *     providerName: 'MiniMax',
 *   }));
 */

const BaseLLMAdapter = require('../core/base-llm-adapter');
const OpenAI = require('openai');

class OpenAICompatAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: config.timeout || 120000,
      workDir: config.workDir || '/tmp/agent',
      ...config
    });

    this.name = config.name || 'openai-compat';
    this.version = '1.0.0';
    this.providerName = config.providerName || this.name;
    this.sessions = new Map();
    this.activeRequests = new Map();

    // Static model list (used when dynamic discovery isn't available/needed)
    this._staticModels = config.staticModels || null;

    // Model list cache
    this._modelsCache = null;
    this._modelsCacheTime = 0;
    this._modelsCacheTTL = 5 * 60 * 1000; // 5 min

    const apiKey = config.apiKey || 'unused';
    const baseURL = config.baseURL;

    if (!baseURL) {
      throw new Error(`[${this.name}] baseURL is required`);
    }

    this.defaultModel = config.defaultModel || null; // resolved lazily if null
    this._baseURL = baseURL;
    this._apiKey = apiKey;

    this.client = new OpenAI({ baseURL, apiKey, dangerouslyAllowBrowser: false });

    console.log(`[${this.name}] Initialized → ${baseURL}`);
  }

  async isAvailable() {
    // For local providers (no key needed), just check if we have a baseURL
    if (!this._apiKey || this._apiKey === 'unused') {
      // Try a quick model list to see if the server is reachable
      try {
        await this.client.models.list();
        return true;
      } catch {
        return false;
      }
    }
    return !!this._apiKey;
  }

  async getAvailableModels() {
    // Return cached
    if (this._modelsCache && (Date.now() - this._modelsCacheTime < this._modelsCacheTTL)) {
      return this._modelsCache;
    }

    // Use static list if provided (skip discovery)
    if (this._staticModels) {
      this._modelsCache = this._staticModels;
      this._modelsCacheTime = Date.now();
      return this._modelsCache;
    }

    // Try dynamic discovery via /v1/models
    try {
      const response = await this.client.models.list();
      const models = [];
      for await (const model of response) {
        models.push({
          id: model.id,
          name: model.id,
          description: model.description || ''
        });
      }
      if (models.length > 0) {
        this._modelsCache = models;
        this._modelsCacheTime = Date.now();
        return models;
      }
    } catch (err) {
      console.warn(`[${this.name}] Model discovery failed: ${err.message}`);
    }

    return [{ id: 'default', name: 'Default', description: 'Provider default model' }];
  }

  async _resolveDefaultModel() {
    if (this.defaultModel) return this.defaultModel;
    const models = await this.getAvailableModels();
    this.defaultModel = models[0]?.id || 'default';
    return this.defaultModel;
  }

  async spawn(sessionId, options = {}) {
    const model = (options.model && options.model !== 'default')
      ? options.model
      : await this._resolveDefaultModel();

    const session = {
      model,
      systemPrompt: options.systemPrompt || null,
      history: [],
      messageCount: 0,
      createdAt: Date.now(),
      temperature: options.temperature,
      top_p: options.top_p,
      max_tokens: options.max_output_tokens || options.max_tokens || null,
      jsonMode: options.jsonMode || false
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    return { sessionId, status: 'ready', adapter: this.name, model };
  }

  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const startTime = Date.now();

    // Build messages array
    const messages = [];
    if (session.systemPrompt) {
      messages.push({ role: 'system', content: session.systemPrompt });
    }
    messages.push(...session.history);
    messages.push({ role: 'user', content: message });

    // Build request params
    const params = {
      model: session.model,
      messages,
      stream: true
    };
    if (session.temperature !== undefined) params.temperature = session.temperature;
    if (session.top_p !== undefined) params.top_p = session.top_p;
    if (session.max_tokens) params.max_tokens = session.max_tokens;
    if (session.jsonMode) params.response_format = { type: 'json_object' };
    if (options.maxOutputTokens) params.max_tokens = options.maxOutputTokens;

    const timeout = options.timeout || this.config.timeout;
    const abortController = new AbortController();
    this.activeRequests.set(sessionId, abortController);

    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = await this.client.chat.completions.create(params, {
        signal: abortController.signal
      });

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          yield { type: 'progress', progressType: 'assistant', content: delta };
        }

        // Usage may appear in final chunk
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }
      }

      // Update history
      session.history.push(
        { role: 'user', content: message },
        { role: 'assistant', content: fullContent }
      );
      session.messageCount++;

      yield {
        type: 'result',
        content: fullContent,
        metadata: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          toolCalls: 0,
          timedOut: false,
          latencyMs: Date.now() - startTime,
          model: session.model,
          provider: this.providerName
        }
      };

    } catch (error) {
      if (abortController.signal.aborted) {
        yield { type: 'error', content: `Request timed out after ${timeout}ms`, timedOut: true };
      } else {
        yield { type: 'error', content: error.message || `${this.providerName} API error`, timedOut: false };
      }
    } finally {
      clearTimeout(timeoutId);
      this.activeRequests.delete(sessionId);
    }
  }

  async interrupt(sessionId) {
    const controller = this.activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionId);
      return true;
    }
    return false;
  }

  async terminate(sessionId) {
    await this.interrupt(sessionId);
    this.sessions.delete(sessionId);
  }

  isSessionActive(sessionId) {
    return this.sessions.has(sessionId);
  }

  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }

  getGenerationParams() {
    return {
      temperature: { min: 0, max: 2, default: 1 },
      topP: { min: 0, max: 1, default: 0.95 },
      maxOutputTokens: { min: 1, max: 32768, default: 4096 }
    };
  }
}

module.exports = OpenAICompatAdapter;
