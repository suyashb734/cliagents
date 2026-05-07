/**
 * Authentication Middleware
 *
 * Protects API endpoints with API key authentication.
 * Fail-closed by default unless localhost-only unauthenticated mode is
 * explicitly enabled for local development.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { sendError } = require('../utils/errors');

const UNAUTH_LOCALHOST_ENV = 'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST';
const LEGACY_API_KEY_ENV = 'CLI_AGENTS_API_KEY';
const CANONICAL_API_KEY_ENV = 'CLIAGENTS_API_KEY';
const LOCAL_API_KEY_FILE_ENV = 'CLIAGENTS_LOCAL_API_KEY_FILE';
const DATA_DIR_ENV = 'CLIAGENTS_DATA_DIR';
const LOCAL_API_KEY_FILENAME = 'local-api-key';

let runtimeAuthConfig = {
  localApiKeyFilePath: null
};

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
  const legacy = normalizeEnvString(process.env[LEGACY_API_KEY_ENV]);
  if (legacy) {
    return legacy;
  }
  return readLocalApiKey();
}

function getConfiguredEnvApiKey() {
  return normalizeEnvString(process.env[CANONICAL_API_KEY_ENV])
    || normalizeEnvString(process.env[LEGACY_API_KEY_ENV]);
}

function getConfiguredApiKeySource() {
  const canonical = normalizeEnvString(process.env[CANONICAL_API_KEY_ENV]);
  if (canonical) {
    return CANONICAL_API_KEY_ENV;
  }
  const legacy = normalizeEnvString(process.env[LEGACY_API_KEY_ENV]);
  if (legacy) {
    return LEGACY_API_KEY_ENV;
  }
  const local = readLocalApiKey();
  if (local) {
    return 'local-file';
  }
  return null;
}

function configureAuth(options = {}) {
  runtimeAuthConfig = {
    ...runtimeAuthConfig,
    ...(options.localApiKeyFilePath !== undefined
      ? { localApiKeyFilePath: options.localApiKeyFilePath || null }
      : {})
  };
}

function getDefaultDataDir() {
  return normalizeEnvString(process.env[DATA_DIR_ENV]) || path.join(process.cwd(), 'data');
}

function getLocalApiKeyFilePath(options = {}) {
  const explicitFilePath = normalizeEnvString(options.filePath)
    || normalizeEnvString(process.env[LOCAL_API_KEY_FILE_ENV]);
  if (explicitFilePath) {
    return path.resolve(explicitFilePath);
  }

  if (options.dataDir) {
    return path.resolve(options.dataDir, LOCAL_API_KEY_FILENAME);
  }

  return path.resolve(
    normalizeEnvString(runtimeAuthConfig.localApiKeyFilePath)
    || path.join(getDefaultDataDir(), LOCAL_API_KEY_FILENAME)
  );
}

function readLocalApiKey(options = {}) {
  const filePath = getLocalApiKeyFilePath(options);
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value || null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

function ensureLocalApiKey(options = {}) {
  const filePath = getLocalApiKeyFilePath(options);
  if (normalizeEnvString(process.env[CANONICAL_API_KEY_ENV]) || normalizeEnvString(process.env[LEGACY_API_KEY_ENV])) {
    return {
      enabled: false,
      source: 'env',
      filePath,
      apiKey: null
    };
  }
  if (isUnauthenticatedLocalhostModeRequested()) {
    return {
      enabled: false,
      source: UNAUTH_LOCALHOST_ENV,
      filePath,
      apiKey: null
    };
  }

  const existing = readLocalApiKey({ filePath });
  if (existing) {
    return {
      enabled: true,
      source: 'local-file',
      filePath,
      apiKey: existing,
      created: false
    };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const apiKey = `cliagents-local-${crypto.randomBytes(32).toString('base64url')}`;
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${apiKey}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const concurrent = readLocalApiKey({ filePath });
      if (concurrent) {
        return {
          enabled: true,
          source: 'local-file',
          filePath,
          apiKey: concurrent,
          created: false
        };
      }
    }
    throw error;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}

  return {
    enabled: true,
    source: 'local-file',
    filePath,
    apiKey,
    created: true
  };
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
  if (getConfiguredEnvApiKey()) {
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
  getConfiguredApiKeySource,
  configureAuth,
  ensureLocalApiKey,
  getLocalApiKeyFilePath,
  readLocalApiKey,
  isLoopbackHost,
  isUnauthenticatedLocalhostModeEnabled,
  assertAuthConfigurationForHost
};
