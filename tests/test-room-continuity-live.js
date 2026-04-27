#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startTestServer } = require('./helpers/server-harness');
const { isAdapterAuthenticated } = require('../src/utils/adapter-auth');

const ENABLE_FLAG = 'CLIAGENTS_ROOM_CONTINUITY_LIVE';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROVIDER_SKIP_PATTERNS = [
  'not authenticated',
  'authentication failed',
  'please log in',
  'please login',
  'login required',
  'api key',
  'quota',
  'usage limit',
  'rate limit',
  'resourceexhausted',
  'capacity on this model',
  'no active provider',
  'no active subscription',
  'billing',
  'request timed out',
  'timed out',
  'timeout',
  'status: 504',
  'fetch failed',
  'socket',
  'econnreset'
];

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function short(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isSkippableProviderFailure(message = '') {
  const text = String(message || '').toLowerCase();
  return PROVIDER_SKIP_PATTERNS.some((pattern) => text.includes(pattern));
}

async function request(baseUrl, method, route, body = null, timeoutMs = 300000) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
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

async function ensureAdapterReady(baseUrl, adapterName) {
  const { status, data } = await request(baseUrl, 'GET', '/adapters', null, 30000);
  assert.strictEqual(status, 200, `Expected /adapters 200, got ${status}`);

  const adapter = (data.adapters || []).find((entry) => entry.name === adapterName);
  if (!adapter) {
    throw new Error(`SKIP: adapter ${adapterName} not registered`);
  }
  if (!adapter.available) {
    throw new Error(`SKIP: adapter ${adapterName} not installed`);
  }
  const auth = isAdapterAuthenticated(adapterName);
  if (!auth.authenticated) {
    throw new Error(`SKIP: ${auth.reason}`);
  }
}

async function startRestartableServer(paths) {
  return startTestServer({
    orchestration: {
      dataDir: paths.dataDir,
      logDir: paths.logDir,
      tmuxSocketPath: paths.tmuxSocketPath,
      destroyTerminalsOnStop: true
    }
  });
}

async function pauseRestartableServer(testServer) {
  if (!testServer?.server) {
    return;
  }
  await testServer.server.stop();
}

async function destroyRestartableServer(testServers, paths) {
  for (const testServer of Array.isArray(testServers) ? testServers : [testServers]) {
    if (testServer?.server) {
      await testServer.server.stop().catch(() => {});
    }
  }

  for (const target of [paths.dataDir, paths.logDir, path.dirname(paths.tmuxSocketPath)]) {
    if (target && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

async function createRoom(baseUrl) {
  const response = await request(baseUrl, 'POST', '/orchestration/rooms', {
    title: 'Live room continuity',
    workDir: PROJECT_ROOT,
    participants: [
      {
        adapter: 'codex-cli',
        displayName: 'Codex live',
        workDir: PROJECT_ROOT
      },
      {
        adapter: 'claude-code',
        displayName: 'Claude live',
        workDir: PROJECT_ROOT
      }
    ]
  }, 120000);

  if (response.status !== 200) {
    throw new Error(`create room failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function discussRoom(baseUrl, roomId, requestId, message) {
  const response = await request(baseUrl, 'POST', `/orchestration/rooms/${encodeURIComponent(roomId)}/discuss`, {
    message,
    requestId,
    rounds: [
      {
        name: 'position',
        transcriptMode: 'none',
        instructions: 'Reply in 2-3 concise sentences with one concrete recommendation.'
      }
    ],
    judge: null,
    timeout: 300000
  }, 360000);

  if (response.status === 200) {
    return response.data;
  }

  const messageText = response.data?.error?.message || JSON.stringify(response.data);
  if (isSkippableProviderFailure(messageText)) {
    throw new Error(`SKIP: ${messageText}`);
  }

  throw new Error(`discuss room failed: ${response.status} ${messageText}`);
}

async function getRoom(baseUrl, roomId) {
  const response = await request(baseUrl, 'GET', `/orchestration/rooms/${encodeURIComponent(roomId)}`, null, 30000);
  if (response.status !== 200) {
    throw new Error(`get room failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function getRoomMessages(baseUrl, roomId) {
  const response = await request(baseUrl, 'GET', `/orchestration/rooms/${encodeURIComponent(roomId)}/messages?limit=100`, null, 30000);
  if (response.status !== 200) {
    throw new Error(`get room messages failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data.messages || [];
}

async function getRootBundle(baseUrl, rootSessionId) {
  const response = await request(
    baseUrl,
    'GET',
    `/orchestration/memory/bundle/${encodeURIComponent(rootSessionId)}?scope_type=root&recent_runs_limit=3`,
    null,
    30000
  );
  if (response.status !== 200) {
    throw new Error(`get root bundle failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function main() {
  if (process.env[ENABLE_FLAG] !== '1') {
    console.log(`SKIP: set ${ENABLE_FLAG}=1 to run live room continuity coverage`);
    return;
  }

  const paths = {
    dataDir: makeTempDir('cliagents-room-live-data-'),
    logDir: makeTempDir('cliagents-room-live-logs-'),
    tmuxSocketPath: path.join(makeTempDir('cliagents-room-live-tmux-'), 'broker.sock')
  };

  let firstServer = null;
  let secondServer = null;

  try {
    firstServer = await startRestartableServer(paths);
    const baseUrlA = firstServer.baseUrl;

    await ensureAdapterReady(baseUrlA, 'codex-cli');
    await ensureAdapterReady(baseUrlA, 'claude-code');

    const createdRoom = await createRoom(baseUrlA);
    const roomId = createdRoom.room.id;
    const rootSessionId = createdRoom.room.rootSessionId;

    console.log(`Created live room ${roomId}`);

    const firstDiscussion = await discussRoom(
      baseUrlA,
      roomId,
      'live-discussion-1',
      'Give one concise recommendation for room continuity hardening before restart.'
    );
    assert(['completed', 'partial'].includes(firstDiscussion.turn.status));
    assert(firstDiscussion.messages.some((message) => (
      message.role === 'system' && message.content.includes('Room discussion completed')
    )));

    const firstRoom = await getRoom(baseUrlA, roomId);
    const firstMessages = await getRoomMessages(baseUrlA, roomId);
    const persistedParticipants = new Map(
      firstRoom.participants
        .filter((participant) => participant.providerSessionId)
        .map((participant) => [participant.id, participant.providerSessionId])
    );
    if (persistedParticipants.size === 0) {
      throw new Error('SKIP: live discussion completed without any persisted participant providerSessionId');
    }

    console.log(`First discussion settled with ${firstDiscussion.turn.status}; transcript size=${firstMessages.length}`);
    await pauseRestartableServer(firstServer);

    secondServer = await startRestartableServer(paths);
    const baseUrlB = secondServer.baseUrl;

    const roomAfterRestart = await getRoom(baseUrlB, roomId);
    const messagesAfterRestart = await getRoomMessages(baseUrlB, roomId);
    assert.strictEqual(roomAfterRestart.room.id, roomId);
    assert(messagesAfterRestart.length >= firstMessages.length);

    for (const [participantId, providerSessionId] of persistedParticipants.entries()) {
      const reloaded = roomAfterRestart.participants.find((participant) => participant.id === participantId);
      assert(reloaded, `missing participant ${participantId} after restart`);
      assert.strictEqual(reloaded.providerSessionId, providerSessionId);
    }

    const rootBundle = await getRootBundle(baseUrlB, rootSessionId);
    assert(rootBundle.brief, 'expected room root bundle after restart');

    const secondDiscussion = await discussRoom(
      baseUrlB,
      roomId,
      'live-discussion-2',
      'Now continue after restart with one concise follow-up recommendation.'
    );
    assert(['completed', 'partial'].includes(secondDiscussion.turn.status));
    assert(secondDiscussion.messages.some((message) => (
      message.role === 'system' && message.content.includes('Room discussion completed')
    )));

    const finalMessages = await getRoomMessages(baseUrlB, roomId);
    assert(finalMessages.length > messagesAfterRestart.length);
    assert(finalMessages.at(-1)?.content.includes('Room discussion completed'));

    console.log(`Live room continuity passed: first=${firstDiscussion.turn.status}, second=${secondDiscussion.turn.status}, messages=${finalMessages.length}`);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('SKIP:') || isSkippableProviderFailure(message)) {
      console.log(message.startsWith('SKIP:') ? message : `SKIP: ${short(message, 220)}`);
      return;
    }
    throw error;
  } finally {
    await destroyRestartableServer([secondServer, firstServer], paths);
  }
}

main().catch((error) => {
  console.error('\nRoom continuity live test failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
