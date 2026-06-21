# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Report suspected vulnerabilities privately through GitHub Security Advisories for this repository, or contact the repository owner directly if advisories are unavailable.

Include:

- Affected version or commit.
- Steps to reproduce.
- Impact and affected Scaleway resources.
- Any relevant logs with secrets removed.

We aim to acknowledge reports within 7 days.

## Secret Handling

Never include real `SCW_SECRET_KEY`, `SCW_ACCESS_KEY`, Secret Manager values, container secret environment variables, or local `.env` files in issues, pull requests, tests, or commits.

## Threat Model

`@bjorntech/alchemy-scaleway` is an infrastructure provider package. It runs locally during deployment and uses the credentials you provide to create, update, and delete Scaleway resources.

In scope:

- Provider bugs that expose secret values in resource outputs, logs, test fixtures, or error messages.
- Provider bugs that send credentials or secret values to the wrong API endpoint.
- Authentication or credential-resolution bugs that use a different profile, project, or region than requested.
- Delete/update lifecycle bugs that can unexpectedly affect resources owned by this provider.

Out of scope:

- Scaleway account, IAM, billing, or API vulnerabilities.
- Costs from intentionally deploying live Scaleway resources.
- Secrets committed by users to their own repositories or `.env` files.
- Behavior of container images, workloads, or third-party services deployed with this provider.
- Reports generated only by automated AI/security scanners without a concrete, reproducible impact.

## Live Resources

Live tests or reproductions can create billable Scaleway resources. Only run live tests when you intentionally opt in and understand the resources being created.
