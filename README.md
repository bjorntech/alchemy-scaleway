# alchemy-scaleway

Scaleway providers for [Alchemy v2](https://v2.alchemy.run/).

This package follows Alchemy's custom-provider model: resources are declared with `Resource`, lifecycle implementations are registered with `Provider.effect`, credentials resolve through an `AuthProvider`, and all Scaleway providers are exposed as a single `Scaleway.providers()` layer.

## Compatibility

| `alchemy-scaleway` | `alchemy` (peer) | `effect` (peer) | Notes |
| ------------------ | ---------------- | --------------- | ----- |
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
import * as Scaleway from "alchemy-scaleway";

export default Alchemy.Stack(
  "scaleway-demo",
  { providers: Scaleway.providers() },
  Effect.gen(function* () {
    const namespace = yield* Scaleway.Namespace("ApiNamespace", {
      description: "Demo namespace",
    });

    const api = yield* Scaleway.Container("Api", {
      namespace,
      registryImage: "rg.fr-par.scw.cloud/my-registry/api:latest",
      port: 3000,
      protocol: "http1",
      privacy: "public",
    });

    const bucket = yield* Scaleway.Bucket("Uploads", {
      versioning: true,
    });

    return {
      apiUrl: api.url,
      bucket: bucket.bucketName,
    };
  }),
);
```

## Resources

- `Namespace` - Scaleway Serverless Containers namespace lifecycle.
- `Container` - Scaleway Serverless Container lifecycle with deployment readiness polling.
- `Cron` - Container cron lifecycle.
- `Domain` - Container custom domain lifecycle.
- `Bucket` - Scaleway Object Storage bucket lifecycle via the S3-compatible API.

For contributor details, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
