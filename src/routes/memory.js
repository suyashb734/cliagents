/**
 * Memory Routes - REST API endpoints for shared memory
 *
 * Provides endpoints for:
 * - Artifacts: Store and retrieve code/file artifacts
 * - Findings: Share insights and issues between agents
 * - Context: Store conversation summaries for handoff
 */

const express = require('express');
const { getDB } = require('../database/db');

/**
 * Create the memory router
 * @returns {express.Router}
 */
function createMemoryRouter() {
  const router = express.Router();
  const db = getDB();

  // ============================================================
  // Artifact Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/artifacts
   * Store an artifact
   */
  router.post('/artifacts', (req, res) => {
    try {
      const { taskId, key, content, type, agentId, metadata } = req.body;

      if (!taskId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'taskId is required', param: 'taskId' }
        });
      }

      if (!key) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'key is required', param: 'key' }
        });
      }

      if (!content) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'content is required', param: 'content' }
        });
      }

      const id = db.storeArtifact(taskId, key, content, { type, agentId, metadata });

      res.json({ id, taskId, key });
    } catch (error) {
      console.error('[memory/artifacts] Store error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/artifacts/:taskId
   * Get all artifacts for a task
   */
  router.get('/artifacts/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const { type } = req.query;

      const artifacts = db.getArtifacts(taskId, { type });

      res.json({ artifacts });
    } catch (error) {
      console.error('[memory/artifacts] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/artifacts/:taskId/:key
   * Get a specific artifact
   */
  router.get('/artifacts/:taskId/:key', (req, res) => {
    try {
      const { taskId, key } = req.params;

      const artifact = db.getArtifact(taskId, key);

      if (!artifact) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Artifact not found: ${key}` }
        });
      }

      res.json({ artifact });
    } catch (error) {
      console.error('[memory/artifacts] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/memory/artifacts/:taskId/:key
   * Delete a specific artifact
   */
  router.delete('/artifacts/:taskId/:key', (req, res) => {
    try {
      const { taskId, key } = req.params;

      const deleted = db.deleteArtifact(taskId, key);

      if (!deleted) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Artifact not found: ${key}` }
        });
      }

      res.json({ success: true, taskId, key });
    } catch (error) {
      console.error('[memory/artifacts] Delete error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Finding Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/findings
   * Store a finding
   */
  router.post('/findings', (req, res) => {
    try {
      const { taskId, agentId, content, type, severity, agentProfile, metadata } = req.body;

      if (!taskId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'taskId is required', param: 'taskId' }
        });
      }

      if (!agentId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentId is required', param: 'agentId' }
        });
      }

      if (!content) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'content is required', param: 'content' }
        });
      }

      const id = db.storeFinding(taskId, agentId, content, { type, severity, agentProfile, metadata });

      res.json({ id, taskId });
    } catch (error) {
      console.error('[memory/findings] Store error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/findings/:taskId
   * Get all findings for a task
   */
  router.get('/findings/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const { type, severity } = req.query;

      const findings = db.getFindings(taskId, { type, severity });

      res.json({ findings });
    } catch (error) {
      console.error('[memory/findings] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/findings/by-id/:id
   * Get a specific finding by ID
   */
  router.get('/findings/by-id/:id', (req, res) => {
    try {
      const { id } = req.params;

      const finding = db.getFinding(id);

      if (!finding) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Finding not found: ${id}` }
        });
      }

      res.json({ finding });
    } catch (error) {
      console.error('[memory/findings] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/memory/findings/:id
   * Delete a specific finding
   */
  router.delete('/findings/:id', (req, res) => {
    try {
      const { id } = req.params;

      const deleted = db.deleteFinding(id);

      if (!deleted) {
        return res.status(404).json({
          error: { code: 'not_found', message: `Finding not found: ${id}` }
        });
      }

      res.json({ success: true, id });
    } catch (error) {
      console.error('[memory/findings] Delete error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Context Endpoints
  // ============================================================

  /**
   * POST /orchestration/memory/context
   * Store context
   */
  router.post('/context', (req, res) => {
    try {
      const { taskId, agentId, summary, keyDecisions, pendingItems } = req.body;

      if (!taskId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'taskId is required', param: 'taskId' }
        });
      }

      if (!agentId) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'agentId is required', param: 'agentId' }
        });
      }

      if (!summary) {
        return res.status(400).json({
          error: { code: 'missing_parameter', message: 'summary is required', param: 'summary' }
        });
      }

      const id = db.storeContext(taskId, agentId, { summary, keyDecisions, pendingItems });

      res.json({ id, taskId });
    } catch (error) {
      console.error('[memory/context] Store error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * GET /orchestration/memory/context/:taskId
   * Get all context for a task
   */
  router.get('/context/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;

      const context = db.getContext(taskId);

      res.json({ context });
    } catch (error) {
      console.error('[memory/context] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Task-level Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/tasks/:taskId
   * Get complete shared memory for a task
   */
  router.get('/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;

      const taskMemory = db.getTaskMemory(taskId);

      res.json(taskMemory);
    } catch (error) {
      console.error('[memory/tasks] Get error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * DELETE /orchestration/memory/tasks/:taskId
   * Clear all memory for a task
   */
  router.delete('/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;

      const deleted = db.clearTaskMemory(taskId);

      res.json({ success: true, taskId, deleted });
    } catch (error) {
      console.error('[memory/tasks] Delete error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  // ============================================================
  // Maintenance Endpoints
  // ============================================================

  /**
   * GET /orchestration/memory/stats
   * Get memory statistics
   */
  router.get('/stats', (req, res) => {
    try {
      const stats = db.getMemoryStats();
      res.json(stats);
    } catch (error) {
      console.error('[memory/stats] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  /**
   * POST /orchestration/memory/cleanup
   * Clean up old entries
   */
  router.post('/cleanup', (req, res) => {
    try {
      const { olderThanHours = 24 } = req.body;
      const olderThanSeconds = olderThanHours * 3600;

      const deleted = db.cleanupMemory(olderThanSeconds);

      res.json({ success: true, deleted });
    } catch (error) {
      console.error('[memory/cleanup] Error:', error.message);
      res.status(500).json({
        error: { code: 'internal_error', message: error.message }
      });
    }
  });

  return router;
}

module.exports = { createMemoryRouter };
