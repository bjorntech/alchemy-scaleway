# Changelog

All notable changes to `@finnvid/alchemy-scaleway` are documented here. The package follows the alchemy beta line — see [README › Compatibility](./README.md#compatibility).

## [Unreleased]

### Added

- Added `DnsZone` and `DnsRecord` resources for Scaleway Domains and DNS.
  `DnsRecord` can manage explicit record values or infer records from existing
  resources such as `Container`, `FlexibleIp`, `Instance`, `RegistryNamespace`,
  and `Bucket`.
- Extended the production smoke test to create a DNS record under
  `alchemy-smoke.finnvid.org`, attach it as a container custom domain, and fetch
  the live URL.
- Added an opt-in live negative smoke test for `FlexibleIp` reverse-DNS create
  failures. It verifies failed initial reverse updates do not leave tagged IPs
  behind and deletes any leaked IPs before failing.
- Added `Domain.waitForCname` to wait for CNAME visibility before creating a
  Scaleway container custom domain.

### Fixed

- `FlexibleIp` now deletes a just-created IP if the initial post-create reverse
  DNS update fails, avoiding untracked allocated IPs when Scaleway rejects the
  reverse value.
- `Domain` now retries repeated transient Scaleway custom-domain deployment
  errors by deleting the failed custom domain and recreating it within a bounded
  retry loop.
- The production smoke stack now sets the nginx container port explicitly so
  custom-domain HTTP-01 validation reaches the container correctly.

## [0.1.4-beta.51] - 2026-06-05

### Added

- `Instance.cloudInit` writes multi-line Scaleway `cloud-init` user data before
  first boot. The script may be a `string` or `Redacted<string>`, is not returned
  in resource attributes, and is tracked by a SHA-256 hash for replacement diffing.
- The production smoke test now covers Instance cloud-init and exposes stable
  smoke rerun controls through `SCW_SMOKE_RUN_ID`, `SCW_SMOKE_STAGE`, and
  `SCW_SMOKE_PREFIX`.

### Fixed

- `Instance` deletion now uses Scaleway's terminate action and deletes Alchemy-created
  `sbs_volume` Block Storage volumes after they are detached, while preserving
  explicitly attached volume IDs.
- `Instance` creation now follows Scaleway's REST lifecycle for first-boot user data:
  create the stopped server, set `cloud-init` user data, then power on when requested.
- `PrivateNic` no longer treats Scaleway auto-assigned IPAM IP IDs as drift unless
  `ipamIpIds` is explicitly configured.
- Scaleway validation errors now include per-argument details when the API returns
  them.

## [0.1.3-beta.51] - 2026-06-05

### Added

- `Vpc` provisions Scaleway VPCs and supports one-way routing and custom route
  propagation enablement.
- `PrivateNetwork` provisions Scaleway Private Networks with optional VPC binding,
  subnet membership, DHCP enablement, and default route propagation.
- `VpcAcl` manages the complete VPC ACL rule set for one VPC/IP version and resets
  that rule set to accept-all on delete.
- `VpcRoute` provisions Scaleway VPC routes with resource, Private Network, or VPC
  connector next hops.
- `VpcConnector` provisions Scaleway VPC connectors between two VPCs.
- `Instance` provisions Scaleway Instance virtual machines with conservative
  replacement for image, commercial type, and volume identity changes.
- `SecurityGroup` provisions Scaleway Instance security groups and owns their full
  rule set.
- `FlexibleIp` provisions Scaleway Instance flexible IP reservations with tag,
  reverse DNS, and server attachment updates.
- `PrivateNic` provisions Scaleway Instance private NIC attachments to Private
  Networks.

### Fixed

- Private Network subnet add/delete requests now use Scaleway's documented batch
  payload shape (`{ subnets: [...] }`).
- VPC ACL rule port fields now use Scaleway's published `src_port_*` and
  `dst_port_*` names.
- The production smoke test now deploys, updates, settles, and destroys a public
  `Alchemy.Stack` through the documented Alchemy CLI workflow.
- Namespace reconciliation waits for Scaleway readiness after create/update.
- Container create/update retries Scaleway transient state errors.
- Instance deletion now powers off servers and detaches managed flexible IPs before
  delete; Instance image aliases are preserved in outputs to avoid alias drift.
- `FlexibleIp` normalizes nullable Scaleway fields to `undefined` in outputs.
- `PrivateNic` preserves stable server and Private Network identity when Scaleway
  omits those fields from responses.
- `SecurityGroup` ignores Scaleway-managed non-editable rules when comparing and
  returning the owned rule set.

### Known limitations

- Scaleway documents in-place Private Network subnet add/delete endpoints, and the
  provider calls them during subnet drift reconciliation. The production smoke
  account currently receives `501 unimplemented endpoint` for those endpoints in
  `fr-par`, so live smoke omits `PrivateNetwork.subnets` until those endpoints are
  available.

## [0.1.2-beta.51] - 2026-06-04

### Fixed

- Pin `@effect/vitest` to `4.0.0-beta.74` in the install command so root installs
  with `alchemy@2.0.0-beta.51` stay on the Effect beta.74 line.

## [0.1.1-beta.51] - 2026-06-04

### Added

- `ContainerProps.domains` can now bind custom domains as part of the container
  workflow while keeping standalone `Domain` available for explicit control.
- `ContainerProps.crons` can now create cron triggers as part of the container
  workflow while keeping standalone `Trigger` available for explicit control.
- `RegistryNamespace` provisions Scaleway Container Registry namespaces and returns
  the registry endpoint plus an `imagePrefix` for container image names.
- `Secret` provisions Scaleway Secret Manager secrets and value versions. Secret
  values are accepted as `Redacted<string>` and are never returned in outputs.
- `ContainerProps.secretEnvironmentVariables` now accepts `Redacted<string>` values
  and unwraps them only at the Scaleway API boundary.
- `smoke:scaleway` now performs an opt-in live smoke test for Containers namespace,
  Container readiness, Registry namespace, Secret Manager secret/version, and Object
  Storage bucket creation/deletion.

### Known limitations

- Current Alchemy v2 beta resource options do not include `alwaysUpdate` or an
  equivalent read-on-noop hook. Same-props deploys cannot detect external deletion
  of `Container`-managed companion domains/triggers; those companions are verified
  when a read/update path runs. Revisit this when Alchemy exposes such an option.

### Changed

- The npm package is now scoped as `@finnvid/alchemy-scaleway`, with package
  metadata and release workflow support for public npm org publishing.
- `publishConfig` and the release workflow now publish the scoped npm package with
  public access.

### Fixed

- Generated `Container` physical names now respect Scaleway's 34-character name
  limit, and explicit overlong container names fail locally before API calls.

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

## [0.1.0-beta.51] - Initial private beta

Tested against `alchemy@2.0.0-beta.51`.

### Added

- Scaleway resource providers: `Namespace`, `Container`, `Cron` (later renamed
  `Trigger`), `Domain`, and `Bucket`.
- `Scaleway.providers()` layer bundling every provider, the `ScalewayAuth` registration, and credential resolution.
- Tagged `ScalewayError` wrapping Scaleway API and Object Storage failures.
- `resolveFromEnv()` and `resolveFromStored(creds)` helpers for credential tests.
