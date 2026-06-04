# AGENTS

## Repo Purpose

This repository implements `alchemy-scaleway`, a Scaleway provider package for Alchemy v2.

The package should keep a flat Alchemy v2 provider layout and avoid nested provider-specific source trees.

## Current Package Shape

- Runtime package: raw TypeScript ESM.
- Public entrypoint: `src/index.ts`.
- Provider bundle: `Scaleway.providers()` from `src/Providers.ts`.
- Tests: Bun test runner.
- Package manager/runtime: Bun.

## Dependency Policy

- Use `alchemy@2.0.0-beta.51` until a newer Alchemy v2 beta is published to npm.
- Use `effect@4.0.0-beta.74` with `alchemy@2.0.0-beta.51`.
- Do not bump to `effect@4.0.0-beta.78` with `alchemy@2.0.0-beta.51`: Alchemy beta.51 still uses `Schema.Defect` as a schema value, while Effect beta.76+ changed it to `Schema.Defect()`.
- Upstream PR alchemy-run/alchemy-effect#542 fixes the Effect beta.78 breakage on `main`, but that fix is not published to npm yet.
- When a newer Alchemy v2 beta is published, bump `alchemy`, `effect`, `package.json` version, README compatibility table, and `CHANGELOG.md` together.

## Architecture Rules

- Keep the flat package layout under `src/`.
- Do not reintroduce nested `src/Scaleway/...` folders.
- Use Alchemy v2 `Resource` plus `Provider.effect(...Provider.of({ read, reconcile, delete }))`.
- Keep `Clients.ts` focused on direct Scaleway API integrations.
- Keep Containers and Object Storage client concerns separate.
- Use `AuthProvider.ts` and `Credentials.ts` for profile/env credential integration.
- Use `ScalewayError` for typed cloud/API errors.

## Resource Scope

Current resources:

- `Namespace` - Scaleway Serverless Containers namespace.
- `Container` - Scaleway Serverless Container with deployment readiness polling.
- `Cron` - container cron.
- `Domain` - container custom domain.
- `Bucket` - Scaleway Object Storage bucket via S3-compatible API.

## Quality Gates

Before considering work complete, run all of these:

```sh
bun run check
bun test
bun run coverage
bun run crap
```

`bun run crap` enforces approximate CRAP score `<=6` using `scripts/crap-index.ts` and the latest `coverage/lcov.info`. Run `bun run coverage` before `bun run crap` so the report is fresh.

The CRAP script supports `// @crap-ignore` only for wrapper/factory functions that the approximate parser cannot score usefully, such as provider factories containing many lifecycle closures. Do not use it to hide ordinary business logic.

## Documentation Rules

- Keep `README.md` end-user focused: compatibility, install, credentials, usage, resources.
- Keep `ARCHITECTURE.md` contributor focused: layout, provider conventions, porting notes, resource rules.
- Update docs when dependency pins, provider shape, credential requirements, or resource behavior change.

## Implementation Guidance

- Keep Scaleway Containers endpoint mappings and response semantics centralized in `Clients.ts`.
- Keep Object Storage S3-compatible behavior separate from Containers REST behavior.
- Keep readiness polling behavior internal to resource reconciliation.
- Preserve clear update-vs-replace rules in each resource's `diff` implementation.
- Do not introduce nested package layout or old `create/update/delete` provider methods.

## Safety Notes

- Never commit secrets or local `.env` files.
- Live Scaleway tests, if added later, must be opt-in and gated by explicit environment variables.
- Object Storage requires `SCW_ACCESS_KEY` and `SCW_SECRET_KEY`.
- Containers require `SCW_SECRET_KEY`, region, and a project id from credentials or resource props.
