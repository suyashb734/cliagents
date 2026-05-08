#!/usr/bin/env node

'use strict';

const assert = require('assert');
const http = require('http');

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
    lastCreateTaskBody: null,
    lastCreateAssignmentBody: null,
    lastStartAssignmentBody: null,
    lastCreateRoomBody: null
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

    if (req.method === 'POST' && req.url === '/orchestration/tasks') {
      state.lastCreateTaskBody = await readBody();
      return writeJson(200, {
        task: {
          id: state.lastCreateTaskBody.taskId || 'task-1',
          title: state.lastCreateTaskBody.title,
          kind: state.lastCreateTaskBody.kind || 'general',
          brief: state.lastCreateTaskBody.brief || null,
          workspaceRoot: state.lastCreateTaskBody.workspaceRoot,
          rootSessionId: state.lastCreateTaskBody.rootSessionId || null
        },
        status: 'pending',
        assignmentCounts: { queued: 0, running: 0, blocked: 0, failed: 0, completed: 0 },
        linkedCounts: { runs: 0, rooms: 0, discussions: 0, memorySnapshots: 0 }
      });
    }

    if (req.method === 'GET' && (req.url === '/orchestration/tasks' || req.url.startsWith('/orchestration/tasks?'))) {
      return writeJson(200, {
        tasks: [
          {
            task: {
              id: 'task-1',
              title: 'Implement Tasks V1',
              workspaceRoot: '/tmp/tasks-v1',
              rootSessionId: 'root-attached'
            },
            status: 'running',
            assignmentCounts: { queued: 0, running: 1, blocked: 0, failed: 0, completed: 0 },
            linkedCounts: { runs: 1, rooms: 1, discussions: 0, memorySnapshots: 0 }
          }
        ]
      });
    }

    if (req.method === 'GET' && req.url === '/orchestration/tasks/task-1') {
      return writeJson(200, {
        task: {
          id: 'task-1',
          title: 'Implement Tasks V1',
          workspaceRoot: '/tmp/tasks-v1',
          rootSessionId: 'root-attached'
        },
        status: 'running',
        assignmentCounts: { queued: 0, running: 1, blocked: 0, failed: 0, completed: 0 },
        linkedCounts: { runs: 1, rooms: 1, discussions: 0, memorySnapshots: 1 }
      });
    }

    if (req.method === 'POST' && req.url === '/orchestration/tasks/task-1/assignments') {
      state.lastCreateAssignmentBody = await readBody();
      return writeJson(200, {
        task: {
          task: { id: 'task-1' },
          status: 'pending',
          assignmentCounts: { queued: 1, running: 0, blocked: 0, failed: 0, completed: 0 },
          linkedCounts: { runs: 0, rooms: 0, discussions: 0, memorySnapshots: 0 }
        },
        assignment: {
          id: state.lastCreateAssignmentBody.assignmentId || 'assignment-1',
          taskId: 'task-1',
          role: state.lastCreateAssignmentBody.role,
          instructions: state.lastCreateAssignmentBody.instructions,
          adapter: state.lastCreateAssignmentBody.adapter || null,
          model: state.lastCreateAssignmentBody.model || null,
          status: 'queued',
          terminalId: null
        }
      });
    }

    if (req.method === 'GET' && req.url === '/orchestration/tasks/task-1/assignments') {
      return writeJson(200, {
        task: {
          id: 'task-1',
          title: 'Implement Tasks V1'
        },
        assignments: [
          {
            id: 'assignment-1',
            taskId: 'task-1',
            role: 'executor',
            status: 'running',
            terminalId: 'term-1',
            adapter: 'codex-cli',
            dispatch: {
              id: 'dispatch-1',
              status: 'spawned'
            },
            taskSessionBindings: [
              { id: 'binding-1', rootSessionId: 'root-attached' }
            ]
          }
        ]
      });
    }

    if (req.method === 'POST' && req.url === '/orchestration/tasks/task-1/assignments/assignment-1/start') {
      state.lastStartAssignmentBody = await readBody();
      return writeJson(200, {
        task: {
          task: {
            id: 'task-1',
            title: 'Implement Tasks V1'
          },
          status: 'running',
          assignmentCounts: { queued: 0, running: 1, blocked: 0, failed: 0, completed: 0 },
          linkedCounts: { runs: 0, rooms: 0, discussions: 0, memorySnapshots: 0 }
        },
        assignment: {
          id: 'assignment-1',
          taskId: 'task-1',
          role: 'executor',
          status: 'running',
          terminalId: 'term-1',
          adapter: 'codex-cli',
          model: 'gpt-5.4',
          dispatch: {
            id: 'dispatch-1',
            status: 'spawned'
          },
          taskSessionBindings: [
            { id: 'binding-1', rootSessionId: 'root-attached' }
          ]
        },
        dispatch: {
          dispatchRequestId: 'dispatch-1',
          contextSnapshotId: 'context-1',
          taskSessionBindingId: 'binding-1',
          status: 'spawned'
        },
        route: {
          terminalId: 'term-1',
          adapter: 'codex-cli',
          model: 'gpt-5.4'
        }
      });
    }

    if (req.method === 'POST' && req.url === '/orchestration/rooms') {
      state.lastCreateRoomBody = await readBody();
      return writeJson(200, {
        room: {
          id: state.lastCreateRoomBody.roomId || 'room-1',
          rootSessionId: 'room-root-1',
          taskId: state.lastCreateRoomBody.taskId || null,
          title: state.lastCreateRoomBody.title || null
        },
        participants: state.lastCreateRoomBody.participants || []
      });
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
  const { mod, restore } = loadMcpModule({
    CLIAGENTS_URL: fakeServer.baseUrl,
    CLIAGENTS_CLIENT_NAME: 'codex',
    CLIAGENTS_ROOT_SESSION_ID: 'root-attached',
    CLIAGENTS_CLIENT_SESSION_REF: 'codex:thread-task-tools',
    CLIAGENTS_REQUIRE_ROOT_ATTACH: '1'
  });

  try {
    const createTaskResult = await mod.handleCreateTask({
      title: 'Implement Tasks V1',
      workspaceRoot: '/tmp/tasks-v1'
    });
    assert(createTaskResult.content[0].text.includes('Task Created'));
    assert.strictEqual(fakeServer.state.lastCreateTaskBody.workspaceRoot, '/tmp/tasks-v1');
    assert.strictEqual(fakeServer.state.lastCreateTaskBody.rootSessionId, 'root-attached');

    const listTasksResult = await mod.handleListTasks({});
    assert(listTasksResult.content[0].text.includes('Tasks'));
    assert(listTasksResult.content[0].text.includes('task-1'));
    assert(listTasksResult.content[0].text.includes('running'));

    const getTaskResult = await mod.handleGetTask({ taskId: 'task-1' });
    assert(getTaskResult.content[0].text.includes('Task'));
    assert(getTaskResult.content[0].text.includes('memory_snapshots=1'));

    const createAssignmentResult = await mod.handleCreateTaskAssignment({
      taskId: 'task-1',
      role: 'executor',
      instructions: 'Implement the feature.'
    });
    assert(createAssignmentResult.content[0].text.includes('Task Assignment Created'));
    assert.strictEqual(fakeServer.state.lastCreateAssignmentBody.role, 'executor');
    assert.strictEqual(fakeServer.state.lastCreateAssignmentBody.instructions, 'Implement the feature.');

    const listAssignmentsResult = await mod.handleListTaskAssignments({ taskId: 'task-1' });
    assert(listAssignmentsResult.content[0].text.includes('Task Assignments'));
    assert(listAssignmentsResult.content[0].text.includes('assignment-1'));
    assert(listAssignmentsResult.content[0].text.includes('dispatch=dispatch-1:spawned'));
    assert(listAssignmentsResult.content[0].text.includes('bindings=1'));

    const startAssignmentResult = await mod.handleStartTaskAssignment({
      taskId: 'task-1',
      assignmentId: 'assignment-1',
      sessionLabel: 'task-executor'
    });
    assert(startAssignmentResult.content[0].text.includes('Task Assignment Started'));
    assert(startAssignmentResult.content[0].text.includes('dispatch_request_id: dispatch-1'));
    assert(startAssignmentResult.content[0].text.includes('context_snapshot_id: context-1'));
    assert(startAssignmentResult.content[0].text.includes('task_session_binding_id: binding-1'));
    assert.strictEqual(fakeServer.state.lastStartAssignmentBody.rootSessionId, 'root-attached');
    assert.strictEqual(fakeServer.state.lastStartAssignmentBody.parentSessionId, 'root-attached');
    assert.strictEqual(fakeServer.state.lastStartAssignmentBody.sessionKind, 'subagent');
    assert.strictEqual(fakeServer.state.lastStartAssignmentBody.sessionLabel, 'task-executor');
    assert.strictEqual(fakeServer.state.lastStartAssignmentBody.sessionMetadata.toolName, 'start_task_assignment');

    const createRoomResult = await mod.handleCreateRoom({
      title: 'Task-linked room',
      taskId: 'task-1',
      participants: [{ adapter: 'codex-cli', displayName: 'Codex' }]
    });
    assert(createRoomResult.content[0].text.includes('Room Created'));
    assert.strictEqual(fakeServer.state.lastCreateRoomBody.taskId, 'task-1');

    console.log('✅ MCP task tools forward task payloads and attached-root context correctly');
  } finally {
    restore();
    await fakeServer.close();
  }
}

run().then(() => {
  console.log('\nMCP task tool tests passed');
}).catch((error) => {
  console.error('\nMCP task tool tests failed:', error);
  process.exit(1);
});
