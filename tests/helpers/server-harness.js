const AgentServer = require('../../src/server');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startTestServer(options = {}) {
  const tempDataDir = options.orchestration?.dataDir || makeTempDir('cliagents-test-data-');
  const tempLogDir = options.orchestration?.logDir || makeTempDir('cliagents-test-logs-');
  const server = new AgentServer({
    ...options,
    host: '127.0.0.1',
    port: 0,
    cleanupOrphans: false,
    orchestration: {
      ...(options.orchestration || {}),
      dataDir: tempDataDir,
      logDir: tempLogDir,
      destroyTerminalsOnStop: options.orchestration?.destroyTerminalsOnStop ?? true
    }
  });

  await server.start();
  const address = server.server?.address();
  const port = address && typeof address === 'object' ? address.port : options.port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    tempDataDir,
    tempLogDir
  };
}

async function stopTestServer(testServer) {
  if (!testServer?.server) {
    return;
  }

  await testServer.server.stop();

  for (const dirPath of [testServer.tempDataDir, testServer.tempLogDir]) {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }
}

module.exports = {
  startTestServer,
  stopTestServer
};
