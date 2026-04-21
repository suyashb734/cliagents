/**
 * Authentication Middleware
 *
 * Protects API endpoints with a simple API key mechanism.
 * Requires CLI_AGENTS_API_KEY environment variable to be set.
 */

const { sendError } = require('../utils/errors');

/**
 * Middleware to enforce API key authentication
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function authenticateRequest(req, res, next) {
  // Allow health check and static files without auth
  if (req.path === '/health' ||
      req.path === '/' ||
      req.path === '/index.html' ||
      req.path === '/console' ||
      req.path === '/console.html' ||
      req.path === '/runs' ||
      req.path === '/runs.html' ||
      req.path === '/dashboard' ||
      req.path === '/dashboard.html' ||
      req.path.startsWith('/public') ||
      req.path === '/favicon.ico') {
    return next();
  }

  // Check if authentication is enabled
  const apiKey = process.env.CLI_AGENTS_API_KEY;
  if (!apiKey) {
    // If no API key is configured, warn but allow access (dev mode)
    // In production, this should be enforced strictly
    if (process.env.NODE_ENV === 'production') {
      console.error('[Security] CLI_AGENTS_API_KEY not set in production mode');
      return sendError(res, 'AUTH_REQUIRED', {
        message: 'Server authentication is not configured correctly',
        status: 500
      });
    }
    return next();
  }

  // Check headers for API key
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  let providedKey = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7);
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  }

  if (!validateApiKey(providedKey)) {
    if (!providedKey) {
       return sendError(res, 'AUTH_REQUIRED', {
        message: 'Authentication required. Provide API key via Authorization: Bearer <key> or X-API-Key header.',
        status: 401
      });
    }
    return sendError(res, 'AUTH_FAILED', {
      message: 'Invalid API key',
      status: 403
    });
  }

  next();
}

/**
 * Validate an API key against the environment variable
 * @param {string} providedKey 
 * @returns {boolean}
 */
function validateApiKey(providedKey) {
  const apiKey = process.env.CLI_AGENTS_API_KEY;
  
  // If no API key is configured, allow access (dev mode)
  // In production check is done in middleware
  if (!apiKey) {
    return true;
  }

  if (!providedKey) {
    return false;
  }

  return constantTimeCompare(providedKey, apiKey);
}

/**
 * Constant-time string comparison
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

module.exports = {
  authenticateRequest,
  validateApiKey
};
