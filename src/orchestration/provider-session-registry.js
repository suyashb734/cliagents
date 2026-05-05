const fs = require('fs');
const os = require('os');
const path = require('path');

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeIsoTimestamp(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizePreviewText(value, maxLength = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isUsefulUserMessage(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }
  return !normalized.startsWith('<environment_context>')
    && !normalized.startsWith('# AGENTS.md instructions')
    && !normalized.startsWith('<INSTRUCTIONS>')
    && !normalized.startsWith('<turn_aborted>');
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      return entry.text || entry.message || entry.content || '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractMessageFromCodexRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const payload = row.payload && typeof row.payload === 'object' ? row.payload : null;
  if (row.type === 'response_item' && payload?.type === 'message') {
    return {
      role: String(payload.role || '').trim(),
      text: extractContentText(payload.content)
    };
  }

  if (row.type === 'message') {
    return {
      role: String(row.role || '').trim(),
      text: extractContentText(row.content)
    };
  }

  if (row.type === 'event_msg' && payload?.type === 'user_message') {
    return {
      role: 'user',
      text: payload.message || ''
    };
  }

  if (row.type === 'event_msg' && payload?.type === 'agent_message') {
    return {
      role: 'assistant',
      text: payload.message || ''
    };
  }

  return null;
}

function sortByUpdatedAtDescending(left, right) {
  const leftTs = Date.parse(left?.updatedAt || 0) || 0;
  const rightTs = Date.parse(right?.updatedAt || 0) || 0;
  if (leftTs !== rightTs) {
    return rightTs - leftTs;
  }
  return String(left?.providerSessionId || '').localeCompare(String(right?.providerSessionId || ''));
}

class CodexProviderSessionBackend {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.codexDir = options.codexDir || path.join(this.homeDir, '.codex');
    this.indexPath = path.join(this.codexDir, 'session_index.jsonl');
    this.sessionsDir = path.join(this.codexDir, 'sessions');
    this.sessionFileMap = null;
    this.sessionMetaCache = new Map();
  }

  isSupported() {
    return fs.existsSync(this.indexPath) || fs.existsSync(this.sessionsDir);
  }

  refresh() {
    this.sessionFileMap = null;
    this.sessionMetaCache.clear();
  }

  listSessions(options = {}) {
    this.refresh();
    const includeArchived = options.includeArchived === true;
    const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
    const entries = this._readIndexEntries();
    const sessions = entries
      .map((entry) => this._buildDescriptor(entry))
      .filter(Boolean)
      .filter((entry) => includeArchived || entry.archived !== true)
      .sort(sortByUpdatedAtDescending)
      .slice(0, limit);

    return {
      adapter: 'codex-cli',
      supported: this.isSupported(),
      sessions
    };
  }

  getSession(providerSessionId) {
    this.refresh();
    const normalizedId = String(providerSessionId || '').trim();
    if (!normalizedId) {
      return null;
    }

    const indexEntry = this._readIndexEntries().find((entry) => entry.id === normalizedId) || null;
    if (indexEntry) {
      return this._buildDescriptor(indexEntry);
    }

    const metadata = this._loadSessionMetadata(normalizedId);
    if (!metadata.sessionFile) {
      return null;
    }

    return {
      adapter: 'codex-cli',
      providerSessionId: normalizedId,
      title: metadata.title || `Codex session ${normalizedId.slice(0, 12)}`,
      updatedAt: metadata.updatedAt || null,
      cwd: metadata.cwd || null,
      model: metadata.model || null,
      preview: metadata.preview || metadata.title || `Codex session ${normalizedId.slice(0, 12)}`,
      summary: metadata.summary || metadata.preview || metadata.title || `Codex session ${normalizedId.slice(0, 12)}`,
      firstUserMessage: metadata.firstUserMessage || null,
      lastUserMessage: metadata.lastUserMessage || null,
      lastAssistantMessage: metadata.lastAssistantMessage || null,
      messageCount: metadata.messageCount || 0,
      archived: Boolean(metadata.archived),
      resumeCapability: 'exact',
      metadata: {
        source: 'codex-local',
        sessionFile: metadata.sessionFile || null,
        originator: metadata.originator || null,
        modelProvider: metadata.modelProvider || null
      }
    };
  }

  _readIndexEntries() {
    if (!fs.existsSync(this.indexPath)) {
      return [];
    }

    const lines = fs.readFileSync(this.indexPath, 'utf8').split('\n');
    const entries = [];
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (!parsed || !parsed.id) {
        continue;
      }
      entries.push(parsed);
    }
    return entries;
  }

  _buildDescriptor(entry) {
    const providerSessionId = String(entry?.id || '').trim();
    if (!providerSessionId) {
      return null;
    }

    const metadata = this._loadSessionMetadata(providerSessionId);
    const title = String(entry.thread_name || metadata.title || `Codex session ${providerSessionId.slice(0, 12)}`).trim();
    const updatedAt = normalizeIsoTimestamp(entry.updated_at || metadata.updatedAt);
    const archived = Boolean(entry.archived || entry.is_archived || metadata.archived);

    return {
      adapter: 'codex-cli',
      providerSessionId,
      title: title || `Codex session ${providerSessionId.slice(0, 12)}`,
      updatedAt,
      cwd: metadata.cwd || null,
      model: metadata.model || null,
      preview: metadata.preview || title || `Codex session ${providerSessionId.slice(0, 12)}`,
      summary: metadata.summary || metadata.preview || title || `Codex session ${providerSessionId.slice(0, 12)}`,
      firstUserMessage: metadata.firstUserMessage || null,
      lastUserMessage: metadata.lastUserMessage || null,
      lastAssistantMessage: metadata.lastAssistantMessage || null,
      messageCount: metadata.messageCount || 0,
      archived,
      resumeCapability: 'exact',
      metadata: {
        source: 'codex-local',
        sessionFile: metadata.sessionFile || null,
        originator: metadata.originator || null,
        modelProvider: metadata.modelProvider || null
      }
    };
  }

  _loadSessionMetadata(providerSessionId) {
    if (this.sessionMetaCache.has(providerSessionId)) {
      return this.sessionMetaCache.get(providerSessionId);
    }

    const sessionFile = this._findSessionFile(providerSessionId);
    if (!sessionFile) {
      const empty = {};
      this.sessionMetaCache.set(providerSessionId, empty);
      return empty;
    }

    const metadata = this._readSessionMeta(sessionFile);
    const result = {
      ...metadata,
      sessionFile
    };
    this.sessionMetaCache.set(providerSessionId, result);
    return result;
  }

  _findSessionFile(providerSessionId) {
    if (!fs.existsSync(this.sessionsDir)) {
      return null;
    }

    if (!this.sessionFileMap) {
      this.sessionFileMap = new Map();
      const stack = [this.sessionsDir];
      while (stack.length > 0) {
        const currentDir = stack.pop();
        let entries = [];
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            stack.push(fullPath);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
            continue;
          }

          const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
          if (match) {
            this.sessionFileMap.set(match[1], fullPath);
          }
        }
      }
    }

    return this.sessionFileMap.get(providerSessionId) || null;
  }

  _readSessionMeta(sessionFile) {
    let lines = [];
    try {
      lines = this._readSessionSampleLines(sessionFile);
    } catch {
      return {};
    }

    let sessionMeta = null;
    let firstUserMessage = null;
    let lastUserMessage = null;
    let lastAssistantMessage = null;
    let userMessageCount = 0;
    let assistantMessageCount = 0;

    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (!parsed) {
        continue;
      }

      if (parsed.type === 'session_meta' && parsed.payload && typeof parsed.payload === 'object') {
        sessionMeta = parsed.payload;
      }

      const message = extractMessageFromCodexRow(parsed);
      const text = normalizePreviewText(message?.text || '', 360);
      if (!message?.role || !text) {
        continue;
      }

      if (message.role === 'user' && isUsefulUserMessage(text)) {
        userMessageCount += 1;
        if (!firstUserMessage) {
          firstUserMessage = text;
        }
        lastUserMessage = text;
      } else if (message.role === 'assistant') {
        assistantMessageCount += 1;
        lastAssistantMessage = text;
      }
    }

    const summary = lastUserMessage
      ? `Last user: ${normalizePreviewText(lastUserMessage, 220)}`
      : (firstUserMessage ? `Started with: ${normalizePreviewText(firstUserMessage, 220)}` : null);

    return {
      title: sessionMeta?.title || null,
      updatedAt: normalizeIsoTimestamp(sessionMeta?.timestamp || null),
      cwd: sessionMeta?.cwd || null,
      model: sessionMeta?.model || null,
      preview: lastUserMessage || firstUserMessage || null,
      summary,
      firstUserMessage,
      lastUserMessage,
      lastAssistantMessage,
      messageCount: userMessageCount + assistantMessageCount,
      originator: sessionMeta?.originator || null,
      modelProvider: sessionMeta?.model_provider || null,
      archived: false
    };
  }

  _readSessionSampleLines(sessionFile) {
    const stat = fs.statSync(sessionFile);
    const headBytes = Math.min(stat.size, 128 * 1024);
    const tailBytes = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(sessionFile, 'r');
    try {
      const headBuffer = Buffer.alloc(headBytes);
      fs.readSync(fd, headBuffer, 0, headBytes, 0);
      const headText = headBuffer.toString('utf8');

      if (stat.size <= headBytes) {
        return headText.split('\n');
      }

      const tailStart = Math.max(0, stat.size - tailBytes);
      const tailBuffer = Buffer.alloc(tailBytes);
      fs.readSync(fd, tailBuffer, 0, tailBytes, tailStart);
      const tailLines = tailBuffer.toString('utf8').split('\n');
      if (tailStart > 0) {
        tailLines.shift();
      }
      return [...headText.split('\n'), ...tailLines];
    } finally {
      fs.closeSync(fd);
    }
  }
}

class ProviderSessionRegistry {
  constructor(options = {}) {
    this.backends = new Map();
    this.backends.set('codex-cli', new CodexProviderSessionBackend(options.codex || {}));
  }

  listSessions(options = {}) {
    const adapter = String(options.adapter || 'codex-cli').trim().toLowerCase() || 'codex-cli';
    const backend = this.backends.get(adapter);
    if (!backend) {
      return {
        adapter,
        supported: false,
        sessions: []
      };
    }
    return backend.listSessions(options);
  }

  getSession(options = {}) {
    const adapter = String(options.adapter || 'codex-cli').trim().toLowerCase() || 'codex-cli';
    const providerSessionId = String(options.providerSessionId || '').trim();
    const backend = this.backends.get(adapter);
    if (!backend || !providerSessionId) {
      return null;
    }
    return backend.getSession(providerSessionId);
  }
}

let providerSessionRegistry = null;

function getProviderSessionRegistry(options = {}) {
  if (!providerSessionRegistry) {
    providerSessionRegistry = new ProviderSessionRegistry(options);
  }
  return providerSessionRegistry;
}

module.exports = {
  ProviderSessionRegistry,
  getProviderSessionRegistry
};
