# Adding a Custom Adapter

This guide explains how to create and register a custom adapter for `cliagents`. Adapters integrate CLI-based LLM tools by implementing the shared interface in `src/core/base-llm-adapter.js` and publishing capability metadata through `src/adapters/contract.js`.

**1) Overview of the Adapter Interface**

All adapters extend `BaseLLMAdapter`, which is an `EventEmitter` defining a consistent lifecycle for CLI tools:

- Check whether the CLI is available on the host.
- Spawn a session with optional system prompt, allowed tools, and working directory.
- Send messages and stream back response chunks.
- Terminate sessions and clean up processes.

File reference: `src/core/base-llm-adapter.js`.

The explicit capability/contract helpers live in `src/adapters/contract.js`. New first-party adapters should use them so the broker can reason about execution mode, multi-turn support, tool support, and failure semantics without guessing from implementation details.

**2) Required Methods to Implement**

Your adapter class must implement these methods:

- `isAvailable()`
Returns `Promise<boolean>` indicating whether the CLI is installed and reachable.
- `spawn(sessionId, options)`
Creates a new session and stores any session metadata you need.
- `send(sessionId, message, options)`
Async generator that yields response chunks. Each chunk is an object with at least `type` and `content`.
- `terminate(sessionId)`
Stops the session and cleans up any underlying processes.
- `isSessionActive(sessionId)`
Returns `true` if the session is currently valid.
- `getActiveSessions()`
Returns an array of active session IDs.

Common optional overrides:

- `getAvailableModels()` if your CLI supports model selection.
- `parseResponse(text)` for adapter-specific parsing.
- `interrupt(sessionId)` for graceful interruption. The base class provides a default implementation if you track `activeProcesses`.
- `getCapabilities()` to return broker-visible capability metadata created with `defineAdapterCapabilities(...)`.
- `getContract()` to return the adapter's explicit contract descriptor created with `createAdapterContract(...)`.

**3) Minimal Working Example**

This example shells out to a hypothetical CLI named `mycli`. It demonstrates the required methods and a basic streaming protocol.

```js
// src/adapters/my-adapter.js
const { spawn } = require('child_process');
const BaseLLMAdapter = require('../core/base-llm-adapter');

class MyAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({ timeout: 60000, workDir: '/tmp/agent', ...config });
    this.name = 'my-adapter';
    this.version = '0.1.0';
    this.sessions = new Map();
    this.activeProcesses = new Map();
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const check = spawn('which', ['mycli']);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  async spawn(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const session = {
      sessionId,
      workDir: options.workDir || this.config.workDir,
      systemPrompt: options.systemPrompt,
      allowedTools: options.allowedTools
    };

    this.sessions.set(sessionId, session);
    this.emit('ready', { sessionId });

    return { sessionId, status: 'ready', adapter: this.name };
  }

  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);

    const proc = spawn('mycli', ['--prompt', message], {
      cwd: session.workDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.activeProcesses.set(sessionId, proc);

    for await (const chunk of proc.stdout) {
      yield { type: 'text', content: chunk.toString() };
    }

    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    this.activeProcesses.delete(sessionId);

    if (exitCode !== 0) {
      yield { type: 'error', content: `mycli exited with ${exitCode}` };
      return;
    }

    yield { type: 'result', content: 'done' };
  }

  async terminate(sessionId) {
    const proc = this.activeProcesses.get(sessionId);
    if (proc && !proc.killed) proc.kill('SIGTERM');
    this.activeProcesses.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  isSessionActive(sessionId) {
    return this.sessions.has(sessionId);
  }

  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }
}

module.exports = MyAdapter;
```

**4) Registration With the Server**

There are two common ways to register your adapter.

A) Programmatic registration (custom server):

```js
const AgentServer = require('./src/server');
const MyAdapter = require('./src/adapters/my-adapter');

const server = new AgentServer();
server.registerAdapter('my-adapter', new MyAdapter());

server.start();
```

B) Register at startup (default server bootstrap):

```js
// src/server/index.js
const MyAdapter = require('../adapters/my-adapter');

// ...inside server initialization
this.sessionManager.registerAdapter('my-adapter', new MyAdapter(options.myAdapter || {}));
```

Once registered, the adapter is visible via `GET /adapters` and can be used by passing `adapter: "my-adapter"` in API requests.
