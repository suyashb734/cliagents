/**
 * cliagents
 *
 * HTTP + WebSocket server that exposes agent adapters via REST API and real-time streaming.
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const SessionManager = require('../core/session-manager');

// Adapters - Existing
const ClaudeCodeAdapter = require('../adapters/claude-code');
const GeminiCliAdapter = require('../adapters/gemini-cli');

// Adapters - New CLI Models
const CodexCliAdapter = require('../adapters/codex-cli');
const AiderAdapter = require('../adapters/aider');
const GooseAdapter = require('../adapters/goose');
const AmazonQAdapter = require('../adapters/amazon-q');
const PlandexAdapter = require('../adapters/plandex');
const ContinueCliAdapter = require('../adapters/continue-cli');
const MistralVibeAdapter = require('../adapters/mistral-vibe');
const ShellGptAdapter = require('../adapters/shell-gpt');
const AichatAdapter = require('../adapters/aichat');
const GitHubCopilotAdapter = require('../adapters/github-copilot');

// Utilities
const { sendError, errorHandler, ErrorCodes } = require('../utils/errors');
const {
  getAdapterStatus,
  getAllAdapterStatuses,
  testAdapterAuth,
  setEnvVar,
  getAuthConfig
} = require('../utils/adapter-auth');

class AgentServer {
  constructor(options = {}) {
    this.port = options.port || 3001;
    this.host = options.host || '0.0.0.0';

    // Initialize session manager
    this.sessionManager = new SessionManager({
      defaultAdapter: options.defaultAdapter || 'claude-code',
      sessionTimeout: options.sessionTimeout || 30 * 60 * 1000,
      maxSessions: options.maxSessions || 10
    });

    // Register all adapters
    this.sessionManager.registerAdapter('claude-code', new ClaudeCodeAdapter(options.claudeCode || {}));
    this.sessionManager.registerAdapter('gemini-cli', new GeminiCliAdapter(options.geminiCli || {}));
    this.sessionManager.registerAdapter('codex-cli', new CodexCliAdapter(options.codexCli || {}));
    this.sessionManager.registerAdapter('aider', new AiderAdapter(options.aider || {}));
    this.sessionManager.registerAdapter('goose', new GooseAdapter(options.goose || {}));
    this.sessionManager.registerAdapter('amazon-q', new AmazonQAdapter(options.amazonQ || {}));
    this.sessionManager.registerAdapter('plandex', new PlandexAdapter(options.plandex || {}));
    this.sessionManager.registerAdapter('continue-cli', new ContinueCliAdapter(options.continueCli || {}));
    this.sessionManager.registerAdapter('mistral-vibe', new MistralVibeAdapter(options.mistralVibe || {}));
    this.sessionManager.registerAdapter('shell-gpt', new ShellGptAdapter(options.shellGpt || {}));
    this.sessionManager.registerAdapter('aichat', new AichatAdapter(options.aichat || {}));
    this.sessionManager.registerAdapter('github-copilot', new GitHubCopilotAdapter(options.githubCopilot || {}));

    // Express app
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json({ limit: '50mb' }));

    // Serve static files from public directory
    const publicPath = path.join(__dirname, '../../public');
    this.app.use(express.static(publicPath));

    // Setup routes
    this._setupRoutes();

    // WebSocket clients
    this.wsClients = new Map(); // sessionId -> Set<ws>
  }

  _setupRoutes() {
    const app = this.app;

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // OpenAPI specification
    app.get('/openapi.json', (req, res) => {
      const specPath = path.join(__dirname, '../../openapi.json');
      if (fs.existsSync(specPath)) {
        res.setHeader('Content-Type', 'application/json');
        res.sendFile(specPath);
      } else {
        res.status(404).json({ error: 'OpenAPI specification not found' });
      }
    });

    // List available adapters
    app.get('/adapters', async (req, res) => {
      try {
        const adapters = [];
        for (const name of this.sessionManager.getAdapterNames()) {
          const adapter = this.sessionManager.getAdapter(name);
          const available = await adapter.isAvailable();
          const adapterInfo = {
            name,
            ...adapter.getInfo(),
            available
          };
          // Include available models if adapter supports them
          if (typeof adapter.getAvailableModels === 'function') {
            adapterInfo.models = adapter.getAvailableModels();
          }
          adapters.push(adapterInfo);
        }
        res.json({ adapters });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create session
    app.post('/sessions', async (req, res) => {
      try {
        const {
          adapter, systemPrompt, allowedTools, workDir, model, jsonSchema,
          // Generation parameters (Gemini only)
          temperature, top_p, top_k, max_output_tokens
        } = req.body;
        const session = await this.sessionManager.createSession({
          adapter,
          systemPrompt,
          allowedTools,
          workDir,
          model,
          jsonSchema,  // JSON Schema for structured output (Claude only)
          // Generation parameters (Gemini only - writes to ~/.gemini/config.yaml)
          temperature,
          top_p,
          top_k,
          max_output_tokens
        });
        res.json(session);
      } catch (error) {
        if (error.message?.includes('not registered')) {
          return sendError(res, 'ADAPTER_NOT_FOUND', { message: error.message });
        }
        if (error.message?.includes('not available')) {
          return sendError(res, 'ADAPTER_UNAVAILABLE', { message: error.message });
        }
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // List sessions
    app.get('/sessions', (req, res) => {
      try {
        const sessions = this.sessionManager.listSessions();
        res.json({ sessions });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get session info
    app.get('/sessions/:sessionId', (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json(session);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Get session status (running/stable/error)
    app.get('/sessions/:sessionId/status', (req, res) => {
      try {
        const status = this.sessionManager.getSessionStatus(req.params.sessionId);
        if (!status) {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json(status);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Interrupt session (kill active process)
    app.post('/sessions/:sessionId/interrupt', async (req, res) => {
      try {
        const result = await this.sessionManager.interruptSession(req.params.sessionId);
        if (result.reason === 'session_not_found') {
          return sendError(res, 'SESSION_NOT_FOUND');
        }
        res.json(result);
      } catch (error) {
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Send message to session (non-streaming, waits for full response)
    app.post('/sessions/:sessionId/messages', async (req, res) => {
      try {
        const { message, timeout, stream, jsonSchema, allowedTools } = req.body;
        if (!message) {
          return sendError(res, 'MISSING_PARAMETER', { param: 'message', message: 'Message is required' });
        }

        const options = {
          timeout,
          jsonSchema,      // Per-message JSON schema override (Claude only)
          allowedTools     // Per-message allowed tools override
        };

        // If stream=true, use SSE streaming
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
          res.flushHeaders();

          try {
            for await (const chunk of this.sessionManager.sendStream(req.params.sessionId, message, options)) {
              if (chunk.type === 'chunk') {
                res.write(`event: chunk\ndata: ${JSON.stringify({ content: chunk.content })}\n\n`);
              } else if (chunk.type === 'result') {
                res.write(`event: result\ndata: ${JSON.stringify(chunk)}\n\n`);
              } else if (chunk.type === 'error') {
                // Send standardized error in SSE format
                const errorCode = chunk.timedOut ? 'timeout_error' : 'cli_error';
                res.write(`event: error\ndata: ${JSON.stringify({
                  error: { code: errorCode, message: chunk.content, type: errorCode }
                })}\n\n`);
              }
            }
            res.write('event: done\ndata: {}\n\n');
            res.end();
          } catch (error) {
            const errorCode = error.message?.includes('not found') ? 'session_not_found' : 'internal_error';
            res.write(`event: error\ndata: ${JSON.stringify({
              error: { code: errorCode, message: error.message, type: errorCode }
            })}\n\n`);
            res.end();
          }
          return;
        }

        // Non-streaming: collect full response
        const response = await this.sessionManager.send(
          req.params.sessionId,
          message,
          options
        );

        res.json(response);
      } catch (error) {
        if (error.message?.includes('not found')) {
          return sendError(res, 'SESSION_NOT_FOUND', { message: error.message });
        }
        if (error.message?.includes('timed out')) {
          return sendError(res, 'TIMEOUT', { message: error.message });
        }
        sendError(res, 'INTERNAL_ERROR', { message: error.message });
      }
    });

    // Parse response
    app.post('/sessions/:sessionId/parse', (req, res) => {
      try {
        const { text } = req.body;
        if (!text) {
          return res.status(400).json({ error: 'Text is required' });
        }

        const parsed = this.sessionManager.parseResponse(req.params.sessionId, text);
        res.json(parsed);
      } catch (error) {
        if (error.message.includes('not found')) {
          return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
      }
    });

    // Terminate session
    app.delete('/sessions/:sessionId', async (req, res) => {
      try {
        const terminated = await this.sessionManager.terminateSession(req.params.sessionId);
        if (!terminated) {
          return res.status(404).json({ error: 'Session not found' });
        }
        res.json({ status: 'terminated' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Upload files to session working directory
    // Accepts: { files: [{ name: "file.txt", content: "base64...", encoding: "base64" | "utf8" }] }
    app.post('/sessions/:sessionId/files', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        const { files } = req.body;
        if (!files || !Array.isArray(files) || files.length === 0) {
          return res.status(400).json({ error: 'Files array is required' });
        }

        // Get session's working directory from adapter
        const adapter = this.sessionManager.getAdapter(session.adapterName);
        const sessionInfo = adapter.sessions.get(req.params.sessionId);
        const workDir = sessionInfo?.workDir || '/tmp/agent';

        // Ensure work directory exists
        if (!fs.existsSync(workDir)) {
          fs.mkdirSync(workDir, { recursive: true });
        }

        const results = [];
        for (const file of files) {
          if (!file.name) {
            results.push({ error: 'File name is required' });
            continue;
          }

          // Sanitize filename to prevent path traversal
          const safeName = path.basename(file.name);
          const filePath = path.join(workDir, safeName);

          try {
            // Decode content based on encoding
            let content;
            if (file.encoding === 'base64') {
              content = Buffer.from(file.content, 'base64');
            } else {
              content = file.content || '';
            }

            fs.writeFileSync(filePath, content);
            results.push({
              name: safeName,
              path: filePath,
              size: content.length,
              status: 'uploaded'
            });
          } catch (writeError) {
            results.push({
              name: safeName,
              error: writeError.message,
              status: 'failed'
            });
          }
        }

        res.json({
          sessionId: req.params.sessionId,
          workDir,
          files: results
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // List files in session working directory
    app.get('/sessions/:sessionId/files', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        // Get session's working directory from adapter
        const adapter = this.sessionManager.getAdapter(session.adapterName);
        const sessionInfo = adapter.sessions.get(req.params.sessionId);
        const workDir = sessionInfo?.workDir || '/tmp/agent';

        if (!fs.existsSync(workDir)) {
          return res.json({ sessionId: req.params.sessionId, workDir, files: [] });
        }

        const files = fs.readdirSync(workDir).map(name => {
          const filePath = path.join(workDir, name);
          const stats = fs.statSync(filePath);
          return {
            name,
            path: filePath,
            size: stats.size,
            isDirectory: stats.isDirectory(),
            modified: stats.mtime
          };
        });

        res.json({
          sessionId: req.params.sessionId,
          workDir,
          files
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Simple one-shot ask (creates session, sends message, returns response, terminates)
    app.post('/ask', async (req, res) => {
      try {
        const { message, adapter, systemPrompt, timeout, jsonSchema, allowedTools, model } = req.body;
        if (!message) {
          return res.status(400).json({ error: 'Message is required' });
        }

        // Create session with JSON schema support
        const session = await this.sessionManager.createSession({
          adapter,
          systemPrompt,
          jsonSchema,      // JSON schema for structured output (Claude only)
          allowedTools,    // Allowed tools
          model            // Model selection
        });

        try {
          // Send message with JSON schema
          const response = await this.sessionManager.send(session.sessionId, message, {
            timeout,
            jsonSchema      // Also pass per-message for Claude
          });

          // Terminate session
          await this.sessionManager.terminateSession(session.sessionId);

          res.json(response);
        } catch (error) {
          // Clean up on error
          await this.sessionManager.terminateSession(session.sessionId);
          throw error;
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // Dashboard Routes
    // ==========================================

    // Serve dashboard page
    app.get('/dashboard', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
    });

    // Get status for all adapters
    app.get('/dashboard/adapters/status', async (req, res) => {
      try {
        const adapters = [];

        for (const name of this.sessionManager.getAdapterNames()) {
          const adapter = this.sessionManager.getAdapter(name);
          const status = await getAdapterStatus(name, adapter);

          // Determine auth status from the status object
          let authStatus = 'unknown';
          if (status.authenticated === true) {
            authStatus = 'authenticated';
          } else if (status.authenticated === 'likely') {
            authStatus = 'likely';
          } else if (status.authenticated === false) {
            authStatus = 'failed';
          }

          adapters.push({
            name: status.name,
            displayName: status.displayName,
            authType: status.authType,
            installed: status.installed,
            authStatus,
            envVarsSet: status.envVarsSet,
            configFileExists: status.configFileExists,
            configFilePath: status.configFilePath,
            loginCommand: status.loginCommand,
            loginInstructions: status.loginInstructions,
            docsUrl: status.docsUrl
          });
        }

        res.json({ adapters });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Test adapter authentication
    app.post('/dashboard/adapters/:name/test', async (req, res) => {
      try {
        const adapterName = req.params.name;
        const adapter = this.sessionManager.getAdapter(adapterName);

        if (!adapter) {
          return res.status(404).json({ success: false, error: 'Adapter not found' });
        }

        const isAvailable = await adapter.isAvailable();
        if (!isAvailable) {
          return res.json({ success: false, error: 'CLI not installed' });
        }

        const result = await testAdapterAuth(adapterName, adapter, 60000); // 60s timeout
        res.json(result);
      } catch (error) {
        res.json({ success: false, error: error.message });
      }
    });

    // Set environment variables for adapter
    app.post('/dashboard/adapters/:name/env', async (req, res) => {
      try {
        const { envVars } = req.body;

        if (!envVars || typeof envVars !== 'object') {
          return res.status(400).json({ success: false, error: 'envVars object required' });
        }

        // Set each environment variable
        for (const [key, value] of Object.entries(envVars)) {
          if (value && typeof value === 'string') {
            setEnvVar(key, value);
          }
        }

        res.json({ success: true, message: 'Environment variables set' });
      } catch (error) {
        res.json({ success: false, error: error.message });
      }
    });

    // Get auth configuration for adapter
    app.get('/dashboard/adapters/:name/auth-config', (req, res) => {
      try {
        const config = getAuthConfig(req.params.name);
        if (!config) {
          return res.status(404).json({ error: 'Adapter not found' });
        }
        res.json(config);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  _setupWebSocket(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      let sessionId = null;

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          switch (msg.type) {
            case 'create_session':
              const session = await this.sessionManager.createSession({
                adapter: msg.adapter,
                systemPrompt: msg.systemPrompt,
                allowedTools: msg.allowedTools,
                workDir: msg.workDir,
                model: msg.model,
                jsonSchema: msg.jsonSchema,  // JSON Schema for structured output (Claude only)
                // Generation parameters (Gemini only - writes to ~/.gemini/config.yaml)
                temperature: msg.temperature,
                top_p: msg.top_p,
                top_k: msg.top_k,
                max_output_tokens: msg.max_output_tokens
              });
              sessionId = session.sessionId;

              // Track this WebSocket for the session
              if (!this.wsClients.has(sessionId)) {
                this.wsClients.set(sessionId, new Set());
              }
              this.wsClients.get(sessionId).add(ws);

              ws.send(JSON.stringify({ type: 'session_created', session }));
              break;

            case 'join_session':
              sessionId = msg.sessionId;
              const existingSession = this.sessionManager.getSession(sessionId);
              if (!existingSession) {
                ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
                return;
              }

              if (!this.wsClients.has(sessionId)) {
                this.wsClients.set(sessionId, new Set());
              }
              this.wsClients.get(sessionId).add(ws);

              ws.send(JSON.stringify({ type: 'session_joined', sessionId }));
              break;

            case 'send_message':
              if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', error: 'No session. Create or join first.' }));
                return;
              }

              // Stream response
              ws.send(JSON.stringify({ type: 'thinking' }));

              try {
                for await (const chunk of this.sessionManager.sendStream(sessionId, msg.message, { timeout: msg.timeout })) {
                  // Broadcast to all clients watching this session
                  const clients = this.wsClients.get(sessionId);
                  if (clients) {
                    const chunkMsg = JSON.stringify({ type: 'chunk', chunk });
                    for (const client of clients) {
                      if (client.readyState === 1) {
                        client.send(chunkMsg);
                      }
                    }
                  }
                }

                ws.send(JSON.stringify({ type: 'complete' }));
              } catch (error) {
                ws.send(JSON.stringify({ type: 'error', error: error.message }));
              }
              break;

            case 'terminate_session':
              if (sessionId) {
                await this.sessionManager.terminateSession(sessionId);
                this.wsClients.delete(sessionId);
                ws.send(JSON.stringify({ type: 'session_terminated' }));
                sessionId = null;
              }
              break;

            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
              break;
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', error: error.message }));
        }
      });

      ws.on('close', () => {
        if (sessionId && this.wsClients.has(sessionId)) {
          this.wsClients.get(sessionId).delete(ws);
          if (this.wsClients.get(sessionId).size === 0) {
            this.wsClients.delete(sessionId);
          }
        }
      });

      ws.send(JSON.stringify({ type: 'connected', message: 'cliagents' }));
    });

    // Forward session manager events to WebSocket clients
    this.sessionManager.on('chunk', (data) => {
      const clients = this.wsClients.get(data.sessionId);
      if (clients) {
        const msg = JSON.stringify({ type: 'chunk', chunk: data.chunk });
        for (const client of clients) {
          if (client.readyState === 1) {
            client.send(msg);
          }
        }
      }
    });
  }

  /**
   * Clean up orphaned CLI processes from previous runs
   * @private
   */
  _cleanupOrphanProcesses() {
    console.log('[Cleanup] Checking for orphaned CLI processes...');
    let killed = 0;

    try {
      // Kill orphaned Gemini CLI processes (spawned with -p flag)
      execSync('pkill -f "gemini.*-p" 2>/dev/null || true', { stdio: 'ignore' });
      killed++;
    } catch (e) {
      // Ignore - process may not exist
    }

    try {
      // Kill orphaned Claude CLI processes (spawned with -p flag)
      execSync('pkill -f "claude -p" 2>/dev/null || true', { stdio: 'ignore' });
      killed++;
    } catch (e) {
      // Ignore - process may not exist
    }

    console.log('[Cleanup] Orphan cleanup complete');
  }

  /**
   * Start the server
   */
  async start() {
    // Clean up orphaned CLI processes from previous runs
    this._cleanupOrphanProcesses();

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        console.log(`cliagents running at http://${this.host}:${this.port}`);
        console.log(`WebSocket available at ws://${this.host}:${this.port}/ws`);
        console.log(`Chat UI available at http://${this.host}:${this.port}/`);
        console.log(`Dashboard available at http://${this.host}:${this.port}/dashboard`);

        this._setupWebSocket(this.server);

        // Log registered adapters
        console.log('\nRegistered adapters:');
        for (const name of this.sessionManager.getAdapterNames()) {
          console.log(`  - ${name}`);
        }
        console.log('');

        resolve(this.server);
      });
    });
  }

  /**
   * Stop the server
   */
  async stop() {
    // Close all WebSocket connections
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
    }

    // Kill all active CLI processes in adapters
    console.log('[Shutdown] Killing active CLI processes...');
    for (const name of this.sessionManager.getAdapterNames()) {
      const adapter = this.sessionManager.getAdapter(name);
      if (typeof adapter.killAllProcesses === 'function') {
        adapter.killAllProcesses();
      }
    }

    // Shutdown session manager
    await this.sessionManager.shutdown();

    // Close HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
  }

  /**
   * Get the session manager (for programmatic access)
   */
  getSessionManager() {
    return this.sessionManager;
  }

  /**
   * Register additional adapter
   */
  registerAdapter(name, adapter) {
    this.sessionManager.registerAdapter(name, adapter);
    return this;
  }
}

module.exports = AgentServer;
