'use strict';

const BUSY_TERMINAL_STATUSES = new Set(['processing', 'queued', 'running']);
const DEFAULT_ARCHIVE_LEGACY_AFTER_MS = 30 * 60 * 1000;
const ROOT_SCOPE_VALUES = new Set(['user', 'all', 'detached', 'legacy']);
const USER_FACING_ORIGIN_CLIENTS = new Set([
  'codex',
  'qwen',
  'opencode',
  'gemini',
  'claude',
  'mcp',
  'openclaw'
]);
const USER_FACING_SESSION_KINDS = new Set(['attach', 'main']);

function parseMetadataField(value) {
  if (!value || typeof value !== 'string') {
    return value || null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeConclusionEvent(event) {
  if (!event) return null;
  const payload = event.payload_json || {};
  return {
    eventType: event.event_type,
    status: payload.status || null,
    summary: payload.decisionSummary || event.payload_summary || null,
    occurredAt: event.occurred_at,
    runId: event.run_id || null,
    discussionId: event.discussion_id || null
  };
}

function inferSessionStatus(node) {
  if (node.blocked) return 'blocked';
  if (node.stale) return 'stale';
  if (node.destroyed) return 'destroyed';

  if (node.taskState || node.terminalStatus) {
    return node.taskState || node.terminalStatus;
  }

  if (node.terminated) {
    if (node.terminationStatus === 'error' || node.attentionCode) {
      return 'error';
    }
    return node.exitCode && node.exitCode !== 0 ? 'error' : 'completed';
  }

  if (
    node.latestEventType === 'judge_completed' ||
    node.latestEventType === 'consensus_recorded' ||
    node.latestEventType === 'delegation_completed'
  ) {
    return 'completed';
  }

  if (
    node.latestEventType === 'discussion_started' ||
    node.latestEventType === 'discussion_round_started' ||
    node.latestEventType === 'delegation_started' ||
    node.latestEventType === 'session_started'
  ) {
    return 'running';
  }

  return 'unknown';
}

function buildSessionMap(events, terminals, rootSessionId) {
  const sessions = new Map();

  function ensureSession(sessionId) {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        rootSessionId,
        parentSessionId: null,
        sessionKind: null,
        adapter: null,
        agentProfile: null,
        role: null,
        name: null,
        model: null,
        workDir: null,
        originClient: null,
        externalSessionRef: null,
        lineageDepth: null,
        sessionMetadata: null,
        terminalId: null,
        terminalStatus: null,
        taskState: null,
        processState: null,
        lastActiveAt: null,
        lastEventType: null,
        lastEventAt: null,
        createdAt: null,
        blocked: false,
        stale: false,
        destroyed: false,
        terminated: false,
        terminationStatus: null,
        exitCode: null,
        attentionCode: null,
        attentionMessage: null,
        resumeCommand: null,
        latestConclusion: null,
        resumeCount: 0,
        wasReused: false,
        lastReuseReason: null
      });
    }
    return sessions.get(sessionId);
  }

  for (const event of events) {
    const node = ensureSession(event.session_id);
    const payload = event.payload_json || {};

    if (event.parent_session_id && !node.parentSessionId) {
      node.parentSessionId = event.parent_session_id;
    }
    if (!node.originClient && event.origin_client) {
      node.originClient = event.origin_client;
    }
    if (!node.sessionMetadata && event.metadata && typeof event.metadata === 'object') {
      node.sessionMetadata = event.metadata;
    }

    node.lastEventType = event.event_type;
    node.lastEventAt = event.occurred_at || event.recorded_at || node.lastEventAt;

    if (event.event_type === 'session_started') {
      node.sessionKind = payload.sessionKind || node.sessionKind;
      node.adapter = payload.adapter || node.adapter;
      node.role = payload.role || node.role;
      node.name = payload.name || node.name;
      node.model = payload.model || node.model;
      node.workDir = payload.workDir || node.workDir;
      node.externalSessionRef = payload.externalSessionRef || node.externalSessionRef;
    } else if (event.event_type === 'session_resumed') {
      node.resumeCount += 1;
      node.wasReused = true;
      node.lastReuseReason = payload.reuseReason || node.lastReuseReason;
    }

    if (event.event_type === 'session_stale') {
      node.stale = true;
    } else if (event.event_type === 'session_destroyed') {
      node.destroyed = true;
    } else if (event.event_type === 'session_terminated') {
      node.terminated = true;
      node.terminationStatus = payload.status || node.terminationStatus;
      if (payload.exitCode !== undefined && payload.exitCode !== null) {
        node.exitCode = payload.exitCode;
      }
      node.attentionCode = payload.attentionCode || node.attentionCode;
      node.attentionMessage = payload.attentionMessage || node.attentionMessage;
      node.resumeCommand = payload.resumeCommand || node.resumeCommand;
    } else if (event.event_type === 'user_input_requested') {
      node.blocked = true;
    } else if (event.event_type === 'user_input_received') {
      node.blocked = false;
    }

    if (event.event_type === 'consensus_recorded' || event.event_type === 'judge_completed') {
      node.latestConclusion = summarizeConclusionEvent(event);
    }
  }

  for (const terminal of terminals) {
    const node = ensureSession(terminal.terminal_id);
    node.terminalId = terminal.terminal_id;
    node.parentSessionId = terminal.parent_session_id || node.parentSessionId;
    node.sessionKind = terminal.session_kind || node.sessionKind;
    node.adapter = terminal.adapter || node.adapter;
    node.agentProfile = terminal.agent_profile || node.agentProfile;
    node.role = terminal.role || node.role;
    node.workDir = terminal.work_dir || node.workDir;
    node.originClient = terminal.origin_client || node.originClient;
    node.externalSessionRef = terminal.external_session_ref || node.externalSessionRef;
    node.lineageDepth = terminal.lineage_depth ?? node.lineageDepth;
    node.sessionMetadata = parseMetadataField(terminal.session_metadata) || node.sessionMetadata;
    node.terminalStatus = terminal.status || node.terminalStatus;
    node.taskState = terminal.task_state || terminal.taskState || terminal.status || node.taskState;
    node.processState = terminal.process_state || terminal.processState || node.processState;
    node.attentionCode = terminal.attention_code || node.attentionCode;
    node.attentionMessage = terminal.attention_message || node.attentionMessage;
    node.resumeCommand = terminal.resume_command || node.resumeCommand;
    node.createdAt = terminal.created_at || node.createdAt;
    node.lastActiveAt = terminal.last_active || node.lastActiveAt;
  }

  const rootNode = ensureSession(rootSessionId);
  rootNode.parentSessionId = null;

  return sessions;
}

function buildAttentionSummary(sessionList) {
  const reasons = [];
  const blockedSessions = sessionList.filter((session) => session.status === 'blocked');
  const staleSessions = sessionList.filter((session) => session.status === 'stale');
  const failedSessions = sessionList.filter((session) => session.status === 'error' || (session.exitCode && session.exitCode !== 0));

  for (const session of blockedSessions) {
    reasons.push({
      code: 'user_input_required',
      sessionId: session.sessionId,
      message: `Session ${session.sessionId} is waiting for input or permission.`
    });
  }

  for (const session of staleSessions) {
    reasons.push({
      code: 'stale_session',
      sessionId: session.sessionId,
      message: `Session ${session.sessionId} is marked stale.`
    });
  }

  for (const session of failedSessions) {
    reasons.push({
      code: 'failed_session',
      sessionId: session.sessionId,
      message: session.attentionMessage || `Session ${session.sessionId} failed or exited non-zero.`,
      resumeCommand: session.resumeCommand || null
    });
  }

  return {
    requiresAttention: reasons.length > 0,
    reasons,
    blockedSessionIds: blockedSessions.map((session) => session.sessionId),
    staleSessionIds: staleSessions.map((session) => session.sessionId),
    failedSessionIds: failedSessions.map((session) => session.sessionId)
  };
}

function isBusyRootSession(session) {
  return Boolean(BUSY_TERMINAL_STATUSES.has(session.status));
}

function isPromptIdleRootSession(session) {
  return Boolean(
    session.status === 'idle'
    && session.processState !== 'exited'
    && USER_FACING_SESSION_KINDS.has(String(session.sessionKind || '').trim().toLowerCase())
    && session.terminalId
  );
}

function deriveRootStatus(sessionList, attention) {
  if (attention.blockedSessionIds.length > 0) {
    return 'blocked';
  }
  if (attention.requiresAttention) {
    return 'needs_attention';
  }

  const runningCount = sessionList.filter(isBusyRootSession).length;

  if (runningCount > 0) {
    return 'running';
  }

  const idleCount = sessionList.filter(isPromptIdleRootSession).length;
  if (idleCount > 0) {
    return 'idle';
  }

  if (sessionList.length > 0) {
    return 'completed';
  }

  return 'unknown';
}

function resolveArchiveAfterMs(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ARCHIVE_LEGACY_AFTER_MS;
}

function normalizeRootScope(value) {
  const normalized = String(value || 'user').trim().toLowerCase();
  return ROOT_SCOPE_VALUES.has(normalized) ? normalized : 'user';
}

function classifyRootSession(snapshot) {
  const rootSession = snapshot?.rootSession || {};
  const originClient = String(rootSession.originClient || '').trim().toLowerCase();
  const sessionKind = String(rootSession.sessionKind || '').trim().toLowerCase();
  const sessionMetadata = rootSession.sessionMetadata && typeof rootSession.sessionMetadata === 'object'
    ? rootSession.sessionMetadata
    : {};
  const attachMode = String(sessionMetadata.attachMode || '').trim().toLowerCase();
  const externalSessionRef = rootSession.externalSessionRef
    || sessionMetadata.externalSessionRef
    || sessionMetadata.clientSessionRef
    || null;
  const clientName = String(sessionMetadata.clientName || '').trim().toLowerCase() || null;
  const implicitFirstUse = attachMode === 'implicit-first-use';
  const explicitAttach = attachMode.startsWith('explicit-');
  const originClientUserFacing = Boolean(originClient) && originClient !== 'system' && USER_FACING_ORIGIN_CLIENTS.has(originClient);
  const clientNameUserFacing = Boolean(clientName) && originClient !== 'system' && USER_FACING_ORIGIN_CLIENTS.has(clientName);
  const attached = !implicitFirstUse && (
    Boolean(externalSessionRef)
    || explicitAttach
    || USER_FACING_SESSION_KINDS.has(sessionKind)
    || originClientUserFacing
    || clientNameUserFacing
  );

  if (originClient === 'legacy') {
    return {
      rootType: 'legacy_root',
      userFacing: false,
      externalSessionRef: externalSessionRef || null,
      clientName
    };
  }

  if (attached) {
    return {
      rootType: 'attached_client_root',
      userFacing: true,
      externalSessionRef: externalSessionRef || null,
      clientName
    };
  }

  if (originClient === 'system') {
    return {
      rootType: 'detached_worker_root',
      userFacing: false,
      externalSessionRef: null,
      clientName
    };
  }

  return {
    rootType: 'workflow_root',
    userFacing: false,
    externalSessionRef: externalSessionRef || null,
    clientName
  };
}

function shouldIncludeRootSummary(summary, scope) {
  const normalizedScope = normalizeRootScope(scope);
  if (normalizedScope === 'all') {
    return true;
  }
  if (normalizedScope === 'detached') {
    return summary.rootType === 'detached_worker_root';
  }
  if (normalizedScope === 'legacy') {
    return summary.rootType === 'legacy_root';
  }
  return summary.userFacing !== false;
}

function shouldArchiveRootSummary(summary, options = {}) {
  const monitorOptions = options && typeof options === 'object' ? options : {};
  if (summary?.originClient !== 'legacy') {
    return false;
  }

  const attention = summary?.attention || { requiresAttention: false, reasons: [] };
  const reasons = Array.isArray(attention.reasons) ? attention.reasons : [];
  if (!attention.requiresAttention || reasons.length === 0) {
    return false;
  }

  if (reasons.some((reason) => reason?.code !== 'stale_session')) {
    return false;
  }

  const counts = summary?.counts || {};
  if ((counts.running || 0) > 0 || (counts.blocked || 0) > 0 || (counts.failed || 0) > 0 || (counts.terminals || 0) > 0) {
    return false;
  }

  const lastOccurredAt = normalizeTimestamp(summary?.lastOccurredAt || summary?.lastRecordedAt);
  if (!Number.isFinite(lastOccurredAt)) {
    return false;
  }

  const nowMs = Number.isFinite(monitorOptions.nowMs) ? monitorOptions.nowMs : Date.now();
  const archiveAfterMs = resolveArchiveAfterMs(monitorOptions.archiveAfterMs);
  return nowMs - lastOccurredAt >= archiveAfterMs;
}

function buildRootSessionSnapshot({
  db,
  rootSessionId,
  eventLimit = 400,
  terminalLimit = 200,
  liveTerminalResolver = null
}) {
  if (!db?.listSessionEvents || !db?.listTerminals) {
    throw new Error('root session monitoring requires orchestration DB support');
  }

  const events = db.listSessionEvents({ rootSessionId, limit: eventLimit });
  const terminals = db.listTerminals({ rootSessionId, limit: terminalLimit })
    .map((terminal) => {
      if (typeof liveTerminalResolver !== 'function') {
        return terminal;
      }

      const terminalId = terminal.terminal_id || terminal.terminalId;
      if (!terminalId) {
        return terminal;
      }

      const liveTerminal = liveTerminalResolver(terminalId);
      if (!liveTerminal) {
        return terminal;
      }

      return {
        ...terminal,
        status: liveTerminal.taskState || liveTerminal.status || terminal.status,
        task_state: liveTerminal.taskState || liveTerminal.status || terminal.status,
        process_state: liveTerminal.processState || null,
        current_command: liveTerminal.currentCommand || null,
        attention_code: liveTerminal.attention?.code || null,
        attention_message: liveTerminal.attention?.message || null,
        resume_command: liveTerminal.attention?.resumeCommand || null,
        last_active: liveTerminal.lastActive || terminal.last_active,
        work_dir: liveTerminal.workDir || terminal.work_dir,
        adapter: liveTerminal.adapter || terminal.adapter,
        role: liveTerminal.role || terminal.role,
        origin_client: liveTerminal.originClient || terminal.origin_client,
        external_session_ref: liveTerminal.externalSessionRef || terminal.external_session_ref,
        session_kind: liveTerminal.sessionKind || terminal.session_kind,
        session_metadata: liveTerminal.sessionMetadata
          ? JSON.stringify(liveTerminal.sessionMetadata)
          : terminal.session_metadata
      };
    });

  if (events.length === 0 && terminals.length === 0) {
    return null;
  }

  const sessionMap = buildSessionMap(events, terminals, rootSessionId);
  const sessionList = Array.from(sessionMap.values())
    .map((session) => ({
      ...session,
      status: inferSessionStatus(session)
    }))
    .sort((left, right) => {
      const leftTime = normalizeTimestamp(left.lastEventAt || left.lastActiveAt || left.createdAt) || 0;
      const rightTime = normalizeTimestamp(right.lastEventAt || right.lastActiveAt || right.createdAt) || 0;
      if (rightTime !== leftTime) {
        return rightTime - leftTime;
      }
      return String(left.sessionId).localeCompare(String(right.sessionId));
    });

  const attention = buildAttentionSummary(sessionList);
  const latestConclusionEvent = [...events].reverse().find((event) => (
    event.event_type === 'consensus_recorded' || event.event_type === 'judge_completed'
  ));
  const rootSession = sessionList.find((session) => session.sessionId === rootSessionId) || {
    sessionId: rootSessionId,
    parentSessionId: null,
    status: 'unknown'
  };

  const counts = {
    sessions: sessionList.length,
    terminals: terminals.length,
    running: sessionList.filter(isBusyRootSession).length,
    idle: sessionList.filter(isPromptIdleRootSession).length,
    blocked: attention.blockedSessionIds.length,
    stale: attention.staleSessionIds.length,
    failed: attention.failedSessionIds.length,
    completed: sessionList.filter((session) => session.status === 'completed').length,
    reusedSessions: sessionList.filter((session) => session.wasReused).length,
    reuseEvents: sessionList.reduce((total, session) => total + (session.resumeCount || 0), 0)
  };
  const classification = classifyRootSession({
    rootSession,
    sessions: sessionList,
    counts,
    attention
  });

  return {
    rootSessionId,
    status: deriveRootStatus(sessionList, attention),
    rootSession,
    rootType: classification.rootType,
    userFacing: classification.userFacing,
    externalSessionRef: classification.externalSessionRef,
    clientName: classification.clientName,
    counts,
    attention,
    latestConclusion: summarizeConclusionEvent(latestConclusionEvent),
    events,
    terminals,
    sessions: sessionList
  };
}

function listRootSessionSummaries({
  db,
  limit = 20,
  eventLimit = 120,
  terminalLimit = 50,
  includeArchived = false,
  archiveAfterMs,
  nowMs,
  scope = 'user',
  liveTerminalResolver = null
} = {}) {
  if (!db?.listRootSessions) {
    throw new Error('root session listing requires orchestration DB support');
  }

  const normalizedScope = normalizeRootScope(scope);
  const scanLimit = includeArchived ? limit : Math.max(limit * 5, limit + 50);
  const rootRows = new Map();
  for (const row of db.listRootSessions({ limit: scanLimit })) {
    rootRows.set(row.root_session_id, row);
  }

  if (db.listTerminals) {
    const terminalScanLimit = Math.max(scanLimit, terminalLimit, 200);
    for (const terminal of db.listTerminals({ limit: terminalScanLimit })) {
      const rootSessionId = terminal.root_session_id || terminal.rootSessionId || terminal.terminal_id || terminal.terminalId;
      if (!rootSessionId || rootRows.has(rootSessionId)) {
        continue;
      }
      const lastSeenAt = terminal.last_active || terminal.lastActive || terminal.created_at || terminal.createdAt || null;
      rootRows.set(rootSessionId, {
        root_session_id: rootSessionId,
        last_recorded_at: lastSeenAt,
        last_occurred_at: lastSeenAt,
        event_count: 0
      });
    }
  }

  const summaries = Array.from(rootRows.values()).map((row) => {
    const snapshot = buildRootSessionSnapshot({
      db,
      rootSessionId: row.root_session_id,
      eventLimit,
      terminalLimit,
      liveTerminalResolver
    });

    return {
      rootSessionId: row.root_session_id,
      lastRecordedAt: row.last_recorded_at,
      lastOccurredAt: row.last_occurred_at,
      eventCount: row.event_count,
      status: snapshot?.status || 'unknown',
      originClient: snapshot?.rootSession?.originClient || null,
      rootType: snapshot?.rootType || 'workflow_root',
      userFacing: snapshot?.userFacing !== false,
      externalSessionRef: snapshot?.externalSessionRef || null,
      clientName: snapshot?.clientName || null,
      latestConclusion: snapshot?.latestConclusion || null,
      attention: snapshot?.attention || { requiresAttention: false, reasons: [] },
      counts: snapshot?.counts || null
    };
  }).sort((left, right) => {
    const leftTime = normalizeTimestamp(left.lastOccurredAt || left.lastRecordedAt) || 0;
    const rightTime = normalizeTimestamp(right.lastOccurredAt || right.lastRecordedAt) || 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return String(left.rootSessionId).localeCompare(String(right.rootSessionId));
  });

  let archivedCount = 0;
  let hiddenDetachedCount = 0;
  let hiddenNonUserCount = 0;
  const visibleRoots = [];
  for (const summary of summaries) {
    const archived = shouldArchiveRootSummary(summary, {
      archiveAfterMs,
      nowMs
    });
    if (archived) {
      archivedCount += 1;
      if (!includeArchived) {
        continue;
      }
    }

    if (!shouldIncludeRootSummary(summary, normalizedScope)) {
      if (summary.rootType === 'detached_worker_root') {
        hiddenDetachedCount += 1;
      } else {
        hiddenNonUserCount += 1;
      }
      continue;
    }

    visibleRoots.push({
      ...summary,
      archived
    });
  }

  return {
    roots: visibleRoots.slice(0, limit),
    archivedCount,
    hiddenDetachedCount,
    hiddenNonUserCount,
    scope: normalizedScope
  };
}

module.exports = {
  buildRootSessionSnapshot,
  listRootSessionSummaries,
  shouldArchiveRootSummary,
  classifyRootSession,
  normalizeRootScope
};
