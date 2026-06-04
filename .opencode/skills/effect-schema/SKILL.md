---
name: effect-schema
description: Use when working with effect/Schema, tagged errors, decode/encode boundaries, or Effect beta compatibility such as Schema.Defect vs Schema.Defect().
license: MIT
compatibility: opencode
metadata:
  domain: effect-schema
  repo: alchemy-scaleway
---

# Effect Schema

Use this skill for `effect/Schema` modeling, tagged errors, and beta compatibility.

## Current Compatibility Note

`alchemy@2.0.0-beta.51` uses `Schema.Defect` as a schema value. Effect beta.76 changed it to `Schema.Defect()`. This repo pins `effect@4.0.0-beta.74` until Alchemy publishes the upstream fix from PR #542.

## Rules

- Treat schemas as `Schema<Type, Encoded, Requirements>`.
- Decode untrusted API/config data at boundaries.
- Prefer tagged errors for provider failures that callers may handle.
- Keep TypeScript types and runtime validation aligned.
- Verify exact Schema APIs against docs/source when changing Effect versions.

## Useful References

- Effect Schema docs: `https://effect.website/docs/schema/introduction/`
- Effect changelog/source for beta compatibility.
- Alchemy `Auth/AuthProvider.ts` for the dependency-pin issue.
