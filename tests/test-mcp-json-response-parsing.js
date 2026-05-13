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
    if (req.method === 'GET' && req.url === '/malformed-issues') {
      const malformed = `{"issues":[{"identifier":"KD-4","description":"Line one
Line two","comments":[{"body":"Alpha
Beta"}]}]}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(malformed);
      return;
    }

    if (req.method === 'GET' && req.url === '/plain-text') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('upstream unavailable');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function run() {
  const fakeServer = await startFakeServer();
  const { mod, restore } = loadMcpModule({
    CLIAGENTS_URL: fakeServer.baseUrl
  });

  try {
    const malformed = await mod.callCliagents('GET', '/malformed-issues');
    assert.strictEqual(malformed.status, 200);
    assert(Array.isArray(malformed.data.issues), 'Expected repaired payload to parse as JSON');
    assert.strictEqual(malformed.data.issues[0].description, 'Line one\nLine two');
    assert.strictEqual(malformed.data.issues[0].comments[0].body, 'Alpha\nBeta');

    const plainText = await mod.callCliagents('GET', '/plain-text');
    assert.strictEqual(plainText.status, 503);
    assert.strictEqual(plainText.data, 'upstream unavailable');
  } finally {
    restore();
    await fakeServer.close();
  }

  console.log('test-mcp-json-response-parsing: ok');
}

run().catch((error) => {
  console.error('test-mcp-json-response-parsing: failed');
  console.error(error);
  process.exit(1);
});
