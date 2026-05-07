#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { createOrchestrationRouter } = require('../src/server/orchestration-router');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', createOrchestrationRouter(context));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function stopServer(serverHandle) {
  if (!serverHandle?.server) {
    return;
  }

  await new Promise((resolve, reject) => {
    serverHandle.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function request(baseUrl, method, route, body = null, headers = {}, timeoutMs = 30000) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

function createDirectSessionManager(options = {}) {
  const sessions = new Map();
  const createCalls = [];
  let counter = 0;
  const providerResolver = typeof options.providerResolver === 'function'
    ? options.providerResolver
    : ((input) => input.providerSessionId || `${input.adapter || 'agent'}-provider-${counter}`);

  return {
    createCalls,
    async createSession(input = {}) {
      counter += 1;
      const sessionId = `direct-${counter}`;
      const providerSessionId = providerResolver({
        ...input,
        counter
      });
      createCalls.push({
        ...input,
        sessionId,
        effectiveProviderSessionId: providerSessionId
      });
      sessions.set(sessionId, {
        sessionId,
        adapter: input.adapter || 'unknown',
        providerSessionId,
        model: input.model || null
      });
      return { sessionId };
    },
    async send(sessionId, message) {
      const session = sessions.get(sessionId);
      assert(session, `missing direct session ${sessionId}`);
      return {
        result: `${session.adapter} reply: ${String(message || '').slice(0, 120)}`,
        metadata: {
          adapter: session.adapter,
          providerSessionId: session.providerSessionId,
          model: session.model || null
        }
      };
    },
    async terminateSession(sessionId) {
      sessions.delete(sessionId);
    },
    getSession(sessionId) {
      return sessions.get(sessionId) || null;
    }
  };
}

function createRecordingDiscussionRunner() {
  const invocations = [];
  let callCount = 0;
  const persistedProviderSessions = new Map();

  async function runDiscussion(_sessionManager, message, options = {}) {
    callCount += 1;
    invocations.push({
      callCount,
      message,
      options: deepClone({
        participants: options.participants || [],
        rounds: options.rounds || [],
        judge: options.judge,
        timeout: options.timeout || null,
        context: options.context || '',
        rootSessionId: options.rootSessionId || null,
        taskId: options.taskId || null
      })
    });

    const rounds = Array.isArray(options.rounds) && options.rounds.length > 0
      ? options.rounds
      : [{ name: 'position' }];
    const participants = (options.participants || []).map((participant) => {
      const canonicalProviderSessionId = persistedProviderSessions.get(participant.participantRef)
        || participant.providerSessionId
        || `${participant.adapter}-discussion-provider-${participant.participantRef}`;
      persistedProviderSessions.set(participant.participantRef, canonicalProviderSessionId);
      return {
        participantRef: participant.participantRef,
        name: participant.name,
        adapter: participant.adapter,
        success: true,
        output: `${participant.name} recommends continuing ${message.slice(0, 80)}`,
        providerSessionId: canonicalProviderSessionId
      };
    });

    return {
      runId: `run-${callCount}`,
      discussionId: `discussion-result-${callCount}`,
      participants,
      rounds: rounds.map((round) => ({
        name: round.name || `round-${callCount}`,
        responses: participants.map((participant) => ({
          name: participant.name,
          adapter: participant.adapter,
          success: true,
          output: `${participant.name} response for ${round.name || 'round'}`
        }))
      })),
      judge: null
    };
  }

  return {
    invocations,
    runDiscussion
  };
}

async function openRoomApp({ dbPath, dataDir, sessionManager, roomDiscussionRunner }) {
  const db = new OrchestrationDB({
    dbPath,
    dataDir
  });
  const sessionManagerStub = {
    async createTerminal() {
      throw new Error('tmux terminal creation is not used in room continuity tests');
    },
    async sendInput() {
      throw new Error('tmux input is not used in room continuity tests');
    }
  };
  const serverHandle = await startApp({
    db,
    sessionManager: sessionManagerStub,
    apiSessionManager: sessionManager,
    roomDiscussionRunner
  });

  return {
    db,
    sessionManager,
    serverHandle,
    baseUrl: serverHandle.baseUrl
  };
}

async function closeRoomApp(app) {
  if (!app) {
    return;
  }
  await stopServer(app.serverHandle);
  app.db.close();
}

function participantMapByAdapter(participants = []) {
  return new Map(participants.map((participant) => [participant.adapter, participant]));
}

async function createRoom(baseUrl, body) {
  const response = await request(baseUrl, 'POST', '/orchestration/rooms', body);
  assert.strictEqual(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

async function sendRoomMessage(baseUrl, roomId, body) {
  const response = await request(baseUrl, 'POST', `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`, body);
  assert.strictEqual(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

async function discussRoom(baseUrl, roomId, body) {
  const response = await request(baseUrl, 'POST', `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`, body, {}, 120000);
  assert.strictEqual(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

async function testRoomSendContinuity() {
  const dataDir = makeTempDir('cliagents-room-send-continuity-');
  const dbPath = path.join(dataDir, 'cliagents.db');
  const managerA = createDirectSessionManager();
  let appA = await openRoomApp({
    dbPath,
    dataDir,
    sessionManager: managerA
  });
  let appB = null;

  try {
    const room = await createRoom(appA.baseUrl, {
      title: 'Continuity room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex continuity' },
        { adapter: 'claude-code', displayName: 'Claude continuity' }
      ]
    });
    const roomId = room.room.id;

    const firstTurn = await sendRoomMessage(appA.baseUrl, roomId, {
      content: 'First turn before restart.',
      requestId: 'turn-1'
    });
    assert.strictEqual(firstTurn.turn.status, 'completed');

    const firstParticipants = participantMapByAdapter(appA.db.listRoomParticipants(roomId));
    const codexProviderSessionId = firstParticipants.get('codex-cli')?.providerSessionId;
    const claudeProviderSessionId = firstParticipants.get('claude-code')?.providerSessionId;
    assert(codexProviderSessionId, 'expected Codex providerSessionId after first turn');
    assert(claudeProviderSessionId, 'expected Claude providerSessionId after first turn');
    assert.strictEqual(managerA.createCalls.length, 2);
    assert.strictEqual(managerA.createCalls.find((call) => call.adapter === 'codex-cli')?.providerSessionId, null);
    assert.strictEqual(managerA.createCalls.find((call) => call.adapter === 'claude-code')?.providerSessionId, null);

    await closeRoomApp(appA);
    appA = null;

    const managerB = createDirectSessionManager();
    appB = await openRoomApp({
      dbPath,
      dataDir,
      sessionManager: managerB
    });
    const secondTurn = await sendRoomMessage(appB.baseUrl, roomId, {
      content: 'Second turn after restart.',
      requestId: 'turn-2'
    });
    assert.strictEqual(secondTurn.turn.status, 'completed');
    assert.strictEqual(
      managerB.createCalls.find((call) => call.adapter === 'codex-cli')?.providerSessionId,
      codexProviderSessionId
    );
    assert.strictEqual(
      managerB.createCalls.find((call) => call.adapter === 'claude-code')?.providerSessionId,
      claudeProviderSessionId
    );

    const roomMessages = await request(appB.baseUrl, 'GET', `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=20`);
    assert.strictEqual(roomMessages.status, 200);
    assert(roomMessages.data.messages.length >= 6, 'expected durable room transcript after restart');
  } finally {
    await closeRoomApp(appB);
    await closeRoomApp(appA);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testImportedSeedContinuity() {
  const dataDir = makeTempDir('cliagents-room-imported-seed-');
  const dbPath = path.join(dataDir, 'cliagents.db');
  const importedSeed = 'import-seed-123';
  const canonicalProviderSessionId = 'codex-canonical-from-import';
  const providerResolver = (input) => {
    if (input.providerSessionId === importedSeed) {
      return canonicalProviderSessionId;
    }
    return input.providerSessionId || `${input.adapter}-provider-${input.counter}`;
  };

  const managerA = createDirectSessionManager({ providerResolver });
  let appA = await openRoomApp({
    dbPath,
    dataDir,
    sessionManager: managerA
  });
  let appB = null;

  try {
    const room = await createRoom(appA.baseUrl, {
      title: 'Imported seed room',
      participants: [
        {
          adapter: 'codex-cli',
          displayName: 'Imported Codex',
          importedFromProviderSessionId: importedSeed
        }
      ]
    });
    const roomId = room.room.id;

    const firstTurn = await sendRoomMessage(appA.baseUrl, roomId, {
      content: 'Seed the canonical provider session id.',
      requestId: 'seed-turn-1'
    });
    assert.strictEqual(firstTurn.turn.status, 'completed');
    assert.strictEqual(managerA.createCalls[0]?.providerSessionId, importedSeed);

    const firstParticipant = appA.db.listRoomParticipants(roomId)[0];
    assert.strictEqual(firstParticipant.providerSessionId, canonicalProviderSessionId);

    await closeRoomApp(appA);
    appA = null;

    const managerB = createDirectSessionManager({ providerResolver });
    appB = await openRoomApp({
      dbPath,
      dataDir,
      sessionManager: managerB
    });
    const secondTurn = await sendRoomMessage(appB.baseUrl, roomId, {
      content: 'Reuse the canonical provider session id after restart.',
      requestId: 'seed-turn-2'
    });
    assert.strictEqual(secondTurn.turn.status, 'completed');
    assert.strictEqual(managerB.createCalls[0]?.providerSessionId, canonicalProviderSessionId);
    assert.notStrictEqual(managerB.createCalls[0]?.providerSessionId, importedSeed);
  } finally {
    await closeRoomApp(appB);
    await closeRoomApp(appA);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testDiscussionContinuityAndIdempotency() {
  const dataDir = makeTempDir('cliagents-room-discussion-continuity-');
  const dbPath = path.join(dataDir, 'cliagents.db');
  const runnerA = createRecordingDiscussionRunner();
  let appA = await openRoomApp({
    dbPath,
    dataDir,
    sessionManager: createDirectSessionManager(),
    roomDiscussionRunner: runnerA.runDiscussion
  });
  let appB = null;

  try {
    const room = await createRoom(appA.baseUrl, {
      title: 'Discussion continuity room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex planner' },
        { adapter: 'claude-code', displayName: 'Claude reviewer' }
      ]
    });
    const roomId = room.room.id;
    const rootSessionId = room.room.rootSessionId;

    const firstDiscussion = await discussRoom(appA.baseUrl, roomId, {
      message: 'Should room summaries be compacted every 20 turns?',
      requestId: 'discussion-1',
      rounds: [
        {
          name: 'position',
          transcriptMode: 'none',
          instructions: 'State one recommendation.'
        }
      ],
      judge: null
    });
    assert.strictEqual(firstDiscussion.turn.status, 'completed');
    assert.strictEqual(firstDiscussion.runId, 'run-1');
    assert.strictEqual(firstDiscussion.discussionId, 'discussion-result-1');

    const firstTurnId = firstDiscussion.turn.id;
    const firstMessageCount = appA.db.countRoomMessages(roomId);
    const firstParticipantSessions = new Map(
      (firstDiscussion.participants || [])
        .filter((participant) => participant.success && participant.providerSessionId)
        .map((participant) => [participant.participantRef, participant.providerSessionId])
    );
    assert.strictEqual(firstParticipantSessions.size, 2);

    await closeRoomApp(appA);
    appA = null;

    const runnerB = createRecordingDiscussionRunner();
    appB = await openRoomApp({
      dbPath,
      dataDir,
      sessionManager: createDirectSessionManager(),
      roomDiscussionRunner: runnerB.runDiscussion
    });
    const persistedBundle = appB.db.getMemoryBundle(roomId, 'room', {
      recentRunsLimit: 3,
      includeRawPointers: true
    });
    assert(persistedBundle?.brief, 'expected persisted room bundle after restart');
    assert(persistedBundle.brief.includes('Discussion continuity room'));

    const duplicateDiscussion = await discussRoom(appB.baseUrl, roomId, {
      message: 'Should room summaries be compacted every 20 turns?',
      requestId: 'discussion-1',
      rounds: [
        {
          name: 'position',
          transcriptMode: 'none',
          instructions: 'State one recommendation.'
        }
      ],
      judge: null
    });
    assert.strictEqual(duplicateDiscussion.turn.id, firstTurnId);
    assert.strictEqual(duplicateDiscussion.runId, 'run-1');
    assert.strictEqual(duplicateDiscussion.discussionId, 'discussion-result-1');
    assert.strictEqual(appB.db.countRoomMessages(roomId), firstMessageCount);
    assert.strictEqual(runnerB.invocations.length, 0, 'duplicate completed request should not rerun discussion');

    const secondDiscussion = await discussRoom(appB.baseUrl, roomId, {
      message: 'What should the post-restart follow-up be?',
      requestId: 'discussion-2',
      rounds: [
        {
          name: 'convergence',
          transcriptMode: 'all',
          instructions: 'Produce the next step.'
        }
      ],
      judge: null
    });
    assert.strictEqual(secondDiscussion.turn.status, 'completed');
    assert.strictEqual(runnerB.invocations.length, 1);

    const invocation = runnerB.invocations[0];
    assert(invocation.options.context.includes('Room brief:'), 'expected carried room brief in discussion context');
    assert(invocation.options.context.includes('Recent room transcript:'), 'expected carried room transcript in discussion context');
    assert(invocation.options.context.includes('Should room summaries be compacted every 20 turns?'));
    assert(invocation.options.context.includes('Room discussion completed'));

    const invocationProviderSessions = new Map(
      invocation.options.participants.map((participant) => [participant.participantRef, participant.providerSessionId])
    );
    for (const [participantRef, providerSessionId] of firstParticipantSessions.entries()) {
      assert.strictEqual(invocationProviderSessions.get(participantRef), providerSessionId);
    }

    const roomAfterRestart = await request(appB.baseUrl, 'GET', `/orchestration/rooms/${encodeURIComponent(roomId)}`);
    assert.strictEqual(roomAfterRestart.status, 200);
    assert.strictEqual(roomAfterRestart.data.latestTurn.id, secondDiscussion.turn.id);

    const finalMessages = await request(appB.baseUrl, 'GET', `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=50`);
    assert.strictEqual(finalMessages.status, 200);
    assert(finalMessages.data.messages.at(-1)?.content.includes('Room discussion completed'));
  } finally {
    await closeRoomApp(appB);
    await closeRoomApp(appA);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testDiscussionRoomBusyGuard() {
  const dataDir = makeTempDir('cliagents-room-discussion-busy-');
  const dbPath = path.join(dataDir, 'cliagents.db');
  const firstInvocationReached = createDeferred();
  const releaseFirstInvocation = createDeferred();

  const roomDiscussionRunner = async (_sessionManager, message, options = {}) => {
    firstInvocationReached.resolve();
    await releaseFirstInvocation.promise;
    return {
      runId: 'run-busy',
      discussionId: 'discussion-busy',
      participants: (options.participants || []).map((participant) => ({
        participantRef: participant.participantRef,
        name: participant.name,
        adapter: participant.adapter,
        success: true,
        output: `${participant.name} handled ${message}`,
        providerSessionId: participant.providerSessionId || `${participant.adapter}-busy-provider`
      })),
      rounds: [
        {
          name: 'position',
          responses: (options.participants || []).map((participant) => ({
            name: participant.name,
            adapter: participant.adapter,
            success: true,
            output: `${participant.name} finished`
          }))
        }
      ],
      judge: null
    };
  };

  const app = await openRoomApp({
    dbPath,
    dataDir,
    sessionManager: createDirectSessionManager(),
    roomDiscussionRunner
  });

  try {
    const room = await createRoom(app.baseUrl, {
      title: 'Busy guard room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex busy' },
        { adapter: 'claude-code', displayName: 'Claude busy' }
      ]
    });
    const roomId = room.room.id;

    const firstDiscussionPromise = request(
      app.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'Hold the first discussion open.',
        requestId: 'discussion-busy-1',
        judge: null
      },
      {},
      120000
    );

    await firstInvocationReached.promise;

    const secondDiscussion = await request(
      app.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'This should hit room_busy.',
        requestId: 'discussion-busy-2',
        judge: null
      }
    );
    assert.strictEqual(secondDiscussion.status, 409);
    assert.strictEqual(secondDiscussion.data.error.code, 'room_busy');

    releaseFirstInvocation.resolve();

    const firstDiscussion = await firstDiscussionPromise;
    assert.strictEqual(firstDiscussion.status, 200, JSON.stringify(firstDiscussion.data));
    assert.strictEqual(firstDiscussion.data.turn.status, 'completed');
  } finally {
    await closeRoomApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testFailedDiscussionRequestIdIsTerminal() {
  const dataDir = makeTempDir('cliagents-room-discussion-failed-idempotency-');
  const dbPath = path.join(dataDir, 'cliagents.db');
  const discussionError = new Error('synthetic discussion failure');
  const roomDiscussionRunner = async () => {
    throw discussionError;
  };

  let appA = await openRoomApp({
    dbPath,
    dataDir,
    sessionManager: createDirectSessionManager(),
    roomDiscussionRunner
  });
  let appB = null;

  try {
    const room = await createRoom(appA.baseUrl, {
      title: 'Failed request id room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex failed discussion' }
      ]
    });
    const roomId = room.room.id;

    const firstFailure = await request(
      appA.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'This discussion should fail.',
        requestId: 'discussion-failed-1',
        judge: null
      },
      {},
      120000
    );
    assert.strictEqual(firstFailure.status, 500);
    assert.strictEqual(firstFailure.data.error.code, 'internal_error');
    assert(firstFailure.data.error.message.includes(discussionError.message));

    const failedTurn = appA.db.getLatestRoomTurn(roomId);
    assert(failedTurn, 'expected failed discussion turn to persist');
    assert.strictEqual(failedTurn.requestId, 'discussion-failed-1');
    assert.strictEqual(failedTurn.status, 'failed');
    const failedMessageCount = appA.db.countRoomMessages(roomId);

    await closeRoomApp(appA);
    appA = null;

    appB = await openRoomApp({
      dbPath,
      dataDir,
      sessionManager: createDirectSessionManager(),
      roomDiscussionRunner
    });

    const reusedFailure = await request(
      appB.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'Retrying with the same failed request id should be terminal.',
        requestId: 'discussion-failed-1',
        judge: null
      },
      {},
      120000
    );
    assert.strictEqual(reusedFailure.status, 200, JSON.stringify(reusedFailure.data));
    assert.strictEqual(reusedFailure.data.turn.id, failedTurn.id);
    assert.strictEqual(reusedFailure.data.turn.status, 'failed');
    assert.strictEqual(reusedFailure.data.runId, null);
    assert.strictEqual(reusedFailure.data.discussionId, null);
    assert.strictEqual(appB.db.countRoomMessages(roomId), failedMessageCount);
  } finally {
    await closeRoomApp(appB);
    await closeRoomApp(appA);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testTimedOutDiscussionSettlesTurn() {
  const dataDir = makeTempDir('cliagents-room-discussion-timeout-');
  const dbPath = path.join(dataDir, 'cliagents.db');
  const neverSettles = createDeferred();
  const roomDiscussionRunner = async () => neverSettles.promise;

  const app = await openRoomApp({
    dbPath,
    dataDir,
    sessionManager: createDirectSessionManager(),
    roomDiscussionRunner
  });

  try {
    const room = await createRoom(app.baseUrl, {
      title: 'Timed out discussion room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex timeout' }
      ]
    });
    const roomId = room.room.id;

    const timeoutRes = await request(
      app.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'This discussion runner will never settle.',
        requestId: 'discussion-timeout-1',
        timeout: 25,
        judge: null
      },
      {},
      5000
    );
    assert.strictEqual(timeoutRes.status, 500, JSON.stringify(timeoutRes.data));
    assert.strictEqual(timeoutRes.data.error.code, 'internal_error');
    assert(timeoutRes.data.error.message.includes('Room discussion timed out after 25ms'));

    const failedTurn = app.db.getLatestRoomTurn(roomId);
    assert(failedTurn, 'expected timed-out discussion turn to persist');
    assert.strictEqual(failedTurn.requestId, 'discussion-timeout-1');
    assert.strictEqual(failedTurn.status, 'failed');
    assert(failedTurn.error.includes('Room discussion timed out after 25ms'));

    const messages = app.db.listRoomMessages(roomId, { limit: 50 });
    assert(messages.some((message) => (
      message.role === 'system'
      && message.content.includes('Room discussion failed: Room discussion timed out after 25ms')
    )), 'expected failed discussion writeback message');

    const roomAfterTimeout = await request(app.baseUrl, 'GET', `/orchestration/rooms/${encodeURIComponent(roomId)}`);
    assert.strictEqual(roomAfterTimeout.status, 200);
    assert.strictEqual(roomAfterTimeout.data.latestTurn.status, 'failed');
  } finally {
    await closeRoomApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(error.stack || error.message || String(error));
    return false;
  }
}

async function main() {
  console.log('\n📦 Room continuity tests\n');

  const results = [];
  results.push(await runTest('room send continuity survives restart', testRoomSendContinuity));
  results.push(await runTest('imported provider-session seed converges to canonical continuity', testImportedSeedContinuity));
  results.push(await runTest('discussion continuity, idempotency, and carried context survive restart', testDiscussionContinuityAndIdempotency));
  results.push(await runTest('concurrent room discussions return room_busy for different request ids', testDiscussionRoomBusyGuard));
  results.push(await runTest('failed discussion request ids stay terminal across restart', testFailedDiscussionRequestIdIsTerminal));
  results.push(await runTest('timed-out room discussions settle failed turns', testTimedOutDiscussionSettlesTurn));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  if (failed > 0) {
    console.error(`\nRoom continuity tests failed: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  console.log(`\nRoom continuity tests passed: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error('\nRoom continuity tests crashed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
