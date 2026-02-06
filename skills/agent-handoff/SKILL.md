---
name: agent-handoff
description: Use when passing work between agents with context preservation
tags: [orchestration, handoff, context]
---

# Agent Handoff Protocol

Ensure smooth transitions when passing work between AI agents.

## Why Handoffs Matter

When one agent hands off to another, context can be lost. This skill ensures:
- The receiving agent understands what was done
- Important decisions are preserved
- Work isn't duplicated or contradicted

## Handoff Checklist

When handing off to another agent, always include:

### 1. Summary of Work Done

**What**: Brief description of completed work
**Why**: The reasoning behind decisions made
**Where**: Files and locations modified

```markdown
## Work Completed
- Implemented user authentication in src/auth/
- Added JWT token generation and validation
- Created middleware for protected routes

## Key Decisions
- Chose JWT over sessions for stateless scaling
- Set token expiry to 24 hours (configurable)
- Used bcrypt for password hashing (cost factor 12)
```

### 2. Files Changed

List all modified files with brief descriptions:

```markdown
## Files Modified
- src/auth/jwt.js - Token generation/validation
- src/auth/middleware.js - Auth middleware
- src/routes/auth.js - Login/logout endpoints
- src/models/user.js - Added password field

## New Files Created
- src/auth/config.js - Auth configuration
- tests/auth.test.js - Authentication tests
```

### 3. Open Issues and Concerns

What the next agent should be aware of:

```markdown
## Open Issues
- [ ] Rate limiting not implemented yet
- [ ] Password reset flow pending
- [ ] Need to add refresh token logic

## Concerns
- JWT secret is currently hardcoded - needs env var
- No input validation on login endpoint
- Error messages might leak user existence
```

### 4. Next Steps

Clear instructions for the receiving agent:

```markdown
## For Next Agent
1. Review security of current implementation
2. Add rate limiting to login endpoint
3. Implement password reset via email
4. Add refresh token rotation

Priority: Security review is most critical
```

## Handoff Template

```markdown
# Agent Handoff: [Task Name]

## Context
[Brief description of the task and current state]

## Work Completed
- [List of completed items]

## Key Decisions
| Decision | Rationale |
|----------|-----------|
| [Choice] | [Why] |

## Files Modified
- path/to/file.js - [what changed]

## Open Issues
- [ ] [Issue description]

## For Next Agent
1. [First action]
2. [Second action]

## Shared Artifacts
- artifact-key: [description]
- finding-ids: [list]
```

## Using cliagents Tools

### Store Artifacts for Handoff

```
store_artifact taskId="task-123" key="implementation-plan" type="plan" content="..."
store_artifact taskId="task-123" key="code-changes" type="code" content="..."
```

### Share Findings

```
share_finding taskId="task-123" type="info" content="JWT implementation notes..."
share_finding taskId="task-123" type="security" severity="medium" content="Rate limiting needed"
```

### Retrieve Previous Work

```
get_shared_findings taskId="task-123"
```

## Anti-Patterns

- **No context**: Starting fresh without reviewing previous work
- **Duplicated effort**: Redoing what another agent already did
- **Lost decisions**: Not documenting why choices were made
- **Silent failures**: Not reporting issues encountered
- **Vague handoffs**: "Finish the implementation" without specifics

## Receiving a Handoff

When you receive a handoff:

1. **Read the full context**: Don't skim
2. **Check shared artifacts**: Use `get_shared_findings`
3. **Validate understanding**: Summarize back if unclear
4. **Build on existing work**: Don't start over
5. **Continue the documentation**: Add your own handoff notes
