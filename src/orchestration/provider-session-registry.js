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
      preview: title || metadata.preview || `Codex session ${providerSessionId.slice(0, 12)}`,
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

          const match = entry.name.match(/-([0-9a-f-]{8,})\.jsonl$/i);
          if (match) {
            this.sessionFileMap.set(match[1], fullPath);
          }
        }
      }
    }

    return this.sessionFileMap.get(providerSessionId) || null;
  }

  _readSessionMeta(sessionFile) {
    let content = '';
    try {
      const fd = fs.openSync(sessionFile, 'r');
      const buffer = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      content = buffer.slice(0, bytesRead).toString('utf8');
    } catch {
      return {};
    }

    const lines = content.split('\n').slice(0, 32);
    let sessionMeta = null;
    let preview = null;

    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (!parsed) {
        continue;
      }

      if (parsed.type === 'session_meta' && parsed.payload && typeof parsed.payload === 'object') {
        sessionMeta = parsed.payload;
      }

      if (!preview && parsed.type === 'message' && parsed.role === 'user' && Array.isArray(parsed.content)) {
        const textEntry = parsed.content.find((entry) => entry?.type === 'input_text' && typeof entry.text === 'string');
        const text = String(textEntry?.text || '').replace(/\s+/g, ' ').trim();
        if (text && !text.startsWith('<environment_context>')) {
          preview = text.slice(0, 180);
        }
      }
    }

    return {
      title: sessionMeta?.title || null,
      updatedAt: normalizeIsoTimestamp(sessionMeta?.timestamp || null),
      cwd: sessionMeta?.cwd || null,
      model: sessionMeta?.model || null,
      preview,
      originator: sessionMeta?.originator || null,
      modelProvider: sessionMeta?.model_provider || null,
      archived: false
    };
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
