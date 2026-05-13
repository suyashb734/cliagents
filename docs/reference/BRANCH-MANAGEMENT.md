# Branch Management

This document is the branch hygiene policy for `cliagents`. It keeps active work
reviewable, makes delegated work easier to reconcile, and prevents broad mixed
branches from becoming the accidental integration target.

## Branch Roles

Use one branch for one coherent outcome.

- `main`: stable integration branch. Merge only reviewed, tested work.
- `release/<slug>`: release hardening and release-blocker fixes only.
- `feature/<slug>`: one product or runtime capability.
- `fix/<slug>`: one bug fix or narrow regression fix.
- `docs/<slug>`: documentation-only changes.
- `task/<slug>-<date>`: delegated or worktree-isolated implementation slice.
- `research/<slug>`: research artifacts and planning notes that do not change runtime behavior.
- `safety/<slug>-<date>`: temporary safety branch before risky integration.

Avoid broad names such as `wip`, `misc`, `cleanup`, `integration`, or a stale
feature name after the branch scope changes.

## Scope Rules

- Start from `main` unless the branch explicitly builds on another active branch.
- Keep runtime behavior, release hygiene, docs-only work, and research on
  separate branches unless the change is intentionally bundled and documented.
- If the branch scope expands, stop and choose one action:
  - split later commits into a new branch,
  - rename or replace the branch with a truthful name,
  - merge the branch intentionally, then start the next branch from `main`.
- Do not continue adding unrelated work just because the current branch is
  already open.
- Do not merge `task/*` branches directly to `main` unless they are intentionally
  promoted and reviewed as the final branch.

## Delegated Work

Use `task/*` branches or git worktrees when multiple workers edit code in
parallel. Give each worker a disjoint write set whenever possible.

Recommended pattern:

1. Supervisor branch owns the plan and integration.
2. Worker branches own narrow implementation slices.
3. Review happens before integration into the supervisor branch.
4. The supervisor branch runs the relevant gates before merging to `main`.

For `cliagents` task assignments, keep `worktreePath` and `worktreeBranch`
metadata aligned with the actual git worktree so persisted assignment history can
explain where the work happened.

Branch-orchestrated assignments may also store `baseBranch`, `branchName`,
`mergeTarget`, `writePaths`, `pathLeaseId`, and `branchStatus`. Use
`autoBranch: true` when the broker should allocate a deterministic worker branch
and worktree. Use `writePaths` for swarm execution so overlapping edit lanes are
blocked before agents start.

## Pre-Work Check

Run this before starting non-trivial work:

```bash
pnpm run branch:check
```

The check validates the current branch name, reports dirty state, and summarizes
distance from `main`. It is intentionally lightweight; it does not replace human
judgment about whether the branch scope is still correct.

## Pre-Merge Gates

Before a branch merges to `main`, run the smallest gate that matches the scope:

- Docs-only: `pnpm run branch:check`, `node scripts/check-canonical-map.js`, and
  `git diff --check`.
- Runtime behavior: focused tests plus any touched-surface tests.
- Release-facing changes: `pnpm run release:check`.
- Broad orchestration/control-plane changes: focused, runtime, broad, and
  deterministic smoke suites when feasible.

If a live-provider test fails due to provider quota, auth, or capacity, record the
skip reason and keep deterministic broker-contract tests passing.

## Current Branch Reconciliation

If a branch name no longer describes its commits, do not keep layering work on it.
Create a truthful successor branch from the current head or from `main`, then use
the old branch only as historical context or a merge source.
