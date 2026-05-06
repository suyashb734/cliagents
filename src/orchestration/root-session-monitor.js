'use strict';

const { resolveRuntimeHostMetadata } = require('../runtime/host-model');

const BUSY_TERMINAL_STATUSES = new Set(['processing', 'queued', 'running']);
const ACTIVE_ROOT_STATUSES = new Set(['running', 'processing', 'pending', 'partial', 'blocked', 'needs_attention']);
const DEFAULT_ARCHIVE_LEGACY_AFTER_MS = 30 * 60 * 1000;
const ROOT_SCOPE_VALUES = new Set(['user', 'all', 'detached', 'legacy']);
const ROOT_STATUS_FILTER_VALUES = new Set(['all', 'live', 'actionable', 'active', 'completed']);
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
const BLOCKED_SESSION_STATUSES = new Set(['blocked', 'waiting_permission', 'waiting_user_answer']);
const OUTPUT_PREFERRED_EVENT_TYPES = new Set([
  'message_received',
  'message_sent',
  'session_started',
  'session_resumed',
  'session_terminated',
  'session_stale',
  'session_destroyed'
]);

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

function truncateActivityText(value, maxLength = 240) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function truncateActivityTailText(value, maxLength = 320) {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, index, lines) => (
      line.length > 0 || (index > 0 && index < lines.length - 1)
    ))
    .join('\n')
    .trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `…${normalized.slice(-(Math.max(0, maxLength - 1))).trimStart()}`;
}

function normalizeActivityLines(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isLowSignalActivityLine(line) {
  const normalized = String(line || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return true;
  }

  return (
    /^[─━-]{4,}$/.test(normalized)
    || /^[❯>›]\s*$/u.test(normalized)
    || /^[\w.-]+@[\w.-]+.*[#$%>]\s*$/.test(normalized)
    || /^(?:java version|Java\(TM\)|Java HotSpot)/i.test(normalized)
    || /^⬆\s+\/\S+/u.test(normalized)
    || /^PR\s+#\d+/i.test(normalized)
    || /Update available!/i.test(normalized)
  );
}

function summarizeOutputExcerpt(value, maxLength = 240) {
  const lines = normalizeActivityLines(value);
  if (lines.length === 0) {
    return '';
  }

  const prioritizedMatchers = [
    (line) => /^assistant:\s+/i.test(line),
    (line) => /^[⏺✦✓•]\s+/u.test(line),
    (line) => /^[❯>›]\s+\S/u.test(line)
  ];

  for (const matcher of prioritizedMatchers) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!matcher(lines[index])) {
        continue;
      }
      return truncateActivityText(lines[index].replace(/^assistant:\s+/i, ''), maxLength);
    }
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isLowSignalActivityLine(lines[index])) {
      return truncateActivityText(lines[index], maxLength);
    }
  }

  return truncateActivityText(lines[lines.length - 1], maxLength);
}

function inferSessionStatus(node) {
  if (node.blocked) return 'blocked';
  if (node.destroyed) return 'destroyed';
  if (node.stale) return 'stale';

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
        currentCommand: null,
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
        providerThreadRef: null,
        runtimeHost: null,
        runtimeId: null,
        runtimeCapabilities: [],
        runtimeFidelity: null,
        runtime: null,
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
    const terminalSessionMetadata = parseMetadataField(terminal.session_metadata);
    const runtimeMetadata = resolveRuntimeHostMetadata({
      ...terminal,
      sessionMetadata: terminalSessionMetadata
    });
    node.terminalId = terminal.terminal_id;
    node.parentSessionId = terminal.parent_session_id || node.parentSessionId;
    node.sessionKind = terminal.session_kind || node.sessionKind;
    node.adapter = terminal.adapter || node.adapter;
    node.agentProfile = terminal.agent_profile || node.agentProfile;
    node.role = terminal.role || node.role;
    node.model = terminal.model || node.model;
    node.workDir = terminal.work_dir || node.workDir;
    node.originClient = terminal.origin_client || node.originClient;
    node.externalSessionRef = terminal.external_session_ref || node.externalSessionRef;
    node.lineageDepth = terminal.lineage_depth ?? node.lineageDepth;
    node.sessionMetadata = terminalSessionMetadata || node.sessionMetadata;
    node.terminalStatus = terminal.status || node.terminalStatus;
    node.taskState = terminal.task_state || terminal.taskState || terminal.status || node.taskState;
    node.processState = terminal.process_state || terminal.processState || node.processState;
    node.currentCommand = terminal.current_command || terminal.currentCommand || node.currentCommand;
    node.attentionCode = terminal.attention_code || node.attentionCode;
    node.attentionMessage = terminal.attention_message || node.attentionMessage;
    node.resumeCommand = terminal.resume_command || node.resumeCommand;
    node.providerThreadRef = terminal.provider_thread_ref || terminal.providerThreadRef || node.providerThreadRef;
    node.runtimeHost = runtimeMetadata.runtimeHost;
    node.runtimeId = runtimeMetadata.runtimeId;
    node.runtimeCapabilities = runtimeMetadata.runtimeCapabilities;
    node.runtimeFidelity = runtimeMetadata.runtimeFidelity;
    node.runtime = runtimeMetadata.runtime;
    node.createdAt = terminal.created_at || node.createdAt;
    node.lastActiveAt = terminal.last_active || node.lastActiveAt;

    const liveTaskState = String(terminal.task_state || terminal.taskState || terminal.status || '').trim().toLowerCase();
    const liveProcessState = String(terminal.process_state || terminal.processState || '').trim().toLowerCase();
    const liveTerminalPresent = Boolean(liveTaskState || liveProcessState);
    const liveTerminalRecovered = liveTerminalPresent
      && liveTaskState !== 'orphaned'
      && liveProcessState !== 'exited';
    if (liveTerminalRecovered) {
      node.stale = false;
    }
  }

  const rootNode = ensureSession(rootSessionId);
  rootNode.parentSessionId = null;

  return sessions;
}

function buildAttentionSummary(sessionList) {
  const reasons = [];
  const blockedSessions = sessionList.filter((session) => BLOCKED_SESSION_STATUSES.has(session.status));
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

function isLiveOperatorSession(session) {
  const runtimeCapabilities = Array.isArray(session?.runtimeCapabilities)
    ? session.runtimeCapabilities
    : [];
  const runtimeIsControllable = runtimeCapabilities.length === 0
    || runtimeCapabilities.includes('send_input')
    || runtimeCapabilities.includes('read_output');
  return Boolean(
    session
    && session.terminalId
    && runtimeIsControllable
    && session.processState !== 'exited'
    && session.status !== 'stale'
    && session.status !== 'destroyed'
    && session.status !== 'completed'
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

function normalizeRootStatusFilter(value) {
  const normalized = String(value || 'all').trim().toLowerCase();
  return ROOT_STATUS_FILTER_VALUES.has(normalized) ? normalized : 'all';
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
  const implicitFirstUse = attachMode.startsWith('implicit');
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

function deriveRootCapabilities(classification, rootSession) {
  const rootType = classification?.rootType || 'workflow_root';
  const sessionKind = String(rootSession?.sessionKind || '').trim().toLowerCase();
  const metadata = rootSession?.sessionMetadata && typeof rootSession.sessionMetadata === 'object'
    ? rootSession.sessionMetadata
    : {};
  const attachMode = String(metadata.attachMode || '').trim().toLowerCase();
  const adopted = attachMode === 'root-adopt'
    || attachMode === 'provider-session-import'
    || metadata.adoptedRoot === true
    || metadata.importedProviderSession === true;
  const runtimeCapabilities = Array.isArray(rootSession?.runtimeCapabilities)
    ? rootSession.runtimeCapabilities
    : [];

  if (rootType === 'attached_client_root') {
    if (adopted) {
      return {
        sessionKind: 'adopted',
        visibility: runtimeCapabilities.includes('send_input') ? 'interactive' : 'read-only',
        replyCapability: runtimeCapabilities.includes('send_input') ? 'full' : 'partial'
      };
    }

    if (sessionKind === 'main') {
      return {
        sessionKind: 'managed',
        visibility: 'interactive',
        replyCapability: 'full'
      };
    }

    return {
      sessionKind: 'attached',
      visibility: 'read-only',
      replyCapability: 'partial'
    };
  }

  if (rootType === 'detached_worker_root') {
    return {
      sessionKind: 'detached',
      visibility: 'internal',
      replyCapability: 'none'
    };
  }

  if (rootType === 'legacy_root') {
    return {
      sessionKind: 'legacy',
      visibility: 'historical',
      replyCapability: 'none'
    };
  }

  return {
    sessionKind: 'workflow',
    visibility: 'internal',
    replyCapability: 'none'
  };
}

function deriveRootMode(classification, rootSession) {
  const rootType = classification?.rootType || 'workflow_root';
  if (rootType !== 'attached_client_root') {
    return null;
  }

  const metadata = rootSession?.sessionMetadata && typeof rootSession.sessionMetadata === 'object'
    ? rootSession.sessionMetadata
    : {};
  const attachMode = String(metadata.attachMode || '').trim().toLowerCase();
  if (
    attachMode === 'root-adopt'
    || attachMode === 'provider-session-import'
    || metadata.adoptedRoot === true
    || metadata.importedProviderSession === true
  ) {
    return 'adopted';
  }

  const sessionKind = String(rootSession?.sessionKind || '').trim().toLowerCase();
  if (sessionKind === 'main') {
    return 'managed';
  }

  return 'attached';
}

function deriveRecoveryCapability({
  rootMode,
  sessions,
  counts,
  lastMessageAt,
  eventCount
}) {
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const liveCount = Number(counts?.live || 0);

  if ((rootMode === 'managed' || rootMode === 'adopted') && liveCount > 0) {
    return 'live_reattach';
  }

  const hasExactResumeHandle = sessionList.some((session) => (
    Boolean(session?.providerThreadRef) || Boolean(session?.resumeCommand)
  ));
  if (hasExactResumeHandle) {
    return 'exact_provider_resume';
  }

  if (lastMessageAt || Number(eventCount || 0) > 0) {
    return 'context_resume';
  }

  return 'unrecoverable';
}

function resolveInteractiveTerminalId(rootSessionId, sessionList, rootMode) {
  if (rootMode !== 'managed' && rootMode !== 'adopted') {
    return null;
  }

  const rootSession = sessionList.find((session) => session.sessionId === rootSessionId);
  if (rootSession?.terminalId) {
    return rootSession.terminalId;
  }

  const mainSession = sessionList.find((session) => (
    session.terminalId
    && String(session.sessionKind || '').trim().toLowerCase() === 'main'
    && !session.parentSessionId
  ));
  return mainSession?.terminalId || null;
}

function findLatestMeaningfulEvent(events) {
  const ignoredEventTypes = new Set([
    'session_started',
    'session_resumed'
  ]);

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    const payload = event.payload_json || {};
    if (truncateActivityText(payload.activitySummary)) {
      return event;
    }
    if (truncateActivityText(payload.activityExcerpt)) {
      return event;
    }
    if (ignoredEventTypes.has(String(event.event_type || '').trim().toLowerCase())) {
      continue;
    }
    if (truncateActivityText(event.payload_summary)) {
      return event;
    }
  }

  return null;
}

function readLiveActivityExcerpt(liveOutputResolver, terminalId) {
  if (typeof liveOutputResolver !== 'function' || !terminalId) {
    return '';
  }

  const extractRecentExcerpt = (output) => {
    const lines = normalizeActivityLines(output);
    if (lines.length === 0) {
      return '';
    }

    let startIndex = Math.max(0, lines.length - 8);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!isLowSignalActivityLine(lines[index])) {
        startIndex = Math.max(0, index - 2);
        break;
      }
    }

    return truncateActivityTailText(lines.slice(startIndex).join('\n'), 320);
  };

  try {
    const visibleOutput = liveOutputResolver(terminalId, {
      mode: 'visible',
      format: 'plain',
      lines: 120
    });
    const visibleExcerpt = extractRecentExcerpt(visibleOutput);
    if (visibleExcerpt) {
      return visibleExcerpt;
    }
  } catch {
    // Ignore live output resolution failures and continue to history fallback.
  }

  try {
    const historyOutput = liveOutputResolver(terminalId, {
      mode: 'history',
      format: 'plain',
      lines: 120
    });
    return extractRecentExcerpt(historyOutput);
  } catch {
    return '';
  }
}

function buildRootFallbackSummary(rootStatus, rootSession) {
  const normalizedStatus = String(rootStatus || 'unknown').trim().toLowerCase();
  const adapter = truncateActivityText(rootSession?.adapter || '');
  const currentCommand = truncateActivityText(rootSession?.currentCommand || '');

  if (normalizedStatus === 'blocked') {
    return currentCommand
      ? `Waiting for input while ${currentCommand} is active.`
      : 'Waiting for input or permission.';
  }
  if (normalizedStatus === 'running') {
    if (currentCommand) {
      return `Running ${currentCommand}.`;
    }
    if (adapter) {
      return `${adapter} is actively working.`;
    }
    return 'Root is actively working.';
  }
  if (normalizedStatus === 'idle') {
    if (currentCommand) {
      return `Idle at ${currentCommand}.`;
    }
    if (adapter) {
      return `${adapter} is idle at a prompt.`;
    }
    return 'Idle at a prompt.';
  }
  if (normalizedStatus === 'needs_attention') {
    return 'Needs operator attention.';
  }
  if (normalizedStatus === 'completed') {
    return 'Completed and no longer running.';
  }
  return 'State could not be determined yet.';
}

function deriveRootActivityDetails({
  rootStatus,
  rootSession,
  latestConclusion,
  attention,
  events,
  liveOutputResolver,
  interactiveTerminalId
}) {
  const conclusionSummary = truncateActivityText(latestConclusion?.summary || '');
  const outputExcerpt = readLiveActivityExcerpt(liveOutputResolver, interactiveTerminalId);
  const outputSummary = summarizeOutputExcerpt(outputExcerpt);

  if (conclusionSummary) {
    return {
      activitySummary: conclusionSummary,
      activityExcerpt: outputExcerpt || null,
      activitySource: 'conclusion'
    };
  }

  const attentionReason = Array.isArray(attention?.reasons) ? attention.reasons[0] : null;
  const attentionSummary = truncateActivityText(attentionReason?.message || '');
  if (attentionSummary) {
    return {
      activitySummary: attentionSummary,
      activityExcerpt: outputExcerpt || null,
      activitySource: 'attention'
    };
  }

  const meaningfulEvent = findLatestMeaningfulEvent(Array.isArray(events) ? events : []);
  if (meaningfulEvent) {
    const payload = meaningfulEvent.payload_json || {};
    const eventSummary = truncateActivityText(payload.activitySummary || meaningfulEvent.payload_summary || '');
    const eventExcerpt = truncateActivityText(payload.activityExcerpt || '') || null;
    const eventType = String(meaningfulEvent.event_type || '').trim().toLowerCase();
    const preferLiveOutputSummary = outputSummary && OUTPUT_PREFERRED_EVENT_TYPES.has(eventType);
    if (eventSummary || eventExcerpt) {
      if (!preferLiveOutputSummary) {
        return {
          activitySummary: eventSummary || summarizeOutputExcerpt(eventExcerpt),
          activityExcerpt: eventExcerpt || outputExcerpt || null,
          activitySource: 'event'
        };
      }
    }
  }

  if (outputSummary) {
    return {
      activitySummary: outputSummary,
      activityExcerpt: outputExcerpt || null,
      activitySource: 'output'
    };
  }

  if (meaningfulEvent) {
    const payload = meaningfulEvent.payload_json || {};
    const eventSummary = truncateActivityText(payload.activitySummary || meaningfulEvent.payload_summary || '');
    const eventExcerpt = truncateActivityText(payload.activityExcerpt || '') || null;
    if (eventSummary || eventExcerpt) {
      return {
        activitySummary: eventSummary || summarizeOutputExcerpt(eventExcerpt),
        activityExcerpt: eventExcerpt || outputExcerpt || null,
        activitySource: 'event'
      };
    }
  }

  return {
    activitySummary: buildRootFallbackSummary(rootStatus, rootSession),
    activityExcerpt: null,
    activitySource: 'fallback'
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

  const lastOccurredAt = normalizeTimestamp(summary?.lastMessageAt || summary?.lastOccurredAt || summary?.lastRecordedAt);
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
  liveTerminalResolver = null,
  liveOutputResolver = null
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
        provider_thread_ref: liveTerminal.providerThreadRef || terminal.provider_thread_ref || null,
        runtime_host: liveTerminal.runtimeHost || terminal.runtime_host || null,
        runtime_id: liveTerminal.runtimeId || terminal.runtime_id || null,
        runtime_capabilities: liveTerminal.runtimeCapabilities
          ? JSON.stringify(liveTerminal.runtimeCapabilities)
          : terminal.runtime_capabilities,
        runtime_fidelity: liveTerminal.runtimeFidelity || terminal.runtime_fidelity || null,
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
  const mainTerminal = terminals.find((terminal) => (
    String(terminal?.role || '').trim().toLowerCase() === 'main'
    && String(terminal?.session_kind || '').trim().toLowerCase() === 'main'
  )) || terminals.find((terminal) => {
    const terminalRootSessionId = terminal?.root_session_id || terminal?.rootSessionId || terminal?.terminal_id || terminal?.terminalId;
    return terminalRootSessionId === rootSessionId;
  }) || null;
  const rootRuntimeTerminal = terminals.find((terminal) => (
    String(terminal?.role || '').trim().toLowerCase() === 'main'
    && String(terminal?.session_kind || '').trim().toLowerCase() === 'main'
  )) || terminals.find((terminal) => {
    const terminalId = terminal?.terminal_id || terminal?.terminalId;
    return terminalId === rootSessionId;
  }) || null;
  const lastMessageAtMs = terminals.reduce((max, terminal) => (
    Math.max(max, normalizeTimestamp(terminal?.last_message_at || terminal?.lastMessageAt))
  ), 0);
  const lastMessageAt = lastMessageAtMs > 0 ? new Date(lastMessageAtMs).toISOString() : null;
  const messageCount = typeof db.countMessages === 'function'
    ? db.countMessages({ rootSessionId })
    : 0;

  const counts = {
    sessions: sessionList.length,
    terminals: terminals.length,
    live: sessionList.filter(isLiveOperatorSession).length,
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
  const capabilities = deriveRootCapabilities(classification, rootSession);
  const rootMode = deriveRootMode(classification, rootSession);
  const interactiveTerminalId = resolveInteractiveTerminalId(rootSessionId, sessionList, rootMode);
  const rootStatus = deriveRootStatus(sessionList, attention);
  const hasRootRuntimeMetadata = Boolean(
    rootSession.runtimeHost
    || rootSession.runtime_host
    || rootRuntimeTerminal?.runtime_host
    || rootRuntimeTerminal?.runtimeHost
  );
  const rootRuntime = hasRootRuntimeMetadata
    ? resolveRuntimeHostMetadata({
      ...rootRuntimeTerminal,
      ...rootSession
    })
    : null;
  const recoveryCapability = deriveRecoveryCapability({
    rootMode,
    sessions: sessionList,
    counts,
    lastMessageAt,
    eventCount: events.length
  });
  const activity = deriveRootActivityDetails({
    rootStatus,
    rootSession,
    latestConclusion: summarizeConclusionEvent(latestConclusionEvent),
    attention,
    events,
    liveOutputResolver,
    interactiveTerminalId
  });

  return {
    rootSessionId,
    status: rootStatus,
    rootSession: {
      ...rootSession,
      model: rootSession.model || mainTerminal?.model || null,
      lastMessageAt,
      messageCount
    },
    runtimeHost: rootRuntime?.runtimeHost || null,
    runtimeId: rootRuntime?.runtimeId || null,
    runtimeCapabilities: rootRuntime?.runtimeCapabilities || [],
    runtimeFidelity: rootRuntime?.runtimeFidelity || null,
    runtime: rootRuntime?.runtime || null,
    rootType: classification.rootType,
    rootMode,
    sessionKind: capabilities.sessionKind,
    visibility: capabilities.visibility,
    replyCapability: capabilities.replyCapability,
    interactiveTerminalId,
    activitySummary: activity.activitySummary,
    activityExcerpt: activity.activityExcerpt,
    activitySource: activity.activitySource,
    userFacing: classification.userFacing,
    externalSessionRef: classification.externalSessionRef,
    clientName: classification.clientName,
    lastMessageAt,
    messageCount,
    recoveryCapability,
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
  statusFilter = 'all',
  liveTerminalResolver = null,
  liveOutputResolver = null
} = {}) {
  if (!db?.listRootSessions) {
    throw new Error('root session listing requires orchestration DB support');
  }

  const normalizedScope = normalizeRootScope(scope);
  const normalizedStatusFilter = normalizeRootStatusFilter(statusFilter);
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
      liveTerminalResolver,
      liveOutputResolver
    });

    return {
      rootSessionId: row.root_session_id,
      lastMessageAt: row.last_message_at || null,
      messageCount: row.message_count || 0,
      lastRecordedAt: row.last_recorded_at,
      lastOccurredAt: row.last_occurred_at,
      eventCount: row.event_count,
      status: snapshot?.status || 'unknown',
      originClient: snapshot?.rootSession?.originClient || null,
      rootType: snapshot?.rootType || 'workflow_root',
      rootMode: snapshot?.rootMode || null,
      sessionKind: snapshot?.sessionKind || 'workflow',
      visibility: snapshot?.visibility || 'internal',
      replyCapability: snapshot?.replyCapability || 'none',
      interactiveTerminalId: snapshot?.interactiveTerminalId || null,
      activitySummary: snapshot?.activitySummary || null,
      activityExcerpt: snapshot?.activityExcerpt || null,
      activitySource: snapshot?.activitySource || 'fallback',
      userFacing: snapshot?.userFacing !== false,
      externalSessionRef: snapshot?.externalSessionRef || null,
      clientName: snapshot?.clientName || null,
      model: snapshot?.rootSession?.model || null,
      runtimeHost: snapshot?.runtimeHost || null,
      runtimeId: snapshot?.runtimeId || null,
      runtimeCapabilities: snapshot?.runtimeCapabilities || [],
      runtimeFidelity: snapshot?.runtimeFidelity || null,
      runtime: snapshot?.runtime || null,
      latestConclusion: snapshot?.latestConclusion || null,
      attention: snapshot?.attention || { requiresAttention: false, reasons: [] },
      counts: snapshot?.counts || null,
      live: Boolean(snapshot?.counts?.live),
      recoveryCapability: deriveRecoveryCapability({
        rootMode: snapshot?.rootMode || null,
        sessions: snapshot?.sessions || [],
        counts: snapshot?.counts || null,
        lastMessageAt: row.last_message_at || null,
        eventCount: row.event_count || 0
      })
    };
  }).sort((left, right) => {
    const leftTime = normalizeTimestamp(left.lastMessageAt || left.lastOccurredAt || left.lastRecordedAt) || 0;
    const rightTime = normalizeTimestamp(right.lastMessageAt || right.lastOccurredAt || right.lastRecordedAt) || 0;
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

  const filteredRoots = visibleRoots.filter((summary) => {
    if (normalizedStatusFilter === 'all') {
      return true;
    }
    if (normalizedStatusFilter === 'live') {
      return Boolean(summary.live);
    }
    if (normalizedStatusFilter === 'actionable') {
      return Boolean(summary.attention?.requiresAttention);
    }
    if (normalizedStatusFilter === 'active') {
      return ACTIVE_ROOT_STATUSES.has(String(summary.status || '').trim().toLowerCase());
    }
    if (normalizedStatusFilter === 'completed') {
      return String(summary.status || '').trim().toLowerCase() === 'completed';
    }
    return true;
  });

  return {
    roots: filteredRoots.slice(0, limit),
    archivedCount,
    hiddenDetachedCount,
    hiddenNonUserCount,
    scope: normalizedScope,
    statusFilter: normalizedStatusFilter
  };
}

module.exports = {
  buildRootSessionSnapshot,
  listRootSessionSummaries,
  shouldArchiveRootSummary,
  classifyRootSession,
  normalizeRootScope,
  normalizeRootStatusFilter
};
