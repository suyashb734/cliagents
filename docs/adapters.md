# cliagents Adapters

The canonical active broker surface is:

- `claude-code`
- `gemini-cli`
- `codex-cli`
- `qwen-cli`
- `opencode-cli`

This is the runtime truth for `GET /adapters`, orchestration, and the default test gates. New adapter work should either enter through this contract completely or stay out of the supported surface until it is ready.

## Public Alpha Status

`supported-alpha` requires the child adapter reliability matrix to report ready
across three consecutive runs in the last 24 hours. Otherwise the adapter is
`experimental`. `qwen-cli` remains `experimental/degraded` unless it passes
three session creates, three follow-up messages, and one resume within one hour.

| Adapter | Status | Last verified | Matrix run id | Notes |
|---|---|---:|---|---|
| `claude-code` | `experimental` | 2026-05-11 | pending-live-matrix | Deterministic tests cover command construction, auth, metadata, and MCP flows; 3-run child reliability evidence is still required for `supported-alpha`. |
| `gemini-cli` | `experimental` | 2026-05-11 | pending-live-matrix | Deterministic and runtime tests cover fallback and resume behavior; live quota/capacity can still affect readiness. |
| `codex-cli` | `experimental` | 2026-05-11 | pending-live-matrix | Deterministic and runtime tests cover managed roots, resume, model selection, and usage parsing; live matrix promotion is pending. |
| `qwen-cli` | `experimental/degraded` | 2026-05-11 | pending-live-matrix | Upstream auth/provider availability has been unreliable; do not classify as supported until the stricter Qwen pass bar succeeds. |
| `opencode-cli` | `experimental` | 2026-05-11 | pending-live-matrix | Deterministic tests cover command construction, model routing, and smoke paths; live matrix promotion is pending. |

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
