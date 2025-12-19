# Contributing to cliagents

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- At least one supported AI CLI installed (Claude Code, Gemini CLI, etc.)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/suyashb734/cliagents.git
cd cliagents

# Install dependencies
npm install

# Start in development mode (auto-reload)
npm run dev

# Run tests (requires server running)
npm start &
npm test
```

## Project Structure

```
src/
├── index.js              # Entry point and exports
├── core/
│   ├── base-llm-adapter.js   # Base class for all adapters
│   └── session-manager.js    # Session lifecycle management
├── adapters/             # CLI adapter implementations
│   ├── claude-code.js
│   ├── gemini-cli.js
│   └── ...
├── server/
│   └── index.js          # HTTP + WebSocket server
├── services/             # Auxiliary services
└── utils/                # Shared utilities
```

## Adding a New Adapter

1. Create a new file in `src/adapters/your-adapter.js`
2. Extend `BaseLLMAdapter` from `src/core/base-llm-adapter.js`
3. Implement required methods:
   - `isAvailable()` - Check if CLI is installed
   - `spawn(sessionId, options)` - Initialize a session
   - `send(sessionId, message, options)` - Send message and yield responses
   - `terminate(sessionId)` - Clean up session
   - `isSessionActive(sessionId)` - Check session status
   - `getActiveSessions()` - List active sessions

4. Register in `src/server/index.js`:
   ```javascript
   const YourAdapter = require('../adapters/your-adapter');
   this.sessionManager.registerAdapter('your-adapter', new YourAdapter(options));
   ```

5. Export in `src/index.js`
6. Add tests in `tests/run-all.js`
7. Document in `README.md`

### Adapter Template

```javascript
const BaseLLMAdapter = require('../core/base-llm-adapter');

class YourAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super({
      timeout: 120000,
      ...config
    });
    this.name = 'your-adapter';
    this.sessions = new Map();
    this.activeProcesses = new Map();
  }

  async isAvailable() {
    // Check if CLI is installed
  }

  async spawn(sessionId, options = {}) {
    // Initialize session
  }

  async *send(sessionId, message, options = {}) {
    // Yield response chunks
    yield { type: 'progress', content: '...' };
    yield { type: 'result', content: '...' };
  }

  async terminate(sessionId) {
    // Clean up
  }

  isSessionActive(sessionId) {
    return this.sessions.has(sessionId);
  }

  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }
}

module.exports = YourAdapter;
```

## Code Style

- Use ES6+ features (async/await, destructuring, etc.)
- Use JSDoc comments for public methods
- Follow existing naming conventions
- Keep adapters consistent with existing implementations

## Testing

```bash
# Start the server
npm start

# In another terminal, run tests
npm test
```

All tests must pass before submitting a PR. Add tests for new features.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

### PR Checklist

- [ ] Tests pass
- [ ] New features have tests
- [ ] Documentation updated (README, JSDoc)
- [ ] Code follows existing style
- [ ] Commits are clean and descriptive

## Reporting Issues

- Use GitHub Issues
- Include steps to reproduce
- Include Node.js version and OS
- Include relevant logs

## Questions?

Open a GitHub Discussion or Issue.
