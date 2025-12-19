/**
 * Standardized Error Codes and Helper Functions
 *
 * Provides consistent error responses across the API.
 */

// Error codes following common LLM API patterns
const ErrorCodes = {
  // Client errors (4xx)
  INVALID_REQUEST: {
    code: 'invalid_request_error',
    status: 400,
    message: 'The request was invalid or malformed'
  },
  MISSING_PARAMETER: {
    code: 'missing_parameter',
    status: 400,
    message: 'A required parameter was missing'
  },
  INVALID_PARAMETER: {
    code: 'invalid_parameter',
    status: 400,
    message: 'A parameter value was invalid'
  },
  SESSION_NOT_FOUND: {
    code: 'session_not_found',
    status: 404,
    message: 'The specified session was not found'
  },
  ADAPTER_NOT_FOUND: {
    code: 'adapter_not_found',
    status: 404,
    message: 'The specified adapter was not found'
  },
  ADAPTER_UNAVAILABLE: {
    code: 'adapter_unavailable',
    status: 503,
    message: 'The adapter CLI is not available on this system'
  },

  // Server errors (5xx)
  INTERNAL_ERROR: {
    code: 'internal_error',
    status: 500,
    message: 'An internal server error occurred'
  },
  CLI_ERROR: {
    code: 'cli_error',
    status: 500,
    message: 'The CLI process returned an error'
  },
  TIMEOUT: {
    code: 'timeout_error',
    status: 504,
    message: 'The request timed out'
  },

  // Rate limiting
  RATE_LIMIT: {
    code: 'rate_limit_exceeded',
    status: 429,
    message: 'Rate limit exceeded. Please try again later'
  },
  MAX_SESSIONS: {
    code: 'max_sessions_reached',
    status: 429,
    message: 'Maximum concurrent sessions reached'
  }
};

/**
 * Create a standardized error response
 */
function createError(errorType, details = {}) {
  const errorDef = ErrorCodes[errorType] || ErrorCodes.INTERNAL_ERROR;
  return {
    error: {
      code: errorDef.code,
      message: details.message || errorDef.message,
      param: details.param || null,
      type: errorDef.code
    },
    status: errorDef.status
  };
}

/**
 * Express middleware for standardized error handling
 */
function errorHandler(err, req, res, next) {
  console.error('[Error]', err);

  // Check for known error patterns
  if (err.message?.includes('not found')) {
    const errorResponse = createError('SESSION_NOT_FOUND', { message: err.message });
    return res.status(errorResponse.status).json({ error: errorResponse.error });
  }

  if (err.message?.includes('timed out') || err.message?.includes('timeout')) {
    const errorResponse = createError('TIMEOUT', { message: err.message });
    return res.status(errorResponse.status).json({ error: errorResponse.error });
  }

  if (err.message?.includes('not registered') || err.message?.includes('not available')) {
    const errorResponse = createError('ADAPTER_UNAVAILABLE', { message: err.message });
    return res.status(errorResponse.status).json({ error: errorResponse.error });
  }

  // Default to internal error
  const errorResponse = createError('INTERNAL_ERROR', { message: err.message });
  res.status(errorResponse.status).json({ error: errorResponse.error });
}

/**
 * Helper to send standardized error response
 */
function sendError(res, errorType, details = {}) {
  const errorResponse = createError(errorType, details);
  res.status(errorResponse.status).json({ error: errorResponse.error });
}

module.exports = {
  ErrorCodes,
  createError,
  errorHandler,
  sendError
};
