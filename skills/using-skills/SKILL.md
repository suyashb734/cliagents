---
name: using-skills
description: Use when learning how to use the cliagents skills system
tags: [meta, help]
---

# Using Skills

Skills are reusable workflows that provide domain-specific guidance for tasks. They help you follow best practices and maintain consistency across projects.

## Discovering Skills

1. **List available skills**: Use `list_skills` to see all available skills
2. **Filter by tag**: Use `list_skills tag="debugging"` to find relevant skills
3. **Filter by adapter**: Use `list_skills adapter="claude-code"` to find compatible skills

## Invoking Skills

When you encounter a task that matches a skill's domain:

1. **Invoke the skill**: Use `invoke_skill skill="skill-name" message="Your task description"`
2. **Follow the returned instructions**: The skill provides step-by-step guidance
3. **Adapt as needed**: Skills are guidelines, not rigid rules

## Skill Priority

Skills are discovered from three locations (in priority order):

1. **Project skills** (`.cliagents/skills/`): Project-specific workflows
2. **Personal skills** (`~/.cliagents/skills/`): Your custom workflows
3. **Core skills** (bundled with cliagents): Standard best practices

Higher-priority skills shadow lower-priority ones with the same name.

## Creating Your Own Skills

Create a `SKILL.md` file in any of the skill directories:

```yaml
---
name: my-skill
description: Use when [trigger condition]
adapters: [claude-code, gemini-cli]  # Optional: restrict adapters
tags: [category1, category2]          # For discovery
---

# My Skill

Your workflow instructions here...
```

## Best Practices

- Keep skills focused on one domain or workflow
- Include clear trigger conditions in the description
- Use tags for discoverability
- Provide step-by-step instructions
- Include examples where helpful
