#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { INPUT_POLICY, RunLedgerService } = require('../src/orchestration/run-ledger');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run() {
  const rootDir = makeTempDir('cliagents-run-ledger-service-');
  const dbPath = path.join(rootDir, 'cliagents.db');
  const db = new OrchestrationDB({ dbPath, dataDir: rootDir });
  const ledger = new RunLedgerService(db);

  try {
    const hashA = ledger.computeMessageHash('plan-review', {
      plan: 'Step 1\r\nStep 2   ',
      context: 'Context line\r\n',
      participants: [
        { adapter: 'codex-cli', name: 'correctness', timeout: 45000 },
        { adapter: 'gemini-cli', name: 'risk', timeout: 45000 }
      ],
      judge: { adapter: 'qwen-cli', name: 'judge', timeout: 45000 },
      timeout: 45000,
      workingDirectory: '/tmp/project'
    });

    const hashB = ledger.computeMessageHash('plan-review', {
      workingDirectory: '/tmp/project',
      timeout: 45000,
      judge: { timeout: 45000, name: 'judge', adapter: 'qwen-cli' },
      participants: [
        { name: 'correctness', timeout: 45000, adapter: 'codex-cli' },
        { timeout: 45000, adapter: 'gemini-cli', name: 'risk' }
      ],
      context: 'Context line\n',
      plan: 'Step 1\nStep 2'
    });

    const hashDifferentOrder = ledger.computeMessageHash('plan-review', {
      plan: 'Step 1\nStep 2',
      context: 'Context line\n',
      participants: [
        { adapter: 'gemini-cli', name: 'risk', timeout: 45000 },
        { adapter: 'codex-cli', name: 'correctness', timeout: 45000 }
      ],
      judge: { adapter: 'qwen-cli', name: 'judge', timeout: 45000 },
      timeout: 45000,
      workingDirectory: '/tmp/project'
    });

    assert.strictEqual(hashA, hashB, 'Hash should ignore key order and trailing whitespace differences');
    assert.notStrictEqual(hashA, hashDifferentOrder, 'Hash should preserve participant array ordering');

    const inlinePayload = ledger.prepareOutput('short answer');
    assert.strictEqual(inlinePayload.storageMode, 'inline_text');
    assert.strictEqual(inlinePayload.compression, 'none');
    assert.strictEqual(inlinePayload.isTruncated, 0);

    const inlineInputPayload = ledger.prepareInput('participant prompt');
    assert.strictEqual(inlineInputPayload.storageMode, 'inline_text');
    assert.strictEqual(inlineInputPayload.originalBytes, Buffer.byteLength('participant prompt', 'utf8'));
    assert.strictEqual(INPUT_POLICY.previewBytes, 16 * 1024);

    const redactedPayload = ledger.prepareOutput('Authorization: Bearer sk-test-KD38-REDACTME-12345678901234567890');
    assert(redactedPayload.previewText.includes('[REDACTED_SECRET]'));
    assert(!redactedPayload.previewText.includes('KD38-REDACTME'));

    const compressedPayload = ledger.prepareOutput('A'.repeat(80 * 1024));
    assert.strictEqual(compressedPayload.storageMode, 'compressed');
    assert.strictEqual(compressedPayload.compression, 'gzip');
    assert.strictEqual(compressedPayload.isTruncated, 0);

    const previewOnlyPayload = ledger.prepareToolEventPayload(
      crypto.randomBytes(160 * 1024).toString('hex')
    );
    assert.strictEqual(previewOnlyPayload.storageMode, 'preview_only');
    assert.strictEqual(previewOnlyPayload.isTruncated, 1);

    const runId = ledger.createRun({
      kind: 'consensus',
      status: 'pending',
      hashInput: {
        message: 'What is 2 + 2?',
        participants: [
          { adapter: 'codex-cli', name: 'codex' },
          { adapter: 'gemini-cli', name: 'gemini' }
        ],
        judge: { adapter: 'qwen-cli', name: 'judge' },
        timeout: 30000,
        workingDirectory: '/tmp/project'
      },
      inputSummary: 'What is 2 + 2?',
      workingDirectory: '/tmp/project',
      initiator: 'test-suite',
      rootSessionId: 'root-run-ledger-service',
      metadata: { source: 'unit-test' }
    });

    const participantId = ledger.addParticipant({
      runId,
      participantRole: 'reviewer',
      participantName: 'codex',
      adapter: 'codex-cli',
      status: 'running',
      startedAt: Date.now()
    });

    const stepId = ledger.appendStep({
      runId,
      participantId,
      stepKey: 'participant-start',
      stepName: 'participant start',
      status: 'completed',
      retrySafe: true,
      completedAt: Date.now(),
      metadata: { phase: 'initial' }
    });

    const inputBaseTime = Date.now();

    ledger.appendInput({
      runId,
      inputKind: 'run_message',
      content: 'What is 2 + 2?',
      metadata: { scope: 'run' },
      createdAt: inputBaseTime
    });

    ledger.appendInput({
      runId,
      participantId,
      inputKind: 'participant_prompt',
      content: 'What is 2 + 2? Reply with just the number. paperclip_api_key=sk-test-KD38-INPUT-SECRET-123456789',
      metadata: {
        systemPrompt: 'Return concise answers.',
        apiKey: 'sk-test-KD38-META-INPUT-SECRET-123456789'
      },
      createdAt: inputBaseTime + 1
    });

    ledger.appendOutput({
      runId,
      participantId,
      outputKind: 'participant_final',
      content: '4\nopenai_api_key=sk-test-KD38-OUTPUT-SECRET-123456789',
      metadata: {
        adapter: 'codex-cli',
        accessToken: 'token-should-not-persist'
      }
    });

    const toolEventId = ledger.appendToolEvent({
      runId,
      participantId,
      stepId,
      toolClass: 'cli',
      toolName: 'codex exec',
      idempotency: 'idempotent',
      status: 'completed',
      content: crypto.randomBytes(160 * 1024).toString('hex'),
      metadata: { command: 'codex exec ...' }
    });

    ledger.updateParticipant(participantId, {
      status: 'completed',
      currentStep: 'done',
      endedAt: Date.now()
    });

    ledger.updateRun(runId, {
      status: 'completed',
      currentStep: 'finalized',
      activeParticipantCount: 0,
      decisionSummary: 'Consensus reached: 4',
      decisionSource: 'judge',
      completedAt: Date.now(),
      durationMs: 1234
    });

    const listedRuns = ledger.listRuns({ kind: 'consensus', adapter: 'codex-cli' });
    assert.strictEqual(listedRuns.length, 1, 'Run list should return the newly created run');
    assert.strictEqual(listedRuns[0].id, runId);

    const detail = ledger.getRunDetail(runId);
    assert(detail, 'Run detail should exist');
    assert.strictEqual(detail.run.status, 'completed');
    assert.strictEqual(detail.participants.length, 1);
    assert.strictEqual(detail.steps.length, 1);
    assert.strictEqual(detail.inputs.length, 2);
    assert.strictEqual(detail.inputs[0].inputKind, 'run_message');
    assert.strictEqual(detail.inputs[1].inputKind, 'participant_prompt');
    assert.strictEqual(detail.inputs[1].metadata.systemPrompt, 'Return concise answers.');
    assert.strictEqual(detail.inputs[1].metadata.apiKey, '[REDACTED_SECRET]');
    assert(detail.inputs[1].previewText.includes('[REDACTED_SECRET]'));
    assert(!detail.inputs[1].previewText.includes('KD38-INPUT-SECRET'));
    assert.strictEqual(detail.outputs.length, 1);
    assert.strictEqual(detail.outputs[0].storageMode, 'inline_text');
    assert.strictEqual(detail.outputs[0].metadata.accessToken, '[REDACTED_SECRET]');
    assert(detail.outputs[0].previewText.includes('[REDACTED_SECRET]'));
    assert(!detail.outputs[0].previewText.includes('KD38-OUTPUT-SECRET'));
    assert.strictEqual(detail.toolEvents.length, 1);
    assert.strictEqual(detail.toolEvents[0].storageMode, 'preview_only');
    assert.strictEqual(detail.toolEvents[0].toolClass, 'cli');
    const rootToolEvents = db.listRootIoEvents({
      rootSessionId: 'root-run-ledger-service',
      eventKind: 'tool_event',
      limit: 10
    });
    assert.strictEqual(rootToolEvents.length, 1);
    assert.strictEqual(rootToolEvents[0].metadata.sourceTable, 'run_tool_events');
    assert.strictEqual(rootToolEvents[0].metadata.toolEventId, toolEventId);
    assert.strictEqual(rootToolEvents[0].metadata.toolName, 'codex exec');

    const staleNow = Date.now();

    const stalePartialRunId = ledger.createRun({
      kind: 'plan-review',
      status: 'running',
      currentStep: 'judge',
      activeParticipantCount: 1,
      inputSummary: 'Review the broker plan.',
      workingDirectory: '/tmp/project',
      startedAt: staleNow - 120000,
      lastHeartbeatAt: staleNow - 120000
    });

    const staleReviewerId = ledger.addParticipant({
      runId: stalePartialRunId,
      participantRole: 'reviewer',
      participantName: 'codex-reviewer',
      adapter: 'codex-cli',
      status: 'completed',
      startedAt: staleNow - 120000,
      endedAt: staleNow - 90000
    });

    const staleJudgeId = ledger.addParticipant({
      runId: stalePartialRunId,
      participantRole: 'judge',
      participantName: 'judge',
      adapter: 'codex-cli',
      status: 'running',
      currentStep: 'judge',
      startedAt: staleNow - 120000,
      lastHeartbeatAt: staleNow - 120000
    });

    ledger.appendOutput({
      runId: stalePartialRunId,
      participantId: staleReviewerId,
      outputKind: 'participant_final',
      content: 'Reviewer output survived.',
      createdAt: staleNow - 95000
    });

    const staleJudgeStepId = ledger.appendStep({
      runId: stalePartialRunId,
      participantId: staleJudgeId,
      stepKey: 'judge',
      stepName: 'judge',
      status: 'running',
      startedAt: staleNow - 120000,
      lastHeartbeatAt: staleNow - 120000
    });

    ledger.appendToolEvent({
      runId: stalePartialRunId,
      participantId: staleJudgeId,
      stepId: staleJudgeStepId,
      toolClass: 'cli',
      toolName: 'codex exec',
      idempotency: 'idempotent',
      status: 'running',
      content: 'judge still running',
      startedAt: staleNow - 120000,
      metadata: { phase: 'judge' }
    });

    const staleAbandonedRunId = ledger.createRun({
      kind: 'discussion',
      status: 'running',
      currentStep: 'round-1',
      activeParticipantCount: 1,
      inputSummary: 'Debate the routing policy.',
      startedAt: staleNow - 180000,
      lastHeartbeatAt: staleNow - 180000
    });

    const staleParticipantId = ledger.addParticipant({
      runId: staleAbandonedRunId,
      participantRole: 'participant',
      participantName: 'qwen',
      adapter: 'qwen-cli',
      status: 'running',
      currentStep: 'round-1',
      startedAt: staleNow - 180000,
      lastHeartbeatAt: staleNow - 180000
    });

    const staleParticipantStepId = ledger.appendStep({
      runId: staleAbandonedRunId,
      participantId: staleParticipantId,
      stepKey: 'round-1',
      stepName: 'round-1',
      status: 'running',
      startedAt: staleNow - 180000,
      lastHeartbeatAt: staleNow - 180000
    });

    ledger.appendToolEvent({
      runId: staleAbandonedRunId,
      participantId: staleParticipantId,
      stepId: staleParticipantStepId,
      toolClass: 'cli',
      toolName: 'qwen run',
      idempotency: 'side_effectful',
      status: 'running',
      content: 'participant still running',
      startedAt: staleNow - 180000,
      metadata: { phase: 'participant' }
    });

    const staleRuns = ledger.findStaleRuns({ now: staleNow, staleMs: 30000, limit: 10 });
    assert(staleRuns.some((run) => run.id === stalePartialRunId), 'findStaleRuns should include stale judge runs');
    assert(staleRuns.some((run) => run.id === staleAbandonedRunId), 'findStaleRuns should include stale runs without outputs');

    const reconciliation = ledger.reconcileStaleRuns({ now: staleNow, staleMs: 30000, limit: 10 });
    assert.strictEqual(reconciliation.reconciledCount, 2, 'reconcileStaleRuns should reconcile both stale runs');

    const partialRecovered = ledger.getRunDetail(stalePartialRunId);
    assert.strictEqual(partialRecovered.run.status, 'partial');
    assert.strictEqual(partialRecovered.run.failureClass, 'timeout');
    assert.strictEqual(partialRecovered.run.decisionSource, 'recovery');
    assert.strictEqual(partialRecovered.run.activeParticipantCount, 0);
    assert.strictEqual(partialRecovered.participants.find((participant) => participant.id === staleJudgeId).status, 'abandoned');
    assert.strictEqual(partialRecovered.steps.find((step) => step.id === staleJudgeStepId).status, 'abandoned');
    assert.strictEqual(partialRecovered.toolEvents.find((event) => event.stepId === staleJudgeStepId).status, 'abandoned');
    assert(
      partialRecovered.outputs.some((output) => output.outputKind === 'participant_error'),
      'reconciliation should append a participant_error output for abandoned participants'
    );

    const abandonedRecovered = ledger.getRunDetail(staleAbandonedRunId);
    assert.strictEqual(abandonedRecovered.run.status, 'abandoned');
    assert.strictEqual(abandonedRecovered.run.failureClass, 'timeout');
    assert.strictEqual(abandonedRecovered.run.decisionSource, null);
    assert.strictEqual(abandonedRecovered.run.activeParticipantCount, 0);
    assert.strictEqual(abandonedRecovered.participants.find((participant) => participant.id === staleParticipantId).status, 'abandoned');
    assert.strictEqual(abandonedRecovered.steps.find((step) => step.id === staleParticipantStepId).status, 'abandoned');
    assert.strictEqual(abandonedRecovered.toolEvents.find((event) => event.stepId === staleParticipantStepId).status, 'abandoned');

    console.log('✅ Run-ledger service hash, payload, and CRUD flows behave as expected');
  } finally {
    db.close();
  }
}

try {
  run();
  console.log('\nRun-ledger service tests passed');
} catch (error) {
  console.error('\nRun-ledger service tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
