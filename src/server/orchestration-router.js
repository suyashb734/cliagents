/**
 * Orchestration Router - REST API endpoints for multi-agent orchestration
 *
 * Provides endpoints for:
 * - handoff: Synchronous task delegation
 * - assign: Asynchronous task delegation
 * - send_message: Inter-agent messaging
 * - Terminal management
 */

const express = require('express');
const { handoff } = require('../orchestration/handoff');
const { assign } = require('../orchestration/assign');
const { sendMessage, broadcastMessage } = require('../orchestration/send-message');
const { getAgentProfiles } = require('../services/agent-profiles');

/**
 * Create the orchestration router
 * @param {Object} context - Shared context with sessionManager, db, inboxService
 * @returns {express.Router}
 */
function createOrchestrationRouter(context) {
  const router = express.Router();
  const { sessionManager, db, inboxService } = context;

  /**
   * POST /orchestration/handoff
   * Synchronous task delegation - wait for worker to complete
   */
  router.post('/handoff', async (req, res) => {
    try {
      const { agentProfile, message, timeout, returnSummary, maxSummaryLength } = req.body;

      if (!agentProfile) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentProfile is required', param: 'agentProfile' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await handoff(agentProfile, message, {
        timeout,
        returnSummary,
        maxSummaryLength,
        context: { sessionManager, db }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/handoff] Error:', error.message);

      if (error.message.includes('Unknown agent profile')) {
        return res.status(404).json({
          error: { code: 'profile_not_found', message: error.message }
        });
      }

      if (error.message.includes('timed out')) {
        return res.status(504).json({
          error: { code: 'timeout_error', message: error.message, traceId: error.traceId }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message, traceId: error.traceId }
      });
    }
  });

  /**
   * POST /orchestration/assign
   * Asynchronous task delegation - returns immediately
   */
  router.post('/assign', async (req, res) => {
    try {
      const { agentProfile, message, callbackTerminalId } = req.body;

      if (!agentProfile) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentProfile is required', param: 'agentProfile' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await assign(agentProfile, message, {
        callbackTerminalId,
        context: { sessionManager, db, inboxService }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/assign] Error:', error.message);

      if (error.message.includes('Unknown agent profile')) {
        return res.status(404).json({
          error: { code: 'profile_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message, traceId: error.traceId }
      });
    }
  });

  /**
   * POST /orchestration/send_message
   * Inter-agent messaging
   */
  router.post('/send_message', async (req, res) => {
    try {
      // Sender can be specified in header or body
      const senderId = req.headers['x-terminal-id'] || req.body.senderId;
      const { receiverId, message, priority } = req.body;

      if (!receiverId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'receiverId is required', param: 'receiverId' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await sendMessage(senderId, receiverId, message, {
        priority,
        context: { sessionManager, inboxService, db }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/send_message] Error:', error.message);

      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/broadcast
   * Send message to multiple terminals
   */
  router.post('/broadcast', async (req, res) => {
    try {
      const senderId = req.headers['x-terminal-id'] || req.body.senderId;
      const { receiverIds, message, priority } = req.body;

      if (!receiverIds || !Array.isArray(receiverIds) || receiverIds.length === 0) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'receiverIds array is required', param: 'receiverIds' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      const result = await broadcastMessage(senderId, receiverIds, message, {
        priority,
        context: { sessionManager, inboxService, db }
      });

      res.json(result);

    } catch (error) {
      console.error('[orchestration/broadcast] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals
   * List all persistent terminals
   */
  router.get('/terminals', (req, res) => {
    try {
      const terminals = sessionManager.listTerminals();

      res.json({
        count: terminals.length,
        terminals: terminals.map(t => ({
          terminalId: t.terminalId,
          adapter: t.adapter,
          agentProfile: t.agentProfile,
          role: t.role,
          status: t.status,
          createdAt: t.createdAt,
          lastActive: t.lastActive
        }))
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals/:id
   * Get terminal info
   */
  router.get('/terminals/:id', (req, res) => {
    try {
      const terminal = sessionManager.getTerminal(req.params.id);

      if (!terminal) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: `Terminal ${req.params.id} not found` }
        });
      }

      res.json({
        ...terminal,
        attachCommand: sessionManager.getAttachCommand(req.params.id)
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/terminals/:id/output
   * Get terminal output
   */
  router.get('/terminals/:id/output', (req, res) => {
    try {
      const lines = parseInt(req.query.lines) || 200;
      const output = sessionManager.getOutput(req.params.id, lines);

      res.json({
        terminalId: req.params.id,
        lines,
        output
      });

    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/terminals/:id/input
   * Send input to terminal
   */
  router.post('/terminals/:id/input', async (req, res) => {
    try {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      await sessionManager.sendInput(req.params.id, message);

      res.json({
        success: true,
        terminalId: req.params.id,
        status: sessionManager.getStatus(req.params.id)
      });

    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/terminals/:id
   * Destroy terminal
   */
  router.delete('/terminals/:id', async (req, res) => {
    try {
      await sessionManager.destroyTerminal(req.params.id);

      res.json({
        success: true,
        message: `Terminal ${req.params.id} destroyed`
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/terminals
   * Create a new persistent terminal
   */
  router.post('/terminals', async (req, res) => {
    try {
      const { adapter, agentProfile, role, workDir, systemPrompt, model, allowedTools } = req.body;

      const terminal = await sessionManager.createTerminal({
        adapter,
        agentProfile,
        role,
        workDir,
        systemPrompt,
        model,
        allowedTools
      });

      res.json(terminal);

    } catch (error) {
      console.error('[orchestration/terminals] Create error:', error.message);

      if (error.message.includes('Unknown adapter')) {
        return res.status(400).json({
          error: { code: 'invalid_adapter', message: error.message }
        });
      }

      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/profiles
   * List available agent profiles
   */
  router.get('/profiles', (req, res) => {
    try {
      const profiles = getAgentProfiles().getAllProfiles();

      res.json({
        count: Object.keys(profiles).length,
        profiles
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/profiles/:name
   * Get a specific agent profile
   */
  router.get('/profiles/:name', (req, res) => {
    try {
      const profile = getAgentProfiles().getProfile(req.params.name);

      if (!profile) {
        return res.status(404).json({
          error: { code: 'profile_not_found', message: `Profile ${req.params.name} not found` }
        });
      }

      res.json({
        name: req.params.name,
        ...profile
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/inbox/:terminalId
   * Get inbox for a terminal
   */
  router.get('/inbox/:terminalId', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const messages = inboxService.getPendingMessages(req.params.terminalId, limit);
      const stats = inboxService.getStats(req.params.terminalId);

      res.json({
        terminalId: req.params.terminalId,
        stats,
        messages
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/stats
   * Get orchestration statistics
   */
  router.get('/stats', (req, res) => {
    try {
      const dbStats = db ? db.getStats() : null;
      const terminals = sessionManager.listTerminals();

      res.json({
        terminals: {
          total: terminals.length,
          byStatus: terminals.reduce((acc, t) => {
            acc[t.status] = (acc[t.status] || 0) + 1;
            return acc;
          }, {}),
          byAdapter: terminals.reduce((acc, t) => {
            acc[t.adapter] = (acc[t.adapter] || 0) + 1;
            return acc;
          }, {})
        },
        database: dbStats
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  return router;
}

module.exports = { createOrchestrationRouter };
