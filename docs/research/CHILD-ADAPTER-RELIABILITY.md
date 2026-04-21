# Child Adapter Reliability

This document defines the minimum runtime bar for calling an adapter "usable" as a
`cliagents` child session in collaborative coding workflows.

It is intentionally stricter than "the adapter exists" or "the adapter can answer
one prompt."

## Why This Matters

The collaborative-coding thesis only holds if a brokered child can:

- launch under an attached root session
- produce usable output through the broker
- stay inspectable in the root/session graph
- accept follow-up input on the same terminal
- preserve enough state across turns to be worth using as a collaborator

If any of those fail, the adapter may still be useful directly, but it is not yet
reliable enough for the core `cliagents` child-session workflow.

## Checklist

Each adapter is evaluated against these checks:

1. `available`
   The adapter CLI is installed and visible to the broker.

2. `authenticated`
   Local auth state indicates the adapter is ready for live use.

3. `route_launch`
   `POST /orchestration/route` can create a child terminal for the adapter under an
   explicitly attached root session.

4. `root_attachment`
   The created child appears under the expected root in
   `GET /orchestration/root-sessions/:rootSessionId`.

5. `workdir_metadata`
   The child terminal records the requested working directory in broker metadata.

6. `first_output`
   The child reaches a settled state and produces non-empty usable output through
   `GET /orchestration/terminals/:id/output`.

7. `message_persistence`
   The broker stores follow-up/user messages for the child terminal in
   `GET /orchestration/terminals/:id/messages`.

8. `followup_input`
   `POST /orchestration/terminals/:id/input` works after the first completion.

9. `session_continuity`
   The second turn demonstrates continuity on the same child terminal rather than
   behaving like a stateless one-shot.

## Ratings

- `ready`
  All checks pass. The adapter is suitable for real child-session collaboration.

- `partial`
  Launch and first output work, but follow-up continuity, persistence, or root
  attachment is weak. The adapter is usable for bounded side tasks, not as a
  dependable collaborator.

- `not-ready`
  Launch fails, output is unusable, or the broker cannot supervise the child
  reliably enough for collaborative coding.

## Live Check Command

Run the live matrix on the current machine:

```bash
node scripts/run-with-supported-node.js tests/test-child-adapter-reliability-live.js
```

This is an environment-dependent test. Results depend on:

- local CLI installation
- local authentication state
- provider health / quotas / rate limits
- current broker runtime behavior
