# alchemy-scaleway

[![CI](https://github.com/finnvid/alchemy-scaleway/actions/workflows/ci.yml/badge.svg)](https://github.com/finnvid/alchemy-scaleway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40finnvid%2Falchemy-scaleway/next?style=flat-square)](https://www.npmjs.com/package/@finnvid/alchemy-scaleway)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)

Scaleway providers for [Alchemy v2](https://v2.alchemy.run/).

This package follows Alchemy's custom-provider model: resources are declared with `Resource`, lifecycle implementations are registered with `Provider.effect`, credentials resolve through an `AuthProvider`, and all Scaleway providers are exposed as a single `Scaleway.providers()` layer.

Resources are designed around useful deployment workflows rather than raw Scaleway API endpoints. Low-level resources remain available, while higher-level resources may hide provider quirks, apply defaults, wait for readiness, and return application-useful outputs such as URLs.

## Compatibility

| `@finnvid/alchemy-scaleway` | `alchemy` (peer) | `effect` (peer) | Notes         |
| --------------------------- | ---------------- | --------------- | ------------- |
| `0.4.0-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Adds `ContainerImage`, public image helpers, and retained resource rediscovery. |
| `0.3.1-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Adds Managed Database `DatabaseInstance` and open-ended Scaleway readiness waits. |
| `0.2.0-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Adds Project lifecycle, managed project defaults, and Scaleway Object Storage-backed state. |
| `0.1.5-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Adds DNS resources, custom-domain smoke coverage, and detached Instance volume cleanup fixes. |
| `0.1.4-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Adds Instance cloud-init support and managed SBS volume cleanup. |
| `0.1.3-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Adds Scaleway networking and Instance resources; smoke test uses Alchemy CLI stack workflow. |
| `0.1.2-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Public beta; pins Alchemy's Effect test helper dependency to beta.74. |
| `0.1.1-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Public beta with live smoke coverage. |
| `0.1.0-beta.51`             | `2.0.0-beta.51`  | `4.0.0-beta.74` | Private beta. |

## Install

```sh
bun add alchemy@2.0.0-beta.51 effect@4.0.0-beta.74 @effect/vitest@4.0.0-beta.74 @finnvid/alchemy-scaleway@next
```

`@effect/vitest@4.0.0-beta.74` keeps Alchemy beta.51's floating Effect helper dependency on the same Effect beta line as the runtime.

`@finnvid/alchemy-scaleway` ships raw TypeScript and uses `.ts` import suffixes internally. Your `tsconfig.json` needs `"moduleResolution": "Bundler"` and `"allowImportingTsExtensions": true`.

`alchemy@2.0.0-beta.51` is pinned with `effect@4.0.0-beta.74`. Effect beta.76 changed `Schema.Defect` from a schema value to a function; Alchemy has fixed that on `main`, but the fix is not published to npm yet. Bump both dependencies together when the next Alchemy v2 beta is published.

## Credentials

The `env` auth method reads:

```sh
SCW_SECRET_KEY=...
SCW_ACCESS_KEY=...              # optional, required for Object Storage
SCW_DEFAULT_PROJECT_ID=...      # optional, required for project-scoped resources unless set per resource
SCW_DEFAULT_REGION=fr-par       # optional, defaults to fr-par
SCW_API_URL=https://api.scaleway.com # optional, defaults to https://api.scaleway.com
```

The `stored` auth method is configured through `alchemy login` and writes credentials under `~/.alchemy/credentials/{profile}/scaleway-stored.json`.

`Project` requires an explicit `organizationId` prop. The API key must have Account/Organization-level permissions to create, update, or delete Scaleway projects.

When a stack declares exactly one `Scaleway.Project`, new project-scoped application resources in the same deploy use that managed project unless the resource or `Scaleway.providers({ project })` sets a project explicitly. In that case, deploying the stack creates the project and then creates those resources in it. Existing beta stacks that should keep creating resources in `SCW_DEFAULT_PROJECT_ID` can set `providers: Scaleway.providers({ project: process.env.SCW_DEFAULT_PROJECT_ID })`. Resources that already exist in state keep their persisted project for backward compatibility. Remote state still uses `SCW_DEFAULT_PROJECT_ID` for its default bucket name, and DNS resources (`DnsZone`/`DnsRecord`) default to `SCW_DEFAULT_PROJECT_ID` unless `project` is set explicitly.

### Live Smoke Test

The production smoke test is opt-in and creates billable Scaleway resources before deleting them. Run it only with credentials for a test project:

```sh
SCW_LIVE_TEST=1 op run --environment <1password-environment-id> -- bun run smoke:scaleway
```

`op run --environment` requires the 1Password Environment ID, not the environment name.
This flag requires the beta 1Password CLI version that supports Environments.

The test reads `SCW_SECRET_KEY`, `SCW_ACCESS_KEY`, `SCW_ORGANIZATION_ID`, `SCW_DEFAULT_PROJECT_ID`, `SCW_DEFAULT_REGION`, optional `SCW_DOMAIN_PROJECT_ID`, `SCW_DEFAULT_ZONE`, and `SCW_API_URL` from the environment, and requires a working local Docker CLI. It creates and deletes a managed Scaleway project, then verifies new project-scoped resources are created in that project while DNS/domain resources stay explicitly scoped to the DNS project. It also creates Containers, builds and pushes a `ContainerImage` through Registry, creates a custom container domain under `alchemy-smoke.finnvid.org`, DNS records, a child DNS zone, Secret Manager, Managed Database for PostgreSQL/MySQL, Object Storage, VPC, VPC route, security group, flexible IP, Instance, and private NIC resources. VPC connectors are billed as VPC Peering and are skipped by default; set `SCW_SMOKE_EXPENSIVE_NETWORK=1` only when explicitly testing that charged path. Set `SCW_DOMAIN_PROJECT_ID` when the smoke-test DNS zone lives in a different project from `SCW_DEFAULT_PROJECT_ID`. Set `SCW_SMOKE_DNS_ZONE` and `SCW_SMOKE_DNS_LABEL` to override the smoke-test DNS hostname; set `SCW_SMOKE_DNS_DOMAIN` when the registered Scaleway domain is not the last two labels of `SCW_SMOKE_DNS_ZONE`.

By default each smoke run uses a random Alchemy stage and resource prefix. If a run is interrupted, rerun with the same `SCW_SMOKE_RUN_ID`, or set both `SCW_SMOKE_STAGE` and `SCW_SMOKE_PREFIX`, so Alchemy can reuse the same local state and destroy or reconcile the same resources.

The negative Flexible IP smoke test is separately opt-in. It intentionally deploys a Flexible IP with invalid reverse DNS, expects the deploy to fail, then audits and deletes any leaked tagged IPs before failing the test if cleanup regressed:

```sh
SCW_LIVE_NEGATIVE_TEST=1 op run --environment <1password-environment-id> -- bun run smoke:scaleway:negative
```

It reads `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, `SCW_DEFAULT_REGION`, optional `SCW_DEFAULT_ZONE`, `SCW_API_URL`, `SCW_NEGATIVE_SMOKE_RUN_ID`, `SCW_NEGATIVE_SMOKE_STAGE`, `SCW_NEGATIVE_SMOKE_PREFIX`, and `SCW_NEGATIVE_SMOKE_REVERSE`.

## Usage

```ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Scaleway from "@finnvid/alchemy-scaleway";

export default Alchemy.Stack(
  "scaleway-demo",
  { providers: Scaleway.providers() },
  Effect.gen(function* () {
    const namespace = yield* Scaleway.Namespace("ApiNamespace", {
      description: "Demo namespace",
    });

    const registry = yield* Scaleway.RegistryNamespace("Registry", {
      description: "Demo container images",
      public: false,
    });

    const apiImage = yield* Scaleway.ContainerImage("ApiImage", {
      registry,
      context: ".",
      dockerfile: "docker/api/Dockerfile",
      repository: "api",
      tag: "latest",
    });

    const apiToken = yield* Scaleway.Secret("ApiToken", {
      description: "Token used by the API",
      value: Redacted.make(process.env.API_TOKEN!),
    });

    const database = yield* Scaleway.DatabaseInstance("Database", {
      engine: "PostgreSQL-15",
      nodeType: "db-dev-s",
      userName: "app",
      password: Redacted.make(process.env.DB_ADMIN_PASSWORD!),
      volumeType: "sbs_5k",
      volumeSize: 30_000_000_000,
    });

    const vpc = yield* Scaleway.Vpc("Network", {
      routing: true,
      customRoutesPropagation: true,
    });

    const privateNetwork = yield* Scaleway.PrivateNetwork("PrivateNetwork", {
      vpc,
      subnets: ["10.10.0.0/24"],
    });

    yield* Scaleway.VpcAcl("VpcAcl", {
      vpc,
      defaultPolicy: "drop",
      rules: [{ protocol: "TCP", action: "accept", destinationPort: 443 }],
    });

    yield* Scaleway.VpcRoute("PrivateRoute", {
      vpc,
      destination: "10.20.0.0/24",
      nextHop: { type: "privateNetwork", privateNetwork },
    });

    const api = yield* Scaleway.Container("Api", {
      namespace,
      image: apiImage.ref,
      secretEnvironmentVariables: { API_TOKEN: Redacted.make(process.env.API_TOKEN!) },
      port: 3000,
      protocol: "http1",
      privacy: "public",
      domains: ["api.example.com"],
      crons: [{ schedule: "0 * * * *", destination: { httpPath: "/jobs/hourly" } }],
    });

    const bucket = yield* Scaleway.Bucket("Uploads", {
      versioning: true,
    });

    // Apex DNS zones must already be registered or validated in Scaleway.
    const zone = yield* Scaleway.DnsZone("DnsZone", {
      domain: "example.com",
    });

    yield* Scaleway.DnsRecord("ApiDns", {
      zone,
      name: "api",
      target: api,
    });

    return {
      apiUrl: api.url,
      imagePrefix: registry.imagePrefix,
      secretId: apiToken.secretId,
      databaseEndpoint: database.endpointHostname ?? database.endpointIp,
      bucket: bucket.bucketName,
      privateNetworkId: privateNetwork.privateNetworkId,
    };
  }),
);
```

## Remote State

`Scaleway.state()` stores Alchemy state in a Scaleway Object Storage bucket, using Scaleway's S3-compatible API. When `bucket` is omitted, the provider uses `alchemy-state-${SCW_DEFAULT_PROJECT_ID}` and creates it on first use if it does not exist. `prefix` isolates projects, stacks, or environments sharing the same bucket and defaults to `alchemy/state`.

```ts
export default Alchemy.Stack(
  "scaleway-demo",
  {
    providers: Scaleway.providers(),
    state: Scaleway.state({
      region: "fr-par",
      prefix: "alchemy/project-a",
    }),
  },
  Effect.gen(function* () {
    // resources
  }),
);
```

Remote state requires `SCW_ACCESS_KEY` plus `SCW_SECRET_KEY`. `SCW_DEFAULT_PROJECT_ID` is used only to derive the default bucket name; the Object Storage credentials decide which project/account owns the bucket. Bucket names are globally unique, so pass `bucket` explicitly if the derived name is unavailable or if you want a shared state bucket. For multiple Scaleway projects, either use separate buckets or separate prefixes such as `alchemy/project-a` and `alchemy/project-b`. Do not run concurrent deploys against the same `bucket + prefix + stack + stage`; the Object Storage backend does not provide a distributed lock.

## Resources

- `Project` - Scaleway Account project lifecycle. Requires `organizationId`; changing `organizationId` replaces the project, while name and description update in place. If exactly one `Project` is declared, new application resources use it unless they set `project` explicitly or the provider is configured with `providers({ project })`. Same-name project rediscovery requires explicit adoption because Scaleway projects do not expose a reliable ownership marker.
- `Namespace` - Scaleway Serverless Containers namespace lifecycle.
- `Container` - Scaleway Serverless Container lifecycle with deployment readiness polling, optional custom domains, and optional cron triggers.
- `ContainerImage` - Local Docker image build and push lifecycle for Scaleway Container Registry. It logs in with `SCW_SECRET_KEY`, runs `docker build`, runs `docker push`, returns content-tagged `ref` plus requested-tag `stableRef`, and can feed `Container.image` directly.
- `Trigger` - Container trigger lifecycle (cron, SQS, or NATS source).
- `Domain` - Container custom domain lifecycle. Set `waitForCname: true` when the stack also creates the CNAME and Scaleway should wait for DNS visibility before custom-domain creation.
- `DnsZone` - Scaleway Domains and DNS zone lifecycle. Apex zones (`domain` without `subdomain`) reference existing Scaleway-registered or validated domains; child zones (`domain` plus `subdomain`) are created through the DNS zone API. Zones default to `SCW_DEFAULT_PROJECT_ID` and retain on stack removal.
- `DnsRecord` - Scaleway Domains and DNS record-set lifecycle. Records are scoped through their `DnsZone`, including its project, or through an explicit `project`; otherwise DNS operations use `SCW_DEFAULT_PROJECT_ID`. Records can use explicit values or infer a target from resources such as `Container`, `FlexibleIp`, `Instance`, `RegistryNamespace`, and `Bucket`. Initial creates refuse to replace an existing same-name/type record set unless `overwriteExisting: true` is set.
- `RegistryNamespace` - Scaleway Container Registry namespace lifecycle with ready-to-use image prefix output.
- `Secret` - Scaleway Secret Manager secret metadata and version lifecycle. Secret values are accepted as `Redacted<string>` and are never returned in outputs.
- `DatabaseInstance` - Scaleway Managed Database for PostgreSQL/MySQL instance lifecycle with readiness polling, project defaults, endpoint outputs, and redacted admin password input. Engine, node type, default user, password, HA mode, and volume shape changes replace the instance; name, tags, and backup schedule update in place. Defaults to `retain()` on removal and uses `alchemy:logical-id` tags for later rediscovery.
- `Bucket` - Scaleway Object Storage bucket lifecycle via the S3-compatible API. Defaults to `retain()` on removal and uses S3 `alchemy:logical-id` tags for later rediscovery.
- `Vpc` - Scaleway VPC lifecycle with optional routing and custom route propagation enablement.
- `PrivateNetwork` - Scaleway Private Network lifecycle, including optional VPC binding, subnets, DHCP enablement, and default route propagation.
- `VpcAcl` - Scaleway VPC ACL lifecycle for one VPC/IP version. This resource owns the full ACL rule set for that `vpc` plus `ipVersion` and resets it to `defaultPolicy: "accept"` with no rules on delete.
- `VpcRoute` - Scaleway VPC route lifecycle with next hops expressed as a resource ID, Private Network, or VPC connector.
- `VpcConnector` - Scaleway VPC connector lifecycle for connecting two VPCs, with name and tag updates in place.
- `Instance` - Scaleway Instance lifecycle for virtual machines, with conservative replacement for image/type/volume/cloud-init identity changes and action-based power state convergence.
- `SecurityGroup` - Scaleway Instance security group lifecycle. This resource owns the complete security group rule set.
- `FlexibleIp` - Scaleway Instance flexible IP reservation lifecycle, including tag, reverse DNS, and server attachment updates. Defaults to `retain()` on removal and uses `alchemy:logical-id` tags for later rediscovery.
- `PrivateNic` - Scaleway Instance private NIC lifecycle for attaching one Instance to one Private Network.

`Instance.cloudInit` accepts a multi-line `string` or `Redacted<string>` and writes it to Scaleway's `cloud-init` user-data key before the first boot. The script is treated as first-boot input: Alchemy stores only a SHA-256 hash in resource outputs, and changing the value replaces the Instance instead of mutating a running VM.

`Container.image` accepts plain image strings, `ContainerImage.ref`, or helper-built refs such as `dockerHubImage("library/nginx", "1.27")` and `ghcrImage("owner/app", "sha-1234")`. Public Docker Hub and GHCR images are passed through unchanged. Scaleway's Serverless Containers API does not expose private external registry pull credentials; private images should be pushed to Scaleway Container Registry with `ContainerImage`, or made accessible to Scaleway by registry-side policy if your registry supports that.

`ContainerImage` requires a working local Docker CLI. It computes a source hash from the Docker context, Dockerfile, `buildArgs`, `target`, and `platform`, so source changes trigger a rebuild/push on the next deploy. Docker builds default to `--platform linux/amd64` because Scaleway Serverless Containers only supports amd64 images; pass `platform` only when you intentionally need a different target. The returned `ref` uses a content-derived tag such as `dev-a1b2c3d4e5f6`, while `stableRef` is also pushed with the requested tag such as `dev`. Pass `image.ref` to `Container.image` so source changes produce a changed image reference and force a container redeploy. Keep Docker contexts small and use `.dockerignore` as you would with `docker build`; the provider hash applies `.dockerignore` rules and hashes symlink metadata without following broken targets, so ignored-file changes do not create a new content tag. Use `buildArgs` for build-time frontend values such as `VITE_API_URL`; do not pass secrets as build args because Docker build arguments are not a secret mechanism. For Scaleway registries, `ContainerImage` logs in with `SCW_SECRET_KEY`; for GHCR, Docker Hub, or another external registry, pass `auth: { username, password }` when the image push needs Docker login, or omit `auth` to use an existing local Docker session.

High-value resources that can hold data or scarce addresses default to `retain()` on stack removal: `Bucket`, `DatabaseInstance`, and `FlexibleIp`. Add `.pipe(destroy())` when you intentionally want Alchemy to delete them during stack removal. Replacement cleanup is still destructive when an identity change forces replacement, so treat replace-triggering changes such as database engine, volume, or flexible IP type changes as data/address migration operations.

`DnsRecord.target` chooses `A` or `AAAA` for IP addresses and `CNAME` for hostnames/endpoints. Use `records` plus an explicit `type` when you need full control over MX, TXT, SRV, CAA, or other record data:

`DnsRecord` owns the complete record set for one zone/name/type. If the record set already exists outside Alchemy, initial creation fails by default to avoid replacing unmanaged DNS. Set `overwriteExisting: true` only when you intentionally want Alchemy to take over and replace that record set.

DNS zones can live in a shared/default project while targets live in another project. Set `project` on the project-scoped app resource, and pass the shared `DnsZone` to `DnsRecord`; `Domain` remains scoped to the target container:

For apex zones such as `example.com`, register, transfer, or validate the domain in Scaleway first, then use `DnsZone` as an existing-zone reference. To create a child zone such as `dev.example.com`, pass `{ domain: "example.com", subdomain: "dev" }`.

```ts
const zone = yield* Scaleway.DnsZone("Zone", { domain: "example.com" });
const namespace = yield* Scaleway.Namespace("ApiNs", { project: "app-project-id" });
const api = yield* Scaleway.Container("Api", { namespace, image: "rg.fr-par.scw.cloud/app/api:latest" });

yield* Scaleway.DnsRecord("ApiDns", { zone, name: "api", target: api });
yield* Scaleway.Domain("ApiDomain", { container: api, hostname: "api.example.com" });
```

```ts
yield* Scaleway.DnsRecord("Verification", {
  zone,
  name: "_acme-challenge",
  type: "TXT",
  records: ["challenge-token"],
  ttl: 60,
});
```

```ts
yield* Scaleway.Instance("DockerVm", {
  commercialType: "DEV1-S",
  image: "ubuntu_jammy",
  desiredState: "running",
  cloudInit: Redacted.make(`#!/bin/bash
set -e
apt-get update
apt-get install -y docker.io
systemctl enable docker
systemctl start docker
`),
});
```

`Instance.securityGroup` can attach or switch to a security group by ID. Omitting it leaves the current attachment unchanged; Scaleway's Instance update API does not expose a documented raw security-group detach operation.

When deleting an `Instance`, the provider terminates the Scaleway server and deletes Block Storage volumes that were created by that Instance resource. Volumes passed with an explicit `id` are treated as externally owned and are preserved.

### VPC Caveats

Scaleway's public VPC v2 schema documents in-place subnet add/delete endpoints for existing Private Networks. The provider implements those documented endpoints for subnet drift reconciliation, but the production smoke account currently receives `501 unimplemented endpoint` from Scaleway in `fr-par`. The live smoke test omits `PrivateNetwork.subnets` until those endpoints are available.

`Vpc.routing` and `Vpc.customRoutesPropagation` map to one-way Scaleway operations. Once enabled, attempting to disable either flag fails locally instead of silently drifting.

For contributor details, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
