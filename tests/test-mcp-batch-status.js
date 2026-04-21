#!/usr/bin/env node

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
    scenariosByTerminal: {},
    statusPolls: new Map()
  };

  const server = http.createServer((req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const outputMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)\/output$/);
    if (req.method === 'GET' && outputMatch) {
      const terminalId = outputMatch[1];
      const scenario = state.scenariosByTerminal[terminalId];
      if (!scenario) {
        return writeJson(404, { error: { message: 'not found' } });
      }
      return writeJson(200, { output: scenario.output || 'No output captured' });
    }

    const statusMatch = req.url.match(/^\/orchestration\/terminals\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) {
      const terminalId = statusMatch[1];
      const scenario = state.scenariosByTerminal[terminalId];
      if (!scenario) {
        return writeJson(404, { error: { message: 'not found' } });
      }

      const statuses = scenario.statuses || ['processing'];
      const index = state.statusPolls.get(terminalId) || 0;
      state.statusPolls.set(terminalId, index + 1);
      const status = statuses[Math.min(index, statuses.length - 1)];

      if (status === 404) {
        return writeJson(404, { error: { message: 'not found' } });
      }

      return writeJson(200, {
        terminalId,
        status,
        adapter: scenario.adapter,
        agentProfile: scenario.agentProfile
      });
    }

    return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
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
    CLIAGENTS_MCP_RETRY_AFTER_MS: '25'
  });

  try {
    const batchTool = mod.TOOLS.find((tool) => tool.name === 'check_tasks_status');
    const waitTool = mod.TOOLS.find((tool) => tool.name === 'wait_for_tasks');
    const watchTool = mod.TOOLS.find((tool) => tool.name === 'watch_tasks');
    assert(batchTool, 'check_tasks_status tool should be exposed');
    assert(waitTool, 'wait_for_tasks tool should be exposed');
    assert(watchTool, 'watch_tasks tool should be exposed');

    fakeServer.state.scenariosByTerminal = {
      'term-running': {
        statuses: ['processing'],
        output: 'still working',
        adapter: 'codex-cli',
        agentProfile: 'review_codex-cli'
      },
      'term-complete': {
        statuses: ['completed'],
        output: 'done',
        adapter: 'qwen-cli',
        agentProfile: 'architect_qwen-cli'
      },
      'term-blocked': {
        statuses: ['waiting_permission'],
        output: 'Need approval',
        adapter: 'gemini-cli',
        agentProfile: 'research_gemini-cli'
      }
    };

    const running = await mod.handleCheckTaskStatus({ terminalId: 'term-running' });
    const runningText = running.content[0].text;
    assert(runningText.includes('Task Status: PROCESSING'));
    assert(runningText.includes('retry_after_ms'));
    assert(runningText.includes('check_tasks_status'));

    fakeServer.state.statusPolls.clear();
    const batch = await mod.handleCheckTasksStatus({
      terminalIds: ['term-running', 'term-complete', 'term-blocked']
    });
    const batchText = batch.content[0].text;
    assert(batchText.includes('Batch Task Status'));
    assert(batchText.includes('Tasks: 3'));
    assert(batchText.includes('Completed: 1'));
    assert(batchText.includes('Blocked: 1'));
    assert(batchText.includes('Running: 1'));
    assert(batchText.includes('retry_after_ms: 25'));
    assert(batchText.includes('term-complete: COMPLETED'));
    assert(batchText.includes('term-blocked: WAITING_PERMISSION'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.scenariosByTerminal = {
      'term-a': {
        statuses: ['processing', 'completed'],
        output: 'A complete',
        adapter: 'codex-cli',
        agentProfile: 'implement_codex-cli'
      },
      'term-b': {
        statuses: ['processing', 'processing', 'completed'],
        output: 'B complete',
        adapter: 'qwen-cli',
        agentProfile: 'review_qwen-cli'
      }
    };

    const settled = await mod.handleWaitForTasks({
      terminalIds: ['term-a', 'term-b'],
      timeoutMs: 80
    });
    const settledText = settled.content[0].text;
    assert(settledText.includes('Wait Result: SETTLED'));
    assert(settledText.includes('Completed: 2'));
    assert(settledText.includes('A complete'));
    assert(settledText.includes('B complete'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.scenariosByTerminal = {
      'term-timeout': {
        statuses: ['processing', 'processing', 'processing', 'processing'],
        output: 'not done yet',
        adapter: 'codex-cli',
        agentProfile: 'review_codex-cli'
      }
    };

    const timedOut = await mod.handleWaitForTasks({
      terminalIds: ['term-timeout'],
      timeoutMs: 25,
      includeOutput: false
    });
    const timeoutText = timedOut.content[0].text;
    assert(timeoutText.includes('Wait Result: TIMEOUT'));
    assert(timeoutText.includes('Running: 1'));
    assert(timeoutText.includes('retry_after_ms: 25'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.scenariosByTerminal = {
      'term-watch-a': {
        statuses: ['processing', 'processing', 'completed'],
        output: 'A changed',
        adapter: 'codex-cli',
        agentProfile: 'review_codex-cli'
      },
      'term-watch-b': {
        statuses: ['processing', 'processing', 'processing'],
        output: 'B still running',
        adapter: 'qwen-cli',
        agentProfile: 'architect_qwen-cli'
      }
    };

    const watched = await mod.handleWatchTasks({
      terminalIds: ['term-watch-a', 'term-watch-b'],
      timeoutMs: 80
    });
    const watchedText = watched.content[0].text;
    assert(watchedText.includes('Watch Result: CHANGED') || watchedText.includes('Watch Result: SETTLED'));
    assert(watchedText.includes('Changed: 1'));
    assert(watchedText.includes('Changed terminalIds: term-watch-a'));
    assert(watchedText.includes('A changed'));

    fakeServer.state.statusPolls.clear();
    fakeServer.state.scenariosByTerminal = {
      'term-watch-timeout': {
        statuses: ['processing', 'processing', 'processing', 'processing'],
        output: 'still running',
        adapter: 'codex-cli',
        agentProfile: 'review_codex-cli'
      }
    };

    const watchTimedOut = await mod.handleWatchTasks({
      terminalIds: ['term-watch-timeout'],
      timeoutMs: 25,
      includeOutput: false
    });
    const watchTimedOutText = watchTimedOut.content[0].text;
    assert(watchTimedOutText.includes('Watch Result: TIMEOUT'));
    assert(watchTimedOutText.includes('Changed: 0'));
    assert(watchTimedOutText.includes('retry_after_ms: 25'));

    console.log('✅ MCP batch status and wait tools reduce per-terminal polling pressure and report grouped progress correctly');
    console.log('\nMCP batch-status tests passed');
  } finally {
    restore();
    await fakeServer.close();
  }
}

run().catch((error) => {
  console.error('\nMCP batch-status tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
