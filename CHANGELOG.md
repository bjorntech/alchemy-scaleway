# Changelog

All notable changes to `alchemy-scaleway` are documented here. The package follows the alchemy beta line — see [README › Compatibility](./README.md#compatibility).

## [Unreleased]

### Added

- `ContainerProps.domains` can now bind custom domains as part of the container
  workflow while keeping standalone `Domain` available for explicit control.
- `ContainerProps.crons` can now create cron triggers as part of the container
  workflow while keeping standalone `Trigger` available for explicit control.

### Known limitations

- Current Alchemy v2 beta resource options do not include `alwaysUpdate` or an
  equivalent read-on-noop hook. Same-props deploys cannot detect external deletion
  of `Container`-managed companion domains/triggers; those companions are verified
  when a read/update path runs. Revisit this when Alchemy exposes such an option.

### Changed

- Migrated the Serverless Containers integration from the `v1beta1` API to the
  generally-available `v1` API (`/containers/v1/...`). The public resource props were
  refactored to v1-native names and semantics (no backward-compatible aliasing):
  - Container `Create`/`Update` now auto-deploy; the separate deploy call was removed.
  - `ContainerProps` renames: `registryImage` → `image`, `memoryLimit` (MiB) →
    `memoryLimitBytes`, `cpuLimit` → `mvcpuLimit`, `timeout` is now a duration string
    (e.g. `"300s"`), `maxConcurrency` → `scalingOption` (with
    `concurrentRequestsThreshold`/`cpuUsageThreshold`/`memoryUsageThreshold`), and the
    `httpOption` enum → `httpsConnectionsOnly` boolean. The `ContainerHttpOption` type
    was removed and `ContainerScalingOption` added. The `Container` attribute
    `registryImage` is now `image` and `domainName` is now `publicEndpoint`.
  - The `Cron` resource was renamed to `Trigger` (resource type `Scaleway.Trigger`,
    attribute `triggerId`), backed by the v1 `/triggers` route. It now supports every
    v1 trigger source via a discriminated `source` union:
    - `{ type: "cron", schedule, timezone?, body?, headers? }`
    - `{ type: "sqs", queueUrl, accessKeyId, secretAccessKey, region?, endpoint? }`
    - `{ type: "nats", serverUrls, subject, credentialsFileContent? }`

    Plus an optional `destination` (`{ httpPath?, httpMethod? }`) and `description`.
    Write-only secrets (`secretAccessKey`, `credentialsFileContent`) are sent on
    create/update and never read back. New exported types: `TriggerSource`,
    `CronTriggerSource`, `SqsTriggerSource`, `NatsTriggerSource`, `TriggerDestination`,
    `TriggerSourceType`, `TriggerHttpMethod`.
  - `Domain` derives its `url` from the hostname (v1 no longer returns `url`).
- The in-memory test mock now returns flat (non-enveloped) Containers responses to
  match the real v1 API, and serves `/triggers` instead of `/crons`.

### Removed

- Unused `listCrons`/`listDomains` client methods.

## [0.1.0-beta.51] — Initial public beta

Tested against `alchemy@2.0.0-beta.51`.

### Added

- Scaleway resource providers: `Namespace`, `Container`, `Cron` (later renamed
  `Trigger`), `Domain`, and `Bucket`.
- `Scaleway.providers()` layer bundling every provider, the `ScalewayAuth` registration, and credential resolution.
- Tagged `ScalewayError` wrapping Scaleway API and Object Storage failures.
- `resolveFromEnv()` and `resolveFromStored(creds)` helpers for credential tests.
