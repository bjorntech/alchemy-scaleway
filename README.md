# alchemy-scaleway

[![CI](https://github.com/finnvid/alchemy-scaleway/actions/workflows/ci.yml/badge.svg)](https://github.com/finnvid/alchemy-scaleway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/alchemy-scaleway?style=flat-square)](https://www.npmjs.com/package/alchemy-scaleway)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)

Scaleway providers for [Alchemy v2](https://v2.alchemy.run/).

This package follows Alchemy's custom-provider model: resources are declared with `Resource`, lifecycle implementations are registered with `Provider.effect`, credentials resolve through an `AuthProvider`, and all Scaleway providers are exposed as a single `Scaleway.providers()` layer.

Resources are designed around useful deployment workflows rather than raw Scaleway API endpoints. Low-level resources remain available, while higher-level resources may hide provider quirks, apply defaults, wait for readiness, and return application-useful outputs such as URLs.

## Compatibility

| `alchemy-scaleway` | `alchemy` (peer) | `effect` (peer) | Notes         |
| ------------------ | ---------------- | --------------- | ------------- |
| `0.1.0-beta.51`    | `2.0.0-beta.51`  | `4.0.0-beta.74` | Initial beta. |

## Install

```sh
bun add alchemy@2.0.0-beta.51 effect@4.0.0-beta.74 alchemy-scaleway
```

`alchemy-scaleway` ships raw TypeScript and uses `.ts` import suffixes internally. Your `tsconfig.json` needs `"moduleResolution": "Bundler"` and `"allowImportingTsExtensions": true`.

`alchemy@2.0.0-beta.51` is pinned with `effect@4.0.0-beta.74`. Effect beta.76 changed `Schema.Defect` from a schema value to a function; Alchemy has fixed that on `main`, but the fix is not published to npm yet. Bump both dependencies together when the next Alchemy v2 beta is published.

## Credentials

The `env` auth method reads:

```sh
SCW_SECRET_KEY=...
SCW_ACCESS_KEY=...              # optional, required for Object Storage
SCW_DEFAULT_PROJECT_ID=...      # optional, required for Containers unless set per resource
SCW_DEFAULT_REGION=fr-par       # optional, defaults to fr-par
SCW_API_URL=https://api.scaleway.com # optional, defaults to https://api.scaleway.com
```

The `stored` auth method is configured through `alchemy login` and writes credentials under `~/.alchemy/credentials/{profile}/scaleway-stored.json`.

## Usage

```ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Scaleway from "alchemy-scaleway";

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

For contributor details, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
