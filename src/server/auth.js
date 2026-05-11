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
const LOCAL_CONSOLE_LOGIN_VERSION = 'v1';
const DEFAULT_LOCAL_CONSOLE_LOGIN_TTL_MS = 60 * 1000;

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

function pushUniquePath(paths, filePath) {
  if (!filePath) {
    return;
  }
  const resolved = path.resolve(filePath);
  if (!paths.includes(resolved)) {
    paths.push(resolved);
  }
}

function getPackageDataDir(options = {}) {
  return path.resolve(
    normalizeEnvString(options.packageDataDir)
    || path.join(__dirname, '..', '..', 'data')
  );
}

function getLocalApiKeyFilePaths(options = {}) {
  const explicitFilePath = normalizeEnvString(options.filePath)
    || normalizeEnvString(process.env[LOCAL_API_KEY_FILE_ENV]);
  if (explicitFilePath) {
    return [path.resolve(explicitFilePath)];
  }

  if (options.dataDir) {
    return [path.resolve(options.dataDir, LOCAL_API_KEY_FILENAME)];
  }

  const envDataDir = normalizeEnvString(process.env[DATA_DIR_ENV]);
  if (envDataDir) {
    return [path.resolve(envDataDir, LOCAL_API_KEY_FILENAME)];
  }

  const paths = [];
  pushUniquePath(paths, normalizeEnvString(runtimeAuthConfig.localApiKeyFilePath));
  pushUniquePath(paths, path.join(process.cwd(), 'data', LOCAL_API_KEY_FILENAME));
  pushUniquePath(paths, path.join(getPackageDataDir(options), LOCAL_API_KEY_FILENAME));
  return paths;
}

function getLocalApiKeyFilePath(options = {}) {
  return getLocalApiKeyFilePaths(options)[0];
}

function readLocalApiKey(options = {}) {
  for (const filePath of getLocalApiKeyFilePaths(options)) {
    try {
      const value = fs.readFileSync(filePath, 'utf8').trim();
      if (value) {
        return value;
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }
      continue;
    }
  }
  return null;
}

function encodeJsonBase64Url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJsonBase64Url(value) {
  return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
}

function signLocalConsoleLoginPayload(encodedPayload, apiKey) {
  return crypto
    .createHmac('sha256', apiKey)
    .update(`${LOCAL_CONSOLE_LOGIN_VERSION}.${encodedPayload}`)
    .digest('base64url');
}

function createLocalConsoleLoginToken(options = {}) {
  const apiKey = normalizeEnvString(options.apiKey) || getConfiguredApiKey();
  if (!apiKey) {
    return null;
  }

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.max(1, Number(options.ttlMs))
    : DEFAULT_LOCAL_CONSOLE_LOGIN_TTL_MS;
  const payload = {
    purpose: 'local-console-login',
    expiresAt: now + ttlMs,
    nonce: crypto.randomBytes(16).toString('base64url')
  };
  const encodedPayload = encodeJsonBase64Url(payload);
  const signature = signLocalConsoleLoginPayload(encodedPayload, apiKey);
  return `${LOCAL_CONSOLE_LOGIN_VERSION}.${encodedPayload}.${signature}`;
}

function validateLocalConsoleLoginToken(token, options = {}) {
  const apiKey = normalizeEnvString(options.apiKey) || getConfiguredApiKey();
  if (!apiKey) {
    return {
      valid: false,
      reason: 'missing_api_key'
    };
  }

  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== LOCAL_CONSOLE_LOGIN_VERSION) {
    return {
      valid: false,
      reason: 'malformed_token'
    };
  }

  const [, encodedPayload, signature] = parts;
  const expectedSignature = signLocalConsoleLoginPayload(encodedPayload, apiKey);
  if (!constantTimeCompare(signature, expectedSignature)) {
    return {
      valid: false,
      reason: 'invalid_signature'
    };
  }

  let payload = null;
  try {
    payload = decodeJsonBase64Url(encodedPayload);
  } catch {
    return {
      valid: false,
      reason: 'invalid_payload'
    };
  }

  if (payload?.purpose !== 'local-console-login') {
    return {
      valid: false,
      reason: 'invalid_purpose'
    };
  }

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const expiresAt = Number(payload.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return {
      valid: false,
      reason: 'expired',
      expiresAt
    };
  }

  return {
    valid: true,
    expiresAt,
    payload
  };
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
      req.path === '/auth/local-console/exchange' ||
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
  getLocalApiKeyFilePaths,
  readLocalApiKey,
  createLocalConsoleLoginToken,
  validateLocalConsoleLoginToken,
  isLoopbackHost,
  isUnauthenticatedLocalhostModeEnabled,
  assertAuthConfigurationForHost
};
