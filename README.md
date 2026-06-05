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

### Live Smoke Test

The production smoke test is opt-in and creates billable Scaleway resources before deleting them. Run it only with credentials for a test project:

```sh
SCW_LIVE_TEST=1 op run --environment <1password-environment-id> -- bun run smoke:scaleway
```

`op run --environment` requires the 1Password Environment ID, not the environment name.
This flag requires the beta 1Password CLI version that supports Environments.

The test reads `SCW_SECRET_KEY`, `SCW_ACCESS_KEY`, `SCW_DEFAULT_PROJECT_ID`, `SCW_DEFAULT_REGION`, and `SCW_API_URL` from the environment. It creates and deletes a Containers namespace and container, Registry namespace, Secret Manager secret/version, and Object Storage bucket.

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

    const apiToken = yield* Scaleway.Secret("ApiToken", {
      description: "Token used by the API",
      value: Redacted.make(process.env.API_TOKEN!),
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
      image: "rg.fr-par.scw.cloud/my-registry/api:latest",
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

    return {
      apiUrl: api.url,
      imagePrefix: registry.imagePrefix,
      secretId: apiToken.secretId,
      bucket: bucket.bucketName,
      privateNetworkId: privateNetwork.privateNetworkId,
    };
  }),
);
```

## Resources

- `Namespace` - Scaleway Serverless Containers namespace lifecycle.
- `Container` - Scaleway Serverless Container lifecycle with deployment readiness polling, optional custom domains, and optional cron triggers.
- `Trigger` - Container trigger lifecycle (cron, SQS, or NATS source).
- `Domain` - Container custom domain lifecycle.
- `RegistryNamespace` - Scaleway Container Registry namespace lifecycle with ready-to-use image prefix output.
- `Secret` - Scaleway Secret Manager secret metadata and version lifecycle. Secret values are accepted as `Redacted<string>` and are never returned in outputs.
- `Bucket` - Scaleway Object Storage bucket lifecycle via the S3-compatible API.
- `Vpc` - Scaleway VPC lifecycle with optional routing and custom route propagation enablement.
- `PrivateNetwork` - Scaleway Private Network lifecycle, including optional VPC binding, subnets, DHCP enablement, and default route propagation.
- `VpcAcl` - Scaleway VPC ACL lifecycle for one VPC/IP version. This resource owns the full ACL rule set for that `vpc` plus `ipVersion` and resets it to `defaultPolicy: "accept"` with no rules on delete.
- `VpcRoute` - Scaleway VPC route lifecycle with next hops expressed as a resource ID, Private Network, or VPC connector.
- `VpcConnector` - Scaleway VPC connector lifecycle for connecting two VPCs, with name and tag updates in place.
- `Instance` - Scaleway Instance lifecycle for virtual machines, with conservative replacement for image/type/volume identity changes and action-based power state convergence.
- `SecurityGroup` - Scaleway Instance security group lifecycle. This resource owns the complete security group rule set.
- `FlexibleIp` - Scaleway Instance flexible IP reservation lifecycle, including tag, reverse DNS, and server attachment updates.
- `PrivateNic` - Scaleway Instance private NIC lifecycle for attaching one Instance to one Private Network.

`Instance.securityGroup` can attach or switch to a security group by ID. Omitting it leaves the current attachment unchanged; Scaleway's Instance update API does not expose a documented raw security-group detach operation.

### VPC Caveats

Scaleway's public VPC v2 schema documents in-place subnet add/delete endpoints for existing Private Networks. The provider implements those documented endpoints for subnet drift reconciliation, but the production smoke account currently receives `501 unimplemented endpoint` from Scaleway in `fr-par`. Create-time `PrivateNetwork.subnets` is verified by the live smoke test.

`Vpc.routing` and `Vpc.customRoutesPropagation` map to one-way Scaleway operations. Once enabled, attempting to disable either flag fails locally instead of silently drifting.

For contributor details, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
