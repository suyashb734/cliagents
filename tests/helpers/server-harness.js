const AgentServer = require('../../src/server');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UNAUTH_LOCALHOST_ENV = 'CLIAGENTS_ALLOW_UNAUTHENTICATED_LOCALHOST';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hasConfiguredApiKey() {
  return Boolean(
    (process.env.CLIAGENTS_API_KEY && process.env.CLIAGENTS_API_KEY.trim()) ||
    (process.env.CLI_AGENTS_API_KEY && process.env.CLI_AGENTS_API_KEY.trim())
  );
}

async function startTestServer(options = {}) {
  const authOptions = options.auth || {};
  const allowUnauthenticatedLocalhost = authOptions.allowUnauthenticatedLocalhost !== false;
  const previousUnauthValue = process.env[UNAUTH_LOCALHOST_ENV];
  let shouldRestoreUnauthEnv = false;

  if (allowUnauthenticatedLocalhost && !hasConfiguredApiKey() && previousUnauthValue !== '1') {
    process.env[UNAUTH_LOCALHOST_ENV] = '1';
    shouldRestoreUnauthEnv = true;
  }

  const tempDataDir = options.orchestration?.dataDir || makeTempDir('cliagents-test-data-');
  const tempLogDir = options.orchestration?.logDir || makeTempDir('cliagents-test-logs-');
  const tempTmuxSocketPath = options.orchestration?.tmuxSocketPath || path.join(makeTempDir('cliagents-test-tmux-'), 'broker.sock');

  try {
    const server = new AgentServer({
      ...options,
      host: '127.0.0.1',
      port: 0,
      cleanupOrphans: false,
      orchestration: {
        ...(options.orchestration || {}),
        dataDir: tempDataDir,
        logDir: tempLogDir,
        tmuxSocketPath: tempTmuxSocketPath,
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
      tempLogDir,
      tempTmuxSocketPath,
      __authEnvRestore: shouldRestoreUnauthEnv
        ? { name: UNAUTH_LOCALHOST_ENV, value: previousUnauthValue }
        : null
    };
  } catch (error) {
    if (shouldRestoreUnauthEnv) {
      if (typeof previousUnauthValue === 'string') {
        process.env[UNAUTH_LOCALHOST_ENV] = previousUnauthValue;
      } else {
        delete process.env[UNAUTH_LOCALHOST_ENV];
      }
    }
    throw error;
  }
}

async function stopTestServer(testServer) {
  if (!testServer?.server) {
    return;
  }

  await testServer.server.stop();

  for (const dirPath of [testServer.tempDataDir, testServer.tempLogDir, testServer.tempTmuxSocketPath && path.dirname(testServer.tempTmuxSocketPath)]) {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }

  const authEnvRestore = testServer.__authEnvRestore;
  if (authEnvRestore) {
    if (typeof authEnvRestore.value === 'string') {
      process.env[authEnvRestore.name] = authEnvRestore.value;
    } else {
      delete process.env[authEnvRestore.name];
    }
  }
}

module.exports = {
  startTestServer,
  stopTestServer
};
