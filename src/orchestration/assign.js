/**
 * assign() - Asynchronous task delegation to a worker agent
 *
 * Creates a worker terminal, sends a task, and returns immediately
 * without waiting for completion. The worker runs independently.
 *
 * Optionally, a callback terminal can be specified to receive results
 * when the worker completes.
 */

const crypto = require('crypto');
const { TerminalStatus } = require('../models/terminal-status');
const { loadProfile } = require('../services/agent-profiles');
const { getDB } = require('../database/db');
const { buildEnhancedMessage } = require('./handoff');

/**
 * Generate a trace ID for tracking
 */
function generateTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Truncate text for summaries
 */
function truncate(text, maxLength = 500) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Execute an asynchronous assignment to a worker agent
 *
 * @param {string} agentProfile - Name of the agent profile to use
 * @param {string} message - Task message to send to the worker
 * @param {Object} options - Additional options
 * @param {string} options.callbackTerminalId - Terminal to notify on completion
 * @param {string} options.taskId - Task ID for shared memory (findings/context from other agents)
 * @param {boolean} options.includeSharedContext - Whether to include shared findings/context (default: true if taskId provided)
 * @param {Object} options.context - Shared context (sessionManager, db, etc.)
 * @returns {Promise<Object>} - Info about the spawned worker
 */
async function assign(agentProfile, message, options = {}) {
  const {
    callbackTerminalId = null,
    taskId = null,
    includeSharedContext = null,
    context = {},
    workDir = null
  } = options;

  let { sessionManager, db, inboxService } = context;

  // Ensure db is available if not passed in context
  if (!db) {
    try {
      db = getDB();
    } catch (e) {
      // DB might not be initialized in some contexts
    }
  }

  if (!sessionManager) {
    throw new Error('sessionManager is required in context');
  }

  // Load profile
  const profile = loadProfile(agentProfile);
  if (!profile) {
    throw new Error(`Unknown agent profile: ${agentProfile}`);
  }

  // Generate trace ID for tracking
  const traceId = generateTraceId();
  let spanId = null;

  try {
    // Create trace if db available
    if (db) {
      db.createTrace(traceId, callbackTerminalId, `assign:${agentProfile}`, {
        message: truncate(message),
        callbackTerminalId
      });
    }

    // 1. Create worker terminal
    const worker = await sessionManager.createTerminal({
      adapter: profile.adapter,
      agentProfile,
      role: 'worker',
      systemPrompt: profile.systemPrompt,
      allowedTools: profile.allowedTools,
      workDir: workDir || undefined
    });

    // Add span for tracking
    if (db) {
      spanId = db.addSpan(traceId, worker.terminalId, `assign:${agentProfile}`, truncate(message));
    }

    // 2. Wait for worker to be ready
    try {
      await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.IDLE, 30000);
    } catch (error) {
      // Cleanup on init failure
      await sessionManager.destroyTerminal(worker.terminalId);
      throw new Error(`Worker failed to initialize: ${error.message}`);
    }

    // 3. Build message with shared context if taskId provided
    let fullMessage = message;
    const shouldIncludeContext = includeSharedContext ?? (taskId !== null);

    if (taskId && shouldIncludeContext && db) {
      try {
        const priorFindings = db.getFindings(taskId);
        const priorContext = db.getContext(taskId);

        if (priorFindings.length > 0 || priorContext.length > 0) {
          fullMessage = buildEnhancedMessage(message, priorFindings, priorContext);
          console.log(`[assign] Injected shared context for task ${taskId}: ${priorFindings.length} findings, ${priorContext.length} context entries`);
        }
      } catch (error) {
        console.warn(`[assign] Failed to get shared context: ${error.message}`);
        // Continue with original message
      }
    }

    // 4. Modify message to include callback instructions if specified
    if (callbackTerminalId) {
      fullMessage += `\n\n---\nIMPORTANT: When you complete this task, send your results to terminal ${callbackTerminalId} using the send_message endpoint.`;
    }

    // 5. Send task message (non-blocking)
    await sessionManager.sendInput(worker.terminalId, fullMessage);

    // 6. Set up completion monitoring if callback specified
    if (callbackTerminalId && inboxService) {
      setupCompletionMonitor(worker.terminalId, callbackTerminalId, {
        sessionManager,
        inboxService,
        db,
        traceId,
        spanId,
        agentProfile
      });
    }

    // 7. Return immediately
    return {
      success: true,
      terminalId: worker.terminalId,
      traceId,
      adapter: profile.adapter,
      agentProfile,
      callbackTerminalId,
      taskId,
      status: 'assigned'
    };

  } catch (error) {
    // Handle errors
    if (db && traceId) {
      db.completeTrace(traceId, 'failed');
    }

    const enhancedError = new Error(`assign to ${agentProfile} failed: ${error.message}`);
    enhancedError.traceId = traceId;
    enhancedError.agentProfile = agentProfile;
    throw enhancedError;
  }
}

/**
 * Set up a monitor to watch for task completion and send callback
 */
function setupCompletionMonitor(workerTerminalId, callbackTerminalId, ctx) {
  const { sessionManager, inboxService, db, traceId, spanId, agentProfile } = ctx;

  const pollInterval = 1000;
  const maxPollTime = 3600000; // 1 hour max
  const startTime = Date.now();

  const checkCompletion = async () => {
    try {
      // Check if still within time limit
      if (Date.now() - startTime > maxPollTime) {
        console.warn(`[assign] Worker ${workerTerminalId} monitor timed out`);
        return;
      }

      // Check worker status
      const status = sessionManager.getStatus(workerTerminalId);

      if (status === TerminalStatus.COMPLETED) {
        // Extract output
        const output = sessionManager.getOutput(workerTerminalId, 500);

        // Send result to callback terminal
        const resultMessage = `Results from ${agentProfile} (${workerTerminalId}):\n\n${output}`;
        inboxService.queueMessage(workerTerminalId, callbackTerminalId, resultMessage);

        // Update span
        if (db && spanId) {
          db.completeSpan(spanId, 'completed', output.slice(0, 500));
        }

        // Cleanup worker
        await sessionManager.destroyTerminal(workerTerminalId);

        // Complete trace
        if (db && traceId) {
          db.completeTrace(traceId, 'completed');
        }

        console.log(`[assign] Worker ${workerTerminalId} completed, results sent to ${callbackTerminalId}`);
        return;
      }

      if (status === TerminalStatus.ERROR) {
        // Send error to callback
        const errorMessage = `Error from ${agentProfile} (${workerTerminalId}): Task failed`;
        inboxService.queueMessage(workerTerminalId, callbackTerminalId, errorMessage);

        // Update span
        if (db && spanId) {
          db.completeSpan(spanId, 'failed', 'Task failed with error');
        }

        // Cleanup
        await sessionManager.destroyTerminal(workerTerminalId);

        if (db && traceId) {
          db.completeTrace(traceId, 'failed');
        }

        return;
      }

      // Still processing, check again later
      setTimeout(checkCompletion, pollInterval);

    } catch (error) {
      console.error(`[assign] Monitor error for ${workerTerminalId}:`, error.message);
      // Try again later
      setTimeout(checkCompletion, pollInterval * 2);
    }
  };

  // Start monitoring
  setTimeout(checkCompletion, pollInterval);
}

module.exports = {
  assign,
  setupCompletionMonitor
};
