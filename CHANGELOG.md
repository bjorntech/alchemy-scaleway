# Changelog

All notable changes to `alchemy-scaleway` are documented here. The package follows the alchemy beta line — see [README › Compatibility](./README.md#compatibility).

## [Unreleased]

## [0.1.0-beta.51] — Initial public beta

Tested against `alchemy@2.0.0-beta.51`.

### Added

- Scaleway resource providers: `Namespace`, `Container`, `Cron`, `Domain`, and `Bucket`.
- `Scaleway.providers()` layer bundling every provider, the `ScalewayAuth` registration, and credential resolution.
- Tagged `ScalewayError` wrapping Scaleway API and Object Storage failures.
- `resolveFromEnv()` and `resolveFromStored(creds)` helpers for credential tests.
