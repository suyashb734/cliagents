const { runDiscussion } = require('./discussion-runner');

function truncateText(value, maxLength = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function dedupeStrings(values = [], maxItems = 10) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function formatParticipantLabel(participant) {
  return participant.displayName || participant.adapter;
}

function buildRoomSnapshotBrief(room, participants, recentMessages) {
  const participantList = participants.map((participant) => formatParticipantLabel(participant)).join(', ');
  const messageLines = recentMessages.slice(-6).map((message) => {
    const actor = message.role === 'assistant'
      ? formatParticipantLabel(participants.find((participant) => participant.id === message.participantId) || {})
      : (message.role === 'system' ? 'system' : 'user');
    return `${actor}: ${truncateText(message.content, 180)}`;
  });

  return [
    room.title ? `Room: ${room.title}` : `Room: ${room.id}`,
    participantList ? `Participants: ${participantList}` : null,
    messageLines.length > 0 ? `Recent room context:\n${messageLines.join('\n')}` : 'No room messages yet.'
  ].filter(Boolean).join('\n\n');
}

function buildRoomSnapshotKeyDecisions(recentMessages) {
  return dedupeStrings(
    recentMessages
      .filter((message) => message.role === 'assistant' || message.role === 'system')
      .map((message) => truncateText(message.content, 180)),
    8
  );
}

function buildRoomSnapshotPendingItems(recentMessages) {
  return dedupeStrings(
    recentMessages
      .filter((message) => message.role === 'user')
      .map((message) => truncateText(message.content, 180)),
    8
  );
}

function buildRoomPrompt(room, participant, bundle, recentMessages, content) {
  const excerpt = recentMessages.slice(-8).map((message) => {
    const actor = message.role === 'assistant'
      ? (message.metadata?.displayName || message.metadata?.adapter || 'assistant')
      : message.role;
    return `${actor}: ${truncateText(message.content, 260)}`;
  }).join('\n');

  return [
    `You are participating in the persistent cliagents room "${room.title || room.id}".`,
    `Your role in this room: ${formatParticipantLabel(participant)} (${participant.adapter}).`,
    bundle?.brief ? `Room brief:\n${bundle.brief}` : null,
    Array.isArray(bundle?.keyDecisions) && bundle.keyDecisions.length > 0
      ? `Key decisions:\n${bundle.keyDecisions.map((entry) => `- ${entry}`).join('\n')}`
      : null,
    Array.isArray(bundle?.pendingItems) && bundle.pendingItems.length > 0
      ? `Pending items:\n${bundle.pendingItems.map((entry) => `- ${entry}`).join('\n')}`
      : null,
    excerpt ? `Recent room messages:\n${excerpt}` : null,
    'Respond once as yourself. Do not simulate the other participants.',
    `New message:\n${content}`
  ].filter(Boolean).join('\n\n');
}

function buildDiscussionContext(room, bundle, recentMessages) {
  const transcript = recentMessages.slice(-10).map((message) => {
    const actor = message.role === 'assistant'
      ? (message.metadata?.displayName || message.metadata?.adapter || 'assistant')
      : message.role;
    return `${actor}: ${truncateText(message.content, 260)}`;
  }).join('\n');

  return [
    `Persistent room: ${room.title || room.id}`,
    bundle?.brief ? `Room brief:\n${bundle.brief}` : null,
    transcript ? `Recent room transcript:\n${transcript}` : null
  ].filter(Boolean).join('\n\n');
}

const ROOM_ARTIFACT_MODES = new Set(['exclude', 'include', 'only']);
const ROOM_DISCUSSION_WRITEBACK_MODES = new Set(['summary', 'curated_transcript']);
const DEFAULT_ROOM_DISCUSSION_TIMEOUT_MS = 10 * 60 * 1000;
const ROOM_DISCUSSION_TIMEOUT_GRACE_MS = 5000;

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveDiscussionTimeoutMs(value, fallback) {
  if (value === 0 || value === '0') {
    return null;
  }
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return parsePositiveInteger(value, fallback);
}

function normalizeArtifactMode(value, fallback = 'exclude') {
  const normalized = String(value || '').trim().toLowerCase();
  return ROOM_ARTIFACT_MODES.has(normalized) ? normalized : fallback;
}

function normalizeDiscussionWritebackMode(value, fallback = 'summary') {
  const normalized = String(value || '').trim().toLowerCase();
  return ROOM_DISCUSSION_WRITEBACK_MODES.has(normalized) ? normalized : fallback;
}

function buildDiscussionArtifactMetadata(baseMetadata = {}, patch = {}) {
  return {
    ...baseMetadata,
    ...patch,
    mode: patch.mode || baseMetadata.mode || 'discussion',
    discussionArtifact: true
  };
}

function extractDiscussionIdentifiers(events = []) {
  const identifiers = {
    runId: null,
    discussionId: null
  };
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.runId) {
      identifiers.runId = event.runId;
    }
    if (event?.discussionId) {
      identifiers.discussionId = event.discussionId;
    }
  }
  return identifiers;
}

async function withTimeout(promise, timeoutMs, errorMessage) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(errorMessage);
          error.code = 'room_discussion_timeout';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function computeDiscussionGuardTimeoutMs(discussionTimeoutMs) {
  if (!Number.isFinite(discussionTimeoutMs) || discussionTimeoutMs <= 0) {
    return null;
  }
  const graceMs = Math.min(
    ROOM_DISCUSSION_TIMEOUT_GRACE_MS,
    Math.max(50, discussionTimeoutMs)
  );
  return discussionTimeoutMs + graceMs;
}

function computeTurnStatus(results) {
  const successCount = results.filter((entry) => entry.success).length;
  const failureCount = results.length - successCount;
  if (successCount === 0) {
    return 'failed';
  }
  if (failureCount > 0) {
    return 'partial';
  }
  return 'completed';
}

class RoomService {
  constructor(options = {}) {
    this.db = options.db;
    this.sessionManager = options.sessionManager;
    this.runLedger = options.runLedger || null;
    this.sessionEventsEnabled = options.sessionEventsEnabled === true;
    this.runDiscussion = typeof options.runDiscussion === 'function'
      ? options.runDiscussion
      : runDiscussion;
    this.defaultDiscussionTimeoutMs = parsePositiveInteger(
      options.discussionTimeoutMs || process.env.CLIAGENTS_ROOM_DISCUSSION_TIMEOUT_MS,
      DEFAULT_ROOM_DISCUSSION_TIMEOUT_MS
    );
  }

  createRoom(input = {}) {
    const room = this.db.createRoom({
      id: input.roomId,
      rootSessionId: input.rootSessionId,
      taskId: input.taskId || null,
      title: input.title || null,
      status: 'active',
      metadata: input.metadata || {}
    });

    const participants = (Array.isArray(input.participants) ? input.participants : []).map((participant) => (
      this.db.addRoomParticipant({
        roomId: room.id,
        adapter: participant.adapter,
        displayName: participant.displayName || participant.name || participant.adapter,
        model: participant.model || null,
        systemPrompt: participant.systemPrompt || null,
        workDir: participant.workDir || input.workDir || null,
        providerSessionId: participant.providerSessionId || null,
        importedFromProviderSessionId: participant.importedFromProviderSessionId || participant.providerSessionId || null,
        status: participant.status || 'active',
        metadata: participant.metadata || {}
      })
    ));

    this.db.addRoomMessage({
      roomId: room.id,
      role: 'system',
      content: `Room created with ${participants.length} participant(s).`,
      metadata: {
        participantIds: participants.map((participant) => participant.id)
      }
    });
    this.refreshRoomSnapshot(room.id);
    return this.getRoom(room.id);
  }

  getRoom(roomId) {
    const room = this.db.getRoom(roomId);
    if (!room) {
      return null;
    }

    return {
      room,
      participants: this.db.listRoomParticipants(roomId),
      latestTurn: this.db.getLatestRoomTurn(roomId) || null
    };
  }

  listRooms(options = {}) {
    return this.db.listRooms(options).map((room) => {
      const participants = this.db.listRoomParticipants(room.id);
      const latestTurn = this.db.getLatestRoomTurn(room.id) || null;
      return {
        room,
        latestTurn,
        participantCount: participants.length,
        messageCount: this.db.countRoomMessages(room.id)
      };
    });
  }

  getRoomByRootSessionId(rootSessionId) {
    const room = this.db.getRoomByRootSessionId(rootSessionId);
    if (!room) {
      return null;
    }
    return this.getRoom(room.id);
  }

  getRoomMessages(roomId, options = {}) {
    const room = this.db.getRoom(roomId);
    if (!room) {
      return null;
    }

    const requestedLimit = Math.max(1, Math.min(Number(options.limit || 100), 500));
    const afterId = Number.isInteger(options.afterId) ? options.afterId : undefined;
    const artifactMode = normalizeArtifactMode(options.artifactMode, 'exclude');
    const rows = this.db.listRoomMessages(roomId, {
      afterId,
      turnId: options.turnId || null,
      artifactMode,
      limit: requestedLimit + 1
    });
    const hasMore = rows.length > requestedLimit;
    const messages = rows.slice(0, requestedLimit);

    return {
      room,
      messages,
      pagination: {
        total: this.db.countRoomMessages(roomId, { artifactMode }),
        returned: messages.length,
        limit: requestedLimit,
        afterId: afterId || null,
        artifactMode,
        hasMore,
        nextAfterId: hasMore ? messages[messages.length - 1]?.id || null : null
      }
    };
  }

  _appendRoomSnapshotLineage(snapshot, room, recentMessages) {
    if (!snapshot?.id || !room?.id || typeof this.db.appendMemorySummaryEdge !== 'function') {
      return;
    }

    const sources = [
      { scopeType: 'room', scopeId: room.id },
      ...recentMessages.map((message) => ({
        scopeType: 'room_message',
        scopeId: String(message.id)
      }))
    ];
    for (const source of sources) {
      try {
        this.db.appendMemorySummaryEdge({
          edgeNamespace: 'derivation',
          parentScopeType: 'memory_snapshot',
          parentScopeId: snapshot.id,
          childScopeType: source.scopeType,
          childScopeId: source.scopeId,
          edgeKind: 'summarizes',
          metadata: {
            source: 'room-service.refreshRoomSnapshot',
            roomId: room.id
          }
        });
      } catch (error) {
        console.warn(`[RoomService] Room snapshot lineage failed for ${room.id}: ${error.message}`);
      }
    }
  }

  refreshRoomSnapshot(roomId) {
    const room = this.db.getRoom(roomId);
    if (!room) {
      return null;
    }

    const participants = this.db.listRoomParticipants(roomId);
    const recentMessages = this.db.getRecentRoomMessages(roomId, 12, { artifactMode: 'exclude' });
    this.db.upsertMemorySnapshot({
      scope: 'room',
      scopeId: room.id,
      rootSessionId: room.rootSessionId,
      taskId: room.taskId || null,
      brief: buildRoomSnapshotBrief(room, participants, recentMessages),
      keyDecisions: buildRoomSnapshotKeyDecisions(recentMessages),
      pendingItems: buildRoomSnapshotPendingItems(recentMessages),
      generationTrigger: 'manual',
      generationStrategy: 'rule_based',
      metadata: {
        roomId: room.id,
        participantIds: participants.map((participant) => participant.id),
        messageCount: this.db.countRoomMessages(roomId),
        lastMessageAt: recentMessages[recentMessages.length - 1]?.createdAt || null
      }
    });
    const snapshot = this.db.getMemorySnapshot('room', room.id);
    this._appendRoomSnapshotLineage(snapshot, room, recentMessages);
    return snapshot;
  }

  _resolveMentionedParticipants(roomId, mentions = []) {
    if (Array.isArray(mentions) && mentions.length > 0) {
      return this.db.getRoomParticipantsByIds(roomId, mentions).filter((participant) => participant.status === 'active');
    }
    return this.db.listRoomParticipants(roomId, { status: 'active' });
  }

  _collectDiscussionArtifacts(events = [], participantIndex = new Map()) {
    const artifacts = [];

    for (const event of Array.isArray(events) ? events : []) {
      if (event.type === 'discussion_started') {
        artifacts.push({
          role: 'system',
          content: `Room discussion started with ${event.participantCount || 0} participant(s).`,
          metadata: buildDiscussionArtifactMetadata({
            runId: event.runId || null,
            discussionId: event.discussionId || null
          }, {
            artifactType: 'discussion_started'
          }),
          createdAt: event.startedAt || Date.now()
        });
        continue;
      }

      if (event.type === 'round_started') {
        artifacts.push({
          role: 'system',
          content: `Round ${Number(event.roundIndex || 0) + 1}: ${event.roundName}`,
          metadata: buildDiscussionArtifactMetadata({
            runId: event.runId || null,
            discussionId: event.discussionId || null
          }, {
            artifactType: 'round_started',
            roundIndex: event.roundIndex,
            roundName: event.roundName || null,
            transcriptMode: event.transcriptMode || null
          }),
          createdAt: event.startedAt || Date.now()
        });
        continue;
      }

      if (event.type === 'participant_response') {
        const response = event.response || {};
        const participant = participantIndex.get(response.participantRef || '');
        artifacts.push({
          role: 'assistant',
          participantId: participant?.id || response.participantRef || null,
          content: response.output || '',
          metadata: buildDiscussionArtifactMetadata({
            runId: event.runId || null,
            discussionId: event.discussionId || null
          }, {
            artifactType: 'participant_response',
            roundIndex: event.roundIndex,
            roundName: event.roundName || null,
            adapter: response.adapter || participant?.adapter || null,
            displayName: response.name || participant?.displayName || null
          }),
          createdAt: Date.now()
        });
        continue;
      }

      if (event.type === 'participant_failure') {
        const response = event.response || {};
        const participant = participantIndex.get(response.participantRef || '');
        artifacts.push({
          role: 'system',
          participantId: participant?.id || response.participantRef || null,
          content: `${response.name || participant?.displayName || response.adapter || 'participant'} failed during ${event.roundName || 'discussion'}: ${response.error || 'unknown error'}`,
          metadata: buildDiscussionArtifactMetadata({
            runId: event.runId || null,
            discussionId: event.discussionId || null
          }, {
            artifactType: 'participant_failure',
            roundIndex: event.roundIndex,
            roundName: event.roundName || null,
            adapter: response.adapter || participant?.adapter || null,
            displayName: response.name || participant?.displayName || null,
            failureClass: response.failureClass || null
          }),
          createdAt: Date.now()
        });
        continue;
      }

      if (event.type === 'judge_completed' && event.judge) {
        artifacts.push({
          role: 'system',
          content: event.judge.success
            ? `Judge:\n${event.judge.output || ''}`
            : `Judge failed (${event.judge.failureClass || 'unknown'}): ${event.judge.error || 'unknown error'}`,
          metadata: buildDiscussionArtifactMetadata({
            runId: event.runId || null,
            discussionId: event.discussionId || null
          }, {
            artifactType: 'judge_completed',
            adapter: event.judge.adapter || null,
            displayName: event.judge.name || null,
            failureClass: event.judge.success ? null : (event.judge.failureClass || null)
          }),
          createdAt: Date.now()
        });
        continue;
      }

      if (event.type === 'discussion_failed') {
        artifacts.push({
          role: 'system',
          content: `Room discussion failed: ${event.error || 'unknown error'}`,
          metadata: buildDiscussionArtifactMetadata({
            runId: event.runId || null,
            discussionId: event.discussionId || null
          }, {
            artifactType: 'discussion_failed'
          }),
          createdAt: event.failedAt || Date.now()
        });
      }
    }

    return artifacts.filter((artifact) => artifact.content);
  }

  async _runParticipantTurn(room, participant, prompt) {
    const initialProviderSessionId = participant.providerSessionId || participant.importedFromProviderSessionId || null;
    let session = null;
    try {
      session = await this.sessionManager.createSession({
        adapter: participant.adapter,
        systemPrompt: participant.systemPrompt || null,
        workDir: participant.workDir || null,
        model: participant.model || null,
        providerSessionId: initialProviderSessionId
      });
      const response = await this.sessionManager.send(session.sessionId, prompt);
      const latestSession = typeof this.sessionManager.getSession === 'function'
        ? this.sessionManager.getSession(session.sessionId)
        : null;
      const providerSessionId = String(
        response?.metadata?.providerSessionId
        || latestSession?.providerSessionId
        || initialProviderSessionId
        || ''
      ).trim() || null;

      return {
        participantId: participant.id,
        adapter: participant.adapter,
        displayName: formatParticipantLabel(participant),
        success: true,
        content: response.result,
        providerSessionId,
        metadata: response.metadata || {}
      };
    } catch (error) {
      return {
        participantId: participant.id,
        adapter: participant.adapter,
        displayName: formatParticipantLabel(participant),
        success: false,
        error: error.message,
        providerSessionId: initialProviderSessionId
      };
    } finally {
      if (session?.sessionId) {
        try {
          await this.sessionManager.terminateSession(session.sessionId);
        } catch {}
      }
    }
  }

  async sendRoomMessage(roomId, input = {}) {
    const room = this.db.getRoom(roomId);
    if (!room) {
      const error = new Error(`Room ${roomId} not found`);
      error.code = 'not_found';
      throw error;
    }

    const turn = this.db.createRoomTurn({
      roomId,
      requestId: input.requestId || input.idempotencyKey || null,
      initiatorRole: input.initiatorRole || 'user',
      initiatorName: input.initiatorName || null,
      content: input.content,
      mentions: input.mentions || [],
      status: 'pending',
      metadata: input.metadata || {}
    });
    if (turn.reusedRequest) {
      return {
        roomId,
        turn,
        messages: this.db.listRoomMessages(roomId, { turnId: turn.id, limit: 500 }),
        participantResults: []
      };
    }

    const participants = this._resolveMentionedParticipants(roomId, input.mentions || []);
    if (participants.length === 0) {
      this.db.updateRoomTurn(turn.id, {
        status: 'failed',
        error: 'No active participants matched this room message',
        completedAt: Date.now()
      });
      throw new Error('No active participants matched this room message');
    }

    const startedAt = Date.now();
    this.db.updateRoomTurn(turn.id, {
      status: 'running',
      startedAt,
      metadata: {
        ...(turn.metadata || {}),
        participantIds: participants.map((participant) => participant.id)
      }
    });
    this.db.addRoomMessage({
      roomId,
      turnId: turn.id,
      role: 'user',
      content: input.content,
      metadata: {
        initiatorRole: input.initiatorRole || 'user',
        initiatorName: input.initiatorName || null,
        mentions: participants.map((participant) => participant.id)
      },
      createdAt: startedAt
    });

    let results;
    try {
      const bundle = this.db.getMemoryBundle(room.id, 'room', {
        recentRunsLimit: 3,
        includeRawPointers: true
      });
      if (!bundle) {
        console.debug(`[RoomService] No room memory bundle available yet for room ${roomId}`);
      }
      const recentMessages = this.db.getRecentRoomMessages(roomId, 12);
      results = await Promise.all(participants.map((participant) => (
        this._runParticipantTurn(
          room,
          participant,
          buildRoomPrompt(room, participant, bundle, recentMessages, input.content)
        )
      )));
    } catch (error) {
      this.db.updateRoomTurn(turn.id, {
        status: 'failed',
        error: error.message,
        completedAt: Date.now()
      });
      this.refreshRoomSnapshot(roomId);
      throw error;
    }

    const completedAt = Date.now();
    for (const result of results) {
      if (result.success) {
        this.db.updateRoomParticipant(result.participantId, {
          providerSessionId: result.providerSessionId,
          lastMessageAt: completedAt
        });
        this.db.addRoomMessage({
          roomId,
          turnId: turn.id,
          participantId: result.participantId,
          role: 'assistant',
          content: result.content,
          metadata: {
            adapter: result.adapter,
            displayName: result.displayName,
            providerSessionId: result.providerSessionId || null
          },
          createdAt: completedAt
        });
      } else {
        this.db.addRoomMessage({
          roomId,
          turnId: turn.id,
          participantId: result.participantId,
          role: 'system',
          content: `${result.displayName} failed to reply: ${result.error}`,
          metadata: {
            adapter: result.adapter,
            displayName: result.displayName,
            failure: true
          },
          createdAt: completedAt
        });
      }
    }

    const status = computeTurnStatus(results);
    const updatedTurn = this.db.updateRoomTurn(turn.id, {
      status,
      error: status === 'failed' ? results.map((entry) => entry.error).filter(Boolean).join('; ') : null,
      completedAt,
      metadata: {
        ...(turn.metadata || {}),
        participantIds: participants.map((participant) => participant.id),
        resultSummary: results.map((entry) => ({
          participantId: entry.participantId,
          success: entry.success
        }))
      }
    });
    this.refreshRoomSnapshot(roomId);

    return {
      roomId,
      turn: updatedTurn,
      participantResults: results,
      messages: this.db.listRoomMessages(roomId, { turnId: turn.id, limit: 500 })
    };
  }

  async discussRoom(roomId, input = {}) {
    const room = this.db.getRoom(roomId);
    if (!room) {
      const error = new Error(`Room ${roomId} not found`);
      error.code = 'not_found';
      throw error;
    }

    const participants = this._resolveMentionedParticipants(roomId, input.participantIds || input.mentions || []);
    if (participants.length === 0) {
      throw new Error('No active participants matched this room discussion');
    }

    const writebackMode = normalizeDiscussionWritebackMode(input.writebackMode, 'summary');
    const turn = this.db.createRoomTurn({
      roomId,
      requestId: input.requestId || input.idempotencyKey || null,
      initiatorRole: input.initiatorRole || 'user',
      initiatorName: input.initiatorName || null,
      content: input.message,
      mentions: participants.map((participant) => participant.id),
      status: 'running',
      metadata: {
        ...(input.metadata || {}),
        mode: 'discussion',
        writebackMode
      }
    });
    if (turn.reusedRequest) {
      return {
        roomId,
        turn,
        runId: turn.metadata?.runId || null,
        discussionId: turn.metadata?.discussionId || null,
        participants: [],
        rounds: [],
        judge: null,
        messages: this.db.listRoomMessages(roomId, { turnId: turn.id, artifactMode: 'include', limit: 500 })
      };
    }

    const startedAt = Date.now();
    this.db.addRoomMessage({
      roomId,
      turnId: turn.id,
      role: 'user',
      content: input.message,
      metadata: {
        mode: 'discussion',
        participantIds: participants.map((participant) => participant.id),
        writebackMode
      },
      createdAt: startedAt
    });

    let result;
    const discussionEvents = [];
    const discussionSink = (event) => {
      discussionEvents.push(event);
    };
    try {
      const discussionTimeoutMs = resolveDiscussionTimeoutMs(input.timeout, this.defaultDiscussionTimeoutMs);
      const bundle = this.db.getMemoryBundle(room.id, 'room', {
        recentRunsLimit: 3,
        includeRawPointers: true
      });
      if (!bundle) {
        console.debug(`[RoomService] No room memory bundle available yet for room discussion ${roomId}`);
      }
      const recentMessages = this.db.getRecentRoomMessages(roomId, 12, { artifactMode: 'exclude' });
      const discussionPromise = Promise.resolve().then(() => this.runDiscussion(this.sessionManager, input.message, {
        participants: participants.map((participant) => ({
          participantRef: participant.id,
          name: formatParticipantLabel(participant),
          adapter: participant.adapter,
          model: participant.model || null,
          systemPrompt: participant.systemPrompt || null,
          workDir: participant.workDir || null,
          providerSessionId: participant.providerSessionId || participant.importedFromProviderSessionId || null
        })),
        rounds: Array.isArray(input.rounds) ? input.rounds : undefined,
        judge: input.judge === undefined ? null : input.judge,
        timeout: input.timeout || null,
        workDir: input.workDir || participants[0]?.workDir || null,
        context: buildDiscussionContext(room, bundle, recentMessages),
        db: this.db,
        runLedger: this.runLedger,
        sessionEventsEnabled: this.sessionEventsEnabled,
        rootSessionId: room.rootSessionId,
        parentSessionId: room.rootSessionId,
        originClient: 'mcp',
        externalSessionRef: null,
        sessionMetadata: {
          roomDiscussion: true,
          roomId,
          turnId: turn.id
        },
        taskId: room.taskId || null,
        sink: discussionSink
      }));
      // If the outer timeout wins, consume a late runner rejection so the process
      // does not emit an unhandled rejection after the room turn has settled.
      discussionPromise.catch(() => {});
      result = await withTimeout(
        discussionPromise,
        computeDiscussionGuardTimeoutMs(discussionTimeoutMs),
        `Room discussion timed out after ${discussionTimeoutMs}ms`
      );
    } catch (error) {
      const failedAt = Date.now();
      const identifiers = extractDiscussionIdentifiers(discussionEvents);
      discussionEvents.push({
        type: 'discussion_failed',
        runId: identifiers.runId,
        discussionId: identifiers.discussionId,
        error: error.message,
        failedAt
      });
      if (writebackMode === 'curated_transcript') {
        const participantIndex = new Map(participants.map((participant) => [participant.id, participant]));
        for (const artifact of this._collectDiscussionArtifacts(discussionEvents, participantIndex)) {
          this.db.addRoomMessage({
            roomId,
            turnId: turn.id,
            participantId: artifact.participantId || null,
            role: artifact.role,
            content: artifact.content,
            metadata: artifact.metadata,
            createdAt: artifact.createdAt
          });
        }
      }
      this.db.addRoomMessage({
        roomId,
        turnId: turn.id,
        role: 'system',
        content: `Room discussion failed: ${error.message}`,
        metadata: {
          mode: 'discussion-summary',
          writebackMode,
          runId: identifiers.runId,
          discussionId: identifiers.discussionId,
          failure: true
        },
        createdAt: failedAt
      });
      this.db.updateRoomTurn(turn.id, {
        status: 'failed',
        error: error.message,
        completedAt: failedAt,
        metadata: {
          ...(turn.metadata || {}),
          mode: 'discussion',
          writebackMode,
          runId: identifiers.runId,
          discussionId: identifiers.discussionId,
          participantIds: participants.map((participant) => participant.id)
        }
      });
      this.refreshRoomSnapshot(roomId);
      throw error;
    }

    const completedAt = Date.now();
    for (const participantResult of result.participants || []) {
      if (participantResult.participantRef && participantResult.providerSessionId) {
        this.db.updateRoomParticipant(participantResult.participantRef, {
          providerSessionId: participantResult.providerSessionId,
          lastMessageAt: completedAt
        });
      }
    }

    if (writebackMode === 'curated_transcript') {
      const participantIndex = new Map(participants.map((participant) => [participant.id, participant]));
      for (const artifact of this._collectDiscussionArtifacts(discussionEvents, participantIndex)) {
        this.db.addRoomMessage({
          roomId,
          turnId: turn.id,
          participantId: artifact.participantId || null,
          role: artifact.role,
          content: artifact.content,
          metadata: artifact.metadata,
          createdAt: artifact.createdAt
        });
      }
    }

    const discussionSummary = [
      `Room discussion completed with ${(result.participants || []).length} participant(s).`,
      result.judge?.success && result.judge.output ? `Judge:\n${truncateText(result.judge.output, 900)}` : null,
      Array.isArray(result.rounds) && result.rounds.length > 0
        ? `Rounds:\n${result.rounds.map((round) => `${round.name}: ${round.responses.filter((entry) => entry.success).length}/${round.responses.length} succeeded`).join('\n')}`
        : null
    ].filter(Boolean).join('\n\n');

    this.db.addRoomMessage({
      roomId,
      turnId: turn.id,
      role: 'system',
      content: discussionSummary,
      metadata: {
        mode: 'discussion-summary',
        writebackMode,
        runId: result.runId || null,
        discussionId: result.discussionId || null
      },
      createdAt: completedAt
    });

    const successfulCount = (result.participants || []).filter((entry) => entry.success).length;
    const status = successfulCount === 0
      ? 'failed'
      : (successfulCount < (result.participants || []).length ? 'partial' : 'completed');

    const updatedTurn = this.db.updateRoomTurn(turn.id, {
      status,
      completedAt,
      metadata: {
        ...(turn.metadata || {}),
        mode: 'discussion',
        writebackMode,
        runId: result.runId || null,
        discussionId: result.discussionId || null,
        participantIds: participants.map((participant) => participant.id)
      }
    });
    this.refreshRoomSnapshot(roomId);

    return {
      roomId,
      turn: updatedTurn,
      runId: result.runId || null,
      discussionId: result.discussionId || null,
      participants: result.participants || [],
      rounds: result.rounds || [],
      judge: result.judge || null,
      messages: this.db.listRoomMessages(roomId, { turnId: turn.id, artifactMode: 'include', limit: 500 })
    };
  }
}

module.exports = {
  RoomService
};
