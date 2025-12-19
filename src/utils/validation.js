/**
 * Input Validation Utilities
 *
 * Provides validation functions for API inputs to prevent security issues.
 */

const path = require('path');

// Configuration
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB max message size
const MAX_WORKDIR_LENGTH = 500;
const ALLOWED_WORKDIR_PREFIXES = ['/tmp', '/var/tmp', process.env.HOME];

/**
 * Validate workDir to prevent path traversal attacks
 * @param {string} workDir - The working directory path
 * @returns {{ valid: boolean, error?: string, sanitized?: string }}
 */
function validateWorkDir(workDir) {
  if (!workDir) {
    return { valid: true, sanitized: '/tmp/agent' };
  }

  if (typeof workDir !== 'string') {
    return { valid: false, error: 'workDir must be a string' };
  }

  if (workDir.length > MAX_WORKDIR_LENGTH) {
    return { valid: false, error: `workDir exceeds maximum length of ${MAX_WORKDIR_LENGTH}` };
  }

  // Normalize the path to resolve .. and .
  const normalized = path.normalize(workDir);

  // Check for path traversal attempts
  if (normalized.includes('..')) {
    return { valid: false, error: 'Path traversal detected in workDir' };
  }

  // Must be absolute path
  if (!path.isAbsolute(normalized)) {
    return { valid: false, error: 'workDir must be an absolute path' };
  }

  // Check for dangerous paths
  const dangerousPaths = ['/etc', '/usr', '/bin', '/sbin', '/root', '/sys', '/proc', '/dev'];
  for (const dangerous of dangerousPaths) {
    if (normalized === dangerous || normalized.startsWith(dangerous + '/')) {
      return { valid: false, error: `workDir cannot be in system directory: ${dangerous}` };
    }
  }

  // Ensure path is under allowed prefixes (if configured strictly)
  // For now, we just check it's not in dangerous locations

  return { valid: true, sanitized: normalized };
}

/**
 * Validate message size
 * @param {string} message - The message content
 * @returns {{ valid: boolean, error?: string }}
 */
function validateMessage(message) {
  if (!message) {
    return { valid: false, error: 'Message is required' };
  }

  if (typeof message !== 'string') {
    return { valid: false, error: 'Message must be a string' };
  }

  const size = Buffer.byteLength(message, 'utf8');
  if (size > MAX_MESSAGE_SIZE) {
    return {
      valid: false,
      error: `Message size (${Math.round(size / 1024)}KB) exceeds maximum allowed (${MAX_MESSAGE_SIZE / 1024}KB)`
    };
  }

  return { valid: true };
}

/**
 * Validate JSON schema (basic structure validation)
 * @param {object} schema - The JSON schema
 * @returns {{ valid: boolean, error?: string }}
 */
function validateJsonSchema(schema) {
  if (!schema) {
    return { valid: true }; // Optional field
  }

  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, error: 'jsonSchema must be an object' };
  }

  // Check for basic JSON schema structure
  if (!schema.type && !schema.properties && !schema.$ref) {
    return { valid: false, error: 'jsonSchema must have a type, properties, or $ref field' };
  }

  // Limit schema complexity (prevent DoS via deeply nested schemas)
  const schemaStr = JSON.stringify(schema);
  if (schemaStr.length > 50000) {
    return { valid: false, error: 'jsonSchema is too complex (max 50KB)' };
  }

  // Check nesting depth
  const depth = getObjectDepth(schema);
  if (depth > 10) {
    return { valid: false, error: 'jsonSchema nesting depth exceeds maximum of 10' };
  }

  return { valid: true };
}

/**
 * Get the maximum nesting depth of an object
 */
function getObjectDepth(obj, currentDepth = 0) {
  if (typeof obj !== 'object' || obj === null) {
    return currentDepth;
  }

  let maxDepth = currentDepth;
  for (const value of Object.values(obj)) {
    const depth = getObjectDepth(value, currentDepth + 1);
    if (depth > maxDepth) {
      maxDepth = depth;
    }
  }
  return maxDepth;
}

/**
 * Validate file name for upload
 * @param {string} fileName - The file name
 * @returns {{ valid: boolean, error?: string, sanitized?: string }}
 */
function validateFileName(fileName) {
  if (!fileName) {
    return { valid: false, error: 'File name is required' };
  }

  if (typeof fileName !== 'string') {
    return { valid: false, error: 'File name must be a string' };
  }

  // Check for path traversal in filename
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return { valid: false, error: 'Invalid characters in file name' };
  }

  // Limit filename length
  if (fileName.length > 255) {
    return { valid: false, error: 'File name exceeds maximum length of 255 characters' };
  }

  // Sanitize: remove any potentially dangerous characters
  const sanitized = fileName.replace(/[<>:"|?*\x00-\x1f]/g, '_');

  return { valid: true, sanitized };
}

module.exports = {
  validateWorkDir,
  validateMessage,
  validateJsonSchema,
  validateFileName,
  MAX_MESSAGE_SIZE,
  MAX_WORKDIR_LENGTH
};
