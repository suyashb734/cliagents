/**
 * Gemini API Adapter
 *
 * Direct HTTP API adapter for Google Gemini, bypassing the gemini CLI.
 * Designed for production use where sub-second latency matters.
 *
 * Architecture:
 * - CLI adapter (gemini-cli): For development — tool use, file editing, interactive debugging
 * - API adapter (gemini-api): For production — fast Q&A with 2-5s latency instead of 30-50s
 *
 * Auth priority:
 * 1. GEMINI_API_KEY or GOOGLE_API_KEY environment variable
 * 2. OAuth credentials from gemini CLI (~/.gemini/oauth_creds.json)
 *
 * Models are discovered dynamically from the API, not hardcoded.
 *
 * Uses @google/genai SDK (GA, replaces deprecated @google/generative-ai)
 */

const BaseLLMAdapter = require('../core/base-llm-adapter');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MODEL = 'gemini-2.5-flash';

class GeminiApiAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: config.timeout || 30000,
      ...config
    });

    this.name = 'gemini-api';
    this.version = '1.0.0';
    this.sessions = new Map();
    this.activeRequests = new Map();

    // Cached model list (refreshed periodically)
    this._modelsCache = null;
    this._modelsCacheTime = 0;
    this._modelsCacheTTL = 5 * 60 * 1000; // 5 min

    // Initialize client with auto-detected auth
    this.client = this._initClient(config);
    this.defaultModel = config.model || DEFAULT_MODEL;
  }

  /**
   * Initialize the SDK client
   *
   * Auth options:
   * 1. API key (GEMINI_API_KEY) → uses generativelanguage.googleapis.com
   *    Get free key: https://aistudio.google.com/apikey
   * 2. Vertex AI (GOOGLE_CLOUD_PROJECT) → uses aiplatform.googleapis.com with ADC
   *    Requires: Vertex AI API enabled, gcloud auth application-default login
   *
   * Note: Gemini CLI's OAuth creds use scopes incompatible with the public API.
   */
  _initClient(config) {
    // Priority 1: Explicit API key (Google AI Studio path)
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (apiKey) {
      console.log('[GeminiAPI] Using API key authentication');
      return new GoogleGenAI({ apiKey });
    }

    // Priority 2: Vertex AI with Application Default Credentials
    const gcpProject = config.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
    const gcpLocation = config.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    if (gcpProject) {
      console.log(`[GeminiAPI] Using Vertex AI (project: ${gcpProject}, location: ${gcpLocation})`);
      return new GoogleGenAI({
        vertexai: true,
        project: gcpProject,
        location: gcpLocation
      });
    }

    console.warn('[GeminiAPI] No auth configured. Set GEMINI_API_KEY (free: https://aistudio.google.com/apikey)');
    return null;
  }

  /**
   * Check if the Gemini API is available
   * Does NOT make an API call — just checks if auth is configured
   */
  async isAvailable() {
    return this.client !== null;
  }

  /**
   * Get available models dynamically from the API
   * Falls back to a minimal known-good list if the API call fails
   */
  async getAvailableModels() {
    // Return cache if fresh
    if (this._modelsCache && (Date.now() - this._modelsCacheTime < this._modelsCacheTTL)) {
      return this._modelsCache;
    }

    if (!this.client) {
      return this._fallbackModels();
    }

    try {
      const response = await this.client.models.list();
      const models = [];

      for await (const model of response) {
        // Only include generative models (not embedding models etc.)
        if (model.name && model.supportedGenerationMethods?.includes('generateContent')) {
          // Model name comes as "models/gemini-2.5-flash" — extract the ID
          const id = model.name.replace('models/', '');
          models.push({
            id,
            name: model.displayName || id,
            description: model.description || '',
            contextWindow: model.inputTokenLimit || 0,
            outputTokenLimit: model.outputTokenLimit || 0
          });
        }
      }

      if (models.length > 0) {
        this._modelsCache = models;
        this._modelsCacheTime = Date.now();
        return models;
      }
    } catch (error) {
      console.warn('[GeminiAPI] Failed to list models from API:', error.message);
    }

    return this._fallbackModels();
  }

  /**
   * Fallback model list when API discovery fails
   */
  _fallbackModels() {
    return [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast, cost-effective' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'High reasoning capability' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Previous gen fast model' }
    ];
  }

  /**
   * Spawn a new session
   * For API adapter, this just creates session metadata — no process to spawn
   * Instant, zero latency
   */
  async spawn(sessionId, options = {}) {
    if (!this.client) {
      throw new Error('Gemini API not configured. Set GEMINI_API_KEY or login via gemini CLI.');
    }

    const model = (options.model && options.model !== 'default')
      ? options.model
      : this.defaultModel;

    const session = {
      model,
      systemPrompt: options.systemPrompt || null,
      history: [],
      messageCount: 0,
      ready: true,
      createdAt: Date.now(),
      generationConfig: {}
    };

    // Only set generation params that were explicitly provided
    if (options.temperature !== undefined) session.generationConfig.temperature = options.temperature;
    if (options.top_p !== undefined) session.generationConfig.topP = options.top_p;
    if (options.top_k !== undefined) session.generationConfig.topK = options.top_k;
    if (options.max_output_tokens !== undefined) session.generationConfig.maxOutputTokens = options.max_output_tokens;

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    return {
      sessionId,
      status: 'ready',
      adapter: this.name,
      model: session.model
    };
  }

  /**
   * Send a message and yield response chunks (streaming)
   * This is the fast path — direct API call, no CLI process spawn
   */
  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const startTime = Date.now();

    // Build contents array with full conversation history
    const contents = [
      ...session.history,
      { role: 'user', parts: [{ text: message }] }
    ];

    // Build config
    const config = { ...session.generationConfig };

    if (session.systemPrompt) {
      config.systemInstruction = session.systemPrompt;
    }

    // Per-message overrides
    if (options.maxOutputTokens) config.maxOutputTokens = options.maxOutputTokens;
    if (options.temperature !== undefined) config.temperature = options.temperature;

    // Remove undefined values
    for (const key of Object.keys(config)) {
      if (config[key] === undefined) delete config[key];
    }

    const timeout = options.timeout || this.config.timeout;
    const timeoutId = setTimeout(() => {
      const controller = this.activeRequests.get(sessionId);
      if (controller) controller.abort();
    }, timeout);

    const abortController = new AbortController();
    this.activeRequests.set(sessionId, abortController);

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const response = await this.client.models.generateContentStream({
        model: session.model,
        contents,
        config
      });

      for await (const chunk of response) {
        const text = chunk.text;
        if (text) {
          fullContent += text;
          yield {
            type: 'progress',
            progressType: 'assistant',
            content: text
          };
        }

        // Extract token usage from final chunk
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount || 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
      }

      // Update conversation history
      session.history.push(
        { role: 'user', parts: [{ text: message }] },
        { role: 'model', parts: [{ text: fullContent }] }
      );
      session.messageCount++;

      const elapsed = Date.now() - startTime;

      yield {
        type: 'result',
        content: fullContent,
        metadata: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          toolCalls: 0,
          timedOut: false,
          latencyMs: elapsed,
          model: session.model
        }
      };

    } catch (error) {
      if (error.name === 'AbortError' || abortController.signal.aborted) {
        yield { type: 'error', content: `Request timed out after ${timeout}ms`, timedOut: true };
      } else {
        yield { type: 'error', content: error.message || 'Gemini API error', timedOut: false };
      }
    } finally {
      clearTimeout(timeoutId);
      this.activeRequests.delete(sessionId);
    }
  }

  /**
   * Interrupt an active request
   */
  async interrupt(sessionId) {
    const controller = this.activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Terminate a session (instant — no process to kill)
   */
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

  /**
   * Generation params metadata for server routes
   */
  getGenerationParams() {
    return {
      temperature: { min: 0, max: 2, default: 1 },
      topP: { min: 0, max: 1, default: 0.95 },
      topK: { min: 1, max: 100, default: 40 },
      maxOutputTokens: { min: 1, max: 65536, default: 8192 }
    };
  }
}

module.exports = GeminiApiAdapter;
