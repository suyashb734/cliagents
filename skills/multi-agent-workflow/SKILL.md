---
name: multi-agent-workflow
description: Use when implementing features with multiple AI agents working together
tags: [orchestration, multi-agent, workflow]
---

# Multi-Agent Workflow

Orchestrate complex tasks across multiple AI agents, each contributing their strengths.

## Agent Roles

| Agent | Strengths | Best For |
|-------|-----------|----------|
| Claude Code | File editing, MCP tools, code generation | Implementation, refactoring |
| Gemini CLI | Web search, large context, fast | Research, documentation |
| Codex CLI | Sandbox execution, code review | Testing, security review |

## Workflow Patterns

### Pattern 1: Sequential Pipeline

Each agent builds on the previous one's output:

```
Gemini (Research) → Claude (Implement) → Codex (Review) → Claude (Fix)
```

**Use when**: Tasks have clear dependencies between phases

**Example workflow**:
1. **Gemini researches** the API/library to use
2. **Claude implements** based on research findings
3. **Codex reviews** for bugs and security
4. **Claude fixes** any issues found

### Pattern 2: Parallel Specialization

Multiple agents work on different aspects simultaneously:

```
         ┌─ Claude (Bug Review)
Task ────┼─ Gemini (Security Review)
         └─ Codex (Performance Review)
```

**Use when**: Independent reviews or analyses can happen concurrently

**Example workflow**:
1. Send the same code to all three agents
2. Each focuses on their specialty
3. Combine findings at the end

### Pattern 3: Supervisor-Worker

One agent coordinates others:

```
Claude (Supervisor)
    ├─ delegates to → Gemini (Research subtask)
    ├─ delegates to → Codex (Test subtask)
    └─ integrates results
```

**Use when**: Complex tasks need coordination and integration

## Implementation Steps

### Step 1: Plan the Workflow

Define the task and identify which agents should participate:

```javascript
const workflow = {
  task: "Implement user authentication",
  phases: [
    { role: "research", agent: "gemini-cli", input: "Research OAuth2 best practices" },
    { role: "implement", agent: "claude-code", input: "Implement based on research" },
    { role: "test", agent: "codex-cli", input: "Write and run security tests" },
    { role: "fix", agent: "claude-code", input: "Fix any issues found" }
  ]
};
```

### Step 2: Execute with Handoffs

Use cliagents' delegation tools:

```
delegate_task role="research" adapter="gemini-cli" message="Research OAuth2..."
delegate_task role="implement" adapter="claude-code" message="[Research results] Implement..."
delegate_task role="test" adapter="codex-cli" message="[Implementation] Test..."
```

### Step 3: Share Context

Use shared memory to pass information between agents:

- `store_artifact`: Save implementation plans, code outputs
- `share_finding`: Report bugs, security issues, suggestions
- `get_shared_findings`: Retrieve what other agents discovered

### Step 4: Integrate Results

Combine outputs from all agents into the final deliverable.

## Best Practices

1. **Clear handoff messages**: Include all context the next agent needs
2. **Use shared memory**: Store artifacts and findings for other agents
3. **Parallel when possible**: Use parallel patterns for independent work
4. **Single source of truth**: Let one agent own the final integration
5. **Validate incrementally**: Check each agent's output before proceeding

## Predefined Workflows

Use `run_workflow` for common patterns:

- `code-review`: Parallel bug + security + performance review
- `feature`: Plan → implement → test
- `bugfix`: Analyze → fix → test
- `research`: Research → document

## Error Handling

- If an agent times out: Increase timeout or use async mode
- If an agent fails: Retry or fall back to another agent
- If agents disagree: Escalate to supervisor agent for resolution
