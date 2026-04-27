#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function loadMcpModule(envOverrides = {}) {
  const modulePath = require.resolve('../src/mcp/cliagents-mcp-server');
  delete require.cache[modulePath];

  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const mod = require('../src/mcp/cliagents-mcp-server');

  return {
    mod,
    restore() {
      delete require.cache[modulePath];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

async function startFakeCliagentsServer() {
  const state = {
    rootsResponse: { roots: [] },
    adaptersResponse: {
      count: 2,
      adapters: {
        'codex-cli': {
          description: 'Codex CLI',
          models: [
            { id: 'default', name: 'Default', description: 'Uses the CLI default model' },
            { id: 'o4-mini', name: 'o4-mini', description: 'Fast reasoning model' }
          ],
          runtimeProviders: []
        },
        'claude-code': {
          description: 'Claude Code',
          models: [
            { id: 'default', name: 'Default', description: 'Uses Claude default model' },
            { id: 'claude-opus-4-5-20250514', name: 'Claude Opus 4.5', description: 'Most capable Claude model' }
          ],
          runtimeProviders: [
            { name: 'anthropic' }
          ]
        }
      }
    },
    recommendModelResponse: {
      adapter: 'opencode-cli',
      role: 'implement',
      taskType: 'implement',
      selectedModel: 'minimax-coding-plan/MiniMax-M2.7',
      selectedProvider: 'minimax-coding-plan',
      selectedFamily: 'minimax',
      strategy: 'config-ranked-exact',
      familyOrder: ['minimax', 'qwen'],
      summary: 'Selected minimax-coding-plan/MiniMax-M2.7 for implement using minimax policy.',
      candidates: [
        {
          family: 'minimax',
          provider: 'minimax-coding-plan',
          model: 'minimax-coding-plan/MiniMax-M2.7',
          available: true
        },
        {
          family: 'qwen',
          provider: 'openrouter',
          model: 'openrouter/qwen/qwen3.6-plus',
          available: true
        }
      ]
    },
    rootDetailResponse: null,
    rootDetailById: new Map(),
    memoryBundleResponse: null,
    memoryBundleByScopeId: new Map(),
    memoryMessagesResponse: null,
    providerSessionsResponse: null,
    providerSessionImportResponses: [],
    providerSessionImportBodies: [],
    roomCreateResponses: [],
    roomCreateBodies: [],
    roomById: new Map(),
    roomMessagesById: new Map(),
    roomMessageResponses: [],
    roomMessageBodies: [],
    roomDiscussResponses: [],
    roomDiscussBodies: [],
    attachResponses: [],
    attachBodies: [],
    launchResponses: [],
    launchBodies: [],
    adoptResponses: [],
    adoptBodies: [],
    routeResponse: null,
    lastRouteBody: null,
    lastOutputUrl: null,
    inputResponses: [],
    inputBodies: []
  };

  const server = http.createServer(async (req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const readBody = async () => {
      let data = '';
      for await (const chunk of req) {
        data += chunk;
      }
      return data ? JSON.parse(data) : {};
    };

    if (req.method === 'POST' && req.url === '/orchestration/root-sessions/attach') {
      const body = await readBody();
      state.attachBodies.push(body);
      const response = state.attachResponses.length > 0
        ? state.attachResponses.shift()
        : {
            rootSessionId: 'attached-root',
            originClient: body.originClient || 'mcp',
            externalSessionRef: body.externalSessionRef,
            clientName: body.sessionMetadata?.clientName || 'mcp-client',
            attachedRoot: true,
            reusedAttachedRoot: false,
            sessionMetadata: body.sessionMetadata || {}
          };
      return writeJson(200, response);
    }

    if (req.method === 'POST' && req.url === '/orchestration/root-sessions/launch') {
      const body = await readBody();
      state.launchBodies.push(body);
      const response = state.launchResponses.length > 0
        ? state.launchResponses.shift()
        : {
            rootSessionId: 'launched-root',
            terminalId: 'launched-terminal',
            sessionName: 'cliagents-launched',
            adapter: body.adapter || 'codex-cli',
            externalSessionRef: body.externalSessionRef || 'codex:thread-launched',
            attachCommand: 'tmux attach -t "cliagents-launched"',
            consoleUrl: '/console',
            managedRoot: true
          };
      return writeJson(200, response);
    }

    if (req.method === 'POST' && req.url === '/orchestration/root-sessions/adopt') {
      const body = await readBody();
      state.adoptBodies.push(body);
      const response = state.adoptResponses.length > 0
        ? state.adoptResponses.shift()
        : {
            rootSessionId: 'adopted-root',
            terminalId: 'adopted-terminal',
            adapter: body.adapter || 'codex-cli',
            tmuxTarget: body.tmuxTarget || `${body.sessionName}:${body.windowName}`,
            externalSessionRef: body.externalSessionRef || 'codex:thread-adopted',
            attachCommand: 'tmux attach -t "cliagents-adopted"',
            consoleUrl: '/console',
            adoptedRoot: true
          };
      return writeJson(200, response);
    }

    if (
      req.method === 'GET' &&
      (req.url === '/orchestration/root-sessions' || req.url.startsWith('/orchestration/root-sessions?'))
    ) {
      return writeJson(200, state.rootsResponse);
    }

    if (req.method === 'GET' && req.url === '/orchestration/adapters') {
      return writeJson(200, state.adaptersResponse);
    }

    if (req.method === 'POST' && req.url === '/orchestration/model-routing/recommend') {
      return writeJson(200, state.recommendModelResponse);
    }

    const memoryBundleMatch = req.url.match(/^\/orchestration\/memory\/bundle\/([^?]+)(\?.*)?$/);
    if (req.method === 'GET' && memoryBundleMatch) {
      const scopeId = decodeURIComponent(memoryBundleMatch[1]);
      const bundle = state.memoryBundleByScopeId.get(scopeId) || state.memoryBundleResponse;
      if (!bundle) {
        return writeJson(404, { error: { message: 'not found' } });
      }
      return writeJson(200, bundle);
    }

    if (req.method === 'GET' && req.url.startsWith('/orchestration/memory/messages?')) {
      return writeJson(200, state.memoryMessagesResponse || { messages: [] });
    }

    if (req.method === 'GET' && req.url.startsWith('/orchestration/provider-sessions')) {
      return writeJson(200, state.providerSessionsResponse || {
        adapter: 'codex-cli',
        supported: true,
        sessions: []
      });
    }

    if (req.method === 'POST' && req.url === '/orchestration/provider-sessions/import') {
      const body = await readBody();
      state.providerSessionImportBodies.push(body);
      const response = state.providerSessionImportResponses.length > 0
        ? state.providerSessionImportResponses.shift()
        : {
            importedRoot: true,
            reusedImportedRoot: false,
            rootSessionId: 'imported-root-1',
            adapter: body.adapter || 'codex-cli',
            providerSessionId: body.providerSessionId,
            externalSessionRef: body.externalSessionRef || `provider-import:${body.adapter || 'codex-cli'}:${body.providerSessionId}`,
            descriptor: {
              title: 'Imported provider session'
            }
          };
      return writeJson(200, response);
    }

    if (req.method === 'POST' && req.url === '/orchestration/rooms') {
      const body = await readBody();
      state.roomCreateBodies.push(body);
      const response = state.roomCreateResponses.length > 0
        ? state.roomCreateResponses.shift()
        : {
            room: {
              id: body.roomId || 'room-1',
              rootSessionId: 'room-root-1',
              title: body.title || 'Room 1'
            },
            participants: Array.isArray(body.participants)
              ? body.participants.map((participant, index) => ({
                  id: `participant-${index + 1}`,
                  adapter: participant.adapter,
                  displayName: participant.displayName || participant.name || participant.adapter
                }))
              : [],
            latestTurn: null
          };
      if (response.room?.id) {
        state.roomById.set(response.room.id, response);
      }
      return writeJson(200, response);
    }

    const roomMessagesMatch = req.url.match(/^\/orchestration\/rooms\/([^/]+)\/messages(\?.*)?$/);
    if (roomMessagesMatch && req.method === 'GET') {
      const roomId = decodeURIComponent(roomMessagesMatch[1]);
      const payload = state.roomMessagesById.get(roomId) || {
        room: { id: roomId, rootSessionId: 'room-root-1' },
        messages: []
      };
      return writeJson(200, payload);
    }

    if (roomMessagesMatch && req.method === 'POST') {
      const roomId = decodeURIComponent(roomMessagesMatch[1]);
      const body = await readBody();
      state.roomMessageBodies.push({ roomId, body });
      const response = state.roomMessageResponses.length > 0
        ? state.roomMessageResponses.shift()
        : {
            roomId,
            turn: { id: 'turn-1', status: 'completed' },
            participantResults: [{ participantId: 'participant-1', success: true }],
            messages: [
              { id: 1, role: 'user', content: body.content },
              { id: 2, role: 'assistant', participantId: 'participant-1', content: 'Done.' }
            ]
          };
      return writeJson(200, response);
    }

    const roomDiscussMatch = req.url.match(/^\/orchestration\/rooms\/([^/]+)\/discuss$/);
    if (roomDiscussMatch && req.method === 'POST') {
      const roomId = decodeURIComponent(roomDiscussMatch[1]);
      const body = await readBody();
      state.roomDiscussBodies.push({ roomId, body });
      const response = state.roomDiscussResponses.length > 0
        ? state.roomDiscussResponses.shift()
        : {
            roomId,
            turn: { id: 'turn-discuss-1', status: 'completed' },
            runId: 'run-room-1',
            discussionId: 'discussion-room-1'
          };
      return writeJson(200, response);
    }

    const roomMatch = req.url.match(/^\/orchestration\/rooms\/([^/?]+)$/);
    if (roomMatch && req.method === 'GET') {
      const roomId = decodeURIComponent(roomMatch[1]);
      const payload = state.roomById.get(roomId);
      if (!payload) {
        return writeJson(404, { error: { message: 'not found' } });
      }
      return writeJson(200, payload);
    }

    const detailMatch = req.url.match(/^\/orchestration\/root-sessions\/([^?]+)(\?.*)?$/);
    if (req.method === 'GET' && detailMatch) {
      const rootSessionId = decodeURIComponent(detailMatch[1]);
      const detail = state.rootDetailById.get(rootSessionId) || state.rootDetailResponse;
      if (!detail) {
        return writeJson(404, { error: { message: 'not found' } });
      }
      return writeJson(200, detail);
    }

    if (req.method === 'POST' && req.url === '/orchestration/route') {
      state.lastRouteBody = await readBody();
      return writeJson(200, state.routeResponse || {
        terminalId: 'attached-terminal',
        adapter: state.lastRouteBody?.forceAdapter || 'codex-cli',
        taskType: state.lastRouteBody?.forceRole || 'review',
        profile: 'review_codex-cli'
      });
    }

    const statusMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) {
      return writeJson(200, {
        terminalId: statusMatch[1],
        status: 'completed',
        adapter: 'codex-cli',
        agentProfile: 'review_codex-cli'
      });
    }

    const outputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/output(\?.*)?$/);
    if (req.method === 'GET' && outputMatch) {
      state.lastOutputUrl = req.url;
      return writeJson(200, { output: 'Attached root task completed' });
    }

    const inputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/input$/);
    if (req.method === 'POST' && inputMatch) {
      const body = await readBody();
      state.inputBodies.push(body);
      const response = state.inputResponses.length > 0
        ? state.inputResponses.shift()
        : { success: true };
      if (response.status && response.status !== 200) {
        return writeJson(response.status, response.body);
      }
      return writeJson(200, response.body || response);
    }

    return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function run() {
  const fakeServer = await startFakeCliagentsServer();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-mcp-root-state-'));
  const envOverrides = {
    CLIAGENTS_URL: fakeServer.baseUrl,
    CLIAGENTS_CLIENT_NAME: 'opencode',
    CLIAGENTS_WORKSPACE_ROOT: '/Users/mojave/Documents/AI-projects/cliagents',
    CLIAGENTS_MCP_SESSION_SCOPE: 'session-alpha',
    CLIAGENTS_MCP_STATE_DIR: stateDir,
    CLIAGENTS_REQUIRE_ROOT_ATTACH: '',
    CLIAGENTS_ROOT_SESSION_ID: '',
    CLIAGENTS_CLIENT_SESSION_REF: ''
  };
  const { mod, restore } = loadMcpModule(envOverrides);

  try {
    const ensureTool = mod.TOOLS.find((tool) => tool.name === 'ensure_root_session');
    assert(ensureTool, 'ensure_root_session should be exposed in the MCP tool list');
    const attachTool = mod.TOOLS.find((tool) => tool.name === 'attach_root_session');
    assert(attachTool, 'attach_root_session should be exposed in the MCP tool list');
    const resetTool = mod.TOOLS.find((tool) => tool.name === 'reset_root_session');
    assert(resetTool, 'reset_root_session should be exposed in the MCP tool list');
    const launchTool = mod.TOOLS.find((tool) => tool.name === 'launch_root_session');
    assert(launchTool, 'launch_root_session should be exposed in the MCP tool list');
    const adoptTool = mod.TOOLS.find((tool) => tool.name === 'adopt_root_session');
    assert(adoptTool, 'adopt_root_session should be exposed in the MCP tool list');
    const listModelsTool = mod.TOOLS.find((tool) => tool.name === 'list_models');
    assert(listModelsTool, 'list_models should be exposed in the MCP tool list');
    const recommendModelTool = mod.TOOLS.find((tool) => tool.name === 'recommend_model');
    assert(recommendModelTool, 'recommend_model should be exposed in the MCP tool list');
    const listProviderSessionsTool = mod.TOOLS.find((tool) => tool.name === 'list_provider_sessions');
    assert(listProviderSessionsTool, 'list_provider_sessions should be exposed in the MCP tool list');
    const importProviderSessionTool = mod.TOOLS.find((tool) => tool.name === 'import_provider_session');
    assert(importProviderSessionTool, 'import_provider_session should be exposed in the MCP tool list');
    const createRoomTool = mod.TOOLS.find((tool) => tool.name === 'create_room');
    assert(createRoomTool, 'create_room should be exposed in the MCP tool list');
    const sendRoomMessageTool = mod.TOOLS.find((tool) => tool.name === 'send_room_message');
    assert(sendRoomMessageTool, 'send_room_message should be exposed in the MCP tool list');
    const getRoomTool = mod.TOOLS.find((tool) => tool.name === 'get_room');
    assert(getRoomTool, 'get_room should be exposed in the MCP tool list');
    const getRoomMessagesTool = mod.TOOLS.find((tool) => tool.name === 'get_room_messages');
    assert(getRoomMessagesTool, 'get_room_messages should be exposed in the MCP tool list');
    const discussRoomTool = mod.TOOLS.find((tool) => tool.name === 'discuss_room');
    assert(discussRoomTool, 'discuss_room should be exposed in the MCP tool list');

    fakeServer.state.rootsResponse = {
      roots: [
        {
          rootSessionId: 'root-123',
          status: 'blocked',
          eventCount: 7,
          rootMode: 'attached',
          interactiveTerminalId: null,
          activitySummary: 'Waiting for operator approval before continuing.',
          attention: {
            requiresAttention: true,
            reasons: [{ code: 'user_input_required' }]
          }
        }
      ]
    };

    const listResult = await mod.handleListRootSessions({ limit: 5 });
    const listText = listResult.content[0].text;
    assert(listText.includes('Root Sessions'));
    assert(listText.includes('root-123'));
    assert(listText.includes('status=blocked'));
    assert(listText.includes('mode=attached'));
    assert(listText.includes('summary="Waiting for operator approval before continuing."'));

    fakeServer.state.rootDetailResponse = {
      rootSessionId: 'root-123',
      status: 'blocked',
      rootMode: 'attached',
      interactiveTerminalId: null,
      activitySummary: 'Waiting for operator approval before continuing.',
      activityExcerpt: 'Need approval',
      activitySource: 'attention',
      counts: {
        sessions: 3,
        running: 1,
        blocked: 1,
        stale: 0,
        reuseEvents: 2,
        reusedSessions: 1
      },
      attention: {
        reasons: [{ code: 'user_input_required' }]
      },
      latestConclusion: {
        summary: 'Proceed with async-first delegation.'
      },
      sessions: [
        {
          sessionId: 'root-123',
          status: 'running',
          sessionKind: 'attach'
        },
        {
          sessionId: 'child-review-1',
          status: 'blocked',
          sessionKind: 'reviewer',
          adapter: 'qwen-cli',
          agentProfile: 'review_qwen-cli'
        }
      ]
    };

    const detailResult = await mod.handleGetRootSessionStatus({
      rootSessionId: 'root-123'
    });
    const detailText = detailResult.content[0].text;
    assert(detailText.includes('Root Session: root-123'));
    assert(detailText.includes('status: blocked'));
    assert(detailText.includes('root_mode: attached'));
    assert(detailText.includes('activity_summary: Waiting for operator approval before continuing.'));
    assert(detailText.includes('reuse_events: 2'));
    assert(detailText.includes('reused_sessions: 1'));
    assert(detailText.includes('latest_conclusion: Proceed with async-first delegation.'));
    assert(detailText.includes('child-review-1 status=blocked'));

    const jsonResult = await mod.handleGetRootSessionStatus({
      rootSessionId: 'root-123',
      format: 'json'
    });
    const parsed = JSON.parse(jsonResult.content[0].text);
    assert.strictEqual(parsed.rootSessionId, 'root-123');
    assert.strictEqual(parsed.status, 'blocked');

    const modelsSummary = await mod.handleListModels({});
    const modelsSummaryText = modelsSummary.content[0].text;
    assert(modelsSummaryText.includes('Adapter Models'));
    assert(modelsSummaryText.includes('codex-cli: 2 models'));

    const claudeModels = await mod.handleListModels({ adapter: 'claude-code' });
    const claudeModelsText = claudeModels.content[0].text;
    assert(claudeModelsText.includes('Models: claude-code'));
    assert(claudeModelsText.includes('claude-opus-4-5-20250514'));
    assert(claudeModelsText.includes('runtime_providers: anthropic'));

    const recommended = await mod.handleRecommendModel({
      adapter: 'opencode-cli',
      role: 'implement'
    });
    const recommendedText = recommended.content[0].text;
    assert(recommendedText.includes('Model Recommendation: opencode-cli'));
    assert(recommendedText.includes('selected_model: minimax-coding-plan/MiniMax-M2.7'));
    assert(recommendedText.includes('selected_provider: minimax-coding-plan'));

    fakeServer.state.providerSessionsResponse = {
      adapter: 'codex-cli',
      supported: true,
      sessions: [
        {
          providerSessionId: 'session-abc',
          title: 'Finance tracker',
          updatedAt: '2026-04-22T10:00:00.000Z',
          cwd: '/tmp/finance-tracker',
          resumeCapability: 'exact'
        }
      ]
    };
    const providerSessionsResult = await mod.handleListProviderSessions({
      adapter: 'codex-cli'
    });
    const providerSessionsText = providerSessionsResult.content[0].text;
    assert(providerSessionsText.includes('Provider Sessions (codex-cli)'));
    assert(providerSessionsText.includes('session-abc'));
    assert(providerSessionsText.includes('title="Finance tracker"'));

    fakeServer.state.providerSessionImportResponses = [
      {
        importedRoot: true,
        reusedImportedRoot: false,
        rootSessionId: 'imported-root-1',
        adapter: 'codex-cli',
        providerSessionId: 'session-abc',
        externalSessionRef: 'provider-import:codex-cli:session-abc',
        descriptor: {
          title: 'Finance tracker'
        }
      }
    ];
    const importProviderResult = await mod.handleImportProviderSession({
      adapter: 'codex-cli',
      providerSessionId: 'session-abc'
    });
    const importProviderText = importProviderResult.content[0].text;
    assert(importProviderText.includes('Provider Session Imported'));
    assert(importProviderText.includes('provider_session_id: session-abc'));
    assert.strictEqual(fakeServer.state.providerSessionImportBodies.at(-1).adapter, 'codex-cli');
    assert.strictEqual(fakeServer.state.providerSessionImportBodies.at(-1).providerSessionId, 'session-abc');

    fakeServer.state.launchResponses = [
      {
        rootSessionId: 'managed-root-1',
        terminalId: 'managed-terminal-1',
        sessionName: 'cliagents-managed-1',
        adapter: 'codex-cli',
        externalSessionRef: 'codex:thread-managed-1',
        attachCommand: 'tmux attach -t "cliagents-managed-1"',
        consoleUrl: '/console?root=managed-root-1&terminal=managed-terminal-1',
        managedRoot: true
      }
    ];
    const launchResult = await mod.handleLaunchRootSession({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      profile: 'supervised-root',
      permissionMode: 'bypassPermissions'
    });
    const launchText = launchResult.content[0].text;
    assert(launchText.includes('Managed Root Launched'));
    assert(launchText.includes('root_session_id: managed-root-1'));
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).adapter, 'codex-cli');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).workDir, '/tmp/project');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).permissionMode, 'bypassPermissions');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).sessionMetadata.launchProfile, 'supervised-root');

    fakeServer.state.launchResponses = [
      {
        rootSessionId: 'managed-root-exact-1',
        terminalId: 'managed-terminal-exact-1',
        sessionName: 'cliagents-managed-exact-1',
        adapter: 'codex-cli',
        externalSessionRef: 'codex:thread-exact-1',
        attachCommand: 'tmux attach -t "cliagents-managed-exact-1"',
        consoleUrl: '/console?root=managed-root-exact-1&terminal=managed-terminal-exact-1',
        managedRoot: true
      }
    ];
    const exactLaunchResult = await mod.handleLaunchRootSession({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      resumeMode: 'exact',
      providerSessionId: 'session-abc'
    });
    const exactLaunchText = exactLaunchResult.content[0].text;
    assert(exactLaunchText.includes('Managed Root Exact Resumed'));
    assert(exactLaunchText.includes('provider_session_id: session-abc'));
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).resumeMode, 'exact');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).providerSessionId, 'session-abc');

    fakeServer.state.roomCreateResponses = [
      {
        room: {
          id: 'room-1',
          rootSessionId: 'room-root-1',
          title: 'Planning room'
        },
        participants: [
          { id: 'participant-1', adapter: 'codex-cli', displayName: 'Codex' },
          { id: 'participant-2', adapter: 'claude-code', displayName: 'Claude' }
        ],
        latestTurn: null
      }
    ];
    const createRoomResult = await mod.handleCreateRoom({
      title: 'Planning room',
      participants: [
        { adapter: 'codex-cli', displayName: 'Codex' },
        { adapter: 'claude-code', displayName: 'Claude' }
      ]
    });
    const createRoomText = createRoomResult.content[0].text;
    assert(createRoomText.includes('Room Created'));
    assert(createRoomText.includes('room_id: room-1'));
    assert.strictEqual(fakeServer.state.roomCreateBodies.at(-1).title, 'Planning room');

    fakeServer.state.roomById.set('room-1', {
      room: {
        id: 'room-1',
        rootSessionId: 'room-root-1',
        title: 'Planning room'
      },
      participants: [
        { id: 'participant-1', adapter: 'codex-cli', displayName: 'Codex' },
        { id: 'participant-2', adapter: 'claude-code', displayName: 'Claude' }
      ],
      latestTurn: {
        id: 'turn-1',
        status: 'completed'
      }
    });
    const getRoomResult = await mod.handleGetRoom({ roomId: 'room-1' });
    const getRoomText = getRoomResult.content[0].text;
    assert(getRoomText.includes('## Room'));
    assert(getRoomText.includes('room_id: room-1'));
    assert(getRoomText.includes('latest_turn_status: completed'));

    fakeServer.state.roomMessageResponses = [
      {
        roomId: 'room-1',
        turn: { id: 'turn-1', status: 'completed' },
        participantResults: [
          { participantId: 'participant-1', success: true },
          { participantId: 'participant-2', success: true }
        ],
        messages: [
          { id: 1, role: 'user', content: 'Give an update.' },
          { id: 2, role: 'assistant', participantId: 'participant-1', content: 'Codex update.' },
          { id: 3, role: 'assistant', participantId: 'participant-2', content: 'Claude update.' }
        ]
      }
    ];
    const sendRoomMessageResult = await mod.handleSendRoomMessage({
      roomId: 'room-1',
      content: 'Give an update.',
      mentions: ['participant-1'],
      requestId: 'room-turn-1'
    });
    const sendRoomMessageText = sendRoomMessageResult.content[0].text;
    assert(sendRoomMessageText.includes('Room Turn Completed'));
    assert(sendRoomMessageText.includes('participant_results: 2'));
    assert.strictEqual(fakeServer.state.roomMessageBodies.at(-1).roomId, 'room-1');
    assert.strictEqual(fakeServer.state.roomMessageBodies.at(-1).body.requestId, 'room-turn-1');

    fakeServer.state.roomMessagesById.set('room-1', {
      room: {
        id: 'room-1',
        rootSessionId: 'room-root-1'
      },
      messages: [
        { id: 1, role: 'system', content: 'Room created.' },
        { id: 2, role: 'user', content: 'Give an update.' },
        { id: 3, role: 'assistant', participantId: 'participant-1', content: 'Codex update.' }
      ]
    });
    const getRoomMessagesResult = await mod.handleGetRoomMessages({
      roomId: 'room-1',
      afterId: 1,
      limit: 10
    });
    const getRoomMessagesText = getRoomMessagesResult.content[0].text;
    assert(getRoomMessagesText.includes('Room Messages'));
    assert(getRoomMessagesText.includes('returned: 3'));
    assert(getRoomMessagesText.includes('3. assistant(participant-1): Codex update.'));

    fakeServer.state.roomDiscussResponses = [
      {
        roomId: 'room-1',
        turn: { id: 'turn-discuss-1', status: 'completed' },
        runId: 'run-room-1',
        discussionId: 'discussion-room-1'
      }
    ];
    const discussRoomResult = await mod.handleDiscussRoom({
      roomId: 'room-1',
      message: 'Debate the persistence plan.'
    });
    const discussRoomText = discussRoomResult.content[0].text;
    assert(discussRoomText.includes('Room Discussion Completed'));
    assert(discussRoomText.includes('discussion_id: discussion-room-1'));
    assert.strictEqual(fakeServer.state.roomDiscussBodies.at(-1).roomId, 'room-1');
    assert.strictEqual(fakeServer.state.roomDiscussBodies.at(-1).body.message, 'Debate the persistence plan.');

    fakeServer.state.adoptResponses = [
      {
        rootSessionId: 'adopted-root-1',
        terminalId: 'adopted-terminal-1',
        adapter: 'gemini-cli',
        tmuxTarget: 'cliagents-gemini:0',
        externalSessionRef: 'gemini:thread-adopted-1',
        attachCommand: 'tmux attach -t "cliagents-gemini"',
        consoleUrl: '/console?root=adopted-root-1&terminal=adopted-terminal-1',
        adoptedRoot: true
      }
    ];
    const adoptResult = await mod.handleAdoptRootSession({
      adapter: 'gemini-cli',
      tmuxTarget: 'cliagents-gemini:0',
      workDir: '/tmp/project'
    });
    const adoptText = adoptResult.content[0].text;
    assert(adoptText.includes('Root Session Adopted'));
    assert(adoptText.includes('root_session_id: adopted-root-1'));
    assert.strictEqual(fakeServer.state.adoptBodies.at(-1).adapter, 'gemini-cli');
    assert.strictEqual(fakeServer.state.adoptBodies.at(-1).tmuxTarget, 'cliagents-gemini:0');
    assert.strictEqual(fakeServer.state.adoptBodies.at(-1).workDir, '/tmp/project');

    fakeServer.state.rootsResponse = {
      roots: [
        {
          rootSessionId: 'recover-root-1',
          originClient: 'claude',
          status: 'needs_attention'
        }
      ]
    };
    fakeServer.state.rootDetailById.set('recover-root-1', {
      rootSessionId: 'recover-root-1',
      status: 'needs_attention',
      rootSession: {
        sessionId: 'recover-root-1',
        adapter: 'claude-code',
        originClient: 'claude',
        status: 'needs_attention',
        processState: 'exited',
        workDir: '/tmp/project',
        providerThreadRef: '019d94a6-2cd8-7742-8e4e-123456789abc',
        sessionMetadata: {
          attachMode: 'managed-root-launch',
          managedLaunch: true,
          clientName: 'claude'
        }
      },
      sessions: [
        {
          sessionId: 'recover-root-1',
          role: 'main',
          sessionKind: 'main',
          providerThreadRef: '019d94a6-2cd8-7742-8e4e-123456789abc'
        }
      ],
      terminals: [
        {
          terminal_id: 'recover-root-1',
          session_name: 'cliagents-recover-1',
          role: 'main',
          session_kind: 'main',
          process_state: 'exited',
          status: 'idle',
          work_dir: '/tmp/project',
          origin_client: 'claude',
          external_session_ref: 'claude:thread-recover-1',
          provider_thread_ref: '019d94a6-2cd8-7742-8e4e-123456789abc'
        }
      ],
      events: []
    });
    fakeServer.state.launchResponses = [
      {
        rootSessionId: 'recovered-root-2',
        terminalId: 'recovered-terminal-2',
        sessionName: 'cliagents-recovered-2',
        adapter: 'claude-code',
        externalSessionRef: 'claude:thread-recovered-2',
        attachCommand: 'tmux attach -t "cliagents-recovered-2"',
        consoleUrl: '/console?root=recovered-root-2&terminal=recovered-terminal-2',
        managedRoot: true
      }
    ];
    const recoveryResult = await mod.handleLaunchRootSession({
      adapter: 'claude-code',
      workDir: '/tmp/project',
      recoverLatest: true,
      permissionMode: 'default'
    });
    const recoveryText = recoveryResult.content[0].text;
    assert(recoveryText.includes('Managed Root Recovered'));
    assert(recoveryText.includes('previous_root_session_id: recover-root-1'));
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).adapter, 'claude-code');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).permissionMode, 'default');
    assert.strictEqual(
      fakeServer.state.launchBodies.at(-1).sessionMetadata.providerResumeSessionId,
      '019d94a6-2cd8-7742-8e4e-123456789abc'
    );

    fakeServer.state.rootsResponse = {
      roots: [
        {
          rootSessionId: 'context-root-1',
          originClient: 'codex',
          status: 'needs_attention',
          recoveryCapability: 'context_resume'
        }
      ]
    };
    fakeServer.state.rootDetailById.set('context-root-1', {
      rootSessionId: 'context-root-1',
      status: 'needs_attention',
      rootMode: 'managed',
      recoveryCapability: 'context_resume',
      rootSession: {
        sessionId: 'context-root-1',
        adapter: 'codex-cli',
        originClient: 'codex',
        status: 'needs_attention',
        model: 'o4-mini',
        sessionMetadata: {
          attachMode: 'managed-root-launch',
          managedLaunch: true,
          clientName: 'codex'
        },
        externalSessionRef: 'codex:thread-context-1'
      },
      sessions: [
        {
          sessionId: 'context-root-1',
          role: 'main',
          sessionKind: 'main'
        }
      ],
      terminals: [
        {
          terminal_id: 'context-root-1',
          session_name: 'cliagents-context-1',
          role: 'main',
          session_kind: 'main',
          process_state: 'exited',
          status: 'idle',
          work_dir: '/tmp/project',
          origin_client: 'codex',
          external_session_ref: 'codex:thread-context-1'
        }
      ],
      events: []
    });
    fakeServer.state.memoryBundleByScopeId.set('context-root-1', {
      scopeType: 'root',
      scopeId: 'context-root-1',
      brief: 'Persistence hardening was in progress.',
      keyDecisions: ['Dead roots should context-resume by default'],
      pendingItems: ['Re-run the focused tests'],
      rawPointers: { runIds: ['run-context-1'] },
      isStale: false
    });
    fakeServer.state.memoryMessagesResponse = {
      messages: [
        { role: 'user', content: 'Finish the persistence hardening.' },
        { role: 'assistant', content: 'The broker launch path is next.' }
      ]
    };
    fakeServer.state.launchResponses = [
      {
        rootSessionId: 'context-root-2',
        terminalId: 'context-terminal-2',
        sessionName: 'cliagents-context-2',
        adapter: 'codex-cli',
        externalSessionRef: 'codex:thread-context-1',
        attachCommand: 'tmux attach -t "cliagents-context-2"',
        consoleUrl: '/console?root=context-root-2&terminal=context-terminal-2',
        managedRoot: true
      }
    ];
    const contextResumeResult = await mod.handleLaunchRootSession({
      adapter: 'codex-cli',
      workDir: '/tmp/project',
      resumeLatest: true
    });
    const contextResumeText = contextResumeResult.content[0].text;
    assert(contextResumeText.includes('Managed Root Resumed with Context'));
    assert(contextResumeText.includes('previous_root_session_id: context-root-1'));
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).externalSessionRef, 'codex:thread-context-1');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).sessionMetadata.resumeMode, 'context');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).sessionMetadata.previousRootSessionId, 'context-root-1');
    assert.strictEqual(fakeServer.state.launchBodies.at(-1).sessionMetadata.carriedContextMessageCount, 2);
    assert(fakeServer.state.launchBodies.at(-1).systemPrompt.includes('Dead roots should context-resume by default'));

    fakeServer.state.attachResponses = [
      {
        rootSessionId: 'attached-root-123',
        originClient: 'opencode',
        externalSessionRef: 'opencode:thread-99',
        clientName: 'opencode',
        attachedRoot: true,
        reusedAttachedRoot: false,
        sessionMetadata: {
          clientName: 'opencode',
          clientSessionRef: 'opencode:thread-99',
          externalSessionRef: 'opencode:thread-99',
          attachMode: 'explicit-http-attach'
        }
      }
    ];

    const ensureResult = await mod.handleEnsureRootSession({
      clientName: 'opencode',
      externalSessionRef: 'opencode:thread-99',
      sessionMetadata: {
        workspace: 'cliagents'
      }
    });
    const ensureText = ensureResult.content[0].text;
    assert(ensureText.includes('cliagents Root Session Ensured'));
    assert(ensureText.includes('root_session_id: attached-root-123'));
    assert(ensureText.includes('external_session_ref: opencode:thread-99'));
    assert(ensureText.includes('action: ensured'));
    assert.strictEqual(fakeServer.state.attachBodies.length, 1);
    assert.strictEqual(fakeServer.state.attachBodies[0].originClient, 'opencode');
    assert.strictEqual(fakeServer.state.attachBodies[0].sessionMetadata.clientName, 'opencode');
    assert.strictEqual(fakeServer.state.attachBodies[0].sessionMetadata.workspace, 'cliagents');
    assert.strictEqual(fakeServer.state.attachBodies[0].sessionMetadata.attachMode, 'explicit-mcp-attach');
    assert.strictEqual(fakeServer.state.attachBodies[0].sessionMetadata.rootIdentitySource, 'explicit-external-session-ref');

    await mod.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      message: 'Review the attached root session task'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.rootSessionId, 'attached-root-123');
    assert.strictEqual(fakeServer.state.lastRouteBody.parentSessionId, 'attached-root-123');
    assert.strictEqual(fakeServer.state.lastRouteBody.originClient, 'opencode');
    assert.strictEqual(fakeServer.state.lastRouteBody.externalSessionRef, 'opencode:thread-99');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.clientName, 'opencode');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.clientSessionRef, 'opencode:thread-99');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.workspace, 'cliagents');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.toolName, 'delegate_task');

    restore();
    const reloaded = loadMcpModule(envOverrides);
    const modReloaded = reloaded.mod;

    await modReloaded.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      message: 'Reuse the sticky root state after reload'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.rootSessionId, 'attached-root-123');
    assert.strictEqual(fakeServer.state.lastRouteBody.externalSessionRef, 'opencode:thread-99');

    const resetResult = await modReloaded.handleResetRootSession();
    const resetText = resetResult.content[0].text;
    assert(resetText.includes('Root Session Reset'));
    assert(resetText.includes('previous_root_session_id: attached-root-123'));

    fakeServer.state.attachResponses = [
      {
        rootSessionId: 'attached-root-456',
        originClient: 'opencode',
        externalSessionRef: 'opencode:thread-100',
        clientName: 'opencode',
        attachedRoot: true,
        reusedAttachedRoot: false,
        sessionMetadata: {
          clientName: 'opencode',
          clientSessionRef: 'opencode:thread-100',
          externalSessionRef: 'opencode:thread-100',
          attachMode: 'explicit-http-attach'
        }
      }
    ];

    await modReloaded.handleEnsureRootSession({
      clientName: 'opencode',
      externalSessionRef: 'opencode:thread-100'
    });
    await modReloaded.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      message: 'Use the fresh root after reset'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.rootSessionId, 'attached-root-456');
    assert.strictEqual(fakeServer.state.lastRouteBody.externalSessionRef, 'opencode:thread-100');

    reloaded.restore();
    const secondSession = loadMcpModule({
      ...envOverrides,
      CLIAGENTS_MCP_SESSION_SCOPE: 'session-beta'
    });
    fakeServer.state.attachResponses = [
      {
        rootSessionId: 'attached-root-789',
        originClient: 'opencode',
        externalSessionRef: 'opencode:session:beta',
        clientName: 'opencode',
        attachedRoot: true,
        reusedAttachedRoot: false,
        sessionMetadata: {
          clientName: 'opencode',
          clientSessionRef: 'opencode:session:beta',
          externalSessionRef: 'opencode:session:beta',
          attachMode: 'explicit-http-attach',
          mcpSessionScope: 'session-beta'
        }
      }
    ];
    const secondEnsure = await secondSession.mod.handleEnsureRootSession({
      clientName: 'opencode'
    });
    const secondEnsureText = secondEnsure.content[0].text;
    assert(secondEnsureText.includes('root_session_id: attached-root-789'));
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).externalSessionRef.startsWith('opencode:session:'), true);
    assert.notStrictEqual(fakeServer.state.attachBodies.at(-1).externalSessionRef, 'opencode:thread-100');
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).originClient, 'opencode');
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).sessionMetadata.mcpSessionScope, 'session-beta');

    secondSession.restore();
    const inferredClientSession = loadMcpModule({
      ...envOverrides,
      CLIAGENTS_CLIENT_NAME: '',
      CLIAGENTS_MCP_SESSION_SCOPE: '',
      CODEX_THREAD_ID: '',
      CLIAGENTS_CLIENT_SESSION_REF: ''
    });
    fakeServer.state.attachResponses = [
      {
        rootSessionId: 'attached-root-codex-ref',
        originClient: 'codex',
        externalSessionRef: 'codex-ai-projects-top-level-session',
        clientName: 'codex',
        attachedRoot: true,
        reusedAttachedRoot: false,
        sessionMetadata: {
          clientName: 'codex',
          clientSessionRef: 'codex-ai-projects-top-level-session',
          externalSessionRef: 'codex-ai-projects-top-level-session',
          attachMode: 'explicit-http-attach'
        }
      }
    ];
    const inferredEnsure = await inferredClientSession.mod.handleEnsureRootSession({
      externalSessionRef: 'codex-ai-projects-top-level-session'
    });
    const inferredEnsureText = inferredEnsure.content[0].text;
    assert(inferredEnsureText.includes('root_session_id: attached-root-codex-ref'));
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).originClient, 'codex');
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).sessionMetadata.clientName, 'codex');
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).sessionMetadata.externalSessionRef, 'codex-ai-projects-top-level-session');
    inferredClientSession.restore();

    const outputResult = await mod.handleGetTerminalOutput({
      terminalId: 'attached-terminal',
      mode: 'visible',
      format: 'ansi'
    });
    assert(outputResult.content[0].text.includes('Attached root task completed'));
    assert.strictEqual(fakeServer.state.lastOutputUrl, '/orchestration/terminals/attached-terminal/output?mode=visible&format=ansi');

    fakeServer.state.inputResponses = [
      {
        status: 403,
        body: {
          error: {
            code: 'root_read_only',
            message: 'Root session root-123 is attached and read-only. Remote execution requires a managed or adopted root.'
          }
        }
      }
    ];
    await assert.rejects(
      () => mod.handleReplyToTerminal({
        terminalId: 'attached-terminal',
        message: 'Continue.'
      }),
      /attached and read-only/
    );

    fakeServer.state.inputResponses = [
      {
        status: 200,
        body: { success: true, terminalId: 'child-terminal-1', status: 'idle' }
      }
    ];
    const replyResult = await mod.handleReplyToTerminal({
      terminalId: 'child-terminal-1',
      message: 'Follow up.'
    });
    assert(replyResult.content[0].text.includes('Terminal Updated'));
    assert(replyResult.content[0].text.includes('child-terminal-1'));

    const implicitUpgrade = loadMcpModule({
      ...envOverrides,
      CLIAGENTS_CLIENT_NAME: '',
      CLIAGENTS_MCP_SESSION_SCOPE: '',
      CODEX_THREAD_ID: 'codex-thread-77'
    });
    await implicitUpgrade.mod.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      message: 'Run detached review before explicit ensure'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.originClient, undefined);
    assert.strictEqual(fakeServer.state.lastRouteBody.externalSessionRef, undefined);
    assert.strictEqual(fakeServer.state.lastRouteBody.rootSessionId, undefined);
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata, undefined);
    fakeServer.state.attachResponses = [
      {
        rootSessionId: 'attached-root-codex',
        originClient: 'codex',
        externalSessionRef: 'codex:session:upgrade',
        clientName: 'codex',
        attachedRoot: true,
        reusedAttachedRoot: false,
        sessionMetadata: {
          clientName: 'codex',
          clientSessionRef: 'codex:session:upgrade',
          externalSessionRef: 'codex:session:upgrade',
          attachMode: 'explicit-http-attach'
        }
      }
    ];
    const upgraded = await implicitUpgrade.mod.handleEnsureRootSession();
    const upgradedText = upgraded.content[0].text;
    assert(upgradedText.includes('root_session_id: attached-root-codex'));
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).originClient, 'codex');
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).sessionMetadata.clientName, 'codex');
    assert.strictEqual(fakeServer.state.attachBodies.at(-1).sessionMetadata.attachMode, 'explicit-mcp-attach');
    assert.notStrictEqual(fakeServer.state.attachBodies.at(-1).sessionMetadata.attachMode, 'implicit-first-use');
    implicitUpgrade.restore();

    const noRootSession = loadMcpModule({
      ...envOverrides,
      CLIAGENTS_CLIENT_NAME: 'opencode',
      CLIAGENTS_MCP_SESSION_SCOPE: 'session-no-root',
      CLIAGENTS_REQUIRE_ROOT_ATTACH: '1'
    });
    try {
      await noRootSession.mod.handleDelegateTask({
        role: 'review',
        adapter: 'codex-cli',
        message: 'This should fail because no root is attached'
      });
      assert.fail('delegate_task should have failed without an attached root');
    } catch (error) {
      assert(
        error.message.includes('root session required')
        || error.message.includes('root session is required')
        || error.message.includes('428'),
        `Expected root session required error, got: ${error.message}`
      );
    }
    noRootSession.restore();

    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk, encoding, callback) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      if (typeof callback === 'function') {
        callback();
      }
      return true;
    };
    try {
      await modReloaded.handleRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      });
      await modReloaded.handleRequest({
        jsonrpc: '2.0',
        method: 'notifications/unknown',
        params: {}
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(writes.length, 0, 'MCP notifications should not emit responses on stdout');

    console.log('✅ MCP root-session tools expose root snapshots and explicit root attach flows');
    console.log('\nMCP root-session tool tests passed');
  } finally {
    restore();
    await fakeServer.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('\nMCP root-session tool tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
