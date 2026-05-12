# 0003 Workspace And Worktree

Status: accepted

## Context

Task assignments can run in git worktrees, but future execution isolation may
also use direct working directories, containers, remote sandboxes, or hosted
runtime environments. Treating "workspace" and "worktree" as the same concept
would make those future isolation strategies awkward.

## Decision

`Workspace` is the durable project/runtime boundary. `worktree` is one assignment
isolation mechanism inside a workspace.

Tasks require a primary `workspaceRoot` for new creation. Assignments may carry
`worktreePath` and `worktreeBranch` metadata when git worktree isolation is used.
Profile-aware and workspace-aware routing can be added later, but the atomic
claim primitive must not depend on first-class Profile or Workspace filters in
this phase.

## Consequences

Code and docs should avoid renaming worktree metadata to Workspace. Future
container or remote-sandbox execution can attach to the same Workspace concept
without pretending to be a git worktree.

## Links

- `src/orchestration/task-worktree.js`
- `src/server/orchestration-router.js`
- `docs/architecture/ARCHITECTURE.md`
