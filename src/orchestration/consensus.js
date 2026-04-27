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

function summarizeText(text, maxLength = 1200) {
  return String(text || '').trim().slice(0, maxLength) || null;
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

function buildJudgePrompt(originalMessage, participantResults) {
  const sections = participantResults.map((result, index) => {
    return [
      `Participant ${index + 1}`,
      `Adapter: ${result.adapter}`,
      `Name: ${result.name}`,
      'Output:',
      result.output
    ].join('\n');
  });

  return [
    'You are judging multiple agent responses for the same task.',
    `Original task:\n${originalMessage}`,
    'Responses:',
    sections.join('\n\n'),
    'Produce a consensus answer that resolves disagreements explicitly and keeps only the best-supported result.'
  ].join('\n\n');
}

async function runParticipant(sessionManager, participant, message, options = {}) {
  const sessionOptions = {
    adapter: participant.adapter,
    sessionId: `consensus-${crypto.randomBytes(6).toString('hex')}`,
    systemPrompt: participant.systemPrompt,
    workDir: participant.workDir || options.workDir,
    model: participant.model,
    jsonSchema: participant.jsonSchema,
    jsonMode: participant.jsonMode
  };

  const startedAt = Date.now();
  const ledger = options.runLedger || null;
  const participantId = options.participantId || null;
  const runId = options.runId || null;
  const outputKind = options.role === 'judge' ? 'judge_final' : 'participant_final';
  const stepId = ledger && participantId && runId
    ? ledger.appendStep({
        runId,
        participantId,
        stepKey: `${options.role || 'participant'}-execution`,
        stepName: `${options.role || 'participant'} execution`,
        status: 'running',
        retrySafe: true,
        startedAt
      })
    : null;

  let session = null;
  let timeoutId = null;

  if (ledger && participantId) {
    ledger.updateParticipant(participantId, {
      status: 'running',
      currentStep: 'executing',
      startedAt,
      lastHeartbeatAt: startedAt
    });

    ledger.appendInput({
      runId,
      participantId,
      inputKind: options.role === 'judge' ? 'judge_prompt' : 'participant_prompt',
      content: message,
      metadata: {
        role: options.role || 'participant',
        adapter: participant.adapter,
        systemPrompt: participant.systemPrompt || null,
        model: participant.model || null,
        workDir: sessionOptions.workDir || null,
        timeout: participant.timeout || options.timeout || null,
        jsonMode: participant.jsonMode === undefined ? null : Boolean(participant.jsonMode),
        jsonSchema: participant.jsonSchema || null
      },
      createdAt: startedAt
    });
  }

  try {
    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordChildSessionStarted({
        sessionId: options.controlSessionId || participantId || sessionOptions.sessionId,
        sessionKind: options.role === 'judge' ? 'judge' : 'subagent',
        role: options.role || 'participant',
        name: participant.name || participant.adapter,
        adapter: participant.adapter,
        model: participant.model || null,
        workDir: sessionOptions.workDir || null,
        stableStepKey: `${options.role || 'participant'}-session-start`,
        payloadSummary: `${participant.name || participant.adapter} session started`,
        occurredAt: startedAt
      });
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || sessionOptions.sessionId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: 'delegation_started',
        stableStepKey: `${options.role || 'participant'}-delegation-start`,
        payloadSummary: `${participant.name || participant.adapter} started ${options.role || 'participant'} execution`,
        payloadJson: {
          adapter: participant.adapter,
          role: options.role || 'participant',
          model: participant.model || null,
          workDir: sessionOptions.workDir || null
        },
        occurredAt: startedAt
      });
    }

    const remainingBudgetBeforeCreate = options.workflowStartedAt != null
      ? computeRemainingBudget(options.workflowStartedAt, options.workflowTimeout)
      : null;
    if (remainingBudgetBeforeCreate !== null && remainingBudgetBeforeCreate <= 0) {
      throw new Error(`${options.role || 'participant'} timed out before execution started`);
    }

    session = await sessionManager.createSession(sessionOptions);
    const timeoutMs = resolveEffectiveTimeout(
      participant.timeout || options.timeout,
      options.workflowStartedAt,
      options.workflowTimeout
    );
    const effectiveTimeoutMs = timeoutMs === null ? undefined : Math.max(timeoutMs, MIN_TIMEOUT_FLOOR_MS);
    const sendPromise = sessionManager.send(session.sessionId, message, {
      timeout: effectiveTimeoutMs
    });
    const response = effectiveTimeoutMs != null
      ? await Promise.race([
          sendPromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              void (async () => {
                try {
                  await sessionManager.interruptSession?.(session.sessionId);
                } catch {}
              })();
              reject(new Error(`${options.role || 'participant'} timed out after ${effectiveTimeoutMs}ms`));
            }, effectiveTimeoutMs);
          })
        ])
      : await sendPromise;

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    const completedAt = Date.now();

    if (ledger && participantId && runId) {
      ledger.updateParticipant(participantId, {
        status: 'completed',
        currentStep: 'completed',
        lastHeartbeatAt: completedAt,
        endedAt: completedAt
      });
      if (stepId) {
        ledger.updateStep(stepId, {
          status: 'completed',
          lastHeartbeatAt: completedAt,
          completedAt
        });
      }
      ledger.appendOutput({
        runId,
        participantId,
        outputKind,
        content: response.result,
        metadata: response.metadata || {}
      });
    }

    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || sessionOptions.sessionId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: options.role === 'judge' ? 'judge_completed' : 'delegation_completed',
        stableStepKey: `${options.role || 'participant'}-delegation-completed`,
        payloadSummary: `${participant.name || participant.adapter} completed ${options.role || 'participant'} execution`,
        payloadJson: {
          adapter: participant.adapter,
          role: options.role || 'participant',
          success: true
        },
        occurredAt: completedAt
      });
    }

    return {
      participantId,
      name: participant.name || participant.adapter,
      adapter: participant.adapter,
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

    if (ledger && participantId && runId) {
      ledger.updateParticipant(participantId, {
        status: 'failed',
        currentStep: 'failed',
        failureClass,
        lastHeartbeatAt: completedAt,
        endedAt: completedAt
      });
      if (stepId) {
        ledger.updateStep(stepId, {
          status: 'failed',
          failureClass,
          lastHeartbeatAt: completedAt,
          completedAt,
          metadata: { error: error.message }
        });
      }
      ledger.appendOutput({
        runId,
        participantId,
        outputKind: 'participant_error',
        content: error.message,
        metadata: { failureClass }
      });
    }

    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || sessionOptions.sessionId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: options.role === 'judge' ? 'judge_completed' : 'delegation_completed',
        stableStepKey: `${options.role || 'participant'}-delegation-completed`,
        payloadSummary: `${participant.name || participant.adapter} failed ${options.role || 'participant'} execution`,
        payloadJson: {
          adapter: participant.adapter,
          role: options.role || 'participant',
          success: false,
          failureClass,
          error: error.message
        },
        occurredAt: completedAt
      });
    }

    return {
      participantId,
      name: participant.name || participant.adapter,
      adapter: participant.adapter,
      success: false,
      error: error.message,
      failureClass
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (session?.sessionId) {
      try {
        await sessionManager.terminateSession(session.sessionId);
      } catch {}
    }
  }
}

async function runConsensus(sessionManager, message, options = {}) {
  const {
    participants,
    judge = null,
    timeout = null,
    workDir = null,
    runLedger = null,
    db = null,
    sessionEventsEnabled = false,
    rootSessionId = null,
    parentSessionId = null,
    originClient = null,
    externalSessionRef = null,
    sessionMetadata = null
  } = options;

  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('participants array is required');
  }

  const startedAt = Date.now();
  const runId = runLedger
    ? runLedger.createRun({
        kind: 'consensus',
        status: 'pending',
        hashInput: {
          message,
          participants,
          judge,
          timeout,
          workingDirectory: workDir
        },
        inputSummary: summarizeText(message),
        workingDirectory: workDir,
        initiator: 'orchestration/consensus',
        metadata: {
          participantCount: participants.length,
          hasJudge: Boolean(judge)
        },
        startedAt,
        rootSessionId: rootSessionId || null,
        taskId: options.taskId || null
      }) 
    : null;
  const workflowSessionId = runId || `consensus_${crypto.randomBytes(8).toString('hex')}`;
  const effectiveRootSessionId = rootSessionId || workflowSessionId;
  const effectiveTaskId = options.taskId || null;
  const eventRecorder = createSessionEventRecorder({
    db,
    enabled: sessionEventsEnabled,
    workflowKind: 'workflow',
    workflowSessionId,
    rootSessionId: effectiveRootSessionId,
    parentSessionId: parentSessionId || null,
    originClient: originClient || 'system',
    externalSessionRef,
    sessionMetadata,
    runId
  });

  eventRecorder.recordWorkflowStarted({
    payloadSummary: `Consensus started: ${summarizeText(message, 120)}`,
    payloadJson: {
      workflowKind: 'consensus',
      participantCount: participants.length,
      hasJudge: Boolean(judge),
      workDir: workDir || null
    },
    occurredAt: startedAt
  });

  if (runLedger && runId) {
    runLedger.appendInput({
      runId,
      inputKind: 'run_message',
      content: message,
      metadata: {
        participantCount: participants.length,
        judgeConfigured: Boolean(judge),
        timeout,
        workDir
      },
      createdAt: startedAt
    });
  }

  const participantSpecs = participants.map((participant) => ({
    ...participant,
    __controlSessionId: null,
    __participantId: runLedger && runId
      ? runLedger.addParticipant({
          runId,
          participantRole: 'participant',
          participantName: participant.name || participant.adapter,
          adapter: participant.adapter,
          agentProfile: participant.model || null,
          status: 'queued',
          metadata: {
            model: participant.model || null,
            workDir: participant.workDir || workDir || null
          }
        })
      : null
  }));

  for (const participant of participantSpecs) {
    participant.__controlSessionId = participant.__participantId || `${workflowSessionId}:${participant.name || participant.adapter}`;
  }

  if (runLedger && runId) {
    runLedger.updateRun(runId, {
      status: 'running',
      currentStep: 'participants',
      activeParticipantCount: participantSpecs.length,
      lastHeartbeatAt: startedAt,
      rootSessionId: effectiveRootSessionId,
      taskId: effectiveTaskId
    });
  }

  const participantResults = await Promise.all(
    participantSpecs.map((participant) => runParticipant(sessionManager, participant, message, {
      timeout,
      workflowStartedAt: startedAt,
      workflowTimeout: timeout,
      workDir,
      runLedger,
      runId,
      role: 'participant',
      participantId: participant.__participantId,
      controlSessionId: participant.__controlSessionId,
      eventRecorder
    }))
  );

  const successfulParticipants = participantResults.filter((result) => result.success);
  const failedParticipants = participantResults.filter((result) => !result.success);
  if (successfulParticipants.length === 0) {
    const completedAt = Date.now();

    if (runLedger && runId) {
      runLedger.updateRun(runId, {
        status: 'failed',
        currentStep: 'finalized',
        activeParticipantCount: 0,
        failureClass: participantResults[0]?.failureClass || 'unknown',
        completedAt,
        durationMs: completedAt - startedAt,
        metadata: {
          participantCount: participantResults.length,
          successCount: 0
        }
      });
    }

    eventRecorder.recordEvent({
      sessionId: workflowSessionId,
      parentSessionId: eventRecorder.parentSessionId,
      eventType: 'consensus_recorded',
      stableStepKey: 'consensus-finalized',
      payloadSummary: 'Consensus failed',
      payloadJson: {
        status: 'failed',
        participantCount: participantResults.length,
        successCount: 0
      },
      occurredAt: completedAt
    });

    return {
      success: false,
      mode: 'direct-session',
      participants: participantResults,
      consensus: null,
      runId
    };
  }

  let consensus = null;

  if (judge) {
    const judgeParticipantId = runLedger && runId
      ? runLedger.addParticipant({
          runId,
          participantRole: 'judge',
          participantName: judge.name || judge.adapter,
          adapter: judge.adapter,
          agentProfile: judge.model || null,
          status: 'queued',
          metadata: {
            model: judge.model || null,
            workDir: judge.workDir || workDir || null
          }
        })
      : null;
    judge.__controlSessionId = judgeParticipantId || `${workflowSessionId}:${judge.name || judge.adapter}`;

    if (runLedger && runId) {
      runLedger.updateRun(runId, {
        currentStep: 'judge',
        activeParticipantCount: 1,
        lastHeartbeatAt: Date.now()
      });
    }

    const judgePrompt = buildJudgePrompt(message, successfulParticipants);
    consensus = await runParticipant(sessionManager, judge, judgePrompt, {
      timeout,
      workflowStartedAt: startedAt,
      workflowTimeout: timeout,
      workDir,
      runLedger,
      runId,
      role: 'judge',
      participantId: judgeParticipantId,
      controlSessionId: judge.__controlSessionId,
      eventRecorder
    });
  }

  const completedAt = Date.now();
  const hasParticipantFailures = failedParticipants.length > 0;
  const judgeFailed = Boolean(judge && !consensus?.success);
  const runStatus = hasParticipantFailures || judgeFailed ? 'partial' : 'completed';
  const decisionSource = judge
    ? (consensus?.success ? 'judge' : null)
    : 'participants';
  const decisionSummary = judge
    ? summarizeText(consensus?.output)
    : summarizeText(successfulParticipants.map((entry) => `${entry.name}: ${entry.output}`).join('\n\n'));

  if (runLedger && runId) {
    runLedger.updateRun(runId, {
      status: runStatus,
      currentStep: 'finalized',
      activeParticipantCount: 0,
      decisionSummary,
      decisionSource,
      failureClass: judgeFailed
        ? (consensus.failureClass || 'unknown')
        : (hasParticipantFailures ? failedParticipants[0]?.failureClass || 'unknown' : null),
      completedAt,
      durationMs: completedAt - startedAt,
      metadata: {
        participantCount: participantResults.length,
        successCount: successfulParticipants.length,
        failedParticipantCount: failedParticipants.length,
        participantFailures: failedParticipants.map((entry) => ({
          name: entry.name,
          adapter: entry.adapter,
          failureClass: entry.failureClass || 'unknown',
          error: entry.error || null
        })),
        judgeConfigured: Boolean(judge),
        judgeSuccess: judge ? Boolean(consensus?.success) : null
      }
    });
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
    sessionId: workflowSessionId,
    parentSessionId: eventRecorder.parentSessionId,
    eventType: 'consensus_recorded',
    stableStepKey: 'consensus-finalized',
    payloadSummary: `Consensus ${runStatus}`,
    payloadJson: {
      status: runStatus,
      decisionSource,
      participantCount: participantResults.length,
      successCount: successfulParticipants.length,
      failedParticipantCount: failedParticipants.length,
      judgeSuccess: judge ? Boolean(consensus?.success) : null
    },
    occurredAt: completedAt
  });

  return {
    success: true,
    mode: 'direct-session',
    participantCount: participantResults.length,
    successCount: successfulParticipants.length,
    participants: participantResults,
    consensus,
    runId
  };
}

module.exports = {
  runConsensus
};
