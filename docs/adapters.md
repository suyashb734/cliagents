# cliagents Adapters

The canonical active broker surface is:

- `claude-code`
- `gemini-cli`
- `codex-cli`
- `qwen-cli`
- `opencode-cli`

This is the runtime truth for `GET /adapters`, orchestration, and the default test gates. New adapter work should either enter through this contract completely or stay out of the supported surface until it is ready.

Project execution defaults:

- Use Node `22.12.0` from [`.nvmrc`](./../.nvmrc).
- Prefer the package scripts because they re-exec through [`scripts/run-with-supported-node.js`](./../scripts/run-with-supported-node.js).
- Runtime and broad suites may skip provider-auth, token-expiry, provider-discontinuation, quota, capacity, or timeout failures when the broker contract is otherwise correct.

## Claude Code

Anthropic's official Claude Code CLI. Best suited for rich tool use, direct coding work, and managed-root/browser-supervision flows.

```bash
npm i -g @anthropic-ai/claude-code
claude auth login
```

```javascript
const session = await manager.createSession({
  adapter: 'claude-code',
  model: 'claude-sonnet-4-5-20250514',
  workDir: '/path/to/project'
});
```

Typical routing:
- direct session work that benefits from Claude's tool loop
- managed-root launch and browser supervision
- adapter surface validation for Claude-specific capabilities

## Gemini CLI

Google's official Gemini CLI. Best suited for research, web-aware review, and large-context analysis.

```bash
npm install -g @google/gemini-cli
gemini auth login
```

```javascript
const session = await manager.createSession({
  adapter: 'gemini-cli',
  model: 'gemini-2.5-pro',
  workDir: '/path/to/project'
});
```

Typical routing:
- `gemini-*` model prefixes in the OpenAI-compatible endpoint
- `review-security`
- `research`

## Codex CLI

OpenAI's official Codex CLI. Best suited for execution-heavy coding tasks, implementation, and test/fix loops.

```bash
npm i -g @openai/codex
codex login
```

```javascript
const session = await manager.createSession({
  adapter: 'codex-cli',
  model: 'o4-mini',
  workDir: '/path/to/project'
});
```

Typical routing:
- `gpt-*`, `o3-*`, `o4-*` model prefixes in the OpenAI-compatible endpoint
- `implement`
- `review-performance`
- `test`
- `fix`

## Qwen CLI

Qwen Code CLI. Best suited for planning, architecture review, and general reasoning-heavy review.

```bash
npm install -g @qwen-code/qwen-code
qwen auth
```

```javascript
const session = await manager.createSession({
  adapter: 'qwen-cli',
  model: 'qwen3-coder',
  workDir: '/path/to/project'
});
```

Typical routing:
- `qwen-*` model prefixes in the OpenAI-compatible endpoint
- `plan`
- `review`
- `architect`
- `document`

## OpenCode CLI

OpenCode CLI. Best suited for broader model-provider routing while still fitting the broker's active adapter contract.

```bash
install opencode
opencode providers login
```

```javascript
const session = await manager.createSession({
  adapter: 'opencode-cli',
  model: 'minimax-coding-plan/MiniMax-M2.7',
  workDir: '/path/to/project'
});
```

Typical routing:
- multi-provider execution when the broker wants one adapter surface with a live model catalog
- implementation slices that need alternate provider routing
- model-catalog exploration via `list_models`

## Role Mapping

The active role defaults are defined in [config/agent-profiles.json](/Users/mojave/Documents/AI-projects/cliagents/config/agent-profiles.json):

| Role | Default adapter |
|---|---|
| `plan` | `qwen-cli` |
| `implement` | `codex-cli` |
| `review` | `qwen-cli` |
| `review-security` | `gemini-cli` |
| `review-performance` | `codex-cli` |
| `test` | `codex-cli` |
| `fix` | `codex-cli` |
| `research` | `gemini-cli` |
| `architect` | `qwen-cli` |
| `document` | `qwen-cli` |

## Notes

- Use `npm test` for the canonical supported broker runtime.
- Use `npm run test:runtime` and `npm run test:broad` for runtime and HTTP/API regression coverage of that same active surface.
- If additional adapters are brought back later, they should re-enter through the adapter contract, routing, auth, docs, and tests together rather than as one-off code paths.
