---
name: adding-adapters
description: Guide for adding new CLI adapters to cliagents. Use when creating a new adapter for a CLI tool like Claude Code, Gemini CLI, Codex, etc.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Adding New Adapters to cliagents

## Quick Start

1. Create adapter file: `src/adapters/my-cli.js`
2. Extend `BaseLLMAdapter` class
3. Implement required methods
4. Register in `src/server/index.js`
5. Add to MODEL_MAP in `src/server/openai-compat.js`

## Adapter Template

```javascript
const BaseLLMAdapter = require('../core/base-llm-adapter');
const { spawn } = require('child_process');

class MyCliAdapter extends BaseLLMAdapter {
  constructor(config = {}) {
    super(config);
    this.name = 'my-cli';
    this.timeout = config.timeout || 120000;
  }

  async isAvailable() {
    // Check if CLI is installed
    try {
      const { execSync } = require('child_process');
      execSync('which my-cli', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  getAvailableModels() {
    return ['model-1', 'model-2'];
  }

  async *send(sessionId, message, options = {}) {
    // Implement streaming response
    const process = spawn('my-cli', ['--prompt', message]);

    for await (const chunk of process.stdout) {
      yield {
        type: 'progress',
        progressType: 'assistant',
        content: chunk.toString()
      };
    }

    yield { type: 'result', content: fullResponse };
  }

  async terminate(sessionId) {
    // Cleanup
  }
}

module.exports = MyCliAdapter;
```

## Required Methods

| Method | Purpose |
|--------|---------|
| `isAvailable()` | Check if CLI is installed |
| `getAvailableModels()` | Return list of supported models |
| `send(sessionId, message, options)` | Async generator yielding response chunks |
| `terminate(sessionId)` | Cleanup resources |

## Registration

In `src/server/index.js`:
```javascript
const MyCliAdapter = require('../adapters/my-cli');
this.sessionManager.registerAdapter('my-cli', new MyCliAdapter(options.myCli || {}));
```

In `src/server/openai-compat.js` MODEL_MAP:
```javascript
'my-model': { adapter: 'my-cli', model: 'model-1' },
```

## Testing

Add test in `tests/run-all.js`:
```javascript
await testAdapter('my-cli', 'My CLI');
```

## Examples

See existing adapters:
- `src/adapters/claude-code.js` - Full-featured with session resume
- `src/adapters/gemini-cli.js` - Config file management
- `src/adapters/codex-cli.js` - Simple spawn pattern
