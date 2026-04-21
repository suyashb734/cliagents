/**
 * handoff() - Synchronous task delegation to a worker agent
 *
 * Creates a worker terminal, sends a task, waits for completion,
 * extracts the output, and cleans up. Returns the result to the caller.
 *
 * This is the primary orchestration primitive for delegating tasks
 * that need to complete before the caller can continue.
 *
 * Features:
 * - Retry with exponential backoff for transient failures
 * - Per-request timeout (no circuit breaker - inappropriate for local CLI processes)
 * - Context summarization to reduce token bloat
 *
 * Note: Circuit breakers were removed because they are designed for remote services
 * with cascading failure risks. Local CLI processes in isolated tmux sessions don't
 * have these failure modes - a slow Claude response doesn't affect Gemini.
 */

const crypto = require('crypto');
const { TerminalStatus } = require('../models/terminal-status');
const { loadProfile } = require('../services/agent-profiles');
const { summarizeOutput, createHandoffSummary, extractKeyDecisions, extractPendingItems } = require('../utils/context-summarizer');
const { getDB } = require('../database/db');
const { isAdapterAuthenticated } = require('../utils/adapter-auth');
const { defineAdapterReadiness } = require('../adapters/contract');
// Use unified output extraction (Gap #3 resolution)
const { extractOutput: extractOutputShared, stripAnsiCodes } = require('../utils/output-extractor');
// Permission interceptor for fine-grained permission control
const { PermissionInterceptor } = require('../interceptor');
const { PermissionManager } = require('../permissions');
// File-based output protocol for reliable extraction
const { FileOutputManager, enhanceSystemPromptWithFileOutput } = require('../pool/file-output-protocol');

// Default timeout for orchestration requests (5 minutes)
// Research and complex tasks often exceed 2 minutes
const DEFAULT_ORCHESTRATION_TIMEOUT = 5 * 60; // 5 minutes in seconds

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  jitter: true,
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'timed out', 'Worker failed to initialize']
};

// ADAPTER_OUTPUT_STRATEGIES moved to src/utils/output-extractor.js (Gap #3 resolution)

/**
 * Generate a trace ID for tracking
 */
function generateTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Truncate text for summaries
 */
function truncate(text, maxLength = 2000) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '... [truncated]';
}

/**
 * Detect terminal-scraped failures that should not be reported as successful handoffs.
 */
function detectExecutionFailure(output, fullOutput = '') {
  const combined = [output, fullOutput]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');

  if (!combined.trim()) {
    return 'Worker completed without producing output';
  }

  const failurePatterns = [
    [/you'?ve hit your usage limit/i, 'Worker hit its usage limit'],
    [/rate limit exceeded|too many requests|resourceexhausted/i, 'Worker hit a rate limit'],
    [/not authenticated|authentication failed|please log in|login required/i, 'Worker is not authenticated'],
    [/process exited with code \d+/i, 'Worker process exited with a non-zero status'],
    [/error:\s*(quota|auth|authentication|permission|timeout)/i, 'Worker reported an execution error']
  ];

  for (const [pattern, message] of failurePatterns) {
    if (pattern.test(combined)) {
      return message;
    }
  }

  return null;
}

/**
 * Calculate delay for retry with exponential backoff
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} config - Retry configuration
 * @returns {number} - Delay in milliseconds
 */
function calculateBackoff(attempt, config) {
  const { baseDelay, maxDelay, jitter } = config;

  // Exponential backoff: baseDelay * 2^attempt
  let delay = baseDelay * Math.pow(2, attempt);

  // Cap at maxDelay
  delay = Math.min(delay, maxDelay);

  // Add jitter (±25%) to prevent thundering herd
  if (jitter) {
    const jitterFactor = 0.5 * Math.random() + 0.75; // 0.75 to 1.25
    delay = Math.floor(delay * jitterFactor);
  }

  return delay;
}

/**
 * Check if an error is retryable
 * @param {Error} error - The error to check
 * @param {Object} config - Retry configuration
 * @returns {boolean} - Whether the error is retryable
 */
function isRetryable(error, config) {
  const message = error.message || '';

  // Check against retryable patterns
  for (const pattern of config.retryableErrors) {
    if (message.includes(pattern)) {
      return true;
    }
  }

  // Check for network errors
  if (error.code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) {
    return true;
  }

  // Check for timeout errors
  if (error.isTimeout) {
    return true;
  }

  return false;
}

/**
 * Sleep for a given duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build an enhanced message that includes shared context from other agents
 * @param {string} message - Original task message
 * @param {Array} findings - Prior findings from other agents
 * @param {Array} context - Prior context entries
 * @returns {string} - Enhanced message with shared context
 */
function buildEnhancedMessage(message, findings, context) {
  let enhanced = '';

  // Ensure arrays are valid
  const safeFindings = Array.isArray(findings) ? findings : [];
  const safeContext = Array.isArray(context) ? context : [];

  // Add prior context summary
  if (safeContext.length > 0) {
    const latest = safeContext[0]; // Most recent context
    enhanced += `## Prior Context\n${latest.summary || ''}\n`;

    // Safely handle keyDecisions - could be null, undefined, or array
    const keyDecisions = Array.isArray(latest.keyDecisions) ? latest.keyDecisions : [];
    if (keyDecisions.length > 0) {
      enhanced += `\n**Key Decisions:**\n`;
      keyDecisions.forEach(d => {
        enhanced += `- ${d}\n`;
      });
    }

    // Safely handle pendingItems - could be null, undefined, or array
    const pendingItems = Array.isArray(latest.pendingItems) ? latest.pendingItems : [];
    if (pendingItems.length > 0) {
      enhanced += `\n**Pending Items:**\n`;
      pendingItems.forEach(p => {
        enhanced += `- ${p}\n`;
      });
    }

    enhanced += '\n';
  }

  // Add findings from other agents
  if (safeFindings.length > 0) {
    enhanced += `## Findings from Other Agents\n`;
    safeFindings.forEach(f => {
      const profile = f.agent_profile || f.agent_id || 'unknown';
      const severity = f.severity ? `[${f.severity}]` : '';
      enhanced += `- **${profile}** (${f.type || 'info'})${severity}: ${f.content || ''}\n`;
    });
    enhanced += '\n';
  }

  // Add the original task
  enhanced += `## Your Task\n${message}`;

  return enhanced;
}

/**
 * Extract final output from terminal log/output
 * Delegates to unified output-extractor utility (Gap #3 resolution)
 * Kept as local function for backward compatibility with existing callers
 */
function extractOutput(output, adapter) {
  return extractOutputShared(output, adapter);
}

function getLegacyInitReadiness(adapter) {
  if (adapter === 'claude-code') {
    return {
      initTimeoutMs: 45000,
      promptHandlers: [
        {
          matchAny: ['Settings Error', 'Continue without these settings'],
          actions: ['Down', 'Enter'],
          description: 'continue-without-invalid-claude-settings'
        }
      ]
    };
  }

  if (adapter === 'codex-cli') {
    return {
      initTimeoutMs: 90000,
      promptHandlers: [
        {
          matchAny: ['Update now', 'Skip until next version'],
          actions: ['Down', 'Enter'],
          description: 'skip-codex-update-menu'
        },
        {
          matchAny: ['Press enter to continue', 'Update available'],
          actions: ['Enter'],
          description: 'dismiss-codex-update-info'
        }
      ]
    };
  }

  if (adapter === 'gemini-cli') {
    return {
      initTimeoutMs: 60000,
      promptHandlers: [
        {
          matchAny: ['Do you trust this folder', 'Trust folder'],
          actions: ['Enter'],
          description: 'accept-gemini-trust-folder'
        }
      ]
    };
  }

  if (adapter === 'qwen-cli') {
    return {
      initTimeoutMs: 60000
    };
  }

  return {
    initTimeoutMs: 45000
  };
}

function resolveInitReadinessPolicy(adapter, options = {}) {
  const runtimeAdapter = options.runtimeAdapter || null;
  const runtimeContract = typeof runtimeAdapter?.getContract === 'function'
    ? runtimeAdapter.getContract()
    : null;
  const contractReadiness = runtimeContract?.readiness || null;

  return defineAdapterReadiness({
    ...getLegacyInitReadiness(adapter),
    ...(contractReadiness || {}),
    ...(options.readiness || {})
  });
}

/**
 * Handle blocking interactive prompts during CLI initialization.
 *
 * Different CLIs may show prompts during startup that block the IDLE state:
 * - Claude Code: Settings Error dialog (invalid .claude/settings.json)
 * - Codex CLI: Update available prompt
 * - Gemini CLI: "Do you trust this folder?" prompt
 *
 * This function detects these prompts and auto-dismisses them.
 */
async function handleInitPrompts(sessionManager, terminalId, adapter, traceId, options = {}) {
  const readinessPolicy = options.readinessPolicy
    ? defineAdapterReadiness(options.readinessPolicy)
    : resolveInitReadinessPolicy(adapter, options);
  const {
    promptMaxWaitMs: maxWaitMs,
    promptPollIntervalMs: pollIntervalMs,
    promptSettleDelayMs: settleDelayMs,
    promptMaxRounds: maxRounds,
    promptFallbackAction,
    promptHandlers
  } = readinessPolicy;

  const deadline = Date.now() + maxWaitMs;
  let round = 0;

  while (Date.now() < deadline && round < maxRounds) {
    const currentStatus = sessionManager.getStatus(terminalId);
    if (
      currentStatus === TerminalStatus.IDLE ||
      currentStatus === TerminalStatus.PROCESSING ||
      currentStatus === TerminalStatus.COMPLETED
    ) {
      return;
    }

    if (currentStatus !== TerminalStatus.WAITING_USER_ANSWER) {
      await sleep(pollIntervalMs);
      continue;
    }

    const output = sessionManager.getOutput(terminalId, 1000);
    let handled = false;
    const matchedHandler = promptHandlers.find((handler) =>
      handler.matchAny.some((pattern) => output.includes(pattern))
    );

    if (matchedHandler) {
      console.log(`[handoff] ${adapter} init prompt matched '${matchedHandler.description || matchedHandler.matchAny[0]}' (round ${round + 1})`);
      for (let index = 0; index < matchedHandler.actions.length; index += 1) {
        sessionManager.sendSpecialKey(terminalId, matchedHandler.actions[index]);
        if (index < matchedHandler.actions.length - 1) {
          await sleep(300);
        }
      }
      handled = true;
    }

    if (!handled && promptFallbackAction) {
      console.log(`[handoff] Unknown WAITING_USER_ANSWER prompt for ${adapter} (round ${round + 1}), pressing ${promptFallbackAction}...`);
      sessionManager.sendSpecialKey(terminalId, promptFallbackAction);
    }

    round += 1;
    await sleep(settleDelayMs);
  }
}

/**
 * Execute a single handoff attempt (internal)
 */
async function executeHandoffAttempt(agentProfile, message, profile, options) {
  const {
    timeout = DEFAULT_ORCHESTRATION_TIMEOUT,
    returnSummary = false,
    maxSummaryLength = 2000,
    summarizeForHandoff = false,
    targetProfile = null,
    taskType = null,
    context = {},
    useFileOutput = false,  // Enable file-based output protocol
    outputFormat = 'text',   // 'text' or 'json'
    workDir = null
  } = options;

  let { sessionManager, db } = context;

  // File output manager (created if useFileOutput is true)
  let fileOutputManager = null;

  // Ensure db is available if not passed in context
  if (!db) {
    try {
      db = getDB();
    } catch (e) {
      // DB might not be initialized in some contexts (e.g. tests)
    }
  }

  // Generate trace ID for tracking
  const traceId = generateTraceId();
  let spanId = null;
  let worker = null;
  let stopInterceptor = null;  // Declared outside try for catch block access
  let fileOutputTerminalId = null;  // Declared outside try for catch block access

  try {
    // Create trace if db available
    if (db) {
      db.createTrace(traceId, null, `handoff:${agentProfile}`, {
        message: truncate(message, 500)
      });
      spanId = db.addSpan(traceId, 'pending', `handoff:${agentProfile}`, truncate(message, 500));
    }

    // 0. Check adapter authentication before creating terminal
    // This prevents hanging on interactive auth prompts (e.g., Gemini "Waiting for auth...")
    const authCheck = isAdapterAuthenticated(profile.adapter);
    if (!authCheck.authenticated) {
      throw new Error(`Adapter ${profile.adapter} not authenticated: ${authCheck.reason}`);
    }

    // 1. Create worker terminal
    // If using file output, we need to prepare the enhanced system prompt
    let systemPrompt = profile.systemPrompt;
    const terminalIdForFileOutput = crypto.randomBytes(4).toString('hex');  // Pre-generate for file path

    if (useFileOutput) {
      fileOutputManager = new FileOutputManager();
      // Enhance system prompt with file output instructions
      systemPrompt = enhanceSystemPromptWithFileOutput(
        systemPrompt || '',
        terminalIdForFileOutput,
        { format: outputFormat }
      );
      console.log(`[handoff] Using file-based output for ${agentProfile}`);
    }

    worker = await sessionManager.createTerminal({
      adapter: profile.adapter,
      agentProfile,
      role: 'worker',
      systemPrompt,
      allowedTools: profile.allowedTools,
      // Pass permissionMode from profile (Gap #4 resolution)
      permissionMode: profile.permissionMode,
      workDir: workDir || undefined
    });

    // Map the actual terminal ID to our pre-generated one for file output
    fileOutputTerminalId = useFileOutput ? terminalIdForFileOutput : worker.terminalId;

    // 1.5. Start permission interceptor if using interceptor mode or restricted tools
    const hasRestrictedAllowedTools = Array.isArray(profile.allowedTools) &&
      profile.allowedTools.length > 0 &&
      (!profile.allowedTools.includes('Write') ||
        !profile.allowedTools.includes('Edit') ||
        !profile.allowedTools.includes('Bash') ||
        !profile.allowedTools.includes('Task'));
    const shouldStartInterceptor = profile.permissionMode === 'interceptor' || hasRestrictedAllowedTools;

    if (shouldStartInterceptor) {
      // Create permission manager from profile settings
      const permissionManager = PermissionManager.fromProfile ?
        PermissionManager.fromProfile(profile, options.workDir || process.cwd()) :
        new PermissionManager({
          allowedTools: profile.allowedTools || null,
          deniedTools: profile.deniedTools || [],
          allowedPaths: options.workDir ? [options.workDir] : [process.cwd()]
        });

      const interceptor = new PermissionInterceptor({
        sessionManager,
        permissionManager
      });

      // Log permission events
      interceptor.on('permission-allowed', ({ terminalId, promptInfo }) => {
        console.log(`[interceptor] Allowed ${promptInfo.toolName} for ${terminalId}`);
      });
      interceptor.on('permission-denied', ({ terminalId, promptInfo, result }) => {
        console.log(`[interceptor] Denied ${promptInfo.toolName} for ${terminalId}: ${result.reason}`);
      });

      stopInterceptor = interceptor.start(worker.terminalId);
      console.log(`[handoff] Started permission interceptor for ${worker.terminalId}`);
    }

    // Update span with terminal ID
    if (db && spanId) {
      db.db.prepare('UPDATE spans SET terminal_id = ? WHERE id = ?').run(worker.terminalId, spanId);
    }

    // 2. Wait for worker to be ready (IDLE)
    const runtimeAdapter = context.apiSessionManager?.getAdapter?.(profile.adapter) || null;
    const readinessPolicy = resolveInitReadinessPolicy(profile.adapter, { runtimeAdapter });
    const initTimeout = readinessPolicy.initTimeoutMs;

    // Auto-handle blocking interactive prompts that prevent IDLE
    // Each adapter may show prompts during initialization that need to be dismissed.
    // We poll the status and check output to detect and handle these prompts.
    await handleInitPrompts(sessionManager, worker.terminalId, profile.adapter, traceId, {
      runtimeAdapter,
      readinessPolicy
    });

    try {
      await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.IDLE, initTimeout);
    } catch (error) {
      // Before giving up, try handling prompts one more time (they may appear late)
      await handleInitPrompts(sessionManager, worker.terminalId, profile.adapter, traceId, {
        runtimeAdapter,
        readinessPolicy
      });
      try {
        await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.IDLE, 15000);
      } catch (retryError) {
        throw new Error(`Worker failed to initialize: ${retryError.message}`);
      }
    }

    // 3. Capture initial output length before sending message
    // This helps us detect if actual work was done (output changed)
    const initialOutput = sessionManager.getOutput(worker.terminalId, 500);
    const initialOutputLength = initialOutput.length;

    // 4. Send task message (pass traceId for message correlation)
    await sessionManager.sendInput(worker.terminalId, message, { traceId });

    // 5. Wait for PROCESSING to start (with short timeout)
    // This ensures we don't accept a false IDLE from status bar patterns
    const processingDetectTimeout = 15000; // 15 seconds to detect processing
    let sawProcessing = false;

    try {
      // Poll for PROCESSING status
      const startTime = Date.now();
      while (Date.now() - startTime < processingDetectTimeout) {
        const status = sessionManager.getStatus(worker.terminalId);
        if (status === TerminalStatus.PROCESSING) {
          sawProcessing = true;
          console.log(`[handoff] PROCESSING detected after ${Date.now() - startTime}ms`);
          break;
        }
        if (status === TerminalStatus.COMPLETED) {
          // Direct completion without processing - very fast response
          console.log(`[handoff] COMPLETED detected immediately`);
          sawProcessing = true; // Treat COMPLETED as having processed
          break;
        }
        if (status === TerminalStatus.ERROR) {
          throw new Error('Worker encountered an error during processing');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (!sawProcessing) {
        console.warn(`[handoff] Warning: PROCESSING not detected within ${processingDetectTimeout}ms, checking output change`);
        // Check if output has changed as a fallback indicator
        const currentOutput = sessionManager.getOutput(worker.terminalId, 500);
        if (currentOutput.length > initialOutputLength + 50) {
          console.log(`[handoff] Output changed (${initialOutputLength} -> ${currentOutput.length}), assuming processing occurred`);
          sawProcessing = true;
        }
      }
    } catch (error) {
      if (!error.message.includes('error during processing')) {
        console.warn(`[handoff] Error detecting processing: ${error.message}`);
      } else {
        throw error;
      }
    }

    // 6. Wait for completion
    const timeoutMs = timeout * 1000;
    try {
      const currentStatus = sessionManager.getStatus(worker.terminalId);
      console.log(`[handoff] Current status=${currentStatus}, sawProcessing=${sawProcessing}`);

      if (currentStatus === TerminalStatus.COMPLETED) {
        // Already completed
        console.log(`[handoff] Task already COMPLETED, extracting output`);
      } else if (currentStatus === TerminalStatus.IDLE && sawProcessing) {
        // IDLE after we saw PROCESSING - task completed
        console.log(`[handoff] Task IDLE after PROCESSING, extracting output`);
      } else if (currentStatus === TerminalStatus.IDLE && !sawProcessing) {
        // IDLE but never saw PROCESSING - might be false positive
        // Wait a bit longer and check output change
        console.log(`[handoff] IDLE without PROCESSING, waiting for actual completion...`);
        await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.COMPLETED, timeoutMs, {
          assumeProcessingStarted: false // Don't assume, wait for real COMPLETED
        });
      } else {
        // Still processing, wait for completion
        console.log(`[handoff] Still processing (${currentStatus}), waiting for completion`);
        await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.COMPLETED, timeoutMs, {
          assumeProcessingStarted: sawProcessing
        });
      }
    } catch (error) {
      throw new Error(`Worker timed out after ${timeout}s`);
    }

    // 6. Extract output
    // Try file-based output first (more reliable), fall back to terminal parsing
    let output = null;
    let outputSource = 'terminal';
    const fullOutput = sessionManager.getOutput(worker.terminalId, 1000);

    if (useFileOutput && fileOutputManager) {
      try {
        const fileResult = await fileOutputManager.readOutput(fileOutputTerminalId, {
          format: outputFormat,
          timeout: 3000  // Wait up to 3s for file
        });
        if (fileResult) {
          output = fileResult.output;
          outputSource = 'file';
          console.log(`[handoff] Output extracted from file (${typeof output === 'string' ? output.length : JSON.stringify(output).length} bytes)`);
        }
      } catch (e) {
        console.warn(`[handoff] File output read failed: ${e.message}, falling back to terminal`);
      }
    }

    // Fall back to terminal output parsing if file not available
    if (!output) {
      output = extractOutput(fullOutput, profile.adapter);
      outputSource = 'terminal';
    }

    const executionFailure = detectExecutionFailure(output, fullOutput);
    if (executionFailure) {
      throw new Error(executionFailure);
    }

    // Store assistant response in message history
    if (db && output) {
      db.addMessage(worker.terminalId, 'assistant', output, {
        traceId,
        metadata: {
          agentProfile,
          adapter: profile.adapter,
          fullOutputLength: fullOutput.length
        }
      });
    }

    // 6. Build result
    const result = {
      success: true,
      terminalId: worker.terminalId,
      traceId,
      adapter: profile.adapter,
      agentProfile,
      outputSource  // 'file' or 'terminal'
    };

    // Apply summarization
    if (summarizeForHandoff && targetProfile) {
      // Use context-aware summarization for multi-agent handoff
      result.output = createHandoffSummary(output, {
        fromProfile: agentProfile,
        toProfile: targetProfile,
        taskType,
        maxLength: maxSummaryLength
      });
      result.wasSummarized = true;
      result.originalLength = output.length;
    } else if (returnSummary) {
      // Simple summarization
      const summaryResult = summarizeOutput(output, {
        maxLength: maxSummaryLength,
        taskType
      });
      result.summary = summaryResult.summary;
      result.fullOutputLength = output.length;
      result.wasSummarized = summaryResult.wasReduced;
    } else {
      result.output = output;
    }

    // Complete span
    if (db && spanId) {
      db.completeSpan(spanId, 'completed', truncate(output, 500));
      db.completeTrace(traceId, 'completed');
    }

    // Auto-store context for future agents if taskId provided
    if (db && options.taskId && output) {
      try {
        const contextSummary = createHandoffSummary(output, {
          fromProfile: agentProfile,
          toProfile: 'next-agent',
          maxLength: 1500
        });
        // Extract key decisions and pending items from the output
        const keyDecisions = extractKeyDecisions(output);
        const pendingItems = extractPendingItems(output);

        db.storeContext(options.taskId, worker.terminalId, {
          summary: contextSummary,
          keyDecisions,
          pendingItems
        });

        if (keyDecisions.length > 0 || pendingItems.length > 0) {
          console.log(`[handoff] Stored context for task ${options.taskId}: ${keyDecisions.length} decisions, ${pendingItems.length} pending items`);
        }
      } catch (e) {
        console.warn('[handoff] Failed to auto-store context:', e.message);
      }
    }

    // 7. Cleanup
    // Stop interceptor if running
    if (stopInterceptor) {
      stopInterceptor();
      console.log(`[handoff] Stopped permission interceptor for ${worker.terminalId}`);
    }
    // Cleanup file output directory
    if (fileOutputManager && useFileOutput) {
      try {
        fileOutputManager.cleanup(fileOutputTerminalId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    await sessionManager.destroyTerminal(worker.terminalId);

    return result;

  } catch (error) {
    // Complete span with failure
    if (db && spanId) {
      db.completeSpan(spanId, 'failed', error.message);
      db.completeTrace(traceId, 'failed');
    }

    // Stop interceptor if running
    if (stopInterceptor) {
      try {
        stopInterceptor();
      } catch (e) {
        // Ignore interceptor cleanup errors
      }
    }

    // Cleanup file output directory
    if (fileOutputManager && useFileOutput) {
      try {
        fileOutputManager.cleanup(fileOutputTerminalId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Cleanup worker if created
    if (worker && sessionManager) {
      try {
        await sessionManager.destroyTerminal(worker.terminalId);
      } catch (cleanupError) {
        console.error('[handoff] Cleanup error:', cleanupError.message);
      }
    }

    // Re-throw with context
    const enhancedError = new Error(`handoff to ${agentProfile} failed: ${error.message}`);
    enhancedError.traceId = traceId;
    enhancedError.agentProfile = agentProfile;
    enhancedError.originalError = error;
    throw enhancedError;
  }
}

/**
 * Execute a synchronous handoff to a worker agent
 *
 * @param {string} agentProfile - Name of the agent profile to use
 * @param {string} message - Task message to send to the worker
 * @param {Object} options - Additional options
 * @param {number} options.timeout - Max time to wait for completion (seconds, default: 300)
 * @param {boolean} options.returnSummary - Return summary instead of full output
 * @param {number} options.maxSummaryLength - Max length of summary
 * @param {boolean} options.summarizeForHandoff - Create context-aware summary for next agent
 * @param {string} options.targetProfile - Target profile for handoff summary
 * @param {string} options.taskType - Task type hint for better summarization
 * @param {string} options.taskId - Task ID for shared memory (findings/context from other agents)
 * @param {boolean} options.includeSharedContext - Whether to include shared findings/context (default: true if taskId provided)
 * @param {boolean} options.useFileOutput - Enable file-based output protocol (more reliable)
 * @param {string} options.outputFormat - Output format: 'text' or 'json' (default: 'text')
 * @param {Object} options.retry - Retry configuration
 * @param {Object} options.context - Shared context (sessionManager, db, etc.)
 * @returns {Promise<Object>} - Result with output
 */
async function handoff(agentProfile, message, options = {}) {
  const {
    retry = {},
    context = {},
    taskId = null,
    includeSharedContext = null,
    resolvedProfile = null,  // Pre-resolved profile from role+adapter API
    workDir = null
  } = options;

  const { sessionManager } = context;

  if (!sessionManager) {
    throw new Error('sessionManager is required in context');
  }

  // Use pre-resolved profile (from role+adapter API) or load by name
  const profile = resolvedProfile || loadProfile(agentProfile);
  if (!profile) {
    throw new Error(`Unknown agent profile: ${agentProfile}`);
  }

  // Build message with shared context if taskId provided
  let finalMessage = message;
  const shouldIncludeContext = includeSharedContext ?? (taskId !== null);

  if (taskId && shouldIncludeContext) {
    try {
      // Get DB from context or global
      let db = context.db;
      if (!db) {
        db = getDB();
      }
      
      if (db) {
        const priorFindings = db.getFindings(taskId);
        const priorContext = db.getContext(taskId);

        if (priorFindings.length > 0 || priorContext.length > 0) {
          finalMessage = buildEnhancedMessage(message, priorFindings, priorContext);
          console.log(`[handoff] Injected shared context for task ${taskId}: ${priorFindings.length} findings, ${priorContext.length} context entries`);
        }
      }
    } catch (error) {
      console.warn(`[handoff] Failed to get shared context: ${error.message}`);
      // Continue with original message
    }
  }

  // Merge retry config with defaults
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retry };

  // Execute with retry logic (no circuit breaker - each request is independent)
  let lastError = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      // Execute the handoff attempt with enhanced message (includes shared context if taskId provided)
      const result = await executeHandoffAttempt(agentProfile, finalMessage, profile, options);
      result.taskId = taskId; // Include taskId in result for reference
      return result;

    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt < retryConfig.maxRetries && isRetryable(error, retryConfig)) {
        const delay = calculateBackoff(attempt, retryConfig);
        console.log(`[handoff] Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error.message}`);
        await sleep(delay);
        continue;
      }

      // Non-retryable or max retries exceeded
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError;
}

module.exports = {
  handoff,
  extractOutput,
  stripAnsiCodes,
  generateTraceId,
  truncate,
  buildEnhancedMessage,
  handleInitPrompts,
  resolveInitReadinessPolicy,
  // Export for testing
  calculateBackoff,
  isRetryable,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_ORCHESTRATION_TIMEOUT
};
