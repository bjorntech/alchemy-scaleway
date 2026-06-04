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
  Container.ts      Serverless Container resource
  Trigger.ts        Container trigger resource (cron/sqs/nats)
  Domain.ts         Container custom domain resource
  Bucket.ts         Object Storage bucket resource

test/
  *.test.ts         Bun test suites
```

## Provider Model

Resources use Alchemy v2's `Provider.effect(...Provider.of({ read, reconcile, delete }))` model. Direct Scaleway API behavior is isolated in `Clients.ts`; resource files translate between Alchemy props/attributes and client calls.

## Resource Conventions

- Physical names use `createPhysicalName` through `Internal.physicalName`.
- `Bucket` stores `alchemy:logical-id` in S3 tags and returns `Unowned(attrs)` for foreign buckets found by name.
- Containers and namespaces are read by persisted IDs only. Scaleway's Containers API does not expose a reliable ownership tag surface, so name-based adoption is intentionally avoided for those resources.
- Deletes are idempotent and ignore 404 responses.
- Container, trigger, and domain readiness waits use Effect sleeps inside provider reconciliation.

## Adding A Resource

1. Add or extend the relevant client function in `Clients.ts`.
2. Add a flat `src/MyResource.ts` file with props, attributes, `Resource`, and provider.
3. Register the resource and provider in `Providers.ts`.
4. Re-export from `src/index.ts`.
5. Add README documentation and a focused test for pure behavior.
