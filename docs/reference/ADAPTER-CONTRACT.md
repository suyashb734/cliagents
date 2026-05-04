# Adapter Contract

Adapters wrap official coding CLIs and expose them through one broker model.

## Required Lifecycle

An adapter should define or support:

- availability and auth checks
- launch/start behavior
- send or one-shot execution behavior
- resume or provider-thread binding when supported
- output extraction
- failure classification
- usage metadata extraction when available

## Capability Metadata

Capability metadata should state whether the adapter supports:

- multi-turn continuity
- provider resume
- streaming or incremental output
- filesystem reads and writes
- model selection
- JSON or structured output mode
- collaborator mode

## Child Readiness

An adapter is child-ready only when it can:

- launch under an attached root
- appear under root child enumeration
- produce usable first output
- persist user and assistant messages
- accept follow-up input after completion

An adapter is collaborator-ready only when it additionally preserves provider
thread state across compatible reuse.

## Current Reliability Source

Use [Child Adapter Reliability](../research/CHILD-ADAPTER-RELIABILITY.md) for
the live readiness checklist and active adapter ratings.
