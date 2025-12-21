/**
 * OpenAI-Compatible API Layer
 *
 * Provides OpenAI-compatible endpoints (/v1/chat/completions, /v1/models)
 * that translate to the internal cliagents adapter interface.
 *
 * This allows developers to:
 * 1. Use cliagents during development with CLI agents
 * 2. Switch to direct API in production by just changing baseURL
 * 3. Use existing OpenAI SDK with cliagents
 *
 * @license MIT
 * @copyright 2025 cliagents contributors
 */

const express = require('express');
const crypto = require('crypto');

/**
 * Model mapping: OpenAI/Claude/Gemini model names → CLI adapters
 */
const MODEL_MAP = {
  // OpenAI models → Codex CLI
  'gpt-4': { adapter: 'codex-cli', model: 'gpt-4o' },
  'gpt-4o': { adapter: 'codex-cli', model: 'gpt-4o' },
  'gpt-4o-mini': { adapter: 'codex-cli', model: 'gpt-4o-mini' },
  'gpt-4-turbo': { adapter: 'codex-cli', model: 'gpt-4o' },
  'gpt-3.5-turbo': { adapter: 'codex-cli', model: 'gpt-4o-mini' },
  'o3-mini': { adapter: 'codex-cli', model: 'o3-mini' },
  'o4-mini': { adapter: 'codex-cli', model: 'o4-mini' },

  // Claude models → Claude Code
  'claude-sonnet-4-20250514': { adapter: 'claude-code', model: 'claude-sonnet-4-20250514' },
  'claude-opus-4-5-20250514': { adapter: 'claude-code', model: 'claude-opus-4-5-20250514' },
  'claude-3-5-sonnet-20241022': { adapter: 'claude-code', model: 'claude-3-5-sonnet-20241022' },
  'claude-3-5-haiku-20241022': { adapter: 'claude-code', model: 'claude-3-5-haiku-20241022' },
  'claude-3-opus-20240229': { adapter: 'claude-code', model: 'claude-3-opus-20240229' },
  'claude-3-sonnet-20240229': { adapter: 'claude-code', model: 'claude-3-sonnet-20240229' },

  // Gemini models → Gemini CLI
  'gemini-2.5-flash': { adapter: 'gemini-cli', model: 'gemini-2.5-flash' },
  'gemini-2.5-pro': { adapter: 'gemini-cli', model: 'gemini-2.5-pro' },
  'gemini-3-pro-preview': { adapter: 'gemini-cli', model: 'gemini-3-pro-preview' },
  'gemini-pro': { adapter: 'gemini-cli', model: 'default' },

  // Mistral models → Vibe CLI
  'devstral': { adapter: 'mistral-vibe', model: 'devstral' },
  'devstral-small': { adapter: 'mistral-vibe', model: 'devstral-small' },
  'codestral': { adapter: 'mistral-vibe', model: 'codestral' },

  // Amazon Q
  'amazon-q': { adapter: 'amazon-q', model: 'default' },

  // GitHub Copilot
  'copilot': { adapter: 'github-copilot', model: 'default' }
};

/**
 * Generate a unique ID for responses
 */
function generateId() {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * Build a single prompt from OpenAI messages array
 * For stateless compatibility, we concatenate all messages
 */
function buildPromptFromMessages(messages) {
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  if (nonSystemMessages.length === 0) {
    return '';
  }

  // If only one user message, just return its content
  if (nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user') {
    const content = nonSystemMessages[0].content;
    // Handle array content (vision messages)
    if (Array.isArray(content)) {
      return content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    return content;
  }

  // Multiple messages - format as conversation
  let prompt = '';
  for (const msg of nonSystemMessages) {
    const content = Array.isArray(msg.content)
      ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : msg.content;

    if (msg.role === 'user') {
      prompt += `User: ${content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant: ${content}\n\n`;
    }
  }

  return prompt.trim();
}

/**
 * Extract system prompt from messages
 */
function extractSystemPrompt(messages) {
  const systemMessages = messages.filter(m => m.role === 'system');
  if (systemMessages.length === 0) {
    return null;
  }
  return systemMessages.map(m => {
    if (Array.isArray(m.content)) {
      return m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    return m.content;
  }).join('\n');
}

/**
 * Translate OpenAI request format to internal format
 */
function translateOpenAIRequest(body) {
  const { model, messages, stream, temperature, max_tokens, top_p, stop } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages is required and must be a non-empty array');
  }

  // Validate message format
  for (const msg of messages) {
    if (!msg.role || (msg.content === undefined && msg.content === null)) {
      throw new Error('Each message must have role and content fields');
    }
    if (!['system', 'user', 'assistant'].includes(msg.role)) {
      throw new Error(`Invalid message role: ${msg.role}`);
    }
  }

  // Extract system prompt
  const systemPrompt = extractSystemPrompt(messages);

  // Build prompt from conversation
  const prompt = buildPromptFromMessages(messages);

  if (!prompt) {
    throw new Error('No user message found in messages array');
  }

  // Map model to adapter (default to claude-code if unknown)
  const mapping = MODEL_MAP[model] || { adapter: 'claude-code', model: 'default' };

  return {
    adapter: mapping.adapter,
    model: mapping.model,
    systemPrompt,
    message: prompt,
    stream: stream ?? false,
    options: {
      temperature,
      max_output_tokens: max_tokens,
      top_p,
      stop
    }
  };
}

/**
 * Translate internal response to OpenAI format (non-streaming)
 */
function translateToOpenAIResponse(content, metadata, requestModel, startTime) {
  const id = `chatcmpl-${generateId()}`;

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(startTime / 1000),
    model: requestModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || ''
      },
      logprobs: null,
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: metadata?.inputTokens || 0,
      completion_tokens: metadata?.outputTokens || 0,
      total_tokens: (metadata?.inputTokens || 0) + (metadata?.outputTokens || 0)
    }
  };
}

/**
 * Create OpenAI-compatible streaming chunk
 */
function createStreamChunk(id, content, finishReason = null, isFirst = false) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'cli-agent',
    choices: [{
      index: 0,
      delta: {},
      logprobs: null,
      finish_reason: finishReason
    }]
  };

  if (isFirst) {
    chunk.choices[0].delta.role = 'assistant';
  }

  if (content) {
    chunk.choices[0].delta.content = content;
  }

  return chunk;
}

/**
 * Create the OpenAI-compatible router
 * @param {SessionManager} sessionManager - The session manager instance
 */
function createOpenAIRouter(sessionManager) {
  const router = express.Router();

  /**
   * POST /v1/chat/completions
   * OpenAI-compatible chat completions endpoint
   */
  router.post('/chat/completions', async (req, res) => {
    const startTime = Date.now();
    let sessionId = null;

    try {
      // Translate request
      const { adapter, model, systemPrompt, message, stream, options } =
        translateOpenAIRequest(req.body);

      // Check if adapter is available
      if (!sessionManager.adapters.has(adapter)) {
        return res.status(400).json({
          error: {
            message: `Model '${req.body.model}' is not available. The adapter '${adapter}' is not registered.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found'
          }
        });
      }

      const adapterInstance = sessionManager.adapters.get(adapter);
      const isAvailable = await adapterInstance.isAvailable();

      if (!isAvailable) {
        return res.status(503).json({
          error: {
            message: `Model '${req.body.model}' is not available. The CLI for '${adapter}' is not installed.`,
            type: 'server_error',
            param: 'model',
            code: 'model_unavailable'
          }
        });
      }

      // Create ephemeral session
      const sessionOptions = {
        adapter,
        model,
        systemPrompt,
        temperature: options.temperature,
        top_p: options.top_p,
        max_output_tokens: options.max_output_tokens
      };

      const session = await sessionManager.createSession(sessionOptions);
      sessionId = session.sessionId;

      if (stream) {
        // Streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const id = `chatcmpl-${generateId()}`;
        let clientDisconnected = false;

        // Handle client disconnect to clean up resources
        req.on('close', async () => {
          clientDisconnected = true;
          if (sessionId) {
            try {
              await sessionManager.terminateSession(sessionId);
              sessionId = null; // Prevent double cleanup in finally
            } catch (e) {
              // Session may already be cleaned up
            }
          }
        });
        let isFirst = true;
        let fullContent = '';

        try {
          // Send initial chunk with role
          const firstChunk = createStreamChunk(id, null, null, true);
          res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
          isFirst = false;

          // Stream content
          for await (const chunk of sessionManager.sendStream(sessionId, message, options)) {
            if (chunk.type === 'progress' && chunk.progressType === 'assistant' && chunk.content) {
              fullContent += chunk.content;
              const streamChunk = createStreamChunk(id, chunk.content);
              res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
            } else if (chunk.type === 'result' && chunk.content) {
              // If we get a final result with content we haven't streamed
              if (chunk.content && chunk.content !== fullContent) {
                const remainingContent = chunk.content.substring(fullContent.length);
                if (remainingContent) {
                  const streamChunk = createStreamChunk(id, remainingContent);
                  res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
                }
              }
            }
          }

          // Send final chunk with finish_reason
          const finalChunk = createStreamChunk(id, null, 'stop');
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();

        } catch (streamError) {
          // Send error in stream format
          res.write(`data: ${JSON.stringify({ error: { message: streamError.message } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }

      } else {
        // Non-streaming response
        let finalContent = '';
        let finalMetadata = {};

        for await (const chunk of sessionManager.sendStream(sessionId, message, options)) {
          if (chunk.type === 'progress' && chunk.progressType === 'assistant' && chunk.content) {
            finalContent += chunk.content;
          } else if (chunk.type === 'result') {
            if (chunk.content) {
              finalContent = chunk.content;
            }
            finalMetadata = chunk.metadata || {};
          }
        }

        res.json(translateToOpenAIResponse(finalContent, finalMetadata, req.body.model, startTime));
      }

    } catch (error) {
      console.error('[OpenAI Compat] Error:', error.message);

      // Determine appropriate status code
      let status = 500;
      let errorType = 'internal_error';

      if (error.message.includes('required') || error.message.includes('invalid')) {
        status = 400;
        errorType = 'invalid_request_error';
      }

      res.status(status).json({
        error: {
          message: error.message,
          type: errorType,
          param: null,
          code: null
        }
      });
    } finally {
      // Clean up session
      if (sessionId) {
        try {
          await sessionManager.terminateSession(sessionId);
        } catch (e) {
          console.error('[OpenAI Compat] Session cleanup error:', e.message);
        }
      }
    }
  });

  /**
   * GET /v1/models
   * Returns available models based on which CLI adapters are installed
   */
  router.get('/models', async (req, res) => {
    try {
      const models = [];
      const checkedAdapters = new Map();

      for (const [modelName, mapping] of Object.entries(MODEL_MAP)) {
        // Cache adapter availability checks
        if (!checkedAdapters.has(mapping.adapter)) {
          const adapter = sessionManager.adapters.get(mapping.adapter);
          if (adapter) {
            const isAvailable = await adapter.isAvailable();
            checkedAdapters.set(mapping.adapter, isAvailable);
          } else {
            checkedAdapters.set(mapping.adapter, false);
          }
        }

        if (checkedAdapters.get(mapping.adapter)) {
          models.push({
            id: modelName,
            object: 'model',
            created: 1700000000,
            owned_by: mapping.adapter
          });
        }
      }

      res.json({
        object: 'list',
        data: models
      });

    } catch (error) {
      console.error('[OpenAI Compat] Models error:', error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: 'internal_error'
        }
      });
    }
  });

  /**
   * GET /v1/models/:model
   * Get details for a specific model
   */
  router.get('/models/:model', async (req, res) => {
    const modelName = req.params.model;
    const mapping = MODEL_MAP[modelName];

    if (!mapping) {
      return res.status(404).json({
        error: {
          message: `Model '${modelName}' not found`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found'
        }
      });
    }

    const adapter = sessionManager.adapters.get(mapping.adapter);
    if (!adapter) {
      return res.status(404).json({
        error: {
          message: `Model '${modelName}' not available (adapter not registered)`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found'
        }
      });
    }

    const isAvailable = await adapter.isAvailable();

    res.json({
      id: modelName,
      object: 'model',
      created: 1700000000,
      owned_by: mapping.adapter,
      available: isAvailable
    });
  });

  return router;
}

module.exports = {
  createOpenAIRouter,
  MODEL_MAP,
  translateOpenAIRequest,
  translateToOpenAIResponse,
  buildPromptFromMessages,
  extractSystemPrompt
};
