# Knowledge Graph Guidance

Graph tools such as Graphify can help agents understand the codebase, but they
are derived indexes, not project authority.

## Recommended Use

- index code, canonical docs, ADRs, and diagrams
- use graph output to find related files and concepts faster
- use graph reports as exploration aids during planning and review

## Authority Order

When sources conflict, use this order:

1. current code and tests
2. ADRs
3. canonical docs listed in `docs/CANONICAL-MAP.json`
4. active plans
5. research and generated graph reports

## Repository Policy

- Do not commit generated graph output by default.
- Do not treat graph summaries as canonical documentation.
- If graph output becomes useful enough to keep, store it as an artifact or
  research note and mark it as derived.
