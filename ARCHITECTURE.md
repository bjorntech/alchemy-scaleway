# Architecture

This package uses a flat Alchemy v2 provider structure with direct Scaleway API integrations.

## File Layout

```text
src/
  index.ts          public re-exports
  Providers.ts      providers() layer and Provider.collection
  AuthProvider.ts   ScalewayAuth env/stored auth provider
  Credentials.ts    ScalewayCredentials service
  Clients.ts        Scaleway REST clients and Object Storage S3 client
  Errors.ts         ScalewayError tagged error helpers
  Internal.ts       naming, config, and small utility helpers

  Project.ts        Account project resource
  Namespace.ts      Serverless Containers namespace resource
  Container.ts      Serverless Container resource, including optional domains/crons
  Trigger.ts        Container trigger resource (cron/sqs/nats)
  Domain.ts         Container custom domain resource
  DnsZone.ts        Domains and DNS zone resource
  DnsRecord.ts      Domains and DNS record-set resource
  RegistryNamespace.ts Container Registry namespace resource
  Secret.ts         Secret Manager secret resource
  DatabaseInstance.ts Managed Database for PostgreSQL/MySQL instance resource
  Bucket.ts         Object Storage bucket resource
  Vpc.ts            VPC resource
  PrivateNetwork.ts Private Network resource
  VpcAcl.ts         VPC ACL rule-set resource
  VpcRoute.ts       VPC route resource
  VpcConnector.ts   VPC connector resource
  Instance.ts       Instance virtual machine resource
  SecurityGroup.ts  Instance security group resource
  FlexibleIp.ts     Instance flexible IP resource
  PrivateNic.ts     Instance private NIC resource

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
- `Project` provisions Scaleway Account projects through `/account/v3/projects`; `organizationId` changes replace the project, while name and description update in place. When a stack declares exactly one `Project` and neither the resource nor provider sets `project`, new project-scoped application resources get an internal default project reference so Alchemy plans the dependency, creates the project, and creates the resources in that managed project. Existing resources with persisted `projectId` outputs keep that project for backward compatibility. `Scaleway.providers({ project })` is the explicit top-level fallback for beta stacks that should keep creating resources in an existing project.
- Remote state and DNS resources are shared-project exceptions: Object Storage state derives its default bucket from `SCW_DEFAULT_PROJECT_ID`, and `DnsZone`/`DnsRecord` default to credentials unless explicitly configured with another project.
- `Bucket` defaults to retain-on-removal, stores `alchemy:logical-id` in S3 tags, and returns `Unowned(attrs)` for foreign buckets found by name.
- Containers and namespaces are read by persisted IDs only. Scaleway's Containers API does not expose a reliable ownership tag surface, so name-based adoption is intentionally avoided for those resources.
- Deletes are idempotent and ignore 404 responses.
- Container, trigger, and domain readiness waits use Effect sleeps inside provider reconciliation.
- `Container` may orchestrate custom domains and cron triggers from `domains`/`crons` props for the common service deployment workflow. Standalone `Domain` and `Trigger` resources remain available for explicit control.
- `DnsZone` provisions Scaleway Domains and DNS zones and defaults to retain-on-removal like Cloudflare zones. Existing zones have no ownership marker, so read paths report them as unowned unless adoption is explicit.
- `DnsRecord` owns one complete record set for a zone/name/type, using Scaleway's record `set` operation for convergent upserts. When passed a `DnsZone` resource it carries the zone project into DNS record operations, which supports shared DNS projects pointing at resources in separate application projects. It can target existing resources that expose IP addresses or hostnames, while explicit `records` remain available for advanced DNS data.
- `RegistryNamespace` provisions the Container Registry namespace needed to host images consumed by `Container.image`. `ContainerImage` can build a local Docker context, log in to that registry with Scaleway credentials, push the tag, and return `ref` for `Container.image`; external CI remains optional for teams that prefer prebuilt images.
- `ContainerImage` hashes Docker context contents during diff so source changes trigger rebuilds without changing props. Its `ref` uses a content-derived tag so dependent `Container` resources redeploy when source changes even if the requested tag is unchanged; it also pushes `stableRef` with the requested tag. The hash is intentionally conservative and does not parse `.dockerignore`, so ignored-file changes can still trigger rebuilds. Builds default to `linux/amd64` because Scaleway Serverless Containers reject arm64 images. It intentionally shells out to the local Docker CLI rather than embedding a Docker client. Scaleway Registry pushes use Scaleway credentials by default; external registries such as GHCR or Docker Hub require explicit `auth` or an existing Docker login. `Container` still accepts public external image refs directly, but Scaleway's Containers API does not expose private external registry pull credentials.
- `Secret` provisions Secret Manager metadata and current value versions. Secret values use `Redacted<string>` and are never returned in resource attributes.
- `DatabaseInstance` provisions Scaleway Managed Database for PostgreSQL/MySQL instances through `/rdb/v1/regions/{region}/instances`. It is the database server primitive: initial admin credentials are required as `Redacted<string>` input and are never returned; logical databases, users, privileges, ACLs, and higher-level connection helpers should remain separate resources or future convenience composition. It defaults to retain-on-removal and uses `alchemy:logical-id` tags for rediscovery. Project, engine, node, user, password, HA, and volume identity changes are conservative replacements, while name, tags, and backup schedule reconcile in place.
- `Vpc` provisions Scaleway VPCs and can enable routing and custom route propagation. Both are one-way provider operations; attempting to disable an already-enabled flag fails locally.
- `PrivateNetwork` provisions Scaleway Private Networks, optional VPC attachment, subnet membership, DHCP enablement, and default route propagation. VPC and project changes replace the resource.
- `VpcAcl` owns the complete ACL rule set for a single VPC and IP version. Deleting it resets that ACL set to `defaultPolicy: "accept"` and no rules; do not use multiple `VpcAcl` resources for the same VPC/IP version.
- `VpcRoute` provisions routes inside one VPC. VPC changes replace the route; destination, description, tags, and next-hop changes update it in place. Next hops can be resource IDs, Private Networks, or VPC connectors.
- `VpcConnector` provisions connectors between two VPCs. Either VPC identity changing replaces the connector; name and tags update in place.
- `Instance` provisions Scaleway Instance virtual machines. Zone, project, image, commercial type, and initial volume identity changes replace the resource; metadata, public IP attachments, security group attachment, placement group attachment, protection, and desired power state update in place.
- `SecurityGroup` provisions Scaleway Instance security groups and owns the complete rule set. Zone changes replace the resource; metadata and rule changes update in place.
- `FlexibleIp` provisions Scaleway Instance flexible IPs. It defaults to retain-on-removal and uses `alchemy:logical-id` tags for rediscovery. Zone or IP type changes replace the reservation; tags, reverse DNS, and server attachment update in place.
- `PrivateNic` provisions Scaleway Instance private NICs that attach one Instance to one Private Network. Zone, server, Private Network, or IPAM IP identity changes replace the NIC; tags update in place.
- Scaleway documents Private Network subnet add/delete endpoints, and the provider uses them for subnet drift reconciliation. Live production smoke currently verifies create-time subnets only because Scaleway returns `501 unimplemented endpoint` for the documented mutation endpoints in `fr-par`.
- Current Alchemy v2 beta `ResourceOptions` do not expose an `alwaysUpdate` or equivalent read-on-noop option. Because of that, same-props deploys cannot detect external deletion of `Container`-managed companion domains/triggers. The `Container` read path verifies persisted companion IDs when a read/update path runs, but no-op plans will not recover missing companions until a prop change triggers reconciliation. Revisit this if Alchemy adds an always-update/read-on-noop resource option.

## Adding A Resource

1. Add or extend the relevant client function in `Clients.ts`.
2. Add a flat `src/MyResource.ts` file with props, attributes, `Resource`, and provider.
3. Register the resource and provider in `Providers.ts`.
4. Re-export from `src/index.ts`.
5. Add README documentation and a focused test for pure behavior.
