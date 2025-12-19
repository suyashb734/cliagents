/**
 * cliagents
 *
 * Main entry point - can be used as a module or run directly as a server.
 */

// Core exports
const AgentAdapter = require('./core/adapter');
const SessionManager = require('./core/session-manager');

// Adapters - Existing
const ClaudeCodeAdapter = require('./adapters/claude-code');
const GeminiCliAdapter = require('./adapters/gemini-cli');

// Adapters - New CLI Models
const CodexCliAdapter = require('./adapters/codex-cli');
const AiderAdapter = require('./adapters/aider');
const GooseAdapter = require('./adapters/goose');
const AmazonQAdapter = require('./adapters/amazon-q');
const PlandexAdapter = require('./adapters/plandex');
const ContinueCliAdapter = require('./adapters/continue-cli');
const MistralVibeAdapter = require('./adapters/mistral-vibe');
const ShellGptAdapter = require('./adapters/shell-gpt');
const AichatAdapter = require('./adapters/aichat');
const GitHubCopilotAdapter = require('./adapters/github-copilot');

// Utilities
const SessionWrapper = require('./utils/session-wrapper');

// Server
const AgentServer = require('./server');

// Transcription Service
const { transcribeAudio } = require('./services/transcriptionService');

// Export for use as a module
module.exports = {
  // Core
  AgentAdapter,
  SessionManager,
  SessionWrapper,

  // Adapters - Existing
  ClaudeCodeAdapter,
  GeminiCliAdapter,

  // Adapters - New CLI Models
  CodexCliAdapter,
  AiderAdapter,
  GooseAdapter,
  AmazonQAdapter,
  PlandexAdapter,
  ContinueCliAdapter,
  MistralVibeAdapter,
  ShellGptAdapter,
  AichatAdapter,
  GitHubCopilotAdapter,

  // Server
  AgentServer,

  // Transcription
  transcribeAudio,

  // Quick-start factory
  createServer: (options = {}) => new AgentServer(options),

  // Create standalone session manager (without HTTP server)
  // Registers all available adapters
  createSessionManager: (options = {}) => {
    const manager = new SessionManager(options);

    // Existing adapters
    manager.registerAdapter('claude-code', new ClaudeCodeAdapter(options.claudeCode || {}));
    manager.registerAdapter('gemini-cli', new GeminiCliAdapter(options.geminiCli || {}));

    // New CLI adapters
    manager.registerAdapter('codex-cli', new CodexCliAdapter(options.codexCli || {}));
    manager.registerAdapter('aider', new AiderAdapter(options.aider || {}));
    manager.registerAdapter('goose', new GooseAdapter(options.goose || {}));
    manager.registerAdapter('amazon-q', new AmazonQAdapter(options.amazonQ || {}));
    manager.registerAdapter('plandex', new PlandexAdapter(options.plandex || {}));
    manager.registerAdapter('continue-cli', new ContinueCliAdapter(options.continueCli || {}));
    manager.registerAdapter('mistral-vibe', new MistralVibeAdapter(options.mistralVibe || {}));
    manager.registerAdapter('shell-gpt', new ShellGptAdapter(options.shellGpt || {}));
    manager.registerAdapter('aichat', new AichatAdapter(options.aichat || {}));
    manager.registerAdapter('github-copilot', new GitHubCopilotAdapter(options.githubCopilot || {}));

    return manager;
  }
};

// Run as server if executed directly
if (require.main === module) {
  const port = process.env.PORT || 3001;

  // Check for transcription command
  const args = process.argv.slice(2);
  const transcribeIndex = args.indexOf('--transcribe');

  if (transcribeIndex !== -1) {
    const audioFilePath = args[transcribeIndex + 1];
    if (audioFilePath) {
      console.log(`Transcribing audio file: ${audioFilePath}`);
      transcribeAudio(audioFilePath)
        .then(transcript => {
          console.log('Transcription Result:');
          console.log(transcript);
          process.exit(0);
        })
        .catch(error => {
          console.error('Transcription failed:', error);
          process.exit(1);
        });
    } else {
      console.error('Error: Please provide an audio file path after --transcribe');
      process.exit(1);
    }
    return; // Exit here, don't start the server
  }

  const server = new AgentServer({ port });

  server.start().then(() => {
    console.log('\nAPI Endpoints:');
    console.log('  GET  /health              - Health check');
    console.log('  GET  /adapters            - List available adapters');
    console.log('  POST /sessions            - Create new session');
    console.log('  GET  /sessions            - List all sessions');
    console.log('  GET  /sessions/:id        - Get session info');
    console.log('  POST /sessions/:id/messages - Send message');
    console.log('  POST /sessions/:id/parse  - Parse response text');
    console.log('  DELETE /sessions/:id      - Terminate session');
    console.log('  POST /ask                 - One-shot ask (auto session)');
    console.log('\nWebSocket: ws://localhost:' + port + '/ws');
    console.log('\nReady to accept connections!\n');
  });

  // Note: Graceful shutdown handlers are registered by AgentServer._setupShutdownHandlers()
}

