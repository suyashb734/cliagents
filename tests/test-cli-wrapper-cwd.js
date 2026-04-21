'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function normalizePathForComparison(value) {
  return fs.realpathSync.native(value);
}

async function startMockServer() {
  let launchBody = null;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/orchestration/root-sessions/launch') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        launchBody = raw ? JSON.parse(raw) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          adapter: launchBody.adapter || 'codex-cli',
          rootSessionId: 'root-test-1',
          terminalId: 'term-test-1',
          sessionName: 'cliagents-root-test-1',
          consoleUrl: '/console?root=root-test-1&terminal=term-test-1',
          externalSessionRef: 'codex:managed:test-1',
          attachCommand: 'tmux attach -t "cliagents-root-test-1"',
          workDir: launchBody.workDir || null
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    getLaunchBody: () => launchBody,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const wrapperPath = path.join(projectRoot, 'bin', 'cliagents.js');
  const mockServer = await startMockServer();
  const tempWorkDir = makeTempDir('cliagents-wrapper-cwd-');

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapperPath, 'launch', 'codex', '--new-root', '--detach'], {
        cwd: tempWorkDir,
        env: {
          ...process.env,
          CLIAGENTS_URL: mockServer.url
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    });

    assert.strictEqual(result.code, 0, result.stderr || result.stdout || 'wrapper command failed');
    const launchBody = mockServer.getLaunchBody();
    assert(launchBody, 'expected wrapper to call the launch endpoint');
    assert.strictEqual(
      normalizePathForComparison(launchBody.workDir),
      normalizePathForComparison(tempWorkDir),
      'expected installed wrapper to preserve the caller cwd'
    );
    assert(
      result.stdout.includes(`workdir: ${launchBody.workDir}`) || result.stdout.includes(`workdir: ${tempWorkDir}`),
      'expected launch output to surface the resolved workdir'
    );
    console.log('✅ cliagents wrapper preserves caller cwd for managed root launch');
  } finally {
    await mockServer.close();
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
