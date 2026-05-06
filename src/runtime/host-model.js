'use strict';

const RUNTIME_HOSTS = Object.freeze({
  TMUX: 'tmux',
  ADOPTED: 'adopted',
  DIRECT_PTY: 'direct_pty',
  SSH: 'ssh',
  CONTAINER: 'container'
});

const RUNTIME_FIDELITY = Object.freeze({
  MANAGED: 'managed',
  ADOPTED_PARTIAL: 'adopted-partial',
  NATIVE_VISIBLE: 'native-visible'
});

const HOST_CAPABILITIES = Object.freeze({
  [RUNTIME_HOSTS.TMUX]: Object.freeze([
    'read_output',
    'send_input',
    'resize',
    'detach',
    'multi_viewer',
    'stream_events',
    'kill'
  ]),
  [RUNTIME_HOSTS.ADOPTED]: Object.freeze([
    'inspect_history',
    'stream_events'
  ]),
  [RUNTIME_HOSTS.DIRECT_PTY]: Object.freeze([
    'read_output',
    'send_input',
    'resize',
    'stream_events'
  ]),
  [RUNTIME_HOSTS.SSH]: Object.freeze([
    'read_output',
    'send_input',
    'resize',
    'detach',
    'stream_events'
  ]),
  [RUNTIME_HOSTS.CONTAINER]: Object.freeze([
    'read_output',
    'send_input',
    'stream_events',
    'kill'
  ])
});

const VALID_RUNTIME_HOSTS = new Set(Object.values(RUNTIME_HOSTS));
const VALID_RUNTIME_FIDELITY = new Set(Object.values(RUNTIME_FIDELITY));

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRuntimeHost(value, fallback = RUNTIME_HOSTS.TMUX) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_RUNTIME_HOSTS.has(normalized) ? normalized : fallback;
}

function normalizeRuntimeFidelity(value, fallback = RUNTIME_FIDELITY.MANAGED) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_RUNTIME_FIDELITY.has(normalized) ? normalized : fallback;
}

function normalizeRuntimeCapabilities(value, runtimeHost = RUNTIME_HOSTS.TMUX) {
  const fallback = HOST_CAPABILITIES[normalizeRuntimeHost(runtimeHost)] || [];
  const source = parseJsonArray(value);
  const capabilities = source.length > 0 ? source : fallback;
  return [...new Set(
    capabilities
      .map((capability) => String(capability || '').trim())
      .filter(Boolean)
  )].sort();
}

function inferRuntimeId(terminal) {
  const runtimeId = terminal?.runtimeId || terminal?.runtime_id;
  if (runtimeId) {
    return String(runtimeId);
  }

  const sessionName = terminal?.sessionName || terminal?.session_name;
  const windowName = terminal?.windowName || terminal?.window_name;
  if (sessionName && windowName) {
    return `${sessionName}:${windowName}`;
  }

  return terminal?.terminalId || terminal?.terminal_id || null;
}

function resolveRuntimeHostMetadata(terminal = {}, overrides = {}) {
  const metadata = terminal.sessionMetadata || terminal.session_metadata || {};
  const metadataObject = parseJsonObject(metadata);
  const runtimeHost = normalizeRuntimeHost(
    overrides.runtimeHost
      || terminal.runtimeHost
      || terminal.runtime_host
      || metadataObject.runtimeHost
      || null,
    RUNTIME_HOSTS.TMUX
  );
  const adoptedAt = overrides.adoptedAt || terminal.adoptedAt || terminal.adopted_at || null;
  const runtimeFidelity = normalizeRuntimeFidelity(
    overrides.runtimeFidelity
      || terminal.runtimeFidelity
      || terminal.runtime_fidelity
      || metadataObject.runtimeFidelity
      || null,
    adoptedAt ? RUNTIME_FIDELITY.ADOPTED_PARTIAL : RUNTIME_FIDELITY.MANAGED
  );
  const runtimeCapabilities = normalizeRuntimeCapabilities(
    overrides.runtimeCapabilities
      || terminal.runtimeCapabilities
      || terminal.runtime_capabilities
      || metadataObject.runtimeCapabilities
      || null,
    runtimeHost
  );
  const runtimeId = overrides.runtimeId
    || terminal.runtimeId
    || terminal.runtime_id
    || inferRuntimeId(terminal);

  return {
    runtimeHost,
    runtimeId: runtimeId || null,
    runtimeCapabilities,
    runtimeFidelity,
    runtime: {
      host: runtimeHost,
      id: runtimeId || null,
      capabilities: runtimeCapabilities,
      fidelity: runtimeFidelity
    }
  };
}

function serializeRuntimeCapabilities(value, runtimeHost = RUNTIME_HOSTS.TMUX) {
  return JSON.stringify(normalizeRuntimeCapabilities(value, runtimeHost));
}

module.exports = {
  RUNTIME_HOSTS,
  RUNTIME_FIDELITY,
  HOST_CAPABILITIES,
  normalizeRuntimeHost,
  normalizeRuntimeFidelity,
  normalizeRuntimeCapabilities,
  resolveRuntimeHostMetadata,
  serializeRuntimeCapabilities
};
