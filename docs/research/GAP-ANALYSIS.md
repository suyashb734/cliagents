# cliagents vs Claude Code: Feature Parity Gap Analysis

**Analysis Date:** February 5, 2026
**Methodology:** Multi-agent research using cliagents orchestration
**Agents Used:** Claude (architect), Gemini (research), Codex (verification)

---

## Executive Summary

**Question:** Can cliagents achieve full Claude Code feature parity with multi-model support?

**Verdict:** ✅ **CONDITIONALLY YES** - with 4-6 weeks of focused development

cliagents already provides unique multi-model capabilities that Claude Code lacks. The gaps are primarily in developer-facing features (skills, hooks) rather than core orchestration. Most gaps can be closed by adopting patterns from Superpowers (skills) and Gastown (persistence).

---

## 1. Feature-by-Feature Comparison

### Core Capabilities

| Claude Code Feature | cliagents Equivalent | Gap | Effort |
|---------------------|---------------------|-----|--------|
| **Task Tool** (ephemeral workers) | `delegate_task()` with `wait: false` | None ✅ | - |
| **Parallel Tasks** (10 concurrent) | `run_workflow()` parallel steps | None ✅ | - |
| **200k context per task** | Inherits from underlying CLI | None ✅ | - |
| **Subagents** (persistent experts) | Role-based profiles (`agent-profiles.json`) | **Partial** | 1 week |
| **One-level delegation limit** | No limit (can chain) | Better ✅ | - |

### Extensibility

| Claude Code Feature | cliagents Equivalent | Gap | Effort |
|---------------------|---------------------|-----|--------|
| **Skills/Slash Commands** | None | **Critical** ❌ | 2 weeks |
| **Skills Directory** (.claude/commands/) | None | **Critical** ❌ | 1 week |
| **Agent-invocable skills** | None | **High** ❌ | 1 week |
| **MCP Client** (tool consumption) | MCP Server only | **Medium** | 2 weeks |
| **MCP Server** (tool exposure) | Full implementation ✅ | None | - |

### Automation & Hooks

| Claude Code Feature | cliagents Equivalent | Gap | Effort |
|---------------------|---------------------|-----|--------|
| **PreToolUse hooks** | None | **High** ❌ | 1 week |
| **PostToolUse hooks** | None | **High** ❌ | 1 week |
| **Hook exit codes** | None | **Medium** | 3 days |
| **settings.json hooks config** | None | **Medium** | 3 days |

### Permissions & Security

| Claude Code Feature | cliagents Equivalent | Gap | Effort |
|---------------------|---------------------|-----|--------|
| **Deny/Allow/Ask tiers** | Permission bypass only | **High** ❌ | 1 week |
| **Glob pattern matching** | None | **Medium** | 3 days |
| **Sandbox mode** | None | **Medium** | 1 week |
| **Tool-specific permissions** | None | **Medium** | 3 days |

### Memory & Context

| Claude Code Feature | cliagents Equivalent | Gap | Effort |
|---------------------|---------------------|-----|--------|
| **CLAUDE.md auto-loading** | None | **High** ❌ | 3 days |
| **Hierarchical context** | None | **Medium** | 3 days |
| **CLAUDE.local.md** | None | **Low** | 1 day |
| **Shared memory** | artifacts/findings/context tables ✅ | None | - |

### Session Management

| Claude Code Feature | cliagents Equivalent | Gap | Effort |
|---------------------|---------------------|-----|--------|
| **Session resume (-c/-r)** | CLI passthrough | None ✅ | - |
| **Background tasks** | Async via `wait: false` | None ✅ | - |
| **Output buffering** | File-based output protocol ✅ | None | - |

---

## 2. Critical Gaps (Blocking Feature Parity)

### Gap 1: No Skills/Slash Commands System
**Severity:** Critical
**Impact:** Cannot create reusable, discoverable agent capabilities
**Solution:** Adopt Superpowers pattern
```
cliagents/
├── skills/                    # Core skills
│   ├── code-review/SKILL.md
│   ├── implement/SKILL.md
│   └── test/SKILL.md
├── .cliagents/commands/       # User skills (project-level)
└── ~/.cliagents/commands/     # User skills (global)
```
**Effort:** 2 weeks

### Gap 2: No Hooks System
**Severity:** High
**Impact:** Cannot enforce policies, auto-format, or gate operations
**Solution:** Event emitter + hook executor
```javascript
// Example hook config
{
  "hooks": {
    "PreToolUse": [{ "script": "./hooks/security-check.sh" }],
    "PostToolUse": [{ "script": "./hooks/auto-format.sh" }]
  }
}
```
**Effort:** 2 weeks

### Gap 3: No Permission Model
**Severity:** High
**Impact:** Security risk in production, can't restrict dangerous operations
**Solution:** Interceptor pattern (already partially exists)
```javascript
// Permission config
{
  "permissions": {
    "Deny": ["rm -rf *", "Read(.env)"],
    "Allow": ["git status", "npm test"],
    "Ask": ["*"]  // default
  }
}
```
**Effort:** 1 week

### Gap 4: No Context Auto-Loading
**Severity:** Medium
**Impact:** Users must manually inject project context
**Solution:** Auto-read CLIAGENTS.md or CLAUDE.md at session start
**Effort:** 3 days

---

## 3. Where cliagents EXCEEDS Claude Code

| Advantage | Description |
|-----------|-------------|
| **Multi-Model Support** | 6 adapters (Claude, Gemini, Codex, Amazon Q, Mistral, Copilot) vs Claude-only |
| **HTTP REST API** | Programmatic access for building applications |
| **OpenAI-Compatible** | Drop-in replacement for existing OpenAI integrations |
| **WebSocket Streaming** | Real-time output for UIs |
| **Workflow Orchestration** | Predefined multi-agent workflows (code-review, feature, bugfix) |
| **Shared Memory** | Database-backed artifacts, findings, context for agent collaboration |
| **Dashboard UI** | Visual monitoring and debugging |
| **MCP Server** | Expose cliagents as tools for other agents |
| **No Concurrency Limit** | Can run multiple adapters simultaneously |

---

## 4. Implementation Roadmap

### Phase 1: Critical (Weeks 1-2)
| Priority | Feature | Effort | Dependencies |
|----------|---------|--------|--------------|
| P0 | Skills directory structure | 3 days | None |
| P0 | Skill discovery + loading | 3 days | Skills dir |
| P0 | Skill invocation in MCP | 2 days | Discovery |
| P0 | PreToolUse hook events | 2 days | None |
| P0 | PostToolUse hook events | 2 days | PreToolUse |

### Phase 2: High Priority (Weeks 3-4)
| Priority | Feature | Effort | Dependencies |
|----------|---------|--------|--------------|
| P1 | Permission interceptor | 3 days | None |
| P1 | Glob pattern matching | 2 days | Interceptor |
| P1 | Hook executor + exit codes | 3 days | Hook events |
| P1 | CLIAGENTS.md auto-loading | 2 days | None |
| P1 | Context hierarchy | 2 days | Auto-loading |

### Phase 3: Medium Priority (Weeks 5-6)
| Priority | Feature | Effort | Dependencies |
|----------|---------|--------|--------------|
| P2 | User skills directory | 2 days | Core skills |
| P2 | Skills shadowing | 2 days | User skills |
| P2 | Sandbox mode | 5 days | Permissions |
| P2 | Config-based workflows | 3 days | None |
| P2 | MCP client (consume tools) | 5 days | None |

---

## 5. Patterns to Adopt

### From Superpowers
```markdown
# skills/code-review/SKILL.md
---
name: code-review
description: Review code for bugs, security, and performance
arguments:
  - name: path
    description: File or directory to review
---

Review the code at {{path}} for:
1. Logic errors and edge cases
2. Security vulnerabilities
3. Performance issues
```

### From Gastown
```javascript
// Git-backed durable state (beads pattern)
// Instead of SQLite, persist to git-tracked JSON
// Survives server restarts, enables distributed agents
```

### From CodeMachine
```javascript
// MCP-based approval gates
// Use workflow-signals tool pattern for step transitions
// Allows external review before proceeding
```

---

## 6. Final Verdict

### Can cliagents be "Claude Code for multi-model"?

**YES, with conditions:**

1. ✅ **Core orchestration** - Already equal or better
2. ✅ **Multi-model** - Already superior (6 providers)
3. ✅ **API/Integration** - Already superior (REST, WS, MCP)
4. ⚠️ **Skills system** - Needs 2 weeks of work
5. ⚠️ **Hooks system** - Needs 2 weeks of work
6. ⚠️ **Permissions** - Needs 1 week of work
7. ⚠️ **Context loading** - Needs 3 days of work

### Timeline to Feature Parity: 4-6 weeks

### Strategic Position After Implementation:

```
Claude Code:  Single-model, local-only, full-featured
cliagents:    Multi-model, API-accessible, full-featured
```

cliagents would become the **infrastructure layer** for multi-model AI agent orchestration, while Claude Code remains the **best single-model local experience**.

---

## Appendix: Research Sources

| Source | Agent | Terminal ID |
|--------|-------|-------------|
| Claude Code Features | Gemini | 8c372e64 |
| cliagents Architecture | Claude | 54ab1d68 |
| Competitor Verification | Codex | b92799c3 |
| Usability Analysis | Gemini | 6b6ea37f |

*Generated through cliagents multi-agent orchestration*
