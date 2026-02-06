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
const { getAgentProfiles, resolveProfile } = require('../services/agent-profiles');
const { createMemoryRouter } = require('../routes/memory');

/**
 * Create the orchestration router
 * @param {Object} context - Shared context with sessionManager, db, inboxService
 * @returns {express.Router}
 */
function createOrchestrationRouter(context) {
  const router = express.Router();
  const { sessionManager, db, inboxService } = context;

  // Mount shared memory routes at /orchestration/memory
  const memoryRouter = createMemoryRouter();
  router.use('/memory', memoryRouter);

  /**
   * POST /orchestration/handoff
   * Synchronous task delegation - wait for worker to complete
   *
   * Supports two APIs:
   * - Legacy: { agentProfile: 'planner', message: '...' }
   * - New:    { role: 'plan', adapter: 'gemini-cli', message: '...' }
   */
  router.post('/handoff', async (req, res) => {
    try {
      const {
        // Legacy API
        agentProfile,
        // New role+adapter API
        role,
        adapter,
        systemPrompt,
        // Common parameters
        message,
        timeout,
        returnSummary,
        maxSummaryLength,
        taskId,
        includeSharedContext,
        workingDirectory
      } = req.body;

      // Require either agentProfile (legacy) or role (new)
      if (!agentProfile && !role) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'Either agentProfile or role is required', param: 'agentProfile|role' }
        });
      }

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required', param: 'message' }
        });
      }

      // Resolve the profile from role+adapter or legacy profile name
      let resolvedProfile = null;
      let profileIdentifier = agentProfile;

      if (role) {
        // New API: resolve role+adapter to a profile
        resolvedProfile = resolveProfile({ role, adapter, systemPrompt });
        if (!resolvedProfile) {
          return res.status(404).json({
            error: {
              code: 'profile_not_found',
              message: `Could not resolve role '${role}'${adapter ? ` with adapter '${adapter}'` : ''}`
            }
          });
        }
        // Use role as the identifier for logging/tracing
        // Use underscore instead of colon to pass validation (alphanumeric, dash, underscore only)
        profileIdentifier = adapter ? `${role}_${adapter}` : role;
      }

      const result = await handoff(profileIdentifier, message, {
        timeout,
        returnSummary,
        maxSummaryLength,
        taskId,
        includeSharedContext,
        workDir: workingDirectory,
        context: { sessionManager, db },
        // Pass resolved profile if we have one (for new API)
        resolvedProfile
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
   * GET /orchestration/terminals/:id/messages
   * Get conversation history for a terminal
   */
  router.get('/terminals/:id/messages', (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          error: { code: 'db_unavailable', message: 'Database not initialized' }
        });
      }

      const terminalId = req.params.id;
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;
      const traceId = req.query.traceId || null;
      const role = req.query.role || null;

      // Verify terminal exists
      const terminal = sessionManager.getTerminal(terminalId);
      if (!terminal) {
        return res.status(404).json({
          error: { code: 'terminal_not_found', message: `Terminal ${terminalId} not found` }
        });
      }

      const messages = db.getHistory(terminalId, { limit, offset, traceId, role });
      const totalCount = db.getMessageCount(terminalId);

      res.json({
        terminalId,
        messages,
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + messages.length < totalCount
        }
      });

    } catch (error) {
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
      const service = getAgentProfiles();
      const profiles = service.getAllProfiles();

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
   * GET /orchestration/roles
   * List available roles (v3 config)
   */
  router.get('/roles', (req, res) => {
    try {
      const service = getAgentProfiles();
      const roles = service.listRoles();

      // Get role details
      const roleDetails = {};
      for (const name of roles) {
        const role = service.getRole(name);
        if (role) {
          roleDetails[name] = {
            description: role.description,
            defaultAdapter: role.defaultAdapter,
            timeout: role.timeout
          };
        }
      }

      res.json({
        count: roles.length,
        roles: roleDetails
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/adapters
   * List available adapters (v3 config)
   */
  router.get('/adapters', (req, res) => {
    try {
      const service = getAgentProfiles();
      const adapters = service.listAdapters();

      // Get adapter details
      const adapterDetails = {};
      for (const name of adapters) {
        const adapter = service.getAdapter(name);
        if (adapter) {
          adapterDetails[name] = {
            description: adapter.description,
            capabilities: adapter.capabilities
          };
        }
      }

      res.json({
        count: adapters.length,
        adapters: adapterDetails
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

  // ============================================
  // Task Routing & Workflow Endpoints
  // ============================================

  // Lazy-load TaskRouter to avoid circular dependencies
  let taskRouter = null;
  const getTaskRouter = () => {
    if (!taskRouter) {
      const { TaskRouter } = require('../orchestration/task-router');
      taskRouter = new TaskRouter(sessionManager);
    }
    return taskRouter;
  };

  /**
   * POST /orchestration/route
   * Intelligently route a task to the appropriate agent
   *
   * Supports two APIs:
   * - Legacy: { forceProfile: 'planner' }
   * - New:    { forceRole: 'plan', forceAdapter: 'gemini-cli' }
   */
  router.post('/route', async (req, res) => {
    try {
      const {
        message,
        // Legacy API
        forceProfile,
        forceType,
        // New role+adapter API
        forceRole,
        forceAdapter,
        workingDirectory
      } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required' }
        });
      }

      // Convert new API to legacy format for now
      // (The task router can be updated later to handle role+adapter natively)
      let effectiveProfile = forceProfile;
      if (forceRole && !forceProfile) {
        // Resolve role+adapter to a profile-like identifier
        effectiveProfile = forceAdapter ? `${forceRole}_${forceAdapter}` : forceRole;
      }

      const router = getTaskRouter();
      const result = await router.routeTask(message, {
        forceProfile: effectiveProfile,
        forceType,
        // Pass role+adapter for native handling if task router supports it
        forceRole,
        forceAdapter,
        workDir: workingDirectory
      });

      res.json(result);

    } catch (error) {
      res.status(500).json({
        error: { code: 'routing_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/route/detect
   * Detect task type without executing
   */
  router.get('/route/detect', (req, res) => {
    try {
      const { message } = req.query;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message query param is required' }
        });
      }

      const router = getTaskRouter();
      const detection = router.detectTaskType(message);

      res.json(detection);

    } catch (error) {
      res.status(500).json({
        error: { code: 'detection_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/route/types
   * List available task types and their default profiles
   */
  router.get('/route/types', (req, res) => {
    try {
      const router = getTaskRouter();
      res.json(router.getTaskTypes());
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/workflows/:name
   * Execute a predefined workflow
   */
  router.post('/workflows/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'message is required' }
        });
      }

      const router = getTaskRouter();
      const result = await router.executeWorkflow(name, message);

      res.json(result);

    } catch (error) {
      res.status(500).json({
        error: { code: 'workflow_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/workflows
   * List available workflows
   */
  router.get('/workflows', (req, res) => {
    try {
      const router = getTaskRouter();
      res.json(router.getWorkflows());
    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/workflows/:id/status
   * Get workflow execution status
   */
  router.get('/workflows/:id/status', (req, res) => {
    try {
      const { id } = req.params;
      const router = getTaskRouter();
      const status = router.getWorkflowStatus(id);

      if (!status) {
        return res.status(404).json({
          error: { code: 'workflow_not_found', message: `Workflow ${id} not found` }
        });
      }

      res.json(status);

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================
  // Skills System Endpoints
  // ============================================

  // Lazy-load SkillsService to avoid startup overhead
  let skillsService = null;
  const getSkillsService = () => {
    if (!skillsService) {
      const { getSkillsService: getService } = require('../services/skills-service');
      skillsService = getService();
    }
    return skillsService;
  };

  /**
   * GET /orchestration/skills
   * List all available skills
   *
   * Query params:
   * - tag: Filter by tag
   * - adapter: Filter by compatible adapter
   */
  router.get('/skills', (req, res) => {
    try {
      const { tag, adapter } = req.query;
      const service = getSkillsService();
      const skills = service.listSkills({ tag, adapter });

      res.json({
        count: skills.length,
        skills
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/skills/tags
   * List all available skill tags
   */
  router.get('/skills/tags', (req, res) => {
    try {
      const service = getSkillsService();
      const tags = service.getAllTags();

      res.json({
        count: tags.length,
        tags
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/skills/:name
   * Get a specific skill by name
   */
  router.get('/skills/:name', (req, res) => {
    try {
      const service = getSkillsService();
      const skill = service.loadSkill(req.params.name);

      if (!skill) {
        return res.status(404).json({
          error: { code: 'skill_not_found', message: `Skill '${req.params.name}' not found` }
        });
      }

      res.json({
        name: skill.name,
        description: skill.description,
        adapters: skill.adapters,
        tags: skill.tags,
        source: skill.source,
        path: skill.path,
        content: skill.content
      });

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/skills/invoke
   * Invoke a skill with optional context
   *
   * Body:
   * - skill: Skill name (required)
   * - message: Task context/description
   * - adapter: Current adapter (for validation)
   */
  router.post('/skills/invoke', async (req, res) => {
    try {
      const { skill, message, adapter } = req.body;

      if (!skill) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'skill is required', param: 'skill' }
        });
      }

      const service = getSkillsService();
      const result = await service.invokeSkill(skill, { message, adapter });

      if (!result.success) {
        return res.status(404).json({
          error: { code: 'skill_error', message: result.error }
        });
      }

      res.json(result);

    } catch (error) {
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/skills/refresh
   * Clear skills cache and force re-discovery
   */
  router.post('/skills/refresh', (req, res) => {
    try {
      const service = getSkillsService();
      service.clearCache();

      // Immediately rescan
      const skills = service.listSkills();

      res.json({
        success: true,
        message: 'Skills cache refreshed',
        count: skills.length
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
