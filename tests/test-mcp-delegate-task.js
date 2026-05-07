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
    scenario: null,
    routeCallCount: 0,
    statusPolls: new Map(),
    lastRouteBody: null,
    routeBodies: [],
    lastTerminalInput: null
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

    if (req.method === 'POST' && req.url === '/orchestration/route') {
      state.lastRouteBody = await readBody();
      state.routeBodies.push(state.lastRouteBody);
      let routeStatus;
      let routeBody;
      const routeSequence = Array.isArray(state.scenario.routeSequence) ? state.scenario.routeSequence : null;
      if (routeSequence && routeSequence.length > 0) {
        const step = routeSequence[Math.min(state.routeCallCount, routeSequence.length - 1)] || {};
        state.routeCallCount += 1;
        routeStatus = Number.isInteger(step.status) ? step.status : 200;
        routeBody = step.body || (
          routeStatus === 200
            ? state.scenario.routeResponse
            : (state.scenario.routeError || { error: { code: 'route_error', message: 'route failed' } })
        );
      } else {
        routeStatus = state.scenario.routeStatus || 200;
        routeBody = routeStatus === 200
          ? state.scenario.routeResponse
          : (state.scenario.routeError || { error: { code: 'route_error', message: 'route failed' } });
      }
      return writeJson(routeStatus, routeBody);
    }

    const outputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/output$/);
    if (req.method === 'GET' && outputMatch) {
      return writeJson(200, { output: state.scenario.output || 'No output captured' });
    }

    const inputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/input$/);
    if (req.method === 'POST' && inputMatch) {
      const body = await readBody();
      state.lastTerminalInput = {
        terminalId: inputMatch[1],
        body
      };
      return writeJson(200, { terminalId: inputMatch[1], status: 'processing', accepted: true });
    }

    const statusMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) {
      const terminalId = statusMatch[1];
      const statuses = state.scenario.statuses || ['processing'];
      const index = state.statusPolls.get(terminalId) || 0;
      state.statusPolls.set(terminalId, index + 1);
      const status = statuses[Math.min(index, statuses.length - 1)];

      if (status === 404) {
        return writeJson(404, { error: { message: 'not found' } });
      }

      return writeJson(200, {
        terminalId,
        status,
        adapter: state.scenario.routeResponse.adapter,
        agentProfile: state.scenario.routeResponse.profile
      });
    }

    return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
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
    CLIAGENTS_MCP_POLL_MS: '10',
    CLIAGENTS_MCP_SYNC_WAIT_MS: '80',
    CLIAGENTS_MCP_ROUTE_RETRY_DELAY_MAX_MS: '25',
    SESSION_GRAPH_WRITES_ENABLED: '1',
    CLIAGENTS_CLIENT_NAME: 'opencode',
    CLIAGENTS_ROOT_SESSION_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    CLIAGENTS_CLIENT_SESSION_REF: 'opencode:thread-42'
  });

  try {
    const delegateTool = mod.TOOLS.find((tool) => tool.name === 'delegate_task');
    assert(delegateTool.inputSchema.properties.collaborator, 'delegate_task should expose collaborator mode');

    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-complete',
        adapter: 'codex-cli',
        taskType: 'review',
        profile: 'review_codex-cli'
      },
      statuses: ['processing', 'completed'],
      output: 'Completed delegated review'
    };

    const completed = await mod.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      message: 'Review this file',
      wait: true
    });
    const completedText = completed.content[0].text;
    assert(completedText.includes('Response'));
    assert(completedText.includes('Completed delegated review'));
    assert(completedText.includes('term-complete'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-running',
        adapter: 'codex-cli',
        taskType: 'research',
        profile: 'research_codex-cli'
      },
      statuses: new Array(50).fill('processing'),
      output: ''
    };

    const longStart = Date.now();
    const longRunning = await mod.handleDelegateTask({
      role: 'research',
      adapter: 'codex-cli',
      message: 'Do a long repository analysis',
      timeout: 'complex',
      wait: true
    });
    const longElapsed = Date.now() - longStart;
    const longText = longRunning.content[0].text;
    assert(longText.includes('Still Running'));
    assert(longText.includes('term-running'));
    assert(longElapsed < 1500, `Expected async fallback quickly, took ${longElapsed}ms`);

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-blocked',
        adapter: 'codex-cli',
        taskType: 'implement',
        profile: 'implement_codex-cli'
      },
      statuses: ['waiting_permission'],
      output: 'Allow file edit?'
    };

    const blocked = await mod.handleDelegateTask({
      role: 'implement',
      adapter: 'codex-cli',
      message: 'Implement the requested change',
      wait: true
    });
    const blockedText = blocked.content[0].text;
    assert(blockedText.includes('Waiting'));
    assert(blockedText.includes('blocked on an interactive prompt'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-custom-prompt',
        adapter: 'qwen-cli',
        taskType: 'review',
        profile: 'review_qwen-cli'
      },
      statuses: ['completed'],
      output: 'Prompt override respected'
    };

    await mod.handleDelegateTask({
      role: 'review',
      adapter: 'qwen-cli',
      message: 'Review this using the custom rubric',
      systemPrompt: 'You are a custom reviewer.'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.systemPrompt, 'You are a custom reviewer.');

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-model-override',
        adapter: 'codex-cli',
        taskType: 'implement',
        profile: 'implement_codex-cli'
      },
      statuses: ['completed'],
      output: 'Model override respected'
    };

    await mod.handleDelegateTask({
      role: 'implement',
      adapter: 'codex-cli',
      model: 'o4-mini',
      sessionLabel: 'claude-architect',
      preferReuse: true,
      forceFreshSession: true,
      message: 'Implement using the requested model'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.model, 'o4-mini');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionLabel, 'claude-architect');
    assert.strictEqual(fakeServer.state.lastRouteBody.preferReuse, true);
    assert.strictEqual(fakeServer.state.lastRouteBody.forceFreshSession, true);
    assert.strictEqual(fakeServer.state.lastRouteBody.rootSessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(fakeServer.state.lastRouteBody.parentSessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(fakeServer.state.lastRouteBody.originClient, 'opencode');
    assert.strictEqual(fakeServer.state.lastRouteBody.externalSessionRef, 'opencode:thread-42');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionKind, 'subagent');
    assert.strictEqual(fakeServer.state.lastRouteBody.lineageDepth, 1);
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.clientName, 'opencode');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.toolName, 'delegate_task');

    fakeServer.state.routeBodies = [];
    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-retried',
        adapter: 'codex-cli',
        taskType: 'review',
        profile: 'review_codex-cli'
      },
      routeSequence: [
        {
          status: 409,
          body: {
            error: {
              code: 'terminal_busy',
              message: 'Terminal reuse candidate is currently processing.',
              retryAfterMs: 2000
            }
          }
        },
        {
          status: 200,
          body: {
            terminalId: 'term-retried',
            adapter: 'codex-cli',
            taskType: 'review',
            profile: 'review_codex-cli'
          }
        }
      ],
      statuses: ['completed'],
      output: 'Recovered after force-fresh retry'
    };

    const recoveredStart = Date.now();
    const recovered = await mod.handleDelegateTask({
      role: 'review',
      adapter: 'codex-cli',
      sessionLabel: 'retry-check',
      preferReuse: true,
      message: 'Retry delegation when reuse is busy'
    });
    const recoveredElapsed = Date.now() - recoveredStart;
    const recoveredText = recovered.content[0].text;
    assert(recoveredText.includes('Recovery:'));
    assert.strictEqual(fakeServer.state.routeBodies.length, 2);
    assert.strictEqual(fakeServer.state.routeBodies[0].preferReuse, true);
    assert.strictEqual(fakeServer.state.routeBodies[1].preferReuse, false);
    assert.strictEqual(fakeServer.state.routeBodies[1].forceFreshSession, true);
    assert.strictEqual(fakeServer.state.routeBodies[1].sessionMetadata.routeRetry.reason, 'terminal_busy');
    assert(recoveredElapsed < 500, `Route retry delay should be capped; observed ${recoveredElapsed}ms`);

    fakeServer.state.routeBodies = [];
    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeSequence: [
        {
          status: 409,
          body: {
            error: {
              code: 'root_binding_conflict',
              message: 'Root session is already bound to another client.',
              retryAfterMs: 1
            }
          }
        },
        {
          status: 200,
          body: {
            terminalId: 'term-non-busy-should-not-retry',
            adapter: 'codex-cli',
            taskType: 'review',
            profile: 'review_codex-cli'
          }
        }
      ],
      statuses: ['completed'],
      output: 'Should never be reached'
    };

    await assert.rejects(
      () => mod.handleDelegateTask({
        role: 'review',
        adapter: 'codex-cli',
        sessionLabel: 'retry-check',
        preferReuse: true,
        message: 'Do not retry non-busy 409 conflicts'
      }),
      (error) => {
        assert(error.message.includes('Routing failed'));
        assert(error.message.includes('root_binding_conflict'));
        return true;
      }
    );
    assert.strictEqual(fakeServer.state.routeBodies.length, 1, 'non-busy 409 responses should not trigger retry');

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-collaborator',
        adapter: 'claude-code',
        taskType: 'review',
        profile: 'review_claude-code'
      },
      statuses: ['completed'],
      output: 'Collaborator reuse configured'
    };

    await mod.handleDelegateTask({
      role: 'review',
      adapter: 'claude-code',
      collaborator: true,
      sessionLabel: 'claude-architect',
      message: 'Continue the long-lived architect collaborator'
    });
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionKind, 'collaborator');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionLabel, 'claude-architect');
    assert.strictEqual(fakeServer.state.lastRouteBody.sessionMetadata.collaborator, true);

    await assert.rejects(
      () => mod.handleDelegateTask({
        role: 'review',
        adapter: 'claude-code',
        collaborator: true,
        message: 'Missing stable collaborator label'
      }),
      /sessionLabel is required when collaborator=true/
    );

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-default-async',
        adapter: 'qwen-cli',
        taskType: 'architect',
        profile: 'architect_qwen-cli',
        reuse: {
          preferred: true,
          selected: false,
          reason: 'no_compatible_terminal',
          candidateTerminalId: null,
          requiredNewBinding: true
        }
      },
      statuses: ['processing'],
      output: ''
    };

    const defaultAsync = await mod.handleDelegateTask({
      role: 'architect',
      adapter: 'qwen-cli',
      message: 'Think about the system design'
    });
    const defaultAsyncText = defaultAsync.content[0].text;
    assert(defaultAsyncText.includes('Task Delegated: ASYNC'));
    assert(defaultAsyncText.includes('term-default-async'));
    assert(defaultAsyncText.includes('preferred=yes, selected=no, reason=no_compatible_terminal'));

    const replied = await mod.handleReplyToTerminal({
      terminalId: 'term-default-async',
      message: 'Continue with the current plan and summarize blockers.'
    });
    const repliedText = replied.content[0].text;
    assert(repliedText.includes('Terminal Updated'));
    assert.strictEqual(fakeServer.state.lastTerminalInput.terminalId, 'term-default-async');
    assert.strictEqual(
      fakeServer.state.lastTerminalInput.body.message,
      'Continue with the current plan and summarize blockers.'
    );

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-async',
        adapter: 'gemini-cli',
        taskType: 'research',
        profile: 'research_gemini-cli'
      },
      statuses: ['processing'],
      output: ''
    };

    const asyncResult = await mod.handleDelegateTask({
      profile: 'researcher',
      message: 'Find relevant references',
      wait: false
    });
    const asyncText = asyncResult.content[0].text;
    assert(asyncText.includes('Task Delegated: ASYNC'));
    assert(asyncText.includes('term-async'));

    fakeServer.state.routeBodies = [];
    fakeServer.state.scenario = {
      routeCallCount: 0,
      routeResponse: {
        terminalId: 'term-workflow',
        adapter: 'codex-cli',
        taskType: 'implement',
        profile: 'implement_codex-cli'
      },
      statuses: ['processing'],
      output: ''
    };

    const workflowTool = mod.TOOLS.find((tool) => tool.name === 'run_workflow');
    assert(workflowTool.inputSchema.properties.model, 'run_workflow should expose a default model override');
    assert(workflowTool.inputSchema.properties.modelsByAdapter, 'run_workflow should expose per-adapter model overrides');

    const workflowResult = await mod.handleRunWorkflow({
      workflow: 'feature',
      message: 'Implement the planned feature',
      modelsByAdapter: {
        'qwen-cli': 'qwen-max',
        'codex-cli': 'o4-mini'
      },
      workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents',
      preferReuse: true,
      forceFreshSession: false
    });
    const workflowText = workflowResult.content[0].text;
    assert(workflowText.includes('Workflow Started: feature'));
    assert.strictEqual(fakeServer.state.routeBodies.length, 3, 'feature workflow should launch three routed steps');
    assert.strictEqual(fakeServer.state.routeBodies[0].model, 'qwen-max');
    assert.strictEqual(fakeServer.state.routeBodies[1].model, 'o4-mini');
    assert.strictEqual(fakeServer.state.routeBodies[2].model, 'o4-mini');
    assert(fakeServer.state.routeBodies.every((body) => body.preferReuse === true));
    assert(fakeServer.state.routeBodies.every((body) => body.forceFreshSession === false));
    assert(fakeServer.state.routeBodies.every((body) => body.workingDirectory === '/Users/mojave/Documents/AI-projects/cliagents'));
    assert(fakeServer.state.routeBodies.every((body) => body.rootSessionId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    assert(fakeServer.state.routeBodies.every((body) => body.originClient === 'opencode'));
    assert(fakeServer.state.routeBodies.every((body) => body.sessionKind === 'workflow'));
    assert(fakeServer.state.routeBodies.every((body) => body.sessionMetadata.toolName === 'run_workflow'));

    fakeServer.state.routeBodies = [];
    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    const detachedWorkflowStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-mcp-detached-workflow-'));
    const detachedWorkflow = loadMcpModule({
      CLIAGENTS_URL: fakeServer.baseUrl,
      CLIAGENTS_MCP_POLL_MS: '10',
      CLIAGENTS_MCP_SYNC_WAIT_MS: '80',
      SESSION_GRAPH_WRITES_ENABLED: '1',
      CLIAGENTS_CLIENT_NAME: 'opencode',
      CLIAGENTS_MCP_SESSION_SCOPE: 'session-detached-workflow',
      CLIAGENTS_MCP_STATE_DIR: detachedWorkflowStateDir,
      CLIAGENTS_ROOT_SESSION_ID: '',
      CLIAGENTS_CLIENT_SESSION_REF: '',
      CLIAGENTS_REQUIRE_ROOT_ATTACH: ''
    });
    try {
      fakeServer.state.scenario = {
        routeResponse: {
          terminalId: 'term-workflow-detached',
          adapter: 'codex-cli',
          taskType: 'implement',
          profile: 'implement_codex-cli'
        },
        statuses: ['processing'],
        output: ''
      };

      const detachedWorkflowResult = await detachedWorkflow.mod.handleRunWorkflow({
        workflow: 'research',
        message: 'Investigate detached workflow mode',
        workingDirectory: '/Users/mojave/Documents/AI-projects/cliagents'
      });
      assert(detachedWorkflowResult.content[0].text.includes('Workflow Started: research'));
      assert.strictEqual(fakeServer.state.routeBodies.length, 2, 'research workflow should launch two routed steps');
      assert(fakeServer.state.routeBodies.every((body) => body.rootSessionId === undefined));
      assert(fakeServer.state.routeBodies.every((body) => body.parentSessionId === undefined));
      assert(fakeServer.state.routeBodies.every((body) => body.originClient === undefined));
      assert(fakeServer.state.routeBodies.every((body) => body.externalSessionRef === undefined));
      assert(fakeServer.state.routeBodies.every((body) => body.lineageDepth === undefined));
      assert(fakeServer.state.routeBodies.every((body) => body.sessionMetadata === undefined));
    } finally {
      detachedWorkflow.restore();
      fs.rmSync(detachedWorkflowStateDir, { recursive: true, force: true });
    }

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeStatus: 428,
      routeError: {
        error: {
          code: 'root_session_required',
          message: 'A root session is required before calling /orchestration/route.',
          nextAction: 'call ensure_root_session or attach_root_session first, or provide a stable externalSessionRef/rootSessionId'
        }
      }
    };

    await assert.rejects(
      () => mod.handleDelegateTask({
        role: 'review',
        adapter: 'codex-cli',
        message: 'This should be rejected by strict root attach mode'
      }),
      (error) => {
        assert(error.message.includes('cliagents root session'));
        assert(error.message.includes('ensure_root_session'));
        return true;
      }
    );

    const strictWorkflowStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-mcp-strict-workflow-'));
    const strictWorkflow = loadMcpModule({
      CLIAGENTS_URL: fakeServer.baseUrl,
      CLIAGENTS_MCP_POLL_MS: '10',
      CLIAGENTS_MCP_SYNC_WAIT_MS: '80',
      SESSION_GRAPH_WRITES_ENABLED: '1',
      CLIAGENTS_CLIENT_NAME: 'opencode',
      CLIAGENTS_MCP_SESSION_SCOPE: 'session-strict-workflow',
      CLIAGENTS_MCP_STATE_DIR: strictWorkflowStateDir,
      CLIAGENTS_ROOT_SESSION_ID: '',
      CLIAGENTS_CLIENT_SESSION_REF: '',
      CLIAGENTS_REQUIRE_ROOT_ATTACH: '1'
    });
    try {
      await assert.rejects(
        () => strictWorkflow.mod.handleRunWorkflow({
          workflow: 'research',
          message: 'This workflow should require an attached root'
        }),
        (error) => {
          assert(error.message.includes('cliagents root session'));
          assert(error.message.includes('ensure_root_session'));
          return true;
        }
      );
    } finally {
      strictWorkflow.restore();
      fs.rmSync(strictWorkflowStateDir, { recursive: true, force: true });
    }

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-status-complete',
        adapter: 'claude-code',
        taskType: 'review',
        profile: 'review_claude-code'
      },
      statuses: ['completed'],
      output: `
mojave@host cliagents % printf '\\n__CLIAGENTS_RUN_START__abc123\\n'; "/opt/homebrew/bin/claude" -p "Review this file" --output-format stream-json --verbose --strict-mcp-config

__CLIAGENTS_RUN_START__abc123
{"type":"assistant","message":{"content":[{"type":"text","text":"Intermediate review note"}]}}
{"type":"result","subtype":"success","result":"Completed extracted output"}
__CLIAGENTS_RUN_EXIT__abc123__0
`
    };

    const completedStatus = await mod.handleCheckTaskStatus({ terminalId: 'term-status-complete' });
    assert(completedStatus.content[0].text.includes('Task Status: COMPLETED'));
    assert(completedStatus.content[0].text.includes('Completed extracted output'));
    assert(!completedStatus.content[0].text.includes('printf'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-status-stale-processing',
        adapter: 'claude-code',
        taskType: 'review',
        profile: 'review_claude-code'
      },
      statuses: ['processing'],
      output: `
{"type":"result","subtype":"success","result":"Completed despite stale processing status","terminal_reason":"completed"}
__CLIAGENTS_RUN_EXIT__stale123__0
`
    };

    const staleCompletedStatus = await mod.handleCheckTaskStatus({ terminalId: 'term-status-stale-processing' });
    assert(staleCompletedStatus.content[0].text.includes('Task Status: COMPLETED'));
    assert(staleCompletedStatus.content[0].text.includes('Completed despite stale processing status'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-status-error',
        adapter: 'gemini-cli',
        taskType: 'research',
        profile: 'research_gemini-cli'
      },
      statuses: ['error'],
      output: 'Process exited with code 1'
    };

    const failedStatus = await mod.handleCheckTaskStatus({ terminalId: 'term-status-error' });
    assert(failedStatus.content[0].text.includes('Task Status: FAILED'));
    assert(failedStatus.content[0].text.includes('Process exited with code 1'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.routeCallCount = 0;
    fakeServer.state.scenario = {
      routeResponse: {
        terminalId: 'term-status-waiting',
        adapter: 'qwen-cli',
        taskType: 'implement',
        profile: 'implement_qwen-cli'
      },
      statuses: ['waiting_permission'],
      output: 'Approve file write?'
    };

    const waitingStatus = await mod.handleCheckTaskStatus({ terminalId: 'term-status-waiting' });
    assert(waitingStatus.content[0].text.includes('WAITING_PERMISSION'));
    assert(waitingStatus.content[0].text.includes('blocked on an interactive prompt'));

    console.log('✅ MCP delegation/status handling preserves terminal IDs, degrades long waits safely, and reports blocked/error states correctly');
    console.log('\nMCP delegate_task tests passed');
  } finally {
    restore();
    await fakeServer.close();
  }
}

run().catch((error) => {
  console.error('\nMCP delegate_task tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
