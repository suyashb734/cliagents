/**
 * Authentication Middleware
 *
 * Protects API endpoints with API key authentication.
 * Fail-closed by default unless localhost-only unauthenticated mode is
 * explicitly enabled for local development.
 */

const net = require('net');
const { sendError } = require('../utils/errors');

const UNAUTH_LOCALHOST_ENV = 'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST';
const LEGACY_API_KEY_ENV = 'CLI_AGENTS_API_KEY';
const CANONICAL_API_KEY_ENV = 'CLIAGENTS_API_KEY';

function normalizeEnvString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function getConfiguredApiKey() {
  const canonical = normalizeEnvString(process.env[CANONICAL_API_KEY_ENV]);
  if (canonical) {
    return canonical;
  }
  return normalizeEnvString(process.env[LEGACY_API_KEY_ENV]);
}

function isUnauthenticatedLocalhostModeRequested() {
  return process.env[UNAUTH_LOCALHOST_ENV] === '1';
}

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return '';
  }

  let value = host.trim().toLowerCase();
  if (!value) {
    return '';
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }

  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) {
    value = value.slice(0, zoneIndex);
  }

  return value;
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return false;
  }

  if (normalized === 'localhost') {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return normalized.startsWith('127.');
  }
  if (ipVersion === 6) {
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
      return true;
    }
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      return net.isIP(mapped) === 4 && mapped.startsWith('127.');
    }
  }

  return false;
}

function isUnauthenticatedLocalhostModeEnabled() {
  if (getConfiguredApiKey()) {
    return false;
  }
  return isUnauthenticatedLocalhostModeRequested();
}

function assertAuthConfigurationForHost(host) {
  if (!isUnauthenticatedLocalhostModeEnabled()) {
    return;
  }

  if (!isLoopbackHost(host)) {
    throw new Error(
      `${UNAUTH_LOCALHOST_ENV}=1 requires a loopback bind host (received "${String(host)}"). ` +
      'Use 127.0.0.1, ::1, or localhost, or configure an API key instead.'
    );
  }
}

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

  if (isUnauthenticatedLocalhostModeEnabled()) {
    return next();
  }

  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return sendError(res, 'AUTH_REQUIRED', {
      message: 'Authentication required. Configure CLIAGENTS_API_KEY (or CLI_AGENTS_API_KEY).'
    });
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
  const apiKey = getConfiguredApiKey();

  if (isUnauthenticatedLocalhostModeEnabled()) {
    return true;
  }

  if (!apiKey) {
    return false;
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
  validateApiKey,
  getConfiguredApiKey,
  isLoopbackHost,
  isUnauthenticatedLocalhostModeEnabled,
  assertAuthConfigurationForHost
};
