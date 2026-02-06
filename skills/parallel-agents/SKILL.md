---
name: parallel-agents
description: Use when multiple agents can work on independent tasks simultaneously
tags: [orchestration, parallel, performance]
---

# Parallel Agent Execution

Maximize efficiency by running independent agent tasks concurrently.

## When to Use Parallelization

Parallelize when tasks are:
- **Independent**: No task depends on another's output
- **Non-conflicting**: Tasks won't modify the same files
- **Separable**: Work can be cleanly divided

## Parallel Patterns

### Pattern 1: Parallel Reviews

Multiple reviewers examine the same code:

```
                ┌─ Bug Reviewer ───────┐
Code to Review ─┼─ Security Reviewer ──┼─ Combined Findings
                └─ Performance Reviewer┘
```

**Implementation**:
```
# Launch all three in parallel (async mode)
delegate_task role="review" adapter="claude-code" wait=false message="Review for bugs..."
delegate_task role="review-security" adapter="gemini-cli" wait=false message="Security audit..."
delegate_task role="review-performance" adapter="codex-cli" wait=false message="Performance review..."

# Check status of each
check_task_status terminalId="..."
```

### Pattern 2: Divide and Conquer

Split a large task into smaller independent pieces:

```
Large Codebase
    ├─ Agent 1: src/auth/
    ├─ Agent 2: src/api/
    └─ Agent 3: src/utils/
```

**Implementation**:
```
# Each agent works on a different directory
delegate_task role="implement" message="Refactor src/auth/..." wait=false
delegate_task role="implement" message="Refactor src/api/..." wait=false
delegate_task role="implement" message="Refactor src/utils/..." wait=false
```

### Pattern 3: Parallel Research

Multiple agents research different aspects:

```
Question: "How should we implement caching?"
    ├─ Agent 1: Research Redis options
    ├─ Agent 2: Research in-memory caching
    └─ Agent 3: Research CDN caching
```

## Implementation Guide

### Step 1: Identify Independent Tasks

Ask yourself:
- Does Task B need Task A's output? → Sequential
- Can Task A and B modify the same file? → Sequential
- Are Task A and B completely separate? → Parallel

### Step 2: Launch Tasks Asynchronously

Use `wait=false` to launch without blocking:

```javascript
// Launch all tasks
const tasks = [
  { role: 'review', adapter: 'claude-code', message: '...' },
  { role: 'review-security', adapter: 'gemini-cli', message: '...' },
  { role: 'review-performance', adapter: 'codex-cli', message: '...' }
];

// All start in parallel
for (const task of tasks) {
  delegate_task({ ...task, wait: false });
}
```

### Step 3: Collect Results

Poll for completion:

```javascript
// Check each task status
for (const terminalId of terminalIds) {
  const status = await check_task_status({ terminalId });
  if (status === 'completed') {
    const output = await get_terminal_output({ terminalId });
    results.push(output);
  }
}
```

### Step 4: Combine Findings

Merge outputs from all agents:

```
# All findings stored in shared memory
get_shared_findings taskId="review-session-123"

# Returns combined findings from all agents
```

## Best Practices

### 1. Set Appropriate Timeouts

Different tasks need different timeouts:
```
# Quick review
delegate_task timeout="simple" ...  # 3 min

# Deep analysis
delegate_task timeout="complex" ...  # 30 min
```

### 2. Use Shared Memory

All parallel agents should write to shared memory:
```
share_finding taskId="common-task-id" type="bug" content="..."
```

### 3. Handle Failures Gracefully

Some agents may fail or timeout:
```
# Check status before using output
if (status === 'failed') {
  // Retry or skip
}
```

### 4. Avoid Resource Conflicts

Don't have parallel agents:
- Edit the same file
- Write to the same artifact key
- Depend on each other's output

## Predefined Parallel Workflows

Use `run_workflow` with `wait=false`:

```
# Parallel code review (3 agents)
run_workflow workflow="code-review" wait=false message="Review src/..."

# Returns terminal IDs for all three agents
```

## Performance Tips

1. **Batch similar tasks**: Group by agent type
2. **Use lightweight agents first**: Get quick wins early
3. **Monitor resource usage**: Don't overload the system
4. **Cache results**: Avoid re-running the same analysis

## Example: Comprehensive Code Review

```javascript
// 1. Launch parallel reviews
const reviews = await Promise.all([
  delegate_task({ role: 'review', adapter: 'claude-code', wait: false, message }),
  delegate_task({ role: 'review-security', adapter: 'gemini-cli', wait: false, message }),
  delegate_task({ role: 'review-performance', adapter: 'codex-cli', wait: false, message })
]);

// 2. Wait for all to complete
await Promise.all(reviews.map(r => waitForCompletion(r.terminalId)));

// 3. Collect findings
const findings = await get_shared_findings({ taskId: reviewTaskId });

// 4. Prioritize and fix
const critical = findings.filter(f => f.severity === 'critical');
for (const issue of critical) {
  await delegate_task({ role: 'fix', message: issue.content });
}
```
