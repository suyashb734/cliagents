#!/usr/bin/env node

'use strict';

const assert = require('assert');

const {
  NORMALIZED_EVENT_TYPES,
  normalizeUsage,
  normalizeSessionEvent,
  normalizeSessionEvents,
  normalizeAdapterEvent
} = require('../src/orchestration/event-normalizer');

function types(events) {
  return events.map((event) => event.type);
}

function assertHasType(events, type) {
  assert(events.some((event) => event.type === type), `expected normalized event type ${type}`);
}

function runSessionEventAssertions() {
  assert(NORMALIZED_EVENT_TYPES.includes('prompt_submitted'));
  assert(NORMALIZED_EVENT_TYPES.includes('tokens_reported'));

  const rootSessionId = 'root-1';
  const rows = [
    {
      id: 'se_1',
      root_session_id: rootSessionId,
      session_id: rootSessionId,
      event_type: 'session_started',
      sequence_no: 1,
      origin_client: 'mcp',
      payload_summary: 'root started',
      payload_json: JSON.stringify({ adapter: 'codex-cli', model: 'gpt-5.4', sessionKind: 'main' }),
      metadata: null,
      occurred_at: 1000,
      recorded_at: 1001
    },
    {
      id: 'se_2',
      root_session_id: rootSessionId,
      session_id: rootSessionId,
      event_type: 'message_sent',
      sequence_no: '2',
      origin_client: 'mcp',
      payload_summary: 'user: fix the bug',
      payload_json: JSON.stringify({ content: 'fix the bug', role: 'user' }),
      metadata: null,
      occurred_at: 1010,
      recorded_at: 1011
    },
    {
      id: 'se_3',
      root_session_id: rootSessionId,
      session_id: rootSessionId,
      event_type: 'user_input_requested',
      sequence_no: 3,
      origin_client: 'mcp',
      payload_json: JSON.stringify({ question: 'Approve file write?', kind: 'permission' }),
      metadata: null,
      occurred_at: 1020,
      recorded_at: 1021
    },
    {
      id: 'se_4',
      root_session_id: rootSessionId,
      session_id: rootSessionId,
      event_type: 'session_terminated',
      sequence_no: 4,
      origin_client: 'mcp',
      payload_json: JSON.stringify({ status: 'completed', exitCode: 0 }),
      metadata: null,
      occurred_at: 1030,
      recorded_at: 1031
    },
    {
      id: 'se_5',
      root_session_id: rootSessionId,
      session_id: rootSessionId,
      event_type: 'consensus_recorded',
      sequence_no: 5,
      origin_client: 'mcp',
      payload_json: JSON.stringify({ decisionSummary: 'ship it' }),
      metadata: null,
      occurred_at: 1040,
      recorded_at: 1041
    }
  ];

  const normalized = normalizeSessionEvents(rows);
  assert.deepStrictEqual(
    types(normalized.events),
    ['session_started', 'prompt_submitted', 'permission_requested', 'session_stopped']
  );
  assert.strictEqual(normalized.diagnostics.inputCount, 5);
  assert.strictEqual(normalized.diagnostics.normalizedCount, 4);
  assert.strictEqual(normalized.diagnostics.skippedCount, 1);
  assert(normalized.diagnostics.gaps.some((entry) => entry.gap === 'unmapped_session_event:consensus_recorded'));

  const prompt = normalized.events.find((event) => event.type === 'prompt_submitted');
  assert.strictEqual(prompt.text.role, 'user');
  assert.strictEqual(prompt.text.preview, 'fix the bug');
  assert.strictEqual(prompt.sequenceNo, 2);
  assert.strictEqual(prompt.adapter, null);

  const permission = normalized.events.find((event) => event.type === 'permission_requested');
  assert.strictEqual(permission.permission.kind, 'permission');
  assert.strictEqual(permission.permission.prompt, 'Approve file write?');

  const failed = normalizeSessionEvent({
    id: 'se_error',
    root_session_id: rootSessionId,
    session_id: rootSessionId,
    event_type: 'session_terminated',
    payload_json: JSON.stringify({ status: 'error', exitCode: 1, attentionMessage: 'Provider crashed' })
  }).event;
  assert.strictEqual(failed.type, 'session_error');
  assert.strictEqual(failed.status, 'error');
  assert.strictEqual(failed.summary, 'Provider crashed');
}

function runAdapterEventAssertions() {
  const codexEvents = [
    ...normalizeAdapterEvent('codex-cli', { type: 'thread.started', thread_id: 'codex-thread-1' }, {
      rootSessionId: 'root-codex',
      sessionId: 'term-codex',
      model: 'gpt-5.4'
    }),
    ...normalizeAdapterEvent('codex-cli', {
      type: 'item.completed',
      item: { type: 'tool_call', name: 'shell', args: { cmd: 'npm test' } }
    }),
    ...normalizeAdapterEvent('codex-cli', {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 }
    })
  ];
  assertHasType(codexEvents, 'session_started');
  assertHasType(codexEvents, 'tool_completed');
  assertHasType(codexEvents, 'tokens_reported');
  assertHasType(codexEvents, 'session_idle');
  assert(codexEvents.find((event) => event.type === 'tool_completed').gaps.includes('tool_started_unavailable_if_no_item_started_event'));
  assert.strictEqual(codexEvents.find((event) => event.type === 'tokens_reported').usage.totalTokens, 15);

  const geminiEvents = normalizeAdapterEvent('gemini-cli', {
    type: 'result',
    status: 'success',
    stats: { input_tokens: 7, output_tokens: 9, total_tokens: 16, duration_ms: 123 }
  });
  assert.deepStrictEqual(types(geminiEvents), ['tokens_reported', 'session_idle']);
  assert.strictEqual(geminiEvents[0].usage.durationMs, 123);

  const geminiErrorEvents = normalizeAdapterEvent('gemini-cli', {
    type: 'result',
    status: 'error',
    error: { message: 'quota exceeded' }
  });
  assert.deepStrictEqual(types(geminiErrorEvents), ['session_error']);
  assert.strictEqual(geminiErrorEvents[0].summary, 'quota exceeded');
  assert(geminiErrorEvents[0].gaps.includes('token_usage_unavailable'));

  const claudeEvents = [
    ...normalizeAdapterEvent('claude-code', {
      type: 'system',
      message: { session_id: 'claude-provider-start' }
    }),
    ...normalizeAdapterEvent('claude-code', {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/app.js' } }
        ]
      }
    }),
    ...normalizeAdapterEvent('claude-code', {
      type: 'result',
      result: 'Done',
      usage: { input_tokens: 3, output_tokens: 4 },
      session_id: 'claude-provider-1'
    })
  ];
  assert.deepStrictEqual(types(claudeEvents), ['session_started', 'tool_started', 'tokens_reported', 'session_idle']);
  assert.strictEqual(claudeEvents[0].providerSessionId, 'claude-provider-start');
  assert.strictEqual(claudeEvents[1].tool.name, 'Read');
  assert.strictEqual(claudeEvents[3].providerSessionId, 'claude-provider-1');
  assert.deepStrictEqual(
    normalizeAdapterEvent('claude-code', { type: 'user', content: 'hello', result: 'not a turn result' }),
    []
  );

  const opencodeEvents = normalizeAdapterEvent('opencode-cli', {
    type: 'step_finish',
    part: { tokens: { input: 11, output: 13, reasoning: 5, total: 29 } }
  });
  assert.deepStrictEqual(types(opencodeEvents), ['tokens_reported', 'session_idle']);
  assert.strictEqual(opencodeEvents[0].usage.reasoningTokens, 5);

  const opencodeErrorEvents = normalizeAdapterEvent('opencode-cli', {
    type: 'error',
    content: 'generic wrapper text',
    error: { message: 'provider failed' }
  });
  assert.deepStrictEqual(types(opencodeErrorEvents), ['session_error']);
  assert.strictEqual(opencodeErrorEvents[0].summary, 'provider failed');

  const qwenEvents = [
    ...normalizeAdapterEvent('qwen-cli', {
      type: 'system',
      subtype: 'init',
      session_id: 'qwen-provider-1'
    }),
    ...normalizeAdapterEvent('qwen-cli', {
      type: 'result',
      result: 'OK',
      usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 },
      session_id: 'qwen-provider-1'
    })
  ];
  assert.deepStrictEqual(types(qwenEvents), ['session_started', 'tokens_reported', 'session_idle']);
  assert.strictEqual(qwenEvents[0].providerSessionId, 'qwen-provider-1');
}

function runUsageAssertions() {
  assert.deepStrictEqual(normalizeUsage({
    prompt_tokens: 1,
    completion_tokens: 2,
    reasoning_tokens: 3,
    cached_input_tokens: 4
  }), {
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 3,
    cachedInputTokens: 4,
    totalTokens: 6,
    costUsd: 0,
    durationMs: 0
  });

  assert.strictEqual(normalizeUsage(null), null);
}

try {
  runSessionEventAssertions();
  runAdapterEventAssertions();
  runUsageAssertions();
  console.log('✅ Event normalizer maps session events and adapter fixtures into the broker event contract');
} catch (error) {
  console.error('\nEvent normalizer tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
