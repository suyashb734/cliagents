---
name: test-driven-development
description: Use when implementing new features or fixing bugs - follows RED-GREEN-REFACTOR cycle
tags: [testing, workflow, quality]
---

# Test-Driven Development (TDD)

Follow the RED-GREEN-REFACTOR cycle for reliable, well-designed code.

## The TDD Cycle

### 1. RED - Write a Failing Test First

Before writing any implementation code:

1. **Understand the requirement**: What behavior are you implementing?
2. **Write a test** that describes the expected behavior
3. **Run the test**: Verify it fails (RED)
4. **Confirm the failure reason**: The test should fail because the feature doesn't exist, not due to test errors

```
Example:
"I need to add a validateEmail function"
→ Write: test('validateEmail returns true for valid email', () => {...})
→ Run tests
→ See: "validateEmail is not defined" (RED - expected failure)
```

### 2. GREEN - Write Minimal Code to Pass

Write the simplest code that makes the test pass:

1. **Focus only on passing the test**: No extra features
2. **Don't optimize yet**: Clarity over cleverness
3. **Run the test**: Verify it passes (GREEN)
4. **Celebrate briefly**: You have working, tested code!

```
Example:
→ Write: function validateEmail(email) { return email.includes('@'); }
→ Run tests
→ See: All tests passing (GREEN)
```

### 3. REFACTOR - Improve the Code

Now that tests are green, improve the code:

1. **Look for code smells**: Duplication, unclear names, long functions
2. **Refactor incrementally**: Small, safe changes
3. **Run tests after each change**: Ensure they stay GREEN
4. **Stop when clean**: Don't over-engineer

```
Example:
→ Improve: Add proper regex validation
→ Run tests: Still GREEN
→ Add edge case tests: Empty string, missing domain
→ Implement edge cases: Keep GREEN
```

## TDD Best Practices

- **One behavior per test**: Keep tests focused
- **Descriptive test names**: Tests document behavior
- **Fast feedback loop**: Run tests frequently
- **Triangulate**: Add more tests to drive better implementation
- **Don't skip RED**: Seeing the test fail first catches test bugs

## When to Use TDD

- New feature implementation
- Bug fixes (write test that reproduces bug first)
- Refactoring (ensure tests exist first)
- API design (tests clarify the interface)

## Common Pitfalls

- Writing implementation before tests
- Making too large a step (multiple behaviors at once)
- Skipping the refactor phase
- Testing implementation details instead of behavior
