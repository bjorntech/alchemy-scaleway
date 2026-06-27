---
name: effect-typescript
description: Use when writing, reviewing, or refactoring Effect 4 TypeScript code: Effect.gen, typed errors, Context.Service, Layer, Schedule, polling, resource safety, and strict inference.
license: MIT
compatibility: opencode
metadata:
  domain: effect-typescript
  repo: alchemy-scaleway
---

# Effect TypeScript

Use this skill for non-trivial work involving `effect` in this repo.

## Canonical References

- Effect docs: `https://effect.website/docs`
- Effect LLM docs: `https://effect.website/llms-full.txt`
- Effect source: `https://github.com/Effect-TS/effect`
- Alchemy source: `https://github.com/alchemy-run/alchemy-effect`

Fetch docs before making claims about APIs that changed across Effect 4 betas.

## Repo Constraints

- This repo currently tests `alchemy@2.0.0-beta.59` with `effect@4.0.0-beta.84`.
- Do not bump to Effect beta.78 until a newer Alchemy beta containing upstream PR #542 is published.
- Keep provider implementation code inside Alchemy v2 lifecycle methods.
- Do not call `Effect.runPromise` in library/provider internals.
- Prefer typed tagged errors for recoverable cloud/API failures.

## Patterns

- Use `Effect.gen` for sequential provider lifecycle logic.
- Use `Effect.tryPromise({ try, catch })` at async boundaries.
- Use `Effect.catchIf(isNotFound, ...)` for idempotent delete/read recovery.
- Use `Context.Service` and `Layer` for credentials/services.
- Keep secret values in `Redacted` until SDK/API boundaries.

## Review Checklist

- Are `A`, `E`, and `R` meaningful and not accidentally widened?
- Are errors recoverable by tag/predicate?
- Is polling bounded and failure explicit?
- Are resources deleted idempotently?
- Are TypeScript assertions hiding an inference/design problem?
