const crypto = require('crypto');
const { createSessionEventRecorder } = require('./session-event-recorder');

const REVIEW_VERDICTS = new Set(['approve', 'revise', 'reject']);
const BLOCKER_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

const DEFAULT_PLAN_REVIEWERS = [
  {
    name: 'correctness-reviewer',
    adapter: 'codex-cli',
    systemPrompt: 'Review implementation plans for correctness and missing execution steps. Return JSON only.'
  },
  {
    name: 'risk-reviewer',
    adapter: 'gemini-cli',
    systemPrompt: 'Review implementation plans for risks, missing tests, and operational gaps. Return JSON only.'
  }
];

const DEFAULT_PR_REVIEWERS = [
  {
    name: 'correctness-reviewer',
    adapter: 'codex-cli',
    systemPrompt: 'Review pull requests for bugs, regressions, and missing test coverage. Return JSON only.'
  },
  {
    name: 'security-reviewer',
    adapter: 'gemini-cli',
    systemPrompt: 'Review pull requests for security issues and unsafe assumptions. Return JSON only.'
  }
];

const DEFAULT_PLAN_JUDGE = {
  name: 'plan-judge',
  adapter: 'codex-cli',
  systemPrompt: 'Synthesize reviewer findings and issue a final plan verdict in JSON only.'
};

const DEFAULT_PR_JUDGE = {
  name: 'pr-judge',
  adapter: 'codex-cli',
  systemPrompt: 'Synthesize reviewer findings and issue a final PR verdict in JSON only.'
};

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

function normalizeVerdict(value) {
  const verdict = String(value || '').toLowerCase().trim();
  return REVIEW_VERDICTS.has(verdict) ? verdict : 'revise';
}

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase().trim();
  return BLOCKER_SEVERITIES.has(severity) ? severity : 'medium';
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function tryParseJson(text) {
  const cleaned = stripCodeFences(text);
  if (!cleaned) {
    return null;
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function normalizeBlockers(blockers) {
  if (!Array.isArray(blockers)) {
    return [];
  }

  return blockers.map((blocker, index) => ({
    id: blocker?.id || `B${index + 1}`,
    severity: normalizeSeverity(blocker?.severity),
    issue: String(blocker?.issue || '').trim(),
    evidence: String(blocker?.evidence || '').trim(),
    fix: String(blocker?.fix || '').trim()
  }));
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function normalizeReviewOutput(rawOutput) {
  const parsed = tryParseJson(rawOutput);
  if (!parsed || typeof parsed !== 'object') {
    return {
      verdict: 'revise',
      summary: String(rawOutput || '').slice(0, 1200).trim(),
      blockers: [],
      risks: [],
      testGaps: [],
      parser: 'fallback-text'
    };
  }

  return {
    verdict: normalizeVerdict(parsed.verdict),
    summary: String(parsed.summary || '').trim(),
    blockers: normalizeBlockers(parsed.blockers),
    risks: normalizeStringList(parsed.risks),
    testGaps: normalizeStringList(parsed.testGaps),
    parser: 'json'
  };
}

function stringifyForPrompt(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function buildPlanReviewMessage(input) {
  return [
    'Review this implementation plan and return ONLY valid JSON.',
    'Required JSON shape:',
    '{',
    '  "verdict": "approve|revise|reject",',
    '  "summary": "short rationale",',
    '  "blockers": [{"id":"B1","severity":"low|medium|high|critical","issue":"...","evidence":"...","fix":"..."}],',
    '  "risks": ["..."],',
    '  "testGaps": ["..."]',
    '}',
    '',
    'Plan:',
    input.plan,
    '',
    'Context:',
    input.context || '(none)'
  ].join('\n');
}

function buildPrReviewMessage(input) {
  return [
    'Review this PR context and return ONLY valid JSON.',
    'Required JSON shape:',
    '{',
    '  "verdict": "approve|revise|reject",',
    '  "summary": "short rationale",',
    '  "blockers": [{"id":"B1","severity":"low|medium|high|critical","issue":"...","evidence":"...","fix":"..."}],',
    '  "risks": ["..."],',
    '  "testGaps": ["..."]',
    '}',
    '',
    'PR summary:',
    input.summary || '(none)',
    '',
    'Diff:',
    input.diff || '(none)',
    '',
    'Test results:',
    input.testResults || '(none)',
    '',
    'Additional context:',
    input.context || '(none)'
  ].join('\n');
}

function buildJudgeMessage(kind, originalMessage, reviewerResults) {
  const sections = reviewerResults.map((result, index) => [
    `Reviewer ${index + 1}`,
    `Name: ${result.name}`,
    `Adapter: ${result.adapter}`,
    'Structured output:',
    stringifyForPrompt(result.structured)
  ].join('\n'));

  return [
    `You are the final judge for a ${kind} workflow.`,
    'Return ONLY valid JSON in this shape:',
    '{',
    '  "verdict": "approve|revise|reject",',
    '  "summary": "short rationale",',
    '  "blockers": [{"id":"B1","severity":"low|medium|high|critical","issue":"...","evidence":"...","fix":"..."}],',
    '  "risks": ["..."],',
    '  "testGaps": ["..."]',
    '}',
    '',
    'Original task:',
    originalMessage,
    '',
    'Reviewer outputs:',
    sections.join('\n\n')
  ].join('\n');
}

function normalizeParticipant(spec, fallback, options) {
  const source = spec || {};
  const base = fallback || {};

  return {
    name: source.name || base.name,
    adapter: source.adapter || base.adapter,
    systemPrompt: source.systemPrompt || base.systemPrompt,
    model: source.model || base.model,
    timeout: source.timeout || options.timeout || null,
    workDir: source.workDir || options.workDir || null,
    jsonMode: source.jsonMode !== undefined ? source.jsonMode : true,
    jsonSchema: source.jsonSchema || null
  };
}

function resolveParticipants(customParticipants, defaults, options) {
  if (!Array.isArray(customParticipants) || customParticipants.length === 0) {
    return defaults.map((entry) => normalizeParticipant(entry, null, options));
  }

  return customParticipants.map((entry, index) => normalizeParticipant(entry, defaults[index], options));
}

function aggregateVerdict(reviewers) {
  const verdicts = reviewers.map((item) => normalizeVerdict(item?.structured?.verdict));
  if (verdicts.includes('reject')) {
    return 'reject';
  }
  if (verdicts.includes('revise')) {
    return 'revise';
  }
  return 'approve';
}

function buildFallbackDecisionSummary(reviewers, finalVerdict) {
  const reviewerSummaries = reviewers
    .map((reviewer) => reviewer?.structured?.summary)
    .filter(Boolean)
    .join(' | ');

  return summarizeText(`${finalVerdict}: ${reviewerSummaries}`);
}

async function runParticipant(sessionManager, participant, message, options = {}) {
  const sessionId = `review-${crypto.randomBytes(6).toString('hex')}`;
  const startedAt = Date.now();
  const ledger = options.runLedger || null;
  const runId = options.runId || null;
  const participantId = options.participantId || null;
  const outputKind = options.role === 'judge' ? 'judge_final' : 'participant_final';
  const stepId = ledger && participantId && runId
    ? ledger.appendStep({
        runId,
        participantId,
        stepKey: `${options.role || 'reviewer'}-execution`,
        stepName: `${options.role || 'reviewer'} execution`,
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
        role: options.role || 'reviewer',
        adapter: participant.adapter,
        systemPrompt: participant.systemPrompt || null,
        model: participant.model || null,
        workDir: participant.workDir || options.workDir || null,
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
        sessionId: options.controlSessionId || participantId || sessionId,
        sessionKind: options.role === 'judge' ? 'judge' : 'reviewer',
        role: options.role || 'reviewer',
        name: participant.name || participant.adapter,
        adapter: participant.adapter,
        model: participant.model || null,
        workDir: participant.workDir || options.workDir || null,
        stableStepKey: `${options.role || 'reviewer'}-session-start`,
        payloadSummary: `${participant.name || participant.adapter} session started`,
        occurredAt: startedAt
      });
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || sessionId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: 'delegation_started',
        stableStepKey: `${options.role || 'reviewer'}-delegation-start`,
        payloadSummary: `${participant.name || participant.adapter} started ${options.role || 'reviewer'} execution`,
        payloadJson: {
          adapter: participant.adapter,
          role: options.role || 'reviewer',
          model: participant.model || null,
          workDir: participant.workDir || options.workDir || null
        },
        occurredAt: startedAt
      });
    }

    session = await sessionManager.createSession({
      adapter: participant.adapter,
      sessionId,
      systemPrompt: participant.systemPrompt,
      workDir: participant.workDir || options.workDir,
      model: participant.model,
      jsonMode: participant.jsonMode,
      jsonSchema: participant.jsonSchema
    });

    const timeoutMs = Number(participant.timeout || options.timeout || 0);
    const sendPromise = sessionManager.send(session.sessionId, message, {
      timeout: timeoutMs
    });
    const response = timeoutMs > 0
      ? await Promise.race([
          sendPromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              void (async () => {
                try {
                  await sessionManager.interruptSession?.(session.sessionId);
                } catch {}
                try {
                  await sessionManager.terminateSession?.(session.sessionId);
                } catch {}
              })();
              reject(new Error(`participant timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          })
        ])
      : await sendPromise;

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    const output = response.result;
    const structured = normalizeReviewOutput(output);
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
        content: output,
        metadata: {
          structured,
          responseMetadata: response.metadata || {}
        }
      });
    }

    if (options.eventRecorder?.enabled) {
      options.eventRecorder.recordEvent({
        sessionId: options.controlSessionId || participantId || sessionId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: options.role === 'judge' ? 'judge_completed' : 'delegation_completed',
        stableStepKey: `${options.role || 'reviewer'}-delegation-completed`,
        payloadSummary: `${participant.name || participant.adapter} completed ${options.role || 'reviewer'} execution`,
        payloadJson: {
          adapter: participant.adapter,
          role: options.role || 'reviewer',
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
      output,
      structured,
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
        sessionId: options.controlSessionId || participantId || sessionId,
        parentSessionId: options.eventRecorder.workflowSessionId,
        eventType: options.role === 'judge' ? 'judge_completed' : 'delegation_completed',
        stableStepKey: `${options.role || 'reviewer'}-delegation-completed`,
        payloadSummary: `${participant.name || participant.adapter} failed ${options.role || 'reviewer'} execution`,
        payloadJson: {
          adapter: participant.adapter,
          role: options.role || 'reviewer',
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

async function runReviewProtocol(sessionManager, protocol, payload, options = {}) {
  const originalMessage = protocol.messageBuilder(payload);
  const reviewers = resolveParticipants(payload.reviewers, protocol.defaultReviewers, options);
  const judgeSpec = payload.judge === false
    ? null
    : normalizeParticipant(payload.judge, protocol.defaultJudge, options);
  const startedAt = Date.now();
  const runLedger = options.runLedger || null;
  const runId = runLedger
    ? runLedger.createRun({
        kind: protocol.name,
        status: 'pending',
        hashInput: {
          ...payload,
          participants: reviewers,
          judge: judgeSpec,
          timeout: options.timeout,
          workingDirectory: options.workDir
        },
        inputSummary: summarizeText(originalMessage),
        workingDirectory: options.workDir || null,
        initiator: `orchestration/${protocol.name}`,
        metadata: {
          reviewerCount: reviewers.length,
          hasJudge: Boolean(judgeSpec)
        },
        startedAt
      })
    : null;
  const workflowSessionId = runId || `${protocol.name}-${crypto.randomBytes(8).toString('hex')}`;
  const eventRecorder = createSessionEventRecorder({
    db: options.db || null,
    enabled: options.sessionEventsEnabled,
    workflowKind: 'workflow',
    workflowSessionId,
    rootSessionId: options.rootSessionId || workflowSessionId,
    parentSessionId: options.parentSessionId || null,
    originClient: options.originClient || 'system',
    externalSessionRef: options.externalSessionRef || null,
    sessionMetadata: options.sessionMetadata || null,
    runId
  });

  eventRecorder.recordWorkflowStarted({
    payloadSummary: `${protocol.name} started`,
    payloadJson: {
      protocol: protocol.name,
      reviewerCount: reviewers.length,
      hasJudge: Boolean(judgeSpec),
      workDir: options.workDir || null
    },
    occurredAt: startedAt
  });

  if (runLedger && runId) {
    runLedger.appendInput({
      runId,
      inputKind: 'run_message',
      content: originalMessage,
      metadata: {
        protocol: protocol.name,
        reviewerCount: reviewers.length,
        judgeConfigured: Boolean(judgeSpec),
        timeout: options.timeout || null,
        workDir: options.workDir || null
      },
      createdAt: startedAt
    });
  }

  const reviewerSpecs = reviewers.map((reviewer) => ({
    ...reviewer,
    __controlSessionId: null,
    __participantId: runLedger && runId
      ? runLedger.addParticipant({
          runId,
          participantRole: 'reviewer',
          participantName: reviewer.name || reviewer.adapter,
          adapter: reviewer.adapter,
          agentProfile: reviewer.model || null,
          status: 'queued',
          metadata: {
            model: reviewer.model || null,
            workDir: reviewer.workDir || options.workDir || null
          }
        })
      : null
  }));

  for (const reviewer of reviewerSpecs) {
    reviewer.__controlSessionId = reviewer.__participantId || `${workflowSessionId}:${reviewer.name || reviewer.adapter}`;
  }

  if (runLedger && runId) {
    runLedger.updateRun(runId, {
      status: 'running',
      currentStep: 'reviewers',
      activeParticipantCount: reviewerSpecs.length,
      lastHeartbeatAt: startedAt
    });
  }

  const reviewerRuns = await Promise.all(
    reviewerSpecs.map((reviewer) => runParticipant(sessionManager, reviewer, originalMessage, {
      ...options,
      runLedger,
      runId,
      role: 'reviewer',
      participantId: reviewer.__participantId,
      controlSessionId: reviewer.__controlSessionId,
      eventRecorder
    }))
  );

  const successfulReviewers = reviewerRuns.filter((entry) => entry.success);
  const failedReviewers = reviewerRuns.filter((entry) => !entry.success);
  if (successfulReviewers.length === 0) {
    const completedAt = Date.now();

    if (runLedger && runId) {
      runLedger.updateRun(runId, {
        status: 'failed',
        currentStep: 'finalized',
        activeParticipantCount: 0,
        failureClass: reviewerRuns[0]?.failureClass || 'unknown',
        completedAt,
        durationMs: completedAt - startedAt,
      metadata: {
        reviewerCount: reviewerRuns.length,
        successCount: 0
      }
    });
    }

    eventRecorder.recordEvent({
      sessionId: workflowSessionId,
      parentSessionId: eventRecorder.parentSessionId,
      eventType: 'consensus_recorded',
      stableStepKey: 'review-finalized',
      payloadSummary: `${protocol.name} failed`,
      payloadJson: {
        protocol: protocol.name,
        status: 'failed',
        reviewerCount: reviewerRuns.length,
        successCount: 0
      },
      occurredAt: completedAt
    });

    return {
      success: false,
      mode: 'direct-session',
      protocol: protocol.name,
      reviewerCount: reviewerRuns.length,
      successCount: 0,
      reviewers: reviewerRuns,
      judge: null,
      decision: null,
      runId
    };
  }

  let judge = null;
  if (judgeSpec) {
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
            workDir: judgeSpec.workDir || options.workDir || null
          }
        })
      : null;
    judgeSpec.__controlSessionId = judgeParticipantId || `${workflowSessionId}:${judgeSpec.name || judgeSpec.adapter}`;

    if (runLedger && runId) {
      runLedger.updateRun(runId, {
        currentStep: 'judge',
        activeParticipantCount: 1,
        lastHeartbeatAt: Date.now()
      });
    }

    const judgePrompt = buildJudgeMessage(protocol.name, originalMessage, successfulReviewers);
    judge = await runParticipant(sessionManager, judgeSpec, judgePrompt, {
      ...options,
      runLedger,
      runId,
      role: 'judge',
      participantId: judgeParticipantId,
      controlSessionId: judgeSpec.__controlSessionId,
      eventRecorder
    });
  }

  const finalVerdict = judge?.success
    ? normalizeVerdict(judge.structured?.verdict)
    : aggregateVerdict(successfulReviewers);
  const completedAt = Date.now();
  const hasReviewerFailures = failedReviewers.length > 0;
  const judgeFailed = Boolean(judgeSpec && judge && !judge.success);
  const decisionSource = judge?.success ? 'judge' : 'aggregated-reviewers';
  const decisionSummary = judge?.success
    ? summarizeText(judge.structured?.summary || judge.output)
    : buildFallbackDecisionSummary(successfulReviewers, finalVerdict);

  if (runLedger && runId) {
    runLedger.updateRun(runId, {
      status: hasReviewerFailures || judgeFailed ? 'partial' : 'completed',
      currentStep: 'finalized',
      activeParticipantCount: 0,
      decisionSummary,
      decisionSource,
      failureClass: judgeFailed
        ? (judge.failureClass || 'unknown')
        : (hasReviewerFailures ? failedReviewers[0]?.failureClass || 'unknown' : null),
      completedAt,
      durationMs: completedAt - startedAt,
      metadata: {
        reviewerCount: reviewerRuns.length,
        successCount: successfulReviewers.length,
        failedReviewerCount: failedReviewers.length,
        reviewerFailures: failedReviewers.map((entry) => ({
          name: entry.name,
          adapter: entry.adapter,
          failureClass: entry.failureClass || 'unknown',
          error: entry.error || null
        })),
        judgeConfigured: Boolean(judgeSpec),
        judgeSuccess: judgeSpec ? Boolean(judge?.success) : null,
        finalVerdict
      }
    });
  }

  eventRecorder.recordEvent({
    sessionId: workflowSessionId,
    parentSessionId: eventRecorder.parentSessionId,
    eventType: 'consensus_recorded',
    stableStepKey: 'review-finalized',
    payloadSummary: `${protocol.name} ${hasReviewerFailures || judgeFailed ? 'partial' : 'completed'} (${finalVerdict})`,
    payloadJson: {
      protocol: protocol.name,
      status: hasReviewerFailures || judgeFailed ? 'partial' : 'completed',
      verdict: finalVerdict,
      decisionSource,
      reviewerCount: reviewerRuns.length,
      successCount: successfulReviewers.length,
      failedReviewerCount: failedReviewers.length,
      judgeSuccess: judgeSpec ? Boolean(judge?.success) : null
    },
    occurredAt: completedAt
  });

  return {
    success: true,
    mode: 'direct-session',
    protocol: protocol.name,
    reviewerCount: reviewerRuns.length,
    successCount: successfulReviewers.length,
    reviewers: reviewerRuns,
    judge,
    decision: {
      verdict: finalVerdict,
      source: decisionSource
    },
    runId
  };
}

async function runPlanReview(sessionManager, payload = {}, options = {}) {
  if (!payload.plan || typeof payload.plan !== 'string') {
    throw new Error('plan is required');
  }

  return runReviewProtocol(sessionManager, {
    name: 'plan-review',
    messageBuilder: buildPlanReviewMessage,
    defaultReviewers: DEFAULT_PLAN_REVIEWERS,
    defaultJudge: DEFAULT_PLAN_JUDGE
  }, payload, options);
}

async function runPrReview(sessionManager, payload = {}, options = {}) {
  const hasSummary = typeof payload.summary === 'string' && payload.summary.trim().length > 0;
  const hasDiff = typeof payload.diff === 'string' && payload.diff.trim().length > 0;

  if (!hasSummary && !hasDiff) {
    throw new Error('summary or diff is required');
  }

  return runReviewProtocol(sessionManager, {
    name: 'pr-review',
    messageBuilder: buildPrReviewMessage,
    defaultReviewers: DEFAULT_PR_REVIEWERS,
    defaultJudge: DEFAULT_PR_JUDGE
  }, payload, options);
}

module.exports = {
  runPlanReview,
  runPrReview
};
