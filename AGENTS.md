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

## Resource Design Philosophy

- Follow Alchemy's programmer-facing resource style rather than a strict one-resource-per-cloud-endpoint mapping.
- Resources may orchestrate multiple Scaleway operations when that better represents an application workflow, such as a container plus domains, triggers, readiness polling, and derived URLs.
- Keep standalone primitive resources available for advanced control even when higher-level convenience props exist.
- Prefer intent-shaped props and useful defaults over raw API payload shapes when the abstraction is clearer for users.
- Hide provider quirks, sequencing, stabilization waits, and retry behavior inside resource reconciliation.
- Return application-useful outputs such as URLs, resolved physical names, IDs, regions, and deployment metadata.
- Do not add adoption behavior unless ownership is reliable; Containers resources currently lack a safe ownership tag surface.
- High-value resources that hold data or scarce addresses should default to Alchemy `retain()` only when retained resources can be rediscovered safely. `Bucket`, `DatabaseInstance`, and `FlexibleIp` use `alchemy:logical-id` ownership tags for this; smoke/tests that require cleanup should opt into `.pipe(destroy())`.
- When exactly one `Project` resource is declared in a stack and neither the resource nor provider sets `project`, new project-scoped application resources use that managed project and depend on it being created. Existing resources must keep their persisted project ID for backward compatibility. DNS resources and Object Storage state remain shared-project exceptions and default to `SCW_DEFAULT_PROJECT_ID` unless explicitly configured.

## Resource Scope

Current resources:

- `Project` - Scaleway Account project lifecycle.
- `Namespace` - Scaleway Serverless Containers namespace.
- `Container` - Scaleway Serverless Container with deployment readiness polling and optional companion domains/cron triggers.
- `ContainerImage` - local Docker image build/push into Scaleway Container Registry for use by `Container.image`.
- `Container.image` accepts public external image refs such as Docker Hub and GHCR strings; private external registry pull credentials are not exposed by the current Scaleway Containers API, so private deploys should use Scaleway Registry or registry-side access policy.
- `Trigger` - container trigger (v1 `/triggers`): cron, SQS, or NATS source.
- `Domain` - container custom domain.
- `FunctionNamespace` - Scaleway Serverless Functions namespace lifecycle.
- `Function` - Scaleway Serverless Function metadata plus bundled entrypoint or prebuilt ZIP upload/deploy lifecycle, with optional companion domains/cron triggers.
- `FunctionCron` - Serverless Function cron lifecycle.
- `FunctionDomain` - Serverless Function custom domain lifecycle.
- `DnsZone` - Scaleway Domains and DNS zone.
- `DnsRecord` - Scaleway Domains and DNS record set with resource target support.
- `RegistryNamespace` - Scaleway Container Registry namespace.
- `Secret` - Scaleway Secret Manager secret and value version lifecycle.
- `DatabaseInstance` - Scaleway Managed Database for PostgreSQL/MySQL instance lifecycle with redacted admin password input.
- `Bucket` - Scaleway Object Storage bucket via S3-compatible API.
- `Vpc` - Scaleway VPC lifecycle with one-way routing and custom route propagation enablement.
- `PrivateNetwork` - Scaleway Private Network with optional VPC binding, subnets, DHCP, and default route propagation.
- `VpcAcl` - complete VPC ACL rule set for one VPC/IP version.
- `VpcRoute` - VPC route with resource, Private Network, or VPC connector next hops.
- `VpcConnector` - VPC connector between two VPCs.
- `Instance` - Scaleway Instance virtual machine lifecycle with conservative replacement for image/type/volume identity changes.
- `SecurityGroup` - Scaleway Instance security group with complete rule-set ownership.
- `FlexibleIp` - Scaleway Instance flexible IP reservation and attachment.
- `PrivateNic` - Scaleway Instance private NIC attachment to a Private Network.

## Quality Gates

Before considering work complete, run all of these:

```sh
bun run check
bun test
bun run coverage
bun run crap
```

`bun run crap` enforces approximate CRAP score `<=6` using `scripts/crap-index.ts` and the latest `coverage/lcov.info`. Run `bun run coverage` before `bun run crap` so the report is fresh. Treat this as a guardrail for scored functions, not as a substitute for provider-level tests; provider lifecycle closures in ignored factories still need focused tests around diff, reconcile, polling, and client request behavior.

The CRAP script supports `// @crap-ignore` only for wrapper/factory functions that the approximate parser cannot score usefully, such as provider factories containing many lifecycle closures. Do not use it to hide ordinary business logic.

## Documentation Rules

- Keep `README.md` end-user focused: compatibility, install, credentials, usage, resources.
- Keep `ARCHITECTURE.md` contributor focused: layout, provider conventions, porting notes, resource rules.
- Update docs when dependency pins, provider shape, credential requirements, or resource behavior change.

## Implementation Guidance

- Keep Scaleway Containers endpoint mappings and response semantics centralized in `Clients.ts`.
- Keep Scaleway Functions endpoint mappings and response semantics centralized in `Clients.ts`, separate from Containers.
- Keep Object Storage S3-compatible behavior separate from Containers REST behavior.
- Keep readiness polling behavior internal to resource reconciliation.
- Preserve clear update-vs-replace rules in each resource's `diff` implementation.
- Do not introduce nested package layout or old `create/update/delete` provider methods.
- Track the current Alchemy v2 limitation: `ResourceOptions` lack `alwaysUpdate`/read-on-noop. Same-props deploys cannot detect external deletion of `Container`-managed companion domains/triggers or `Function`-managed companion domains/crons; revisit when Alchemy exposes an equivalent option.

## Safety Notes

- Never commit secrets or local `.env` files.
- Live Scaleway tests, if added later, must be opt-in and gated by explicit environment variables.
- For live smoke tests, use the 1Password MCP to resolve the Environment ID for `alchemy-scaleway-production`, then run with `op run --environment <environment-id>`; do not read, print, or commit secret values.
- When live smoke cleanup exposes a leaked resource or project deletion precondition, fix provider recovery/read/delete behavior and rerun cleanup through Alchemy. Do not manually delete via raw Scaleway APIs except as a last-resort emergency; the goal is to make interrupted deploys and second-run cleanup increasingly reliable.
- Object Storage requires `SCW_ACCESS_KEY` and `SCW_SECRET_KEY`.
- Containers require `SCW_SECRET_KEY`, region, and a project id from credentials or resource props.
- Serverless Functions require `SCW_SECRET_KEY`, region, and a project id from credentials or resource props.
- Secret Manager requires `SCW_SECRET_KEY`, region, and a project id from credentials or resource props.
- Managed Database for PostgreSQL/MySQL requires `SCW_SECRET_KEY`, region, and a project id from credentials or resource props.
