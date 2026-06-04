# Resource Bring-Up

Use this checklist before adding a new Scaleway API area.

## 1. Start From The API

- Link the Scaleway API docs or schema used as source of truth.
- Identify required credentials, region/zone/project requirements, and beta/GA status.
- Confirm which fields are mutable, immutable, write-only, or unreadable after create.

## 2. Classify The Surface

- Resource: lifecycle-owned infrastructure such as a registry namespace, secret, bucket, queue, or database.
- Helper: an ergonomic workflow over existing resources, such as container-managed domains or triggers.
- Runtime binding: an application capability that should be granted or wired to a runtime later.
- Deferred: API operations that are not needed for a coherent first slice.

Prefer a small coherent slice over broad endpoint coverage.

## 3. Design The Resource

- Model user intent rather than raw API payloads when that is clearer.
- Return useful outputs: IDs, names, URLs/endpoints, regions, project IDs, status, and deployment metadata.
- Keep secret values in `Redacted` props and out of attributes, logs, and test snapshots.
- Decide update vs replace rules before coding.
- Avoid adoption unless Scaleway exposes reliable ownership metadata or the provider semantics are clearly safe.

## 4. Implement In The Flat Layout

- Add or extend direct API calls in `src/Clients.ts`.
- Add one flat resource file under `src/`.
- Register the resource in `src/Providers.ts`.
- Re-export it from `src/index.ts`.
- Keep Object Storage S3-compatible behavior separate from REST clients.

## 5. Test The Lifecycle

Add focused provider tests for:

- create attributes and request payload mapping
- update in place
- replace on identity changes
- idempotent delete and 404 recovery where practical
- write-only or redacted values not leaking into outputs
- readiness or status polling if the API is asynchronous

## 6. Update Docs

Update user-facing docs and contributor guidance when behavior changes:

- `README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `AGENTS.md`
- relevant `.opencode/skills/*/SKILL.md`

## 7. Verify

Run all gates before considering the work complete:

```sh
bun run check
bun test
bun run coverage
bun run crap
```
