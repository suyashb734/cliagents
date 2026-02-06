---
name: debugging
description: Use when investigating bugs - systematic root-cause analysis approach
tags: [debugging, troubleshooting, workflow]
---

# Debugging Workflow

A systematic approach to finding and fixing bugs efficiently.

## Phase 1: Reproduce the Bug

Before fixing anything, ensure you can reliably reproduce the issue:

1. **Get the exact steps**: What actions trigger the bug?
2. **Identify the environment**: OS, versions, configurations
3. **Create a minimal reproduction**: Strip away unrelated code
4. **Document the expected vs actual behavior**

**Key Question**: Can you make the bug happen on demand?

## Phase 2: Gather Information

Collect data about what's happening:

1. **Read error messages carefully**: Full stack traces, not just the first line
2. **Check logs**: Look for warnings or errors before the failure
3. **Inspect state**: What are the variable values at failure point?
4. **Review recent changes**: What changed since it last worked?

**Key Question**: What is the system actually doing vs what you expect?

## Phase 3: Form Hypotheses

Based on gathered information, form theories:

1. **List possible causes**: What could produce this behavior?
2. **Rank by likelihood**: Which are most probable given the evidence?
3. **Consider edge cases**: Null values, empty arrays, race conditions
4. **Check assumptions**: Is the input actually what you think it is?

**Key Question**: What could explain all the observed symptoms?

## Phase 4: Test Hypotheses

Systematically validate or eliminate each theory:

1. **Start with most likely**: Don't test randomly
2. **One variable at a time**: Change one thing, observe result
3. **Use binary search**: If unsure where bug is, eliminate half at each step
4. **Add logging/breakpoints**: Observe actual execution flow

**Key Question**: Does the evidence support or refute this hypothesis?

## Phase 5: Implement Fix

Once you've identified the root cause:

1. **Understand WHY it was broken**: Not just where
2. **Write a test first**: Prove the bug exists (TDD style)
3. **Make the minimal fix**: Don't refactor while fixing
4. **Verify the test passes**: Confirm the fix works
5. **Check for similar issues**: Does this bug pattern exist elsewhere?

**Key Question**: Does this fix the root cause, not just a symptom?

## Phase 6: Prevent Regression

Ensure the bug doesn't return:

1. **Keep the test**: It's now a regression test
2. **Document the fix**: In commit message or comments
3. **Consider adding validation**: Catch similar issues earlier
4. **Update documentation**: If the bug was due to unclear docs

## Debugging Techniques

- **Rubber duck debugging**: Explain the problem out loud
- **Binary search**: Comment out half the code to isolate
- **Print statements**: Strategic logging at decision points
- **Diff analysis**: Compare working vs broken versions
- **Fresh eyes**: Step away and return, or ask someone else

## Common Bug Categories

| Category | Symptoms | Investigation |
|----------|----------|---------------|
| Off-by-one | Wrong counts, missing items | Check loop bounds, indices |
| Null/undefined | "Cannot read property" | Trace data flow to source |
| Race condition | Intermittent failures | Check async timing, locks |
| State mutation | Unexpected side effects | Find all state modifications |
| Type coercion | Surprising comparisons | Use strict equality, check types |
