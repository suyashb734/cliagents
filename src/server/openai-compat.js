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
const fs = require('fs');
const path = require('path');

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

  // Gemini models → Gemini CLI (for agentic dev work with tool use)
  'gemini-2.5-flash': { adapter: 'gemini-cli', model: 'gemini-2.5-flash' },
  'gemini-2.5-pro': { adapter: 'gemini-cli', model: 'gemini-2.5-pro' },
  'gemini-3-pro-preview': { adapter: 'gemini-cli', model: 'gemini-3-pro-preview' },
  'gemini-pro': { adapter: 'gemini-cli', model: 'default' },

  // Gemini models → Gemini API (for fast production Q&A, no CLI overhead)
  'gemini-2.5-flash-api': { adapter: 'gemini-api', model: 'gemini-2.5-flash' },
  'gemini-2.5-pro-api': { adapter: 'gemini-api', model: 'gemini-2.5-pro' },
  'gemini-2.0-flash-api': { adapter: 'gemini-api', model: 'gemini-2.0-flash' },
  'gemini-api': { adapter: 'gemini-api', model: 'gemini-2.5-flash' },

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
 * Cleanup temporary image files
 */
function cleanupImages(images) {
  if (!images || !Array.isArray(images)) return;
  
  for (const img of images) {
    if (img.type === 'file' && img.path) {
      try {
        if (fs.existsSync(img.path)) {
          fs.unlinkSync(img.path);
        }
      } catch (e) {
        console.error(`[OpenAI Compat] Failed to delete temp file ${img.path}:`, e.message);
      }
    }
  }
}

/**
 * Extract images from messages and save to temp files if needed
 */
function extractImagesFromMessages(messages) {
  const images = [];
  const tempDir = '/tmp/cliagents-images/';
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB limit

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url && part.image_url.url) {
          const imageUrl = part.image_url.url;
          
          if (imageUrl.startsWith('data:')) {
            // Base64 image
            try {
              // Check approximate size (base64 is ~1.33x larger than binary)
              if (imageUrl.length > MAX_IMAGE_SIZE * 1.4) {
                console.warn('[OpenAI Compat] Image too large, skipping processing');
                continue;
              }

              // Format: data:image/png;base64,.....
              const matches = imageUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
              if (matches) {
                const ext = matches[1];
                const data = matches[2];
                const filename = `img-${crypto.randomBytes(8).toString('hex')}.${ext}`;
                const filePath = path.join(tempDir, filename);
                
                fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
                images.push({ path: filePath, type: 'file' });
                
                // Update message with file path for the prompt builder
                part.image_url.url = filePath;
              }
            } catch (e) {
              console.error('Failed to process base64 image:', e);
            }
          } else {
            // HTTP URL
            images.push({ path: imageUrl, type: 'url' });
          }
        }
      }
    }
  }
  
  return images;
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

  // Helper to format content parts
  const formatContent = (content) => {
    if (Array.isArray(content)) {
      return content
        .map(c => {
          if (c.type === 'text') return c.text;
          if (c.type === 'image_url') return `[Attached image: ${c.image_url.url}]`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return content;
  };

  // If only one user message, just return its content
  if (nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user') {
    return formatContent(nonSystemMessages[0].content);
  }

  // Multiple messages - format as conversation
  let prompt = '';
  for (const msg of nonSystemMessages) {
    const content = formatContent(msg.content);

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
 * Extract valid JSON from a response that may contain preamble text.
 * Tries JSON.parse first (fast path), then finds the first { or [ and works backward
 * from the last matching } or ] to find valid JSON.
 * Returns the original text unchanged if no valid JSON is found.
 */
function extractJsonFromResponse(text) {
  if (!text || typeof text !== 'string') return text;

  const trimmed = text.trim();

  // Fast path: already valid JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Not valid JSON as-is, try extraction
  }

  // Find first { or [
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');

  let startIdx = -1;
  let endChar = '';

  if (firstBrace === -1 && firstBracket === -1) return text;

  if (firstBrace === -1) {
    startIdx = firstBracket;
    endChar = ']';
  } else if (firstBracket === -1) {
    startIdx = firstBrace;
    endChar = '}';
  } else if (firstBrace < firstBracket) {
    startIdx = firstBrace;
    endChar = '}';
  } else {
    startIdx = firstBracket;
    endChar = ']';
  }

  // From the last occurrence of the matching close char, work backward
  for (let endIdx = trimmed.lastIndexOf(endChar); endIdx > startIdx; endIdx = trimmed.lastIndexOf(endChar, endIdx - 1)) {
    const candidate = trimmed.substring(startIdx, endIdx + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try shorter substring
    }
  }

  // No valid JSON found, return original
  return text;
}

/**
 * Detect rate limit errors in response text from CLI agents.
 * CLI agents output rate limit errors as normal text (exit code 0),
 * so we need to inspect content for known patterns.
 */
function detectRateLimitError(text) {
  if (!text || typeof text !== 'string') return false;
  return /rate.?limit|overloaded|too many requests|quota exceeded|ResourceExhausted/i.test(text);
}

/**
 * Translate OpenAI request format to internal format
 */
function translateOpenAIRequest(body) {
  const { model, messages, stream, temperature, max_tokens, top_p, stop, response_format, timeout } = body;

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

  // Extract images
  const images = extractImagesFromMessages(messages);

  // Extract system prompt
  let systemPrompt = extractSystemPrompt(messages);

  // Build prompt from conversation
  const prompt = buildPromptFromMessages(messages);

  if (!prompt) {
    throw new Error('No user message found in messages array');
  }

  // Map model to adapter (default to claude-code if unknown)
  const mapping = MODEL_MAP[model] || { adapter: 'claude-code', model: 'default' };

  const options = {
    temperature,
    max_output_tokens: max_tokens,
    top_p,
    stop
  };

  if (response_format) {
    if (response_format.type === 'json_schema' && response_format.json_schema) {
      options.jsonSchema = response_format.json_schema.schema;
      options.jsonMode = true;
    } else if (response_format.type === 'json_object') {
      options.jsonMode = true;
    }
  }

  // Augment system prompt for JSON mode (defense in depth with extraction)
  if (options.jsonMode) {
    const jsonInstruction = 'You MUST respond with valid JSON only. Do not include any text before or after the JSON.';
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${jsonInstruction}`
      : jsonInstruction;
  }

  return {
    adapter: mapping.adapter,
    model: mapping.model,
    systemPrompt,
    message: prompt,
    stream: stream ?? false,
    options,
    responseFormat: response_format || null,
    timeout: timeout || null,
    images
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
    let createdImages = [];

    try {
      // Translate request
      const { adapter, model, systemPrompt, message, stream, options, responseFormat, timeout: requestTimeout, images } =
        translateOpenAIRequest(req.body);

      if (images) createdImages = images;

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

      // Resolve timeout: body > header > default
      const effectiveTimeout = requestTimeout
        || (req.headers['x-request-timeout'] ? parseInt(req.headers['x-request-timeout'], 10) : null)
        || null;
      if (effectiveTimeout) {
        options.timeout = effectiveTimeout;
      }

      // Create ephemeral session
      const sessionOptions = {
        adapter,
        model,
        systemPrompt,
        temperature: options.temperature,
        top_p: options.top_p,
        max_output_tokens: options.max_output_tokens,
        jsonSchema: options.jsonSchema,
        jsonMode: options.jsonMode,
        images
      };

      const session = await sessionManager.createSession(sessionOptions);
      sessionId = session.sessionId;

      // Pass images to send options so adapters can access image files
      if (images && images.length > 0) {
        options.images = images;
      }

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
            } else if (chunk.type === 'error' && chunk.content && detectRateLimitError(chunk.content)) {
              // Rate limit error from adapter — send as SSE error event
              res.write(`data: ${JSON.stringify({ error: { message: chunk.content, type: 'rate_limit_error', code: 'rate_limit_exceeded' } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
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

          // Check if accumulated content is a rate limit error (short response)
          if (fullContent.length < 500 && detectRateLimitError(fullContent)) {
            res.write(`data: ${JSON.stringify({ error: { message: fullContent, type: 'rate_limit_error', code: 'rate_limit_exceeded' } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
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

        // Check for rate limit errors in response content
        if (detectRateLimitError(finalContent)) {
          return res.status(429).json({
            error: {
              message: finalContent,
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded'
            }
          });
        }

        // Extract JSON from response if json_object or json_schema mode requested
        if (responseFormat && (responseFormat.type === 'json_object' || responseFormat.type === 'json_schema')) {
          finalContent = extractJsonFromResponse(finalContent);
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

      // Clean up temp images
      cleanupImages(createdImages);
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
  extractSystemPrompt,
  extractJsonFromResponse,
  detectRateLimitError
};
