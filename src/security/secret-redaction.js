'use strict';

const REDACTION_PLACEHOLDER = '[REDACTED_SECRET]';

const SECRET_NAME_PATTERN = '[A-Za-z0-9_\\-]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_\\-]*';

const REDACTION_RULES = [
  {
    reason: 'secret_assignment',
    pattern: new RegExp(`\\b(${SECRET_NAME_PATTERN})\\b(\\s*[:=]\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;]+)`, 'gi'),
    replace: (_match, keyName, separator) => `${keyName}${separator}${REDACTION_PLACEHOLDER}`
  },
  {
    reason: 'secret_cli_flag',
    pattern: /(--?(?:api-key|access-token|token|password|secret)\s+)(\S+)/gi,
    replace: (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`
  },
  {
    reason: 'bearer_token',
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})\b/g,
    replace: (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`
  },
  {
    reason: 'openai_key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replace: REDACTION_PLACEHOLDER
  },
  {
    reason: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: REDACTION_PLACEHOLDER
  },
  {
    reason: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTION_PLACEHOLDER
  },
  {
    reason: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
    replace: REDACTION_PLACEHOLDER
  },
  {
    reason: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replace: REDACTION_PLACEHOLDER
  }
];

const SECRET_FIELD_HINT_PATTERN = /(password|passphrase|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)/i;

function redactSecretsInText(content) {
  let text = content == null ? '' : String(content);
  const reasons = new Set();

  for (const rule of REDACTION_RULES) {
    let matched = false;
    text = text.replace(rule.pattern, (...args) => {
      matched = true;
      return typeof rule.replace === 'function'
        ? rule.replace(...args)
        : rule.replace;
    });
    if (matched) {
      reasons.add(rule.reason);
    }
  }

  return {
    content: text,
    redacted: reasons.size > 0,
    reasons: Array.from(reasons)
  };
}

function redactSecretObject(value, options = {}, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactSecretsInText(value).content;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretObject(entry, options, seen));
  }

  const replacement = String(options.replacement || REDACTION_PLACEHOLDER);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) {
      output[key] = entry;
      continue;
    }

    if (typeof entry === 'string' && SECRET_FIELD_HINT_PATTERN.test(key)) {
      output[key] = replacement;
      continue;
    }

    output[key] = redactSecretObject(entry, options, seen);
  }
  return output;
}

module.exports = {
  REDACTION_PLACEHOLDER,
  redactSecretsInText,
  redactSecretObject
};
