---
name: code-review
description: Use when reviewing code for quality, bugs, security, and maintainability
tags: [review, quality, workflow]
---

# Code Review Workflow

A comprehensive approach to reviewing code for quality, correctness, and maintainability.

## Review Phases

### Phase 1: Understand Context

Before looking at code:

1. **Read the PR/commit description**: What is this change trying to accomplish?
2. **Check related issues/tickets**: What was the original requirement?
3. **Review the scope**: Is this the right size for one change?
4. **Identify the risk level**: High-risk areas need more scrutiny

### Phase 2: Correctness Review

Does the code do what it's supposed to?

1. **Logic validation**: Does the algorithm correctly solve the problem?
2. **Edge cases**: Are boundary conditions handled?
3. **Error handling**: Are failures handled gracefully?
4. **Input validation**: Is untrusted input validated?

**Questions to ask**:
- What happens with null/empty input?
- What happens at min/max values?
- What happens on network/disk errors?

### Phase 3: Security Review

Look for common vulnerabilities:

1. **Injection attacks**: SQL injection, command injection, XSS
2. **Authentication/Authorization**: Are access controls correct?
3. **Sensitive data**: Are secrets, PII, credentials protected?
4. **Dependencies**: Are there known vulnerabilities?

**Red flags**:
- User input in SQL/commands without sanitization
- Hardcoded secrets or credentials
- Missing authentication checks
- Overly permissive CORS/access controls

### Phase 4: Performance Review

Will this code perform well?

1. **Algorithmic complexity**: O(n) vs O(n^2) vs O(n!)
2. **Database queries**: N+1 problems, missing indices
3. **Memory usage**: Large allocations, memory leaks
4. **Caching**: Unnecessary repeated work

**Questions to ask**:
- What happens with 10x/100x the data?
- Are there database queries in loops?
- Is expensive work cached when appropriate?

### Phase 5: Maintainability Review

Will this code be easy to work with?

1. **Readability**: Is the code self-explanatory?
2. **Naming**: Are variables/functions named clearly?
3. **Structure**: Is the code well-organized?
4. **Duplication**: Is there unnecessary repetition?
5. **Tests**: Are there adequate tests?

**Questions to ask**:
- Would a new team member understand this?
- If I see this in 6 months, will I know what it does?
- Are the tests testing behavior, not implementation?

## Giving Feedback

### Be Constructive

- Focus on the code, not the person
- Explain "why", not just "what"
- Suggest alternatives when criticizing
- Acknowledge what's done well

### Categorize Comments

- **Blocker**: Must fix before merge
- **Suggestion**: Would improve but not required
- **Question**: Need clarification to understand
- **Nitpick**: Style preference, optional

### Example Feedback

**Bad**: "This is wrong"
**Good**: "This loop doesn't handle empty arrays - it will throw on line 15. Consider adding an early return: `if (items.length === 0) return []`"

## Multi-Agent Review Strategy

For comprehensive review, delegate to specialized reviewers:

1. **claude-code**: Correctness, maintainability, tests
2. **gemini-cli**: Research, documentation, API design
3. **codex-cli**: Security audit, sandbox testing

Combine findings for complete coverage.
