const crypto = require('crypto');
const { createSessionEventRecorder } = require('./session-event-recorder');
const { getMemorySnapshotService } = require('./memory-snapshot-service');

const MIN_TIMEOUT_FLOOR_MS = 1;

function normalizeTimeoutMs(timeout) {
  const normalized = Number(timeout);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

function computeRemainingBudget(startedAt, timeout) {
  const normalizedTimeout = normalizeTimeoutMs(timeout);
  if (normalizedTimeout == null) {
    return null;
  }
  return Math.max(0, normalizedTimeout - (Date.now() - startedAt));
}

function resolveEffectiveTimeout(configuredTimeout, workflowStartedAt, workflowTimeout) {
  const stageTimeout = normalizeTimeoutMs(configuredTimeout);
  const remainingBudget = workflowStartedAt == null
    ? null
    : computeRemainingBudget(workflowStartedAt, workflowTimeout);

  if (remainingBudget == null) {
    return stageTimeout;
  }
  if (remainingBudget <= 0) {
    return MIN_TIMEOUT_FLOOR_MS;
  }
  return stageTimeout == null ? remainingBudget : Math.min(stageTimeout, remainingBudget);
}

const DEFAULT_ROUNDS = [
  {
    name: 'position',
    transcriptMode: 'none',
    instructions: [
      'State your initial position on the task.',
      'Include the strongest opportunities, the main risks, and one recommendation that peers may disagree with.',
      'Keep the answer concrete and implementation-oriented.'
    ].join('\n')
  },
  {
    name: 'rebuttal',
    transcriptMode: 'previous',
    instructions: [
      'Review the prior round transcript.',
      'Identify one point you disagree with and explain why.',
      'Identify one point you agree with and extend it.',
      'Propose one compromise decision.'
    ].join('\n')
  },
  {
    name: 'convergence',
    transcriptMode: 'all',
    instructions: [
      'Converge toward execution.',
      'Produce a prioritized next-steps roadmap with owners and measurable success criteria.',
      'Call out one unresolved disagreement that still needs a decision.'
    ].join('\n')
  }
];

const DEFAULT_JUDGE = {
  name: 'discussion-judge',
  adapter: 'codex-cli',
  systemPrompt: 'Synthesize multi-agent technical discussions into decisions, disagreements, backlog, and readiness verdicts.'
};

function summarizeText(text, maxLength = 1200) {
  return String(text || '').trim().slice(0, maxLength) || null;
}

function getDiscussionStore(options = {}) {
  const candidate = options.db || options.runLedger?.db || null;
  if (!candidate) {
    return null;
  }

  if (typeof candidate.createDiscussion !== 'function') {
    return null;
  }
  if (typeof candidate.addDiscussionMessage !== 'function') {
    return null;
  }
  if (typeof candidate.updateDiscussionStatus !== 'function') {
    return null;
  }

  return candidate;
}

function makeDiscussionSenderId(kind, name, adapter, index = 0) {
  const sanitizedName = String(name || adapter || kind || 'participant')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return `${kind}-${index + 1}-${sanitizedName || 'participant'}`;
}

function appendDiscussionMessage(discussionStore, discussionId, senderId, content, options = {}) {
  if (!discussionStore || !discussionId || !content) {
    return;
  }

  discussionStore.addDiscussionMessage(discussionId, senderId, String(content), {
    receiverId: options.receiverId || null,
    messageType: options.messageType || 'info'
  });
}

async function emitDiscussionSink(sink, eventType, payload = {}) {
  if (!sink) {
    return;
  }

  const event = {
    type: eventType,
    ...payload
  };

  if (typeof sink === 'function') {
    await sink(event);
    return;
  }

  if (typeof sink[eventType] === 'function') {
    await sink[eventType](event);
    return;
  }

  if (typeof sink.onEvent === 'function') {
    await sink.onEvent(event);
  }
}

function classifyFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();

  if (message.includes('timeout') || message.includes('timed out') || message.includes('deadline exceeded')) {
    return 'timeout';
  }
  if (message.includes('auth') || message.includes('credential') || message.includes('login') || message.includes('subscription')) {
    return 'auth';
  }
  if (message.includes('quota') || message.includes('rate limit') || message.includes('resourceexhausted')) {
    return 'rate_limit';
  }
  if (message.includes('exit code') || message.includes('process exited') || message.includes('terminated')) {
    return 'process_exit';
  }
  if (message.includes('parse') && message.includes('json')) {
    return 'protocol_parse';
  }
  if (message.includes('validation') || message.includes('missing_parameter') || message.includes('required')) {
    return 'validation';
  }
  if (message.includes('cancelled') || message.includes('interrupted')) {
    return 'cancelled';
  }

  return 'unknown';
}

function normalizeRound(round, index) {
  const name = String(round?.name || `round-${index + 1}`).trim();
  const transcriptMode = ['none', 'previous', 'all'].includes(round?.transcriptMode)
    ? round.transcriptMode
    : (index === 0 ? 'none' : 'previous');
  const instructions = String(round?.instructions || round?.prompt || '').trim();

  return {
    name,
    transcriptMode,
    instructions: instructions || 'Provide your best technical response for this round.'
  };
}

function resolveRounds(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return DEFAULT_ROUNDS.map((round, index) => normalizeRound(round, index));
  }

  return rounds.map((round, index) => normalizeRound(round, index));
}

function resolveJudge(judge) {
  if (judge === null) {
    return null;
  }

  const source = judge || DEFAULT_JUDGE;
  return {
    name: source.name || DEFAULT_JUDGE.name,
    adapter: source.adapter || DEFAULT_JUDGE.adapter,
    systemPrompt: source.systemPrompt || DEFAULT_JUDGE.systemPrompt,
    model: source.model || null,
    timeout: source.timeout || null,
    workDir: source.workDir || null,
    jsonMode: source.jsonMode,
    jsonSchema: source.jsonSchema || null
  };
}

function formatRoundTranscript(roundResult, maxLength = null) {
  return (roundResult?.responses || []).map((response) => {
    const content = maxLength ? String(response.output || response.error || '').slice(0, maxLength) : String(response.output || response.error || '');
    return [
      `=== ${roundResult.name}: ${response.name} (${response.adapter}) ===`,
      content
    ].join('\n');
  }).join('\n\n');
}

function buildTranscriptForRound(priorRounds, transcriptMode) {
  if (!Array.isArray(priorRounds) || priorRounds.length === 0 || transcriptMode === 'none') {
    return '';
  }

  if (transcriptMode === 'previous') {
    return formatRoundTranscript(priorRounds[priorRounds.length - 1], 2400);
  }

  return priorRounds.map((roundResult) => formatRoundTranscript(roundResult, 2400)).join('\n\n');
}

function buildRoundPrompt({ message, context, round, priorRounds, participant }) {
  const transcript = buildTranscriptForRound(priorRounds, round.transcriptMode);

  return [
    `You are ${participant.name || participant.adapter}. Participate in a technical multi-agent discussion.`,
    '',
    'Primary task:',
    message,
    '',
    'Context:',
    context || '(none)',
    transcript ? `\nPrior discussion transcript:\n${transcript}\n` : '',
    `Current round: ${round.name}`,
    round.instructions,
    '',
    'Write one final answer for this round. Be concrete and concise.'
  ].filter(Boolean).join('\n');
}

function buildJudgePrompt({ message, context, rounds }) {
  const transcript = (rounds || []).map((roundResult) => formatRoundTranscript(roundResult, 4000)).join('\n\n');

  return [
    'You are the final judge for a multi-agent technical discussion.',
    '',
    'Primary task:',
    message,
    '',
    'Context:',
    context || '(none)',
    '',
    'Discussion transcript:',
    transcript || '(no successful discussion rounds)',
    '',
    'Deliver:',
    '1. CONSENSUS_DECISIONS',
    '2. OPEN_DISAGREEMENTS',
    '3. NEXT_IMPLEMENTATION_BACKLOG with priorities and owners',
    '4. PRODUCTION_READINESS',
    '',
    'Keep the answer structured and concise.'
  ].join('\n');
}

async function ensureSession(sessionManager, state, options = {}) {
  if (state.failed || state.sessionId) {
    return state.sessionId;
  }

  const session = await sessionManager.createSession({
    adapter: state.adapter,
    sessionId: `discussion-${crypto.randomBytes(6).toString('hex')}`,
    systemPrompt: state.systemPrompt,
    workDir: state.workDir || options.workDir,
    model: state.model,
    providerSessionId: state.providerSessionId || null,
    jsonSchema: state.jsonSchema,
    jsonMode: state.jsonMode
  });

  state.sessionId = session.sessionId;
  state.createdSession = true;
  return state.sessionId;
}

async function runRoundForParticipant(sessionManager, state, prompt, context = {}) {
  const { roundIndex, roundName, timeout, runLedger, runId } = context;
  const startedAt = Date.now();
  let timeoutId = null;
  const stepId = runLedger && runId && state.participantId
    ? runLedger.appendStep({
        runId,
        participantId: state.participantId,
        stepKey: `discussion-round-${roundIndex + 1}`,
        stepName: `discussion round ${roundIndex + 1}: ${roundName}`,
        status: 'running',
        retrySafe: true,
        metadata: { roundIndex, roundName },
        startedAt
      })
    : null;

  if (runLedger && runId && state.participantId) {
    runLedger.updateParticipant(state.participantId, {
      status: 'running',
      currentStep: `round-${roundIndex + 1}:${roundName}`,
      startedAt: state.startedAt || startedAt,
      lastHeartbeatAt: startedAt
    });
    runLedger.appendInput({
      runId,
      participantId: state.participantId,
      inputKind: 'participant_prompt',
      content: prompt,
      metadata: {
        roundIndex,
        roundName,
        adapter: state.adapter,
        systemPrompt: state.systemPrompt || null,
        model: state.model || null,
        workDir: state.workDir || context.workDir || null,
        timeout: state.timeout || timeout || null
      },
      createdAt: startedAt
    });
  }

  try {
    if (context.eventRecorder?.enabled) {
      context.eventRecorder.recordChildSessionStarted({
        sessionId: state.controlSessionId,
        sessionKind: 'subagent',
        role: 'participant',
        name: state.name,
        adapter: state.adapter,
        model: state.model || null,
        workDir: state.workDir || context.workDir || null,
        stableStepKey: 'participant-start',
        payloadSummary: `${state.name} session started`,
        occurredAt: startedAt
      });
      context.eventRecorder.recordEvent({
        sessionId: state.controlSessionId,
        parentSessionId: context.eventRecorder.workflowSessionId,
        eventType: 'delegation_started',
        stableStepKey: `round-${roundIndex + 1}-start`,
        payloadSummary: `${state.name} started round ${roundIndex + 1}: ${roundName}`,
        payloadJson: {
          adapter: state.adapter,
          role: 'participant',
          roundIndex,
          roundName,
          model: state.model || null,
          workDir: state.workDir || context.workDir || null
        },
        occurredAt: startedAt
      });
    }

    const effectiveTimeout = resolveEffectiveTimeout(
      state.timeout || timeout,
      context.workflowStartedAt,
      context.workflowTimeout
    );
    if (effectiveTimeout === MIN_TIMEOUT_FLOOR_MS && context.workflowStartedAt != null) {
      const remainingBudget = computeRemainingBudget(context.workflowStartedAt, context.workflowTimeout);
      if (remainingBudget <= 0) {
        throw new Error(`participant timed out before round ${roundIndex + 1} started`);
      }
    }

    const sessionId = await ensureSession(sessionManager, state, context);
    const sendPromise = sessionManager.send(sessionId, prompt, {
      timeout: effectiveTimeout || undefined
    });
    const response = effectiveTimeout != null
      ? await Promise.race([
          sendPromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              void (async () => {
                try {
                  await sessionManager.interruptSession?.(sessionId);
                } catch {}
              })();
              reject(new Error(`participant timed out after ${effectiveTimeout}ms`));
            }, effectiveTimeout);
          })
        ])
      : await sendPromise;

    const latestSession = typeof sessionManager.getSession === 'function'
      ? sessionManager.getSession(sessionId)
      : null;
    state.providerSessionId = String(
      response?.metadata?.providerSessionId
      || latestSession?.providerSessionId
      || state.providerSessionId
      || ''
    ).trim() || null;

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    const completedAt = Date.now();

    if (runLedger && runId && state.participantId) {
      if (stepId) {
        runLedger.updateStep(stepId, {
          status: 'completed',
          lastHeartbeatAt: completedAt,
          completedAt,
          metadata: { roundIndex, roundName }
        });
      }
      runLedger.appendOutput({
        runId,
        participantId: state.participantId,
        outputKind: 'participant_final',
        content: response.result,
        metadata: {
          roundIndex,
          roundName,
          adapter: state.adapter,
          sendMetadata: response.metadata || {}
        },
        createdAt: completedAt
      });
      runLedger.updateParticipant(state.participantId, {
        status: 'running',
        currentStep: `round-${roundIndex + 1}:completed`,
        lastHeartbeatAt: completedAt
      });
    }

    if (context.eventRecorder?.enabled) {
      context.eventRecorder.recordEvent({
        sessionId: state.controlSessionId,
        parentSessionId: context.eventRecorder.workflowSessionId,
        eventType: 'delegation_completed',
        stableStepKey: `round-${roundIndex + 1}-completed`,
        payloadSummary: `${state.name} completed round ${roundIndex + 1}: ${roundName}`,
        payloadJson: {
          adapter: state.adapter,
          role: 'participant',
          roundIndex,
          roundName,
          success: true
        },
        occurredAt: completedAt
      });
    }

    return {
      participantId: state.participantId,
      participantRef: state.participantRef || null,
      senderId: state.discussionSenderId,
      name: state.name,
      adapter: state.adapter,
      success: true,
      output: response.result,
      metadata: response.metadata || {}
    };
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    const completedAt = Date.now();
    const failureClass = classifyFailure(error);
    state.failed = true;
    state.failureClass = failureClass;
    state.error = error.message;

    if (runLedger && runId && state.participantId) {
      if (stepId) {
        runLedger.updateStep(stepId, {
          status: 'failed',
          failureClass,
          lastHeartbeatAt: completedAt,
          completedAt,
          metadata: { roundIndex, roundName, error: error.message }
        });
      }
      runLedger.appendOutput({
        runId,
        participantId: state.participantId,
        outputKind: 'participant_error',
        content: error.message,
        metadata: { roundIndex, roundName, failureClass },
        createdAt: completedAt
      });
      runLedger.updateParticipant(state.participantId, {
        status: 'failed',
        currentStep: `round-${roundIndex + 1}:failed`,
        failureClass,
        lastHeartbeatAt: completedAt,
        endedAt: completedAt
      });
    }

    if (context.eventRecorder?.enabled) {
      context.eventRecorder.recordEvent({
        sessionId: state.controlSessionId,
        parentSessionId: context.eventRecorder.workflowSessionId,
        eventType: 'delegation_completed',
        stableStepKey: `round-${roundIndex + 1}-completed`,
        payloadSummary: `${state.name} failed round ${roundIndex + 1}: ${roundName}`,
        payloadJson: {
          adapter: state.adapter,
          role: 'participant',
          roundIndex,
          roundName,
          success: false,
          failureClass,
          error: error.message
        },
        occurredAt: completedAt
      });
    }

    return {
      participantId: state.participantId,
      participantRef: state.participantRef || null,
      senderId: state.discussionSenderId,
      name: state.name,
      adapter: state.adapter,
      success: false,
      error: error.message,
      failureClass
    };
  }
}

async function runJudge(sessionManager, judgeSpec, prompt, options = {}) {
  const startedAt = Date.now();
  const runLedger = options.runLedger || null;
  const runId = options.runId || null;
  const participantId = options.participantId || null;
  const effectiveTimeout = resolveEffectiveTimeout(
    judgeSpec.timeout || options.timeout,
    options.workflowStartedAt,
    options.workflowTimeout
  );
  const stepId = runLedger && runId && participantId
    ? runLedger.appendStep({
        runId,
        participantId,
        stepKey: 'discussion-judge',
        stepName: 'discussion judge execution',
        status: 'running',
        retrySafe: true,
        startedAt
      })
    : null;

  let session = null;
  try {
    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordChildSessionStarted({
        sessionId: options.controlSessionId || participantId || options.senderId,
        sessionKind: 'judge',
        role: 'judge',
        name: judgeSpec.name || judgeSpec.adapter,
        adapter: judgeSpec.adapter,
        model: judgeSpec.model || null,
        workDir: judgeSpec.workDir || options.workDir || null,
        stableStepKey: 'judge-start',
        payloadSummary: `${judgeSpec.name || judgeSpec.adapter} judge session started`,
        occurredAt: startedAt
      });
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || options.senderId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: 'delegation_started',
        stableStepKey: 'judge-delegation-start',
        payloadSummary: `${judgeSpec.name || judgeSpec.adapter} started judge synthesis`,
        payloadJson: {
          adapter: judgeSpec.adapter,
          role: 'judge',
          model: judgeSpec.model || null,
          workDir: judgeSpec.workDir || options.workDir || null
        },
        occurredAt: startedAt
      });
    }

    if (runLedger && runId && participantId) {
      runLedger.updateParticipant(participantId, {
        status: 'running',
        currentStep: 'judge',
        startedAt,
        lastHeartbeatAt: startedAt
      });
      runLedger.appendInput({
        runId,
        participantId,
        inputKind: 'judge_prompt',
        content: prompt,
        metadata: {
          adapter: judgeSpec.adapter,
          systemPrompt: judgeSpec.systemPrompt || null,
          model: judgeSpec.model || null,
          workDir: judgeSpec.workDir || options.workDir || null,
          timeout: judgeSpec.timeout || options.timeout || null
        },
        createdAt: startedAt
      });
    }

    if (effectiveTimeout === MIN_TIMEOUT_FLOOR_MS && options.workflowStartedAt != null) {
      const remainingBudget = computeRemainingBudget(options.workflowStartedAt, options.workflowTimeout);
      if (remainingBudget <= 0) {
        throw new Error('judge timed out before execution started');
      }
    }

    session = await sessionManager.createSession({
      adapter: judgeSpec.adapter,
      sessionId: `discussion-judge-${crypto.randomBytes(6).toString('hex')}`,
      systemPrompt: judgeSpec.systemPrompt,
      workDir: judgeSpec.workDir || options.workDir,
      model: judgeSpec.model,
      providerSessionId: judgeSpec.providerSessionId || null,
      jsonSchema: judgeSpec.jsonSchema,
      jsonMode: judgeSpec.jsonMode
    });

    const response = await sessionManager.send(session.sessionId, prompt, {
      timeout: effectiveTimeout || undefined
    });
    const completedAt = Date.now();

    if (runLedger && runId && participantId) {
      if (stepId) {
        runLedger.updateStep(stepId, {
          status: 'completed',
          lastHeartbeatAt: completedAt,
          completedAt
        });
      }
      runLedger.appendOutput({
        runId,
        participantId,
        outputKind: 'judge_final',
        content: response.result,
        metadata: {
          ...(response.metadata || {}),
          adapter: judgeSpec.adapter,
          sendMetadata: response.metadata || {}
        },
        createdAt: completedAt
      });
      runLedger.updateParticipant(participantId, {
        status: 'completed',
        currentStep: 'completed',
        lastHeartbeatAt: completedAt,
        endedAt: completedAt
      });
    }

    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || options.senderId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: 'judge_completed',
        stableStepKey: 'judge-completed',
        payloadSummary: `${judgeSpec.name || judgeSpec.adapter} completed judge synthesis`,
        payloadJson: {
          adapter: judgeSpec.adapter,
          success: true
        },
        occurredAt: completedAt
      });
    }

    return {
      participantId,
      senderId: options.senderId || makeDiscussionSenderId('judge', judgeSpec.name || judgeSpec.adapter, judgeSpec.adapter, 0),
      name: judgeSpec.name || judgeSpec.adapter,
      adapter: judgeSpec.adapter,
      success: true,
      output: response.result,
      metadata: response.metadata || {}
    };
  } catch (error) {
    const completedAt = Date.now();
    const failureClass = classifyFailure(error);
    if (runLedger && runId && participantId) {
      if (stepId) {
        runLedger.updateStep(stepId, {
          status: 'failed',
          failureClass,
          lastHeartbeatAt: completedAt,
          completedAt,
          metadata: { error: error.message }
        });
      }
      runLedger.appendOutput({
        runId,
        participantId,
        outputKind: 'participant_error',
        content: error.message,
        metadata: { failureClass },
        createdAt: completedAt
      });
      runLedger.updateParticipant(participantId, {
        status: 'failed',
        currentStep: 'failed',
        failureClass,
        lastHeartbeatAt: completedAt,
        endedAt: completedAt
      });
    }

    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || options.senderId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: 'judge_completed',
        stableStepKey: 'judge-completed',
        payloadSummary: `${judgeSpec.name || judgeSpec.adapter} failed judge synthesis`,
        payloadJson: {
          adapter: judgeSpec.adapter,
          success: false,
          failureClass,
          error: error.message
        },
        occurredAt: completedAt
      });
    }

    return {
      participantId,
      senderId: options.senderId || makeDiscussionSenderId('judge', judgeSpec.name || judgeSpec.adapter, judgeSpec.adapter, 0),
      name: judgeSpec.name || judgeSpec.adapter,
      adapter: judgeSpec.adapter,
      success: false,
      error: error.message,
      failureClass
    };
  } finally {
    if (session?.sessionId) {
      try {
        await sessionManager.terminateSession(session.sessionId);
      } catch {}
    }
  }
}

async function runDiscussion(sessionManager, message, options = {}) {
  const {
    participants,
    rounds,
    judge = undefined,
    timeout = null,
    workDir = null,
    runLedger = null,
    context = null,
    db = null,
    sessionEventsEnabled = false,
    rootSessionId = null,
    parentSessionId = null,
    originClient = null,
    externalSessionRef = null,
    sessionMetadata = null,
    sink = null
  } = options;

  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('participants array is required');
  }

  const resolvedRounds = resolveRounds(rounds);
  const judgeSpec = resolveJudge(judge);
  const startedAt = Date.now();
  const discussionId = `discussion_${crypto.randomBytes(8).toString('hex')}`;
  const discussionStore = getDiscussionStore(options);
  const discussionSystemSenderId = 'discussion-system';
  const runId = runLedger
    ? runLedger.createRun({
        kind: 'discussion',
        status: 'pending',
        hashInput: {
          message,
          context,
          rounds: resolvedRounds,
          participants,
          judge: judgeSpec,
          timeout,
          workingDirectory: workDir
        },
        inputSummary: summarizeText(message),
        workingDirectory: workDir,
        initiator: 'orchestration/discussion',
        discussionId,
        currentStep: 'initializing',
        metadata: {
          roundCount: resolvedRounds.length,
          participantCount: participants.length,
          hasJudge: Boolean(judgeSpec),
          contextSummary: summarizeText(context, 400)
        },
        startedAt,
        rootSessionId: rootSessionId || null,
        taskId: options.taskId || null
      })
    : null;
  const effectiveRootSessionId = rootSessionId || discussionId;
  const effectiveTaskId = options.taskId || null;
  const eventRecorder = createSessionEventRecorder({
    db,
    enabled: sessionEventsEnabled,
    workflowKind: 'discussion',
    workflowSessionId: discussionId,
    rootSessionId: effectiveRootSessionId,
    parentSessionId,
    originClient: originClient || 'system',
    externalSessionRef,
    sessionMetadata,
    runId,
    discussionId
  });

  if (runLedger && runId) {
    runLedger.updateRun(runId, {
      rootSessionId: effectiveRootSessionId,
      taskId: effectiveTaskId
    });
  }

  eventRecorder.recordWorkflowStarted({
    payloadSummary: `Discussion started: ${summarizeText(message, 120)}`,
    payloadJson: {
      participantCount: participants.length,
      roundCount: resolvedRounds.length,
      hasJudge: Boolean(judgeSpec),
      workDir: workDir || null
    },
    occurredAt: startedAt
  });
  eventRecorder.recordEvent({
    sessionId: discussionId,
    parentSessionId: eventRecorder.parentSessionId,
    eventType: 'discussion_started',
    stableStepKey: 'discussion-opened',
    payloadSummary: `Discussion opened with ${participants.length} participant(s)`,
    payloadJson: {
      participantCount: participants.length,
      roundCount: resolvedRounds.length,
      hasJudge: Boolean(judgeSpec),
      contextSummary: summarizeText(context, 400)
    },
    occurredAt: startedAt
  });
  await emitDiscussionSink(sink, 'discussion_started', {
    discussionId,
    runId,
    startedAt,
    message,
    context: context || null,
    participantCount: participants.length,
    roundCount: resolvedRounds.length,
    hasJudge: Boolean(judgeSpec)
  });

  if (discussionStore) {
    discussionStore.createDiscussion(discussionId, discussionSystemSenderId, {
      taskId: runId,
      topic: summarizeText(message, 280),
      metadata: {
        kind: 'discussion',
        runId,
        participantCount: participants.length,
        roundCount: resolvedRounds.length,
        hasJudge: Boolean(judgeSpec),
        workingDirectory: workDir || null,
        contextSummary: summarizeText(context, 400)
      }
    });

    appendDiscussionMessage(
      discussionStore,
      discussionId,
      discussionSystemSenderId,
      [
        'Discussion opened.',
        '',
        'Primary task:',
        message,
        '',
        'Context:',
        context || '(none)'
      ].join('\n'),
      { messageType: 'info' }
    );
  }

  if (runLedger && runId) {
    runLedger.appendInput({
      runId,
      inputKind: 'run_message',
      content: message,
      metadata: {
        participantCount: participants.length,
        roundCount: resolvedRounds.length,
        judgeConfigured: Boolean(judgeSpec),
        timeout,
        workDir
      },
      createdAt: startedAt
    });
  }

  const states = participants.map((participant, index) => ({
    name: participant.name || participant.adapter,
    adapter: participant.adapter,
    discussionSenderId: makeDiscussionSenderId(
      'participant',
      participant.name || participant.adapter,
      participant.adapter,
      index
    ),
    systemPrompt: participant.systemPrompt,
    model: participant.model,
    timeout: participant.timeout || null,
    workDir: participant.workDir || workDir || null,
    participantRef: participant.participantRef || null,
    providerSessionId: participant.providerSessionId || null,
    jsonMode: participant.jsonMode,
    jsonSchema: participant.jsonSchema || null,
    controlSessionId: null,
    failed: false,
    error: null,
    failureClass: null,
    createdSession: false,
    sessionId: null,
    startedAt,
    participantId: runLedger && runId
      ? runLedger.addParticipant({
          runId,
          participantRole: 'participant',
          participantName: participant.name || participant.adapter,
          adapter: participant.adapter,
          agentProfile: participant.model || null,
          status: 'queued',
          metadata: {
            index,
            model: participant.model || null,
            workDir: participant.workDir || workDir || null
          }
        })
      : null
  }));

  for (const state of states) {
    state.controlSessionId = state.participantId || `${discussionId}:${state.discussionSenderId}`;
  }

  const roundResults = [];
  let activeStates = states.slice();

  for (let roundIndex = 0; roundIndex < resolvedRounds.length; roundIndex++) {
    const round = resolvedRounds[roundIndex];

    if (discussionStore) {
      appendDiscussionMessage(
        discussionStore,
        discussionId,
        discussionSystemSenderId,
        [
          `Round ${roundIndex + 1}: ${round.name}`,
          '',
          round.instructions,
          '',
          `Transcript mode: ${round.transcriptMode}`
        ].join('\n'),
        { messageType: 'info' }
      );
    }

    eventRecorder.recordEvent({
      sessionId: discussionId,
      parentSessionId: eventRecorder.parentSessionId,
      eventType: 'discussion_round_started',
      stableStepKey: `round-${roundIndex + 1}-started`,
      payloadSummary: `Round ${roundIndex + 1} started: ${round.name}`,
      payloadJson: {
        roundIndex,
        roundName: round.name,
        transcriptMode: round.transcriptMode,
        participantCount: activeStates.filter((state) => !state.failed).length
      }
    });
    await emitDiscussionSink(sink, 'round_started', {
      discussionId,
      runId,
      roundIndex,
      roundName: round.name,
      transcriptMode: round.transcriptMode,
      instructions: round.instructions,
      startedAt: Date.now(),
      participantCount: activeStates.filter((state) => !state.failed).length
    });

    if (runLedger && runId) {
      runLedger.updateRun(runId, {
        currentStep: `round-${roundIndex + 1}:${round.name}`,
        activeParticipantCount: activeStates.filter((state) => !state.failed).length,
        lastHeartbeatAt: Date.now()
      });
    }

    const responses = await Promise.all(activeStates
      .filter((state) => !state.failed)
      .map((state) => {
        const prompt = buildRoundPrompt({
          message,
          context,
          round,
          priorRounds: roundResults,
          participant: state
        });

        return runRoundForParticipant(sessionManager, state, prompt, {
          roundIndex,
          roundName: round.name,
          timeout,
          workflowStartedAt: startedAt,
          workflowTimeout: timeout,
          workDir,
          runLedger,
          runId,
          eventRecorder
        });
      }));

    const roundResult = {
      roundIndex,
      name: round.name,
      instructions: round.instructions,
      transcriptMode: round.transcriptMode,
      responses
    };
    roundResults.push(roundResult);
    for (const response of responses) {
      await emitDiscussionSink(sink, response.success ? 'participant_response' : 'participant_failure', {
        discussionId,
        runId,
        roundIndex,
        roundName: round.name,
        response
      });
    }
    await emitDiscussionSink(sink, 'round_completed', {
      discussionId,
      runId,
      roundIndex,
      roundName: round.name,
      roundResult
    });

    if (discussionStore) {
      for (const response of responses) {
        appendDiscussionMessage(
          discussionStore,
          discussionId,
          response.senderId || discussionSystemSenderId,
          [
            `Round ${roundIndex + 1}: ${round.name}`,
            '',
            response.success ? 'Status: completed' : `Status: failed (${response.failureClass || 'unknown'})`,
            '',
            response.success ? response.output : response.error
          ].join('\n'),
          { messageType: response.success ? 'answer' : 'info' }
        );
      }

      appendDiscussionMessage(
        discussionStore,
        discussionId,
        discussionSystemSenderId,
        [
          `Round ${roundIndex + 1} summary: ${round.name}`,
          '',
          formatRoundTranscript(roundResult)
        ].join('\n'),
        { messageType: 'info' }
      );
    }

    if (runLedger && runId) {
      runLedger.appendOutput({
        runId,
        outputKind: 'participant_final',
        content: formatRoundTranscript(roundResult),
        metadata: {
          roundIndex,
          roundName: round.name,
          responseCount: responses.length,
          successCount: responses.filter((entry) => entry.success).length
        }
      });
    }

    eventRecorder.recordEvent({
      sessionId: discussionId,
      parentSessionId: eventRecorder.parentSessionId,
      eventType: 'discussion_round_completed',
      stableStepKey: `round-${roundIndex + 1}-completed`,
      payloadSummary: `Round ${roundIndex + 1} completed: ${round.name}`,
      payloadJson: {
        roundIndex,
        roundName: round.name,
        responseCount: responses.length,
        successCount: responses.filter((entry) => entry.success).length
      }
    });

    activeStates = activeStates.filter((state) => !state.failed);
    if (activeStates.length === 0) {
      break;
    }
  }

  for (const state of states) {
    if (runLedger && runId && state.participantId && !state.failed) {
      runLedger.updateParticipant(state.participantId, {
        status: 'completed',
        currentStep: 'completed',
        lastHeartbeatAt: Date.now(),
        endedAt: Date.now()
      });
    }
  }

  const participantResults = states.map((state) => ({
    participantId: state.participantId,
    participantRef: state.participantRef || null,
    name: state.name,
    adapter: state.adapter,
    success: !state.failed,
    error: state.error,
    failureClass: state.failureClass,
    roundsCompleted: roundResults.filter((roundResult) => roundResult.responses.some((response) => response.adapter === state.adapter && response.name === state.name && response.success)).length,
    providerSessionId: state.providerSessionId || null
  }));

  const successfulParticipants = participantResults.filter((entry) => entry.success);
  const failedParticipants = participantResults.filter((entry) => !entry.success);

  let judgeResult = null;
  if (judgeSpec && roundResults.some((roundResult) => roundResult.responses.some((response) => response.success))) {
    const judgeParticipantId = runLedger && runId
      ? runLedger.addParticipant({
          runId,
          participantRole: 'judge',
          participantName: judgeSpec.name || judgeSpec.adapter,
          adapter: judgeSpec.adapter,
          agentProfile: judgeSpec.model || null,
          status: 'queued',
          metadata: {
            model: judgeSpec.model || null,
            workDir: judgeSpec.workDir || workDir || null
          }
        })
      : null;

    if (runLedger && runId) {
      runLedger.updateRun(runId, {
        currentStep: 'judge',
        activeParticipantCount: 1,
        lastHeartbeatAt: Date.now()
      });
    }

    judgeResult = await runJudge(sessionManager, judgeSpec, buildJudgePrompt({ message, context, rounds: roundResults }), {
      timeout,
      workflowStartedAt: startedAt,
      workflowTimeout: timeout,
      workDir,
      runLedger,
      runId,
      participantId: judgeParticipantId,
      senderId: makeDiscussionSenderId('judge', judgeSpec.name || judgeSpec.adapter, judgeSpec.adapter, 0),
      controlSessionId: judgeParticipantId || `${discussionId}:judge`,
      eventRecorder
    });

    if (discussionStore && judgeResult) {
      appendDiscussionMessage(
        discussionStore,
        discussionId,
        judgeResult.senderId || discussionSystemSenderId,
        [
          'Judge synthesis',
          '',
          judgeResult.success ? judgeResult.output : `Judge failed (${judgeResult.failureClass || 'unknown'}): ${judgeResult.error}`
        ].join('\n'),
        { messageType: judgeResult.success ? 'answer' : 'info' }
      );
    }
    await emitDiscussionSink(sink, 'judge_completed', {
      discussionId,
      runId,
      judge: judgeResult
    });
  }

  for (const state of states) {
    if (state.sessionId) {
      try {
        await sessionManager.terminateSession(state.sessionId);
      } catch {}
    }
  }

  const completedAt = Date.now();
  const totalSuccessfulResponses = roundResults.reduce((count, roundResult) => count + roundResult.responses.filter((entry) => entry.success).length, 0);
  const judgeFailed = Boolean(judgeSpec && judgeResult && !judgeResult.success);
  const runStatus = totalSuccessfulResponses === 0
    ? 'failed'
    : (failedParticipants.length > 0 || judgeFailed || activeStates.length === 0 && successfulParticipants.length === 0 ? 'partial' : 'completed');
  const decisionSource = judgeResult?.success ? 'judge' : (roundResults.length > 0 ? 'participants' : null);
  const decisionSummary = judgeResult?.success
    ? summarizeText(judgeResult.output)
    : summarizeText(roundResults.map((roundResult) => `${roundResult.name}: ${formatRoundTranscript(roundResult, 800)}`).join('\n\n'));

  if (runLedger && runId) {
    runLedger.updateRun(runId, {
      status: runStatus,
      currentStep: 'finalized',
      activeParticipantCount: 0,
      decisionSummary,
      decisionSource,
      failureClass: runStatus === 'failed'
        ? (failedParticipants[0]?.failureClass || judgeResult?.failureClass || 'unknown')
        : (judgeFailed ? judgeResult.failureClass || 'unknown' : (failedParticipants[0]?.failureClass || null)),
      completedAt,
      durationMs: completedAt - startedAt,
      metadata: {
        roundCount: resolvedRounds.length,
        roundsCompleted: roundResults.length,
        participantCount: states.length,
        successCount: successfulParticipants.length,
        failedParticipantCount: failedParticipants.length,
        participantFailures: failedParticipants.map((entry) => ({
          name: entry.name,
          adapter: entry.adapter,
          failureClass: entry.failureClass || 'unknown',
          error: entry.error || null
        })),
        judgeConfigured: Boolean(judgeSpec),
        judgeSuccess: judgeSpec ? Boolean(judgeResult?.success) : null,
        totalSuccessfulResponses
      }
    });
  }

  if (discussionStore) {
    discussionStore.updateDiscussionStatus(discussionId, runStatus);
  }

  const snapshotService = getMemorySnapshotService();
  if (snapshotService && runId) {
    const snapshot = snapshotService.writeRunSnapshot(runId, {
      rootSessionId: effectiveRootSessionId,
      taskId: effectiveTaskId
    });
    if (snapshot && effectiveRootSessionId) {
      snapshotService.scheduleRootRefresh(effectiveRootSessionId);
    }
  }

  eventRecorder.recordEvent({
    sessionId: discussionId,
    parentSessionId: eventRecorder.parentSessionId,
    eventType: 'consensus_recorded',
    stableStepKey: 'discussion-finalized',
    payloadSummary: `Discussion ${runStatus}`,
    payloadJson: {
      status: runStatus,
      decisionSource,
      decisionSummary,
      participantCount: states.length,
      successCount: successfulParticipants.length,
      failedParticipantCount: failedParticipants.length,
      judgeSuccess: judgeSpec ? Boolean(judgeResult?.success) : null
    },
    occurredAt: completedAt
  });
  const finalResult = {
    success: runStatus !== 'failed',
    mode: 'direct-session',
    discussionId,
    rounds: roundResults,
    participants: participantResults,
    judge: judgeResult,
    runId
  };
  await emitDiscussionSink(sink, 'discussion_completed', {
    discussionId,
    runId,
    completedAt,
    result: finalResult
  });

  return finalResult;
}

module.exports = {
  runDiscussion,
  DEFAULT_ROUNDS,
  DEFAULT_JUDGE,
  resolveRounds,
  buildRoundPrompt,
  buildJudgePrompt
};
