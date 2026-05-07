'use strict';

const NORMALIZED_EVENT_TYPES = Object.freeze([
  'session_started',
  'prompt_submitted',
  'tool_started',
  'tool_completed',
  'permission_requested',
  'permission_replied',
  'tokens_reported',
  'session_idle',
  'session_stopped',
  'session_error'
]);

const NORMALIZED_EVENT_TYPE_SET = new Set(NORMALIZED_EVENT_TYPES);

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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function truncateText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function normalizeUsage(rawUsage = {}) {
  const usage = parseJsonObject(rawUsage);
  if (Object.keys(usage).length === 0) {
    return null;
  }

  const inputTokens = firstNumber(
    usage.inputTokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.prompt_tokens,
    usage.prompt,
    usage.input
  );
  const outputTokens = firstNumber(
    usage.outputTokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.completion_tokens,
    usage.candidateTokens,
    usage.candidate_tokens,
    usage.candidates,
    usage.output
  );
  const reasoningTokens = firstNumber(usage.reasoningTokens, usage.reasoning_tokens, usage.reasoning);
  const cachedInputTokens = firstNumber(usage.cachedInputTokens, usage.cached_input_tokens);
  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.total_tokens,
    usage.total,
    inputTokens + outputTokens + reasoningTokens
  );
  const costUsd = firstNumber(usage.costUsd, usage.cost_usd, usage.total_cost_usd);
  const durationMs = firstNumber(usage.durationMs, usage.duration_ms);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    costUsd,
    durationMs
  };
}

function buildBaseEvent(type, source = {}, details = {}) {
  if (!NORMALIZED_EVENT_TYPE_SET.has(type)) {
    throw new Error(`Unsupported normalized event type: ${type}`);
  }

  const payload = parseJsonObject(source.payload_json || source.payloadJson);
  const metadata = parseJsonObject(source.metadata);
  const sourceEventType = firstString(source.event_type, source.eventType, details.sourceEventType);
  const sourceEventId = firstString(source.id, source.sourceEventId, details.sourceEventId);
  const gaps = [
    ...parseJsonArray(details.gaps),
    ...parseJsonArray(source.normalizationGaps),
    ...parseJsonArray(metadata.normalizationGaps),
    ...parseJsonArray(payload.normalizationGaps)
  ];

  return {
    id: details.id || (sourceEventId ? `norm_${sourceEventId}_${type}` : null),
    type,
    source: details.source || source.source || 'unknown',
    sourceEventId: sourceEventId || null,
    sourceEventType: sourceEventType || null,
    rootSessionId: firstString(details.rootSessionId, source.root_session_id, source.rootSessionId) || null,
    sessionId: firstString(details.sessionId, source.session_id, source.sessionId) || null,
    parentSessionId: firstString(details.parentSessionId, source.parent_session_id, source.parentSessionId) || null,
    runId: firstString(details.runId, source.run_id, source.runId) || null,
    discussionId: firstString(details.discussionId, source.discussion_id, source.discussionId) || null,
    traceId: firstString(details.traceId, source.trace_id, source.traceId) || null,
    sequenceNo: optionalNumber(source.sequence_no ?? source.sequenceNo),
    occurredAt: source.occurred_at ?? source.occurredAt ?? details.occurredAt ?? null,
    recordedAt: source.recorded_at ?? source.recordedAt ?? null,
    originClient: firstString(details.originClient, source.origin_client, source.originClient) || null,
    adapter: firstString(details.adapter, payload.adapter, metadata.adapter, source.adapter) || null,
    model: firstString(details.model, payload.model, metadata.model, source.model) || null,
    role: firstString(details.role, payload.role, metadata.role, source.role) || null,
    status: firstString(details.status, payload.status, source.status) || null,
    summary: truncateText(details.summary || source.payload_summary || source.payloadSummary || payload.summary || null),
    text: details.text || null,
    tool: details.tool || null,
    permission: details.permission || null,
    usage: details.usage || null,
    providerSessionId: firstString(
      details.providerSessionId,
      payload.providerSessionId,
      payload.providerThreadRef,
      payload.resumeSessionId,
      source.providerSessionId,
      source.provider_thread_ref
    ) || null,
    confidence: details.confidence || 'derived',
    gaps: [...new Set(gaps.filter(Boolean))],
    raw: details.raw === undefined ? null : details.raw
  };
}

function normalizeSessionEvent(row = {}) {
  const eventType = String(row.event_type || row.eventType || '').trim().toLowerCase();
  const payload = parseJsonObject(row.payload_json || row.payloadJson);

  if (!eventType) {
    return { event: null, gap: 'missing_event_type' };
  }

  if (eventType === 'session_started' || eventType === 'session_adopted' || eventType === 'session_resumed') {
    return {
      event: buildBaseEvent('session_started', row, {
        source: 'session_events',
        status: eventType === 'session_resumed' ? 'resumed' : 'started',
        summary: row.payload_summary || row.payloadSummary || `${payload.adapter || 'session'} started`
      })
    };
  }

  if (eventType === 'message_sent') {
    return {
      event: buildBaseEvent('prompt_submitted', row, {
        source: 'session_events',
        text: {
          role: 'user',
          preview: truncateText(payload.content || payload.message || row.payload_summary || row.payloadSummary)
        }
      })
    };
  }

  if (eventType === 'message_received') {
    return {
      event: buildBaseEvent('session_idle', row, {
        source: 'session_events',
        text: {
          role: 'assistant',
          preview: truncateText(payload.content || payload.message || row.payload_summary || row.payloadSummary)
        }
      })
    };
  }

  if (eventType === 'user_input_requested') {
    return {
      event: buildBaseEvent('permission_requested', row, {
        source: 'session_events',
        status: 'waiting',
        permission: {
          kind: firstString(payload.kind, payload.reason, payload.question) || 'user_input',
          prompt: truncateText(payload.question || payload.message || row.payload_summary || row.payloadSummary)
        }
      })
    };
  }

  if (eventType === 'user_input_received') {
    return {
      event: buildBaseEvent('permission_replied', row, {
        source: 'session_events',
        status: 'replied',
        permission: {
          kind: firstString(payload.kind, payload.reason) || 'user_input',
          decision: firstString(payload.decision, payload.status) || 'received'
        }
      })
    };
  }

  if (eventType === 'session_terminated') {
    const status = String(payload.status || '').trim().toLowerCase();
    const exitCode = payload.exitCode ?? payload.exit_code ?? null;
    const failed = status === 'error' || (exitCode !== null && Number(exitCode) !== 0);
    return {
      event: buildBaseEvent(failed ? 'session_error' : 'session_stopped', row, {
        source: 'session_events',
        status: status || (failed ? 'error' : 'completed'),
        summary: payload.attentionMessage || row.payload_summary || row.payloadSummary,
        gaps: payload.resumeCommand ? [] : ['resume_handle_may_be_unavailable']
      })
    };
  }

  if (eventType === 'session_stale') {
    return {
      event: buildBaseEvent('session_error', row, {
        source: 'session_events',
        status: 'stale',
        gaps: ['session_liveness_unverified']
      })
    };
  }

  if (eventType === 'session_destroyed') {
    return {
      event: buildBaseEvent('session_stopped', row, {
        source: 'session_events',
        status: 'destroyed',
        gaps: ['provider_state_may_continue']
      })
    };
  }

  return { event: null, gap: `unmapped_session_event:${eventType}` };
}

function normalizeSessionEvents(rows = []) {
  const normalized = [];
  const gaps = [];
  const inputRows = Array.isArray(rows) ? rows : [];

  for (const row of inputRows) {
    const result = normalizeSessionEvent(row);
    if (result.event) {
      normalized.push(result.event);
      if (result.event.gaps.length > 0) {
        gaps.push(...result.event.gaps.map((gap) => ({
          sourceEventId: result.event.sourceEventId,
          sourceEventType: result.event.sourceEventType,
          gap
        })));
      }
    } else if (result.gap) {
      gaps.push({
        sourceEventId: row?.id || null,
        sourceEventType: row?.event_type || row?.eventType || null,
        gap: result.gap
      });
    }
  }

  return {
    events: normalized,
    diagnostics: {
      inputCount: inputRows.length,
      normalizedCount: normalized.length,
      skippedCount: Math.max(0, inputRows.length - normalized.length),
      gaps
    }
  };
}

function usageFromAdapterEvent(adapter, raw = {}) {
  const event = parseJsonObject(raw);
  if (adapter === 'opencode-cli') {
    return normalizeUsage(event.part?.tokens || event.tokens || event.usage);
  }
  if (adapter === 'gemini-cli') {
    return normalizeUsage(event.stats || event.usage || event.tokens);
  }
  if (adapter === 'qwen-cli') {
    return normalizeUsage(event.usage || event.message?.usage || event.stats);
  }
  if (adapter === 'claude-code') {
    return normalizeUsage(event.usage || event.result?.usage || event.message?.usage);
  }
  if (adapter === 'codex-cli') {
    return normalizeUsage(event.usage || event.stats);
  }
  return normalizeUsage(event.usage || event.stats || event.tokens);
}

function normalizeAdapterEvent(adapterName, raw = {}, context = {}) {
  const adapter = String(adapterName || context.adapter || '').trim().toLowerCase();
  const event = parseJsonObject(raw);
  const type = String(event.type || '').trim();
  const lowerType = type.toLowerCase();
  const source = {
    id: context.sourceEventId || null,
    eventType: type || event.progressType || null,
    rootSessionId: context.rootSessionId || null,
    sessionId: context.sessionId || event.session_id || event.sessionID || event.thread_id || null,
    parentSessionId: context.parentSessionId || null,
    runId: context.runId || null,
    discussionId: context.discussionId || null,
    traceId: context.traceId || null,
    occurredAt: context.occurredAt || Date.now(),
    originClient: context.originClient || 'adapter',
    adapter,
    model: context.model || null
  };
  const events = [];
  const push = (normalizedType, details = {}) => {
    events.push(buildBaseEvent(normalizedType, source, {
      source: 'adapter_event',
      sourceEventType: type || event.progressType || null,
      adapter,
      raw: context.includeRaw ? event : null,
      ...details
    }));
  };

  if (lowerType === 'progress') {
    const progressType = String(event.progressType || '').trim().toLowerCase();
    if (progressType === 'tool_use') {
      push('tool_started', {
        tool: {
          name: firstString(event.tool, event.name) || 'unknown',
          input: event.input || null
        },
        gaps: ['tool_completion_may_arrive_as_separate_chunk']
      });
    } else if (progressType === 'tool_result') {
      push('tool_completed', {
        tool: {
          name: firstString(event.tool, event.name) || null,
          resultPreview: truncateText(event.result || event.content)
        }
      });
    }
    return events;
  }

  if (lowerType === 'error') {
    push('session_error', {
      status: event.failureClass || 'error',
      summary: event.error?.message || event.content || event.message || JSON.stringify(event)
    });
    return events;
  }

  if (adapter === 'codex-cli') {
    if (lowerType === 'thread.started') {
      push('session_started', { providerSessionId: event.thread_id || null });
    } else if (lowerType === 'item.started' && event.item?.type === 'tool_call') {
      push('tool_started', {
        tool: {
          name: firstString(event.item?.name) || 'unknown',
          input: event.item?.args || null
        }
      });
    } else if (lowerType === 'item.completed' && event.item?.type === 'tool_call') {
      push('tool_completed', {
        tool: {
          name: firstString(event.item?.name) || 'unknown',
          input: event.item?.args || null
        },
        gaps: ['tool_started_unavailable_if_no_item_started_event']
      });
    } else if (lowerType === 'turn.completed') {
      const usage = usageFromAdapterEvent(adapter, event);
      if (usage) {
        push('tokens_reported', { usage });
      }
      push('session_idle', { gaps: usage ? [] : ['token_usage_unavailable'] });
    }
    return events;
  }

  if (adapter === 'gemini-cli') {
    if (lowerType === 'tool_use' || lowerType === 'function_call') {
      push('tool_started', {
        tool: {
          name: firstString(event.name, event.tool?.name) || 'unknown',
          input: event.args || event.input || null
        }
      });
    } else if (lowerType === 'tool_result' || lowerType === 'function_result') {
      push('tool_completed', {
        tool: {
          name: firstString(event.name, event.tool?.name) || null,
          resultPreview: truncateText(event.result || event.content)
        }
      });
    } else if (lowerType === 'result') {
      const usage = usageFromAdapterEvent(adapter, event);
      if (usage) {
        push('tokens_reported', { usage });
      }
      push(event.status === 'error' ? 'session_error' : 'session_idle', {
        status: event.status || null,
        summary: event.error?.message || event.error?.content || null,
        gaps: usage ? [] : ['token_usage_unavailable']
      });
    }
    return events;
  }

  if (adapter === 'claude-code') {
    if (lowerType === 'system' && event.message?.session_id) {
      push('session_started', { providerSessionId: event.message.session_id });
    } else if (lowerType === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'tool_use') {
          push('tool_started', {
            tool: {
              name: firstString(block.name) || 'unknown',
              input: block.input || null
            }
          });
        }
      }
    } else if (lowerType === 'tool_use') {
      push('tool_started', {
        tool: {
          name: firstString(event.tool?.name, event.name) || 'unknown',
          input: event.tool?.input || event.input || null
        }
      });
    } else if (lowerType === 'tool_result') {
      push('tool_completed', {
        tool: {
          name: firstString(event.tool?.name, event.name) || null,
          resultPreview: truncateText(event.result || event.content)
        }
      });
    } else if (lowerType === 'result') {
      const usage = usageFromAdapterEvent(adapter, event);
      if (usage) {
        push('tokens_reported', { usage });
      }
      push('session_idle', {
        summary: truncateText(event.result),
        providerSessionId: event.session_id || null,
        gaps: usage ? [] : ['token_usage_unavailable']
      });
    }
    return events;
  }

  if (adapter === 'opencode-cli') {
    if (lowerType === 'step_finish') {
      const usage = usageFromAdapterEvent(adapter, event);
      if (usage) {
        push('tokens_reported', { usage });
      }
      push('session_idle', { gaps: usage ? [] : ['token_usage_unavailable'] });
    }
    return events;
  }

  if (adapter === 'qwen-cli') {
    if (lowerType === 'system' && event.subtype === 'init') {
      push('session_started', { providerSessionId: event.session_id || null });
    } else if (lowerType === 'assistant' && event.message?.usage) {
      const usage = usageFromAdapterEvent(adapter, event);
      if (usage) {
        push('tokens_reported', { usage });
      }
    } else if (lowerType === 'result') {
      const usage = usageFromAdapterEvent(adapter, event);
      if (usage) {
        push('tokens_reported', { usage });
      }
      push('session_idle', {
        summary: truncateText(event.result),
        providerSessionId: event.session_id || null,
        gaps: usage ? [] : ['token_usage_unavailable']
      });
    }
    return events;
  }

  if (lowerType === 'result') {
    const usage = usageFromAdapterEvent(adapter, event);
    if (usage) {
      push('tokens_reported', { usage });
    }
    push('session_idle', {
      summary: truncateText(event.result || event.content || 'Adapter turn completed'),
      providerSessionId: event.session_id || event.sessionID || event.thread_id || null,
      gaps: usage ? [] : ['token_usage_unavailable']
    });
    return events;
  }

  return events;
}

module.exports = {
  NORMALIZED_EVENT_TYPES,
  NORMALIZED_EVENT_TYPE_SET,
  normalizeUsage,
  normalizeSessionEvent,
  normalizeSessionEvents,
  normalizeAdapterEvent
};
