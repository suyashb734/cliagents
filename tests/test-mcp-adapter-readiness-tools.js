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

async function startFakeServer() {
  const server = http.createServer((req, res) => {
    const writeJson = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readiness = {
      adapter: 'claude-code',
      effective: {
        overall: 'partial',
        ephemeralReady: true,
        collaboratorReady: false,
        verified: true,
        source: 'live',
        reason: 'continuity not verified'
      },
      live: {
        verifiedAt: 1700000000000,
        stale: false
      },
      warnings: []
    };

    if (req.method === 'GET' && req.url === '/orchestration/adapters/readiness?details=1') {
      return writeJson(200, {
        count: 1,
        adapters: {
          'claude-code': readiness
        }
      });
    }
    if (req.method === 'GET' && req.url === '/orchestration/adapters/claude-code/readiness') {
      return writeJson(200, readiness);
    }
    return writeJson(404, { error: { code: 'not_found' } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function run() {
  const fake = await startFakeServer();
  const { mod, restore } = loadMcpModule({ CLIAGENTS_URL: fake.baseUrl });

  try {
    assert(mod.TOOLS.some((tool) => tool.name === 'list_adapter_readiness'));
    assert(mod.TOOLS.some((tool) => tool.name === 'get_adapter_readiness'));

    const listResult = await mod.handleListAdapterReadiness();
    assert(listResult.content[0].text.includes('claude-code'));
    assert(listResult.content[0].text.includes('ephemeral=yes'));

    const getResult = await mod.handleGetAdapterReadiness({ adapter: 'claude-code' });
    assert(getResult.content[0].text.includes('collaborator=no'));

    const jsonResult = await mod.handleGetAdapterReadiness({ adapter: 'claude-code', format: 'json' });
    assert(JSON.parse(jsonResult.content[0].text).effective);
  } finally {
    restore();
    await stopServer(fake.server);
  }

  console.log('✅ MCP adapter readiness tools work');
}

run().catch((error) => {
  console.error('\nMCP adapter readiness tool tests failed:', error);
  process.exit(1);
});
