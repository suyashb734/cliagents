/**
 * handoff() - Synchronous task delegation to a worker agent
 *
 * Creates a worker terminal, sends a task, waits for completion,
 * extracts the output, and cleans up. Returns the result to the caller.
 *
 * This is the primary orchestration primitive for delegating tasks
 * that need to complete before the caller can continue.
 */

const crypto = require('crypto');
const { TerminalStatus } = require('../models/terminal-status');
const { loadProfile } = require('../services/agent-profiles');

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
  return text.slice(0, maxLength) + '... [truncated]';
}

/**
 * Extract final output from terminal log/output
 * This is adapter-specific and may need refinement
 */
function extractOutput(output, adapter) {
  if (!output) return '';

  // Try to find the last meaningful response
  // This is a simplified extraction - real implementation should be more sophisticated

  switch (adapter) {
    case 'claude-code':
      // Look for the last response block (after ⏺ marker)
      const claudeMatch = output.match(/⏺\s+([^\n]+(?:\n(?!⏺)[^\n]+)*)/g);
      if (claudeMatch && claudeMatch.length > 0) {
        return claudeMatch[claudeMatch.length - 1].replace(/^⏺\s+/, '').trim();
      }
      break;

    case 'gemini-cli':
      // Look for content between prompts
      const geminiMatch = output.match(/gemini>\s*[^\n]+\n([\s\S]+?)(?=gemini>|$)/gi);
      if (geminiMatch && geminiMatch.length > 0) {
        return geminiMatch[geminiMatch.length - 1].replace(/^gemini>.*\n/i, '').trim();
      }
      break;

    case 'codex-cli':
      // Similar pattern for codex
      const codexMatch = output.match(/>\s*[^\n]+\n([\s\S]+?)(?=>|$)/g);
      if (codexMatch && codexMatch.length > 0) {
        return codexMatch[codexMatch.length - 1].replace(/^>.*\n/, '').trim();
      }
      break;
  }

  // Fallback: return last portion of output
  const lines = output.trim().split('\n');
  return lines.slice(-20).join('\n');
}

/**
 * Execute a synchronous handoff to a worker agent
 *
 * @param {string} agentProfile - Name of the agent profile to use
 * @param {string} message - Task message to send to the worker
 * @param {Object} options - Additional options
 * @param {number} options.timeout - Max time to wait for completion (seconds)
 * @param {boolean} options.returnSummary - Return summary instead of full output
 * @param {number} options.maxSummaryLength - Max length of summary
 * @param {Object} options.context - Shared context (sessionManager, db, etc.)
 * @returns {Promise<Object>} - Result with output
 */
async function handoff(agentProfile, message, options = {}) {
  const {
    timeout = 600,
    returnSummary = false,
    maxSummaryLength = 2000,
    context = {}
  } = options;

  const { sessionManager, db } = context;

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
  let worker = null;

  try {
    // Create trace if db available
    if (db) {
      db.createTrace(traceId, null, `handoff:${agentProfile}`, {
        message: truncate(message, 500)
      });
      spanId = db.addSpan(traceId, 'pending', `handoff:${agentProfile}`, truncate(message, 500));
    }

    // 1. Create worker terminal
    worker = await sessionManager.createTerminal({
      adapter: profile.adapter,
      agentProfile,
      role: 'worker',
      systemPrompt: profile.systemPrompt,
      allowedTools: profile.allowedTools
    });

    // Update span with terminal ID
    if (db && spanId) {
      db.db.prepare('UPDATE spans SET terminal_id = ? WHERE id = ?').run(worker.terminalId, spanId);
    }

    // 2. Wait for worker to be ready (IDLE)
    try {
      await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.IDLE, 30000);
    } catch (error) {
      throw new Error(`Worker failed to initialize: ${error.message}`);
    }

    // 3. Send task message
    await sessionManager.sendInput(worker.terminalId, message);

    // 4. Wait for completion
    const timeoutMs = timeout * 1000;
    try {
      await sessionManager.waitForStatus(worker.terminalId, TerminalStatus.COMPLETED, timeoutMs);
    } catch (error) {
      throw new Error(`Worker timed out after ${timeout}s`);
    }

    // 5. Extract output
    const fullOutput = sessionManager.getOutput(worker.terminalId, 1000);
    const output = extractOutput(fullOutput, profile.adapter);

    // 6. Build result
    const result = {
      success: true,
      terminalId: worker.terminalId,
      traceId,
      adapter: profile.adapter,
      agentProfile
    };

    if (returnSummary) {
      result.summary = truncate(output, maxSummaryLength);
      result.fullOutputLength = output.length;
    } else {
      result.output = output;
    }

    // Complete span
    if (db && spanId) {
      db.completeSpan(spanId, 'completed', truncate(output, 500));
      db.completeTrace(traceId, 'completed');
    }

    // 7. Cleanup
    await sessionManager.destroyTerminal(worker.terminalId);

    return result;

  } catch (error) {
    // Handle errors

    // Complete span with failure
    if (db && spanId) {
      db.completeSpan(spanId, 'failed', error.message);
      db.completeTrace(traceId, 'failed');
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
    throw enhancedError;
  }
}

module.exports = {
  handoff,
  extractOutput,
  generateTraceId,
  truncate
};
