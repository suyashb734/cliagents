'use strict';

const STATUS_WORKING = new Set(['running', 'processing', 'pending', 'queued', 'claimed', 'spawned']);
const STATUS_WAITING = new Set(['waiting_permission', 'waiting_user_answer', 'blocked']);
const STATUS_FAILED = new Set(['error', 'failed']);
const STATUS_STOPPED = new Set(['cancelled', 'canceled', 'abandoned', 'orphaned', 'destroyed', 'stopped']);

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase() || 'unknown';
}

function coerceTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function deriveSessionState(subject = {}) {
  const status = normalizeStatus(subject.status || subject.taskState || subject.lifecycleStatus);
  const processState = normalizeStatus(subject.processState || subject.process_state);
  const live = subject.live === true || processState === 'alive' || subject.hasActiveProcess === true;
  const lastActiveAt = coerceTimestamp(subject.lastActivity || subject.lastActive || subject.last_active || subject.updatedAt);
  const createdAt = coerceTimestamp(subject.createdAt || subject.created_at);

  let task = 'idle';
  if (STATUS_WAITING.has(status)) {
    task = 'needs_input';
  } else if (STATUS_WORKING.has(status)) {
    task = 'working';
  } else if (status === 'completed') {
    task = 'completed';
  } else if (STATUS_FAILED.has(status)) {
    task = 'failed';
  } else if (STATUS_STOPPED.has(status)) {
    task = 'stopped';
  } else if (status === 'idle' || status === 'stable' || status === 'ready') {
    task = 'idle';
  }

  let liveness = 'unknown';
  if (status === 'orphaned') {
    liveness = 'orphaned';
  } else if (processState === 'exited' || STATUS_STOPPED.has(status)) {
    liveness = 'exited';
  } else if (live) {
    liveness = 'alive';
  } else if (subject.evicted === true) {
    liveness = 'evicted';
  }

  const attention = task === 'needs_input' || task === 'failed' || liveness === 'orphaned';
  return {
    task,
    liveness,
    attention,
    status,
    processState: processState === 'unknown' ? null : processState,
    live,
    lastActiveAt,
    createdAt
  };
}

function summarizePendingInput(item) {
  if (!item) {
    return null;
  }
  return {
    id: item.id,
    terminalId: item.terminalId,
    status: item.status,
    inputKind: item.inputKind,
    controlMode: item.controlMode,
    requestedBy: item.requestedBy || null,
    approvalRequired: item.approvalRequired === true,
    expiresAt: item.expiresAt || null,
    createdAt: item.createdAt || null
  };
}

function summarizeLease(lease) {
  if (!lease) {
    return null;
  }
  return {
    id: lease.id,
    terminalId: lease.terminalId,
    rootSessionId: lease.rootSessionId || null,
    sessionId: lease.sessionId || null,
    holder: lease.holder,
    purpose: lease.purpose || null,
    status: lease.status,
    expiresAt: lease.expiresAt,
    heartbeatAt: lease.heartbeatAt || null,
    createdAt: lease.createdAt
  };
}

function buildApiSessionPeek(sessionId, statusPayload = {}) {
  const sessionState = deriveSessionState({
    ...statusPayload,
    lifecycleStatus: statusPayload.status,
    live: statusPayload.hasActiveProcess === true
  });

  return {
    sessionId,
    sessionKind: 'api-session',
    source: 'api-session-manager',
    status: statusPayload.status || null,
    sessionState,
    adapter: statusPayload.adapterName || statusPayload.adapter || null,
    profile: null,
    rootSessionId: null,
    parentSessionId: null,
    taskId: null,
    taskAssignmentId: null,
    model: statusPayload.model || null,
    providerSessionId: statusPayload.providerSessionId || null,
    workDir: statusPayload.workDir || null,
    pendingInput: [],
    inputLease: null,
    tail: null,
    timestamps: {
      createdAt: statusPayload.createdAt || null,
      lastActivity: statusPayload.lastActivity || null,
      idleMs: statusPayload.idleMs || null
    }
  };
}

function buildTerminalPeek({
  sessionId,
  terminal,
  persistedTerminal = null,
  pendingInput = [],
  inputLease = null,
  tail = null
} = {}) {
  const metadata = terminal?.sessionMetadata
    || terminal?.session_metadata
    || persistedTerminal?.sessionMetadata
    || persistedTerminal?.session_metadata
    || {};
  const parsedMetadata = typeof metadata === 'string'
    ? safeJson(metadata)
    : (metadata && typeof metadata === 'object' ? metadata : {});
  const sessionState = deriveSessionState({
    ...(persistedTerminal || {}),
    ...(terminal || {}),
    status: terminal?.status || terminal?.taskState || persistedTerminal?.status,
    processState: terminal?.processState || terminal?.process_state || persistedTerminal?.process_state,
    live: terminal?.live
  });

  return {
    sessionId,
    sessionKind: terminal?.sessionKind || terminal?.session_kind || persistedTerminal?.session_kind || parsedMetadata.sessionKind || 'terminal',
    source: 'orchestration-terminal',
    status: terminal?.status || terminal?.taskState || persistedTerminal?.status || null,
    sessionState,
    adapter: terminal?.adapter || persistedTerminal?.adapter || null,
    profile: terminal?.agentProfile || terminal?.agent_profile || persistedTerminal?.agent_profile || parsedMetadata.agentProfile || null,
    rootSessionId: terminal?.rootSessionId || terminal?.root_session_id || persistedTerminal?.root_session_id || sessionId,
    parentSessionId: terminal?.parentSessionId || terminal?.parent_session_id || persistedTerminal?.parent_session_id || null,
    taskId: parsedMetadata.taskId || null,
    taskAssignmentId: parsedMetadata.taskAssignmentId || null,
    model: terminal?.model || persistedTerminal?.model || null,
    requestedModel: terminal?.requestedModel || persistedTerminal?.requested_model || null,
    effectiveModel: terminal?.effectiveModel || persistedTerminal?.effective_model || terminal?.model || persistedTerminal?.model || null,
    workDir: terminal?.workDir || terminal?.work_dir || persistedTerminal?.work_dir || null,
    runtimeHost: terminal?.runtimeHost || terminal?.runtime_host || persistedTerminal?.runtime_host || null,
    runtimeFidelity: terminal?.runtimeFidelity || terminal?.runtime_fidelity || persistedTerminal?.runtime_fidelity || null,
    pendingInput: (pendingInput || []).map(summarizePendingInput),
    inputLease: summarizeLease(inputLease),
    tail,
    attention: terminal?.attention || null,
    timestamps: {
      createdAt: terminal?.createdAt || persistedTerminal?.created_at || null,
      lastActivity: terminal?.lastActive || terminal?.last_active || persistedTerminal?.last_active || null
    }
  };
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  deriveSessionState,
  buildApiSessionPeek,
  buildTerminalPeek
};
