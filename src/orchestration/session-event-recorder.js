const crypto = require('crypto');

function summarizeText(text, maxLength = 240) {
  return String(text || '').trim().slice(0, maxLength) || null;
}

function randomId(prefix = 'workflow') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function mergeMetadata(base, extra) {
  if (base && extra && typeof base === 'object' && typeof extra === 'object') {
    return { ...base, ...extra };
  }
  return extra ?? base ?? null;
}

function createSessionEventRecorder(options = {}) {
  const db = options.db || null;
  const enabled = Boolean(options.enabled) && typeof db?.addSessionEvent === 'function';
  const workflowKind = options.workflowKind || 'workflow';
  const workflowSessionId = options.workflowSessionId || randomId(workflowKind);
  const rootSessionId = options.rootSessionId || workflowSessionId;
  const parentSessionId = options.parentSessionId || (rootSessionId === workflowSessionId ? null : rootSessionId);
  const originClient = options.originClient || 'system';
  const sessionMetadata = options.sessionMetadata || null;
  const runId = options.runId || null;
  const discussionId = options.discussionId || null;
  const externalSessionRef = options.externalSessionRef || null;

  function buildIdempotencyKey(sessionId, eventType, stableStepKey) {
    return `${rootSessionId}:${sessionId}:${eventType}:${stableStepKey}`;
  }

  function recordEvent(event = {}) {
    if (!enabled) {
      return null;
    }

    const eventSessionId = event.sessionId || workflowSessionId;
    const eventParentSessionId = event.parentSessionId === undefined
      ? parentSessionId
      : event.parentSessionId;
    const stableStepKey = event.stableStepKey || `${event.eventType || 'event'}-${Date.now()}`;

    return db.addSessionEvent({
      rootSessionId,
      sessionId: eventSessionId,
      parentSessionId: eventParentSessionId,
      runId: event.runId === undefined ? runId : event.runId,
      discussionId: event.discussionId === undefined ? discussionId : event.discussionId,
      traceId: event.traceId || null,
      parentEventId: event.parentEventId || null,
      eventType: event.eventType,
      originClient: event.originClient || originClient,
      payloadSummary: event.payloadSummary || null,
      payloadJson: event.payloadJson || null,
      metadata: mergeMetadata(sessionMetadata, event.metadata),
      occurredAt: Number.isFinite(event.occurredAt) ? event.occurredAt : Date.now(),
      idempotencyKey: event.idempotencyKey || buildIdempotencyKey(eventSessionId, event.eventType, stableStepKey)
    });
  }

  function ensureRootAttached(payload = {}) {
    if (!enabled || rootSessionId === workflowSessionId) {
      return null;
    }

    return recordEvent({
      sessionId: rootSessionId,
      parentSessionId: null,
      eventType: 'session_started',
      stableStepKey: 'implicit-root-attach',
      payloadSummary: payload.payloadSummary || `Implicit root attach via ${originClient}`,
      payloadJson: {
        attachMode: 'implicit-direct-workflow',
        sessionKind: 'attach',
        workflowKind,
        externalSessionRef,
        ...(payload.payloadJson || {})
      },
      metadata: payload.metadata || null,
      occurredAt: payload.occurredAt
    });
  }

  function recordWorkflowStarted(payload = {}) {
    ensureRootAttached({ occurredAt: payload.occurredAt });

    return recordEvent({
      sessionId: workflowSessionId,
      parentSessionId,
      eventType: 'session_started',
      stableStepKey: 'workflow-start',
      payloadSummary: payload.payloadSummary || `${workflowKind} session started`,
      payloadJson: {
        sessionKind: workflowKind,
        workflowKind,
        runId,
        discussionId,
        ...(payload.payloadJson || {})
      },
      metadata: payload.metadata || null,
      occurredAt: payload.occurredAt
    });
  }

  function recordChildSessionStarted(payload = {}) {
    return recordEvent({
      sessionId: payload.sessionId,
      parentSessionId: payload.parentSessionId === undefined ? workflowSessionId : payload.parentSessionId,
      eventType: 'session_started',
      stableStepKey: payload.stableStepKey || 'child-start',
      payloadSummary: payload.payloadSummary || summarizeText(`${payload.sessionKind || 'subagent'} session started`),
      payloadJson: {
        sessionKind: payload.sessionKind || 'subagent',
        adapter: payload.adapter || null,
        role: payload.role || null,
        name: payload.name || null,
        model: payload.model || null,
        workDir: payload.workDir || null,
        ...(payload.payloadJson || {})
      },
      metadata: payload.metadata || null,
      occurredAt: payload.occurredAt
    });
  }

  return {
    enabled,
    rootSessionId,
    parentSessionId,
    workflowSessionId,
    workflowKind,
    recordEvent,
    ensureRootAttached,
    recordWorkflowStarted,
    recordChildSessionStarted
  };
}

module.exports = {
  createSessionEventRecorder,
  summarizeText
};
