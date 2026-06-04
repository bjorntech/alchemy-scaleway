# Architecture

This package uses a flat Alchemy v2 provider structure with direct Scaleway API integrations.

## File Layout

```text
src/
  index.ts          public re-exports
  Providers.ts      providers() layer and Provider.collection
  AuthProvider.ts   ScalewayAuth env/stored auth provider
  Credentials.ts    ScalewayCredentials service
  Clients.ts        Containers REST client and Object Storage S3 client
  Errors.ts         ScalewayError tagged error helpers
  Internal.ts       naming, config, and small utility helpers

  Namespace.ts      Serverless Containers namespace resource
  Container.ts      Serverless Container resource, including optional domains/crons
  Trigger.ts        Container trigger resource (cron/sqs/nats)
  Domain.ts         Container custom domain resource
  RegistryNamespace.ts Container Registry namespace resource
  Secret.ts         Secret Manager secret resource
  Bucket.ts         Object Storage bucket resource

test/
  *.test.ts         Bun test suites
```

## Provider Model

Resources use Alchemy v2's `Provider.effect(...Provider.of({ read, reconcile, delete }))` model. Direct Scaleway API behavior is isolated in `Clients.ts`; resource files translate between Alchemy props/attributes and client calls.

## Resource Design Philosophy

Alchemy resources should model useful programmer workflows, not mirror cloud APIs one-to-one. AWS Lambda and Cloudflare Worker resources in Alchemy intentionally collapse multiple provider operations into one resource when that is the helpful application-facing abstraction: bundling code, creating URLs, provisioning routes/domains/triggers, waiting for stabilization, applying defaults, and returning derived outputs.

Apply the same rule to Scaleway:

- Keep direct Scaleway endpoint details in `Clients.ts`, but let resources hide provider quirks and sequencing requirements.
- Prefer intent-shaped props over raw API payloads when the higher-level shape is clearer for application authors.
- It is acceptable for one programmer-facing resource to orchestrate companion resources, such as container domains or triggers, when that matches the common deployment workflow.
- Keep standalone low-level resources available for advanced cases; ergonomic composition should not remove precise control.
- Return outputs that application code needs, such as URLs, resolved names, IDs, regions, and deployment-relevant metadata.
- Add readiness waits, retry/stabilization behavior, and safe defaults inside reconciliation instead of requiring users to script them.
- Do not add name-based adoption merely for convenience; adoption must be backed by reliable ownership markers or clearly safe provider semantics.

## Resource Conventions

- Physical names use `createPhysicalName` through `Internal.physicalName`.
- `Bucket` stores `alchemy:logical-id` in S3 tags and returns `Unowned(attrs)` for foreign buckets found by name.
- Containers and namespaces are read by persisted IDs only. Scaleway's Containers API does not expose a reliable ownership tag surface, so name-based adoption is intentionally avoided for those resources.
- Deletes are idempotent and ignore 404 responses.
- Container, trigger, and domain readiness waits use Effect sleeps inside provider reconciliation.
- `Container` may orchestrate custom domains and cron triggers from `domains`/`crons` props for the common service deployment workflow. Standalone `Domain` and `Trigger` resources remain available for explicit control.
- `RegistryNamespace` provisions the Container Registry namespace needed to host images consumed by `Container.image`; image/tag pushes remain an external CI/build concern.
- `Secret` provisions Secret Manager metadata and current value versions. Secret values use `Redacted<string>` and are never returned in resource attributes.
- Current Alchemy v2 beta `ResourceOptions` do not expose an `alwaysUpdate` or equivalent read-on-noop option. Because of that, same-props deploys cannot detect external deletion of `Container`-managed companion domains/triggers. The `Container` read path verifies persisted companion IDs when a read/update path runs, but no-op plans will not recover missing companions until a prop change triggers reconciliation. Revisit this if Alchemy adds an always-update/read-on-noop resource option.

## Adding A Resource

1. Add or extend the relevant client function in `Clients.ts`.
2. Add a flat `src/MyResource.ts` file with props, attributes, `Resource`, and provider.
3. Register the resource and provider in `Providers.ts`.
4. Re-export from `src/index.ts`.
5. Add README documentation and a focused test for pure behavior.
