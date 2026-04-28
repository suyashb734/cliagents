#!/usr/bin/env node

'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OrchestrationDB } = require('../src/database/db');
const { ProviderSessionRegistry } = require('../src/orchestration/provider-session-registry');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonLines(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function seedCodexHome(homeDir) {
  const codexDir = path.join(homeDir, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions', '2026', '04', '22');
  const activeId = '11111111-1111-4111-8111-111111111111';
  const archivedId = '22222222-2222-4222-8222-222222222222';

  writeJsonLines(path.join(codexDir, 'session_index.jsonl'), [
    {
      id: activeId,
      thread_name: 'Finance tracker',
      updated_at: '2026-04-22T10:00:00.000Z'
    },
    {
      id: archivedId,
      thread_name: 'Old experiment',
      updated_at: '2026-04-21T08:00:00.000Z',
      archived: true
    }
  ]);

  writeJsonLines(path.join(sessionsDir, `session-${activeId}.jsonl`), [
    {
      type: 'session_meta',
      payload: {
        title: 'Finance tracker',
        timestamp: '2026-04-22T10:00:00.000Z',
        cwd: '/tmp/finance-tracker',
        model: 'o4-mini',
        originator: 'codex',
        model_provider: 'openai'
      }
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Build a finance tracker with durable summaries.' }]
    }
  ]);

  writeJsonLines(path.join(sessionsDir, `session-${archivedId}.jsonl`), [
    {
      type: 'session_meta',
      payload: {
        title: 'Old experiment',
        timestamp: '2026-04-21T08:00:00.000Z',
        cwd: '/tmp/old-experiment',
        model: 'o4-mini'
      }
    }
  ]);

  return { codexDir, activeId, archivedId };
}

function loadCreateOrchestrationRouter() {
  const routerPath = require.resolve('../src/server/orchestration-router');
  const registryPath = require.resolve('../src/orchestration/provider-session-registry');
  delete require.cache[routerPath];
  delete require.cache[registryPath];
  return require('../src/server/orchestration-router').createOrchestrationRouter;
}

async function startApp(context) {
  const app = express();
  app.use(express.json());
  app.use('/orchestration', loadCreateOrchestrationRouter()(context));

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

async function stopApp(serverHandle) {
  await new Promise((resolve, reject) => {
    serverHandle.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function request(baseUrl, method, route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

function createDirectSessionManager() {
  const sessions = new Map();
  const createCalls = [];
  let counter = 0;

  const manager = {
    createCalls,
    async createSession(options = {}) {
      counter += 1;
      const sessionId = `direct-${counter}`;
      const providerSessionId = options.providerSessionId || `${options.adapter || 'agent'}-provider-${counter}`;
      createCalls.push({ ...options, sessionId, effectiveProviderSessionId: providerSessionId });
      const session = {
        sessionId,
        adapter: options.adapter || 'unknown',
        providerSessionId,
        model: options.model || null
      };
      sessions.set(sessionId, session);
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
  return manager;
}

async function runProviderRegistryAssertions(homeDir) {
  const fixture = seedCodexHome(homeDir);
  const registry = new ProviderSessionRegistry({
    codex: {
      homeDir,
      codexDir: fixture.codexDir
    }
  });

  const activeOnly = registry.listSessions({ adapter: 'codex-cli', limit: 10 });
  assert.strictEqual(activeOnly.supported, true);
  assert.strictEqual(activeOnly.sessions.length, 1);
  assert.strictEqual(activeOnly.sessions[0].providerSessionId, fixture.activeId);
  assert.strictEqual(activeOnly.sessions[0].cwd, '/tmp/finance-tracker');
  assert.strictEqual(activeOnly.sessions[0].model, 'o4-mini');
  assert.strictEqual(activeOnly.sessions[0].resumeCapability, 'exact');

  const withArchived = registry.listSessions({
    adapter: 'codex-cli',
    limit: 10,
    includeArchived: true
  });
  assert.strictEqual(withArchived.sessions.length, 2);
  assert.strictEqual(withArchived.sessions[0].providerSessionId, fixture.activeId);
  assert.strictEqual(withArchived.sessions[1].providerSessionId, fixture.archivedId);

  const activeSession = registry.getSession({
    adapter: 'codex-cli',
    providerSessionId: fixture.activeId
  });
  assert(activeSession, 'expected active provider session descriptor');
  assert.strictEqual(activeSession.title, 'Finance tracker');
  assert.strictEqual(activeSession.preview, 'Finance tracker');

  const unsupported = registry.listSessions({ adapter: 'claude-code' });
  assert.strictEqual(unsupported.supported, false);
  assert.deepStrictEqual(unsupported.sessions, []);

  console.log('✅ Provider session registry reads local Codex sessions with archived filtering');
  return fixture;
}

async function runRouteAssertions(homeDir, fixture) {
  const previousHome = process.env.HOME;
  const previousSessionEvents = process.env.SESSION_EVENTS_ENABLED;
  const previousRunLedger = process.env.RUN_LEDGER_ENABLED;
  const previousRunLedgerReads = process.env.RUN_LEDGER_READS_ENABLED;
  const previousGraph = process.env.SESSION_GRAPH_WRITES_ENABLED;

  process.env.HOME = homeDir;
  process.env.SESSION_EVENTS_ENABLED = '1';
  process.env.RUN_LEDGER_ENABLED = '1';
  process.env.RUN_LEDGER_READS_ENABLED = '1';
  process.env.SESSION_GRAPH_WRITES_ENABLED = '1';

  const rootDir = makeTempDir('cliagents-provider-rooms-');
  const db = new OrchestrationDB({
    dbPath: path.join(rootDir, 'cliagents.db'),
    dataDir: rootDir
  });
  const apiSessionManager = createDirectSessionManager();
  const sessionManager = {
    async createTerminal() {
      throw new Error('tmux terminal creation not used in provider-session and room route tests');
    },
    async sendInput() {
      throw new Error('tmux input not used in provider-session and room route tests');
    }
  };

  let serverHandle = null;

  try {
    serverHandle = await startApp({ sessionManager, apiSessionManager, db });

    const providerListRes = await request(
      serverHandle.baseUrl,
      'GET',
      '/orchestration/provider-sessions?adapter=codex-cli&limit=5'
    );
    assert.strictEqual(providerListRes.status, 200);
    assert.strictEqual(providerListRes.data.supported, true);
    assert.strictEqual(providerListRes.data.sessions.length, 1);
    assert.strictEqual(providerListRes.data.sessions[0].providerSessionId, fixture.activeId);

    const providerListArchivedRes = await request(
      serverHandle.baseUrl,
      'GET',
      '/orchestration/provider-sessions?adapter=codex-cli&limit=5&includeArchived=1'
    );
    assert.strictEqual(providerListArchivedRes.status, 200);
    assert.strictEqual(providerListArchivedRes.data.sessions.length, 2);

    const importRes = await request(
      serverHandle.baseUrl,
      'POST',
      '/orchestration/provider-sessions/import',
      {
        adapter: 'codex-cli',
        providerSessionId: fixture.activeId
      }
    );
    assert.strictEqual(importRes.status, 200);
    assert.strictEqual(importRes.data.importedRoot, true);
    assert.strictEqual(importRes.data.reusedImportedRoot, false);
    assert.strictEqual(importRes.data.descriptor.title, 'Finance tracker');

    const importedTerminal = db.findRootTerminalByProviderThreadRef('codex-cli', fixture.activeId);
    assert(importedTerminal, 'expected imported provider session to bind a root terminal');
    assert.strictEqual(importedTerminal.root_session_id, importRes.data.rootSessionId);
    assert.strictEqual(importedTerminal.provider_thread_ref, fixture.activeId);

    const reimportRes = await request(
      serverHandle.baseUrl,
      'POST',
      '/orchestration/provider-sessions/import',
      {
        adapter: 'codex-cli',
        providerSessionId: fixture.activeId
      }
    );
    assert.strictEqual(reimportRes.status, 200);
    assert.strictEqual(reimportRes.data.reusedImportedRoot, true);
    assert.strictEqual(reimportRes.data.rootSessionId, importRes.data.rootSessionId);

    const roomCreateRes = await request(
      serverHandle.baseUrl,
      'POST',
      '/orchestration/rooms',
      {
        title: 'Planner room',
        workDir: '/tmp/planner-room',
        participants: [
          {
            adapter: 'codex-cli',
            displayName: 'Codex planner',
            importedFromProviderSessionId: fixture.activeId
          },
          { adapter: 'claude-code', displayName: 'Claude reviewer' }
        ]
      }
    );
    assert.strictEqual(roomCreateRes.status, 200);
    assert(roomCreateRes.data.room?.id, 'expected created room id');
    assert.strictEqual(roomCreateRes.data.room.title, 'Planner room');
    assert.strictEqual(roomCreateRes.data.participants.length, 2);

    const roomId = roomCreateRes.data.room.id;
    const roomRootSessionId = roomCreateRes.data.room.rootSessionId;
    const [codexParticipant, claudeParticipant] = roomCreateRes.data.participants;

    const roomGetRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}`
    );
    assert.strictEqual(roomGetRes.status, 200);
    assert.strictEqual(roomGetRes.data.room.id, roomId);
    assert.strictEqual(roomGetRes.data.participants.length, 2);

    const roomListRes = await request(
      serverHandle.baseUrl,
      'GET',
      '/orchestration/rooms?limit=10'
    );
    assert.strictEqual(roomListRes.status, 200);
    assert(Array.isArray(roomListRes.data.rooms));
    assert(roomListRes.data.rooms.some((entry) => entry.room?.id === roomId));

    const duplicateRoomRes = await request(
      serverHandle.baseUrl,
      'POST',
      '/orchestration/rooms',
      {
        rootSessionId: roomRootSessionId,
        title: 'Duplicate planner room',
        participants: [
          { adapter: 'codex-cli', displayName: 'Codex planner' }
        ]
      }
    );
    assert.strictEqual(duplicateRoomRes.status, 409);
    assert.strictEqual(duplicateRoomRes.data.error.code, 'room_exists');
    assert.strictEqual(duplicateRoomRes.data.error.roomId, roomId);

    const firstTurnRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content: 'Give a one-line update.',
        requestId: 'turn-1'
      }
    );
    assert.strictEqual(firstTurnRes.status, 200);
    assert.strictEqual(firstTurnRes.data.turn.status, 'completed');
    assert.strictEqual(firstTurnRes.data.participantResults.length, 2);
    assert(firstTurnRes.data.participantResults.every((entry) => entry.success === true));
    assert.strictEqual(
      apiSessionManager.createCalls.find((call) => call.adapter === 'codex-cli')?.providerSessionId,
      fixture.activeId,
      'room participant should seed exact resume from importedFromProviderSessionId'
    );

    const duplicateTurnRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content: 'Give a one-line update.',
        requestId: 'turn-1'
      }
    );
    assert.strictEqual(duplicateTurnRes.status, 200);
    assert.strictEqual(duplicateTurnRes.data.turn.id, firstTurnRes.data.turn.id);
    assert.strictEqual(duplicateTurnRes.data.participantResults.length, 0);

    const roomMessagesRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=20`
    );
    assert.strictEqual(roomMessagesRes.status, 200);
    assert(roomMessagesRes.data.messages.length >= 4, 'expected room transcript messages');
    const fullMessageCount = roomMessagesRes.data.messages.length;

    const mentionedTurnRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content: 'Only Codex should reply.',
        requestId: 'turn-2',
        mentions: [codexParticipant.id]
      }
    );
    assert.strictEqual(mentionedTurnRes.status, 200);
    assert.strictEqual(mentionedTurnRes.data.participantResults.length, 1);
    assert.strictEqual(mentionedTurnRes.data.participantResults[0].participantId, codexParticipant.id);

    const pagedMessagesRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?after_id=${roomMessagesRes.data.messages[1].id}&limit=10`
    );
    assert.strictEqual(pagedMessagesRes.status, 200);
    assert(pagedMessagesRes.data.messages.every((message) => message.id > roomMessagesRes.data.messages[1].id));

    const busyTurn = db.createRoomTurn({
      roomId,
      content: 'Busy turn sentinel',
      status: 'running'
    });
    const roomBusyRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content: 'This should hit room_busy.'
      }
    );
    assert.strictEqual(roomBusyRes.status, 409);
    assert.strictEqual(roomBusyRes.data.error.code, 'room_busy');
    db.updateRoomTurn(busyTurn.id, {
      status: 'completed',
      completedAt: Date.now()
    });

    const runningIdempotentTurn = db.createRoomTurn({
      roomId,
      requestId: 'turn-running-idempotent',
      content: 'Running idempotent turn',
      status: 'running'
    });
    const runningDuplicateRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content: 'Running idempotent turn',
        requestId: 'turn-running-idempotent'
      }
    );
    assert.strictEqual(runningDuplicateRes.status, 200);
    assert.strictEqual(runningDuplicateRes.data.turn.id, runningIdempotentTurn.id);
    assert.strictEqual(runningDuplicateRes.data.participantResults.length, 0);
    db.updateRoomTurn(runningIdempotentTurn.id, {
      status: 'completed',
      completedAt: Date.now()
    });

    const staleTurn = db.createRoomTurn({
      roomId,
      content: 'Stale turn sentinel',
      status: 'running',
      createdAt: Date.now() - 60 * 60 * 1000
    });
    db.db.prepare('UPDATE room_turns SET updated_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, staleTurn.id);
    const afterStaleTurnRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content: 'This should expire stale active turn.',
        requestId: 'turn-after-stale'
      }
    );
    assert.strictEqual(afterStaleTurnRes.status, 200);
    assert.strictEqual(db.getRoomTurn(staleTurn.id).status, 'failed');

    const discussRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'Debate whether summaries should be compacted every 20 turns.',
        participantIds: [codexParticipant.id, claudeParticipant.id],
        rounds: [
          {
            name: 'position',
            transcriptMode: 'none',
            instructions: 'State one recommendation.'
          }
        ],
        judge: null
      }
    );
    assert.strictEqual(discussRes.status, 200, JSON.stringify(discussRes.data));
    assert(discussRes.data.discussionId, 'expected room discussion to return a discussion id');
    assert(['completed', 'partial'].includes(discussRes.data.turn.status));
    assert.strictEqual(discussRes.data.turn.metadata.writebackMode, 'summary');
    assert(discussRes.data.messages.some((message) => message.role === 'system' && message.content.includes('Room discussion completed')));

    const roomAfterDiscussionRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}`
    );
    assert.strictEqual(roomAfterDiscussionRes.status, 200);
    assert(['completed', 'partial'].includes(roomAfterDiscussionRes.data.latestTurn.status));

    const finalMessagesRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=50`
    );
    assert.strictEqual(finalMessagesRes.status, 200);
    assert(finalMessagesRes.data.messages.length > fullMessageCount);
    assert(finalMessagesRes.data.messages.at(-1).content.includes('Room discussion completed'));
    assert(finalMessagesRes.data.messages.every((message) => message.metadata?.discussionArtifact !== true), 'default room transcript view should hide discussion artifacts');

    const curatedDiscussRes = await request(
      serverHandle.baseUrl,
      'POST',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`,
      {
        message: 'Show the actual round outputs in the room transcript.',
        participantIds: [codexParticipant.id, claudeParticipant.id],
        writebackMode: 'curated_transcript',
        rounds: [
          {
            name: 'position',
            transcriptMode: 'none',
            instructions: 'State one recommendation.'
          }
        ],
        judge: null
      }
    );
    assert.strictEqual(curatedDiscussRes.status, 200, JSON.stringify(curatedDiscussRes.data));
    assert.strictEqual(curatedDiscussRes.data.turn.metadata.writebackMode, 'curated_transcript');
    assert(curatedDiscussRes.data.messages.some((message) => message.metadata?.discussionArtifact === true), 'curated writeback should return artifact-tagged room messages');

    const hiddenArtifactMessagesRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=80`
    );
    assert.strictEqual(hiddenArtifactMessagesRes.status, 200);
    assert(hiddenArtifactMessagesRes.data.messages.every((message) => message.metadata?.discussionArtifact !== true), 'artifact rows should stay hidden by default');

    const allMessagesRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=120&artifact_mode=include`
    );
    assert.strictEqual(allMessagesRes.status, 200);
    assert(allMessagesRes.data.messages.some((message) => message.metadata?.discussionArtifact === true), 'include mode should return discussion artifact rows');

    const onlyArtifactMessagesRes = await request(
      serverHandle.baseUrl,
      'GET',
      `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=120&artifact_mode=only`
    );
    assert.strictEqual(onlyArtifactMessagesRes.status, 200);
    assert(onlyArtifactMessagesRes.data.messages.length > 0);
    assert(onlyArtifactMessagesRes.data.messages.every((message) => message.metadata?.discussionArtifact === true), 'artifact-only mode should return only discussion artifacts');

    const roomBundle = db.getMemoryBundle(roomRootSessionId, 'root', {
      recentRunsLimit: 3,
      includeRawPointers: true
    });
    assert(roomBundle.brief.includes('Planner room'));
    assert(Array.isArray(roomBundle.keyDecisions));
    assert(Array.isArray(roomBundle.pendingItems));

    const storedRoom = db.getRoom(roomId);
    assert(storedRoom, 'expected stored room row');
    const storedParticipants = db.listRoomParticipants(roomId);
    assert(storedParticipants.some((participant) => participant.providerSessionId), 'expected room participants to persist provider session ids');

    console.log('✅ Provider-session import and persistent room routes behave correctly');
  } finally {
    if (serverHandle) {
      await stopApp(serverHandle.server);
    }
    db.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSessionEvents === undefined) delete process.env.SESSION_EVENTS_ENABLED;
    else process.env.SESSION_EVENTS_ENABLED = previousSessionEvents;
    if (previousRunLedger === undefined) delete process.env.RUN_LEDGER_ENABLED;
    else process.env.RUN_LEDGER_ENABLED = previousRunLedger;
    if (previousRunLedgerReads === undefined) delete process.env.RUN_LEDGER_READS_ENABLED;
    else process.env.RUN_LEDGER_READS_ENABLED = previousRunLedgerReads;
    if (previousGraph === undefined) delete process.env.SESSION_GRAPH_WRITES_ENABLED;
    else process.env.SESSION_GRAPH_WRITES_ENABLED = previousGraph;
  }
}

async function run() {
  const homeDir = makeTempDir('cliagents-provider-home-');
  const fixture = await runProviderRegistryAssertions(homeDir);
  await runRouteAssertions(homeDir, fixture);
  console.log('\nProvider-session and room tests passed');
}

run().catch((error) => {
  console.error('\nProvider-session and room tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
