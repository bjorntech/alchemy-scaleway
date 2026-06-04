---
name: alchemy-v2-provider
description: Use when adding or changing Alchemy v2 provider resources, Provider.effect lifecycle methods, Provider.collection wiring, adoption behavior, docs, or compatibility pins.
license: MIT
compatibility: opencode
metadata:
  domain: alchemy-provider
  repo: alchemy-scaleway
---

# Alchemy V2 Provider

Use this skill for resource/provider changes in `alchemy-scaleway`.

## Target Shape

- Flat package files under `src/`.
- Public exports from `src/index.ts`.
- Provider bundle from `src/Providers.ts` as `Scaleway.providers()`.
- Resource declaration with `Resource<Type, Props, Attributes, never, Providers>`.
- Lifecycle with `Provider.effect(Resource, Effect.gen(... Resource.Provider.of({ read, reconcile, delete })))`.

## Resource Design

- Model programmer-facing workflows, not a strict one-to-one mapping of cloud API endpoints.
- A resource may orchestrate multiple provider operations when that is the useful abstraction, similar to Alchemy AWS Lambda and Cloudflare Worker resources.
- Prefer intent-shaped props, safe defaults, readiness/stabilization handling, and derived outputs over exposing raw provider payload shape.
- Keep standalone primitive resources available when callers need explicit control.
- Keep provider quirks, retries, sequencing, and readiness polling inside lifecycle reconciliation.

## Lifecycle Rules

- `read` recovers from persisted IDs and returns `undefined` on 404.
- `reconcile` should be convergent: observe if needed, create or update, sync mutable fields, return durable attributes.
- `delete` must be idempotent and tolerate already-missing resources.
- `diff` should return `replace` only for identity changes and `update` for mutable changes.
- `stables` should list durable identity outputs only.
- Current Alchemy v2 beta resource options do not include `alwaysUpdate`/read-on-noop. Do not assume unchanged-props deploys can detect external drift for orchestrated child resources; revisit this limitation when Alchemy exposes such an option.

## Ownership

- Prefer explicit ownership markers where the cloud resource supports them.
- `Bucket` uses S3 tags with `alchemy:logical-id`.
- Containers resources do not currently use name-based adoption because Scaleway Containers lack a reliable tag surface.

## Documentation

Update `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `AGENTS.md` when resource behavior, credentials, provider shape, or dependency pins change.

## References

- Use this repo's `ARCHITECTURE.md` and `AGENTS.md` as the public source of truth for provider shape and porting decisions.
- Use public Alchemy v2 documentation/source when API details are unclear.
