---
name: scaleway-provider
description: Use when working on Scaleway Containers, Cron, Domain, Object Storage Bucket, SCW credentials, endpoint mappings, readiness polling, or API error handling.
license: MIT
compatibility: opencode
metadata:
  domain: scaleway
  repo: alchemy-scaleway
---

# Scaleway Provider

Use this skill for Scaleway-specific API and resource behavior.

## Current Scope

- `Namespace`: Serverless Containers namespace.
- `Container`: Serverless Container plus deployment readiness polling and optional companion domains/cron triggers.
- `Trigger`: container trigger (cron, SQS, or NATS source).
- `Domain`: container custom domain.
- `Bucket`: Object Storage bucket via S3-compatible API.

## Resource Ergonomics

- Scaleway resources should be useful application abstractions, not raw endpoint wrappers.
- It is acceptable for `Container` or a future higher-level resource to compose domains, triggers, readiness waits, and derived URLs when that matches common deployment workflows.
- Preserve standalone `Trigger`, `Domain`, and other primitive resources for advanced or explicit wiring.
- Prefer user intent in props (`env`, `secrets`, `domains`, `crons`, HTTP settings) when clearer than Scaleway's raw API field names, while keeping update/replace semantics explicit.
- Do not add name-based adoption for Containers resources unless Scaleway exposes reliable ownership metadata.
- Current Alchemy v2 beta cannot force read/reconcile on otherwise no-op `Container` deploys. `Container`-managed companion drift is verified when read/update paths run, but unchanged props cannot recover externally deleted domains/triggers until Alchemy provides an always-update/read-on-noop option.

## Credentials

- Containers require `SCW_SECRET_KEY`, region, and project id from credentials or resource props.
- Object Storage requires `SCW_ACCESS_KEY` and `SCW_SECRET_KEY`.
- `SCW_DEFAULT_REGION` is a region slug like `fr-par`, not a zone like `fr-par-1`.

## API Guidance

- Keep Containers and Object Storage client concerns separate.
- Containers use direct Scaleway REST endpoints under `/containers/v1beta1/regions/{region}`.
- Object Storage uses S3-compatible requests signed via `aws4fetch`.
- Preserve v1 endpoint and readiness knowledge, but do not copy the old provider architecture.

## Error Handling

- Convert HTTP/cloud failures into `ScalewayError`.
- Treat 404 as recoverable for read/delete.
- Mark 5xx and 429 as retryable where surfaced.

## Readiness

- Container deploy waits until URL/ready or fails on error/failed status.
- Cron waits until ready or error.
- Domain waits until ready or error with provider message when available.
