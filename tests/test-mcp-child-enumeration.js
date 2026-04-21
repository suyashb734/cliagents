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
    childrenByRoot: new Map(),
    disableChildrenRouteFor: new Set(),
    rootDetailById: new Map(),
  };

  const server = http.createServer(async (req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const childrenMatch = req.url.match(/^\/orchestration\/root-sessions\/([^/]+)\/children(\?.*)?$/);
    if (req.method === 'GET' && childrenMatch) {
      const rootSessionId = decodeURIComponent(childrenMatch[1]);
      if (state.disableChildrenRouteFor.has(rootSessionId)) {
        return writeJson(404, { error: { message: `Unhandled route ${req.method} ${req.url}` } });
      }
      const children = state.childrenByRoot.get(rootSessionId);
      if (!children) {
        return writeJson(404, { error: { code: 'root_session_not_found', message: 'not found' } });
      }
      return writeJson(200, {
        rootSessionId,
        children,
        count: children.length
      });
    }

    const detailMatch = req.url.match(/^\/orchestration\/root-sessions\/([^?]+)(\?.*)?$/);
    if (req.method === 'GET' && detailMatch) {
      const rootSessionId = decodeURIComponent(detailMatch[1]);
      const detail = state.rootDetailById.get(rootSessionId);
      if (!detail) {
        return writeJson(404, { error: { message: 'not found' } });
      }
      return writeJson(200, detail);
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliagents-mcp-child-enum-'));
  const envOverrides = {
    CLIAGENTS_URL: fakeServer.baseUrl,
    CLIAGENTS_MCP_STATE_DIR: stateDir,
    CLIAGENTS_REQUIRE_ROOT_ATTACH: '',
    CLIAGENTS_ROOT_SESSION_ID: 'root-123'
  };
  const { mod, restore } = loadMcpModule(envOverrides);

  try {
    const listChildTool = mod.TOOLS.find((tool) => tool.name === 'list_child_sessions');
    assert(listChildTool, 'list_child_sessions should be exposed in the MCP tool list');

    // Case 1: Multiple child sessions
    fakeServer.state.childrenByRoot.set('root-123', [
      {
        terminalId: 'child-1',
        status: 'completed',
        sessionKind: 'subagent',
        sessionLabel: 'research-partner',
        adapter: 'gemini-cli',
        role: 'research',
        providerThreadRefPresent: true
      },
      {
        terminalId: 'child-2',
        status: 'running',
        sessionKind: 'reviewer',
        adapter: 'codex-cli',
        agentProfile: 'review_codex-cli',
        lastActive: '2026-04-17T11:30:00.000Z'
      }
    ]);

    const result = await mod.handleListChildSessions({ rootSessionId: 'root-123' });
    const text = result.content[0].text;
    
    assert(text.includes('Child Sessions for Root: root-123'));
    assert(text.includes('Total children: 2'));
    assert(text.includes('child-1 status=completed [gemini-cli] kind=subagent label=research-partner role=research providerThread=present'));
    assert(text.includes('child-2 status=running [codex-cli] kind=reviewer profile=review_codex-cli lastActive=2026-04-17T11:30:00.000Z'));

    // Case 2: No child sessions
    fakeServer.state.childrenByRoot.set('root-empty', []);

    const emptyResult = await mod.handleListChildSessions({ rootSessionId: 'root-empty' });
    const emptyText = emptyResult.content[0].text;
    assert(emptyText.includes('No child sessions found for root root-empty.'));

    // Case 3: Compatibility fallback to the older root snapshot route
    fakeServer.state.rootDetailById.set('root-fallback', {
      rootSessionId: 'root-fallback',
      status: 'running',
      sessions: [
        {
          sessionId: 'root-fallback',
          status: 'running',
          sessionKind: 'attach'
        },
        {
          sessionId: 'child-fallback',
          status: 'completed',
          sessionKind: 'reviewer',
          adapter: 'qwen-cli',
          agentProfile: 'review_qwen-cli'
        }
      ]
    });
    fakeServer.state.disableChildrenRouteFor.add('root-fallback');
    const fallbackResult = await mod.handleListChildSessions({ rootSessionId: 'root-fallback' });
    const fallbackText = fallbackResult.content[0].text;
    assert(fallbackText.includes('child-fallback status=completed [qwen-cli] kind=reviewer profile=review_qwen-cli'));
    fakeServer.state.disableChildrenRouteFor.delete('root-fallback');

    // Case 4: Root not found
    try {
      await mod.handleListChildSessions({ rootSessionId: 'non-existent' });
      assert.fail('Should have thrown error for non-existent root');
    } catch (error) {
      assert(error.message.includes('Root session not found: non-existent'));
    }

    console.log('✅ MCP child-enumeration tool tests passed');
  } finally {
    restore();
    await fakeServer.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('\nMCP child-enumeration tool tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
