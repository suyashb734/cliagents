#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');

const AgentServer = require('../src/server');

async function request(baseUrl, method, route, body) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data };
}

async function startServer() {
  const server = new AgentServer({
    host: '127.0.0.1',
    port: 0,
    cleanupOrphans: false,
    orchestration: {
      enabled: false
    }
  });
  await server.start();
  const address = server.server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function run() {
  console.log('Running /ask route option tests...');

  const serverHandle = await startServer();
  const { server, baseUrl } = serverHandle;
  const terminatedSessionIds = [];
  let createSessionOptions = null;

  try {
    server.sessionManager.createSession = async (options) => {
      createSessionOptions = { ...options };
      assert(createSessionOptions.workDir, 'expected /ask to create or forward a workDir');
      assert(fs.existsSync(createSessionOptions.workDir), 'expected ephemeral workDir to exist before send');
      return { sessionId: 'test-ask-session' };
    };

    server.sessionManager.send = async (sessionId, message, options = {}) => {
      assert.strictEqual(sessionId, 'test-ask-session');
      assert.strictEqual(message, 'Reply with JSON.');
      assert.strictEqual(options.timeout, 1234);
      return { result: '{"ok":true}' };
    };

    server.sessionManager.terminateSession = async (sessionId) => {
      terminatedSessionIds.push(sessionId);
      return true;
    };

    const { status, data } = await request(baseUrl, 'POST', '/ask', {
      adapter: 'gemini-cli',
      message: 'Reply with JSON.',
      timeout: 1234,
      temperature: 0.25,
      top_p: 0.8,
      top_k: 20,
      max_output_tokens: 512
    });

    assert.strictEqual(status, 200, `expected 200 from /ask, got ${status} ${JSON.stringify(data)}`);
    assert.deepStrictEqual(data, { result: '{"ok":true}' });
    assert(createSessionOptions, 'expected createSession to be called');
    assert.strictEqual(createSessionOptions.adapter, 'gemini-cli');
    assert.strictEqual(createSessionOptions.temperature, 0.25);
    assert.strictEqual(createSessionOptions.top_p, 0.8);
    assert.strictEqual(createSessionOptions.top_k, 20);
    assert.strictEqual(createSessionOptions.max_output_tokens, 512);
    assert.strictEqual(terminatedSessionIds.length, 1);
    assert.strictEqual(terminatedSessionIds[0], 'test-ask-session');
    assert(!fs.existsSync(createSessionOptions.workDir), 'expected ephemeral workDir to be removed after /ask completed');

    console.log('  ✓ /ask forwards generation params and cleans ephemeral workdirs');
    console.log('/ask route option tests passed.');
  } finally {
    await server.stop();
  }
}

run().catch((error) => {
  console.error('/ask route option tests failed:', error);
  process.exit(1);
});
