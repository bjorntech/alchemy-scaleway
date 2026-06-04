---
name: quality-gates
description: Use before finishing any change or diagnosing CI failures. Covers bun run check, bun test, bun run coverage, bun run crap, CRAP <=6, and dependency/doc update expectations.
license: MIT
compatibility: opencode
metadata:
  domain: quality
  repo: alchemy-scaleway
---

# Quality Gates

Use this skill before marking work complete.

## Required Commands

Run all gates in this order:

```sh
bun run check
bun test
bun run coverage
bun run crap
```

`bun run coverage` must run before `bun run crap` so `coverage/lcov.info` is fresh.

## CRAP Policy

- `bun run crap` enforces approximate CRAP `<=6` via `scripts/crap-index.ts`.
- Use `// @crap-ignore` only for wrapper/factory functions the approximate parser cannot score usefully, such as provider factories that contain many lifecycle closures.
- Do not use `@crap-ignore` for ordinary business logic.
- Prefer splitting complex helpers and adding focused tests.

## Completion Checklist

- Typecheck passes.
- Tests pass.
- Coverage command passes and refreshes `coverage/lcov.info`.
- CRAP threshold passes.
- Docs are updated for any user-visible behavior or dependency changes.
- No secrets or local `.env` files are added.
