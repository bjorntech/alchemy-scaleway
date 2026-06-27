---
name: release-workflow
description: Use when releasing or publishing @bjorntech/alchemy-scaleway; covers version bumps, changelog promotion, compatibility docs, gates, GitHub trusted publishing, GitHub Releases, and npm verification.
license: MIT
compatibility: opencode
metadata:
  domain: release
  repo: alchemy-scaleway
---

# Release Workflow

Use this skill when the user asks to release or publish this package.

## Versioning

- Keep the Alchemy beta suffix aligned with the pinned dependency line, for example `0.7.2-beta.59` with `alchemy@2.0.0-beta.59`.
- For new resources or meaningful user-facing behavior, prefer a minor beta bump.
- For fixes only, prefer a patch beta bump.
- Do not bump `alchemy`, `effect`, or package version independently. If dependency pins change, update `package.json`, `README.md` compatibility table, and `CHANGELOG.md` together.

## Release Metadata

- Promote `CHANGELOG.md` `Unreleased` notes into `## [x.y.z-beta.N] - YYYY-MM-DD`.
- Keep an empty `## Unreleased` heading at the top.
- Add the new package version to the top of the `README.md` compatibility table.
- Update `package.json` `version`.
- Do not edit `bun.lock` for a package-only version bump unless Bun changes it through a required install/update operation.

## Pre-Publish Checks

- Confirm the target version is not already published: `npm view "@bjorntech/alchemy-scaleway@<version>" version`.
- Run all gates in order: `bun run check`, `bun test`, `bun run coverage`, `bun run crap`.
- Run `git diff --check`.
- Inspect `git status --short` and `git diff` before committing.

## Commit And Publish

- Commit release metadata as `chore: release <version>`.
- Prefer PR flow for release commits unless the user explicitly asks for direct release or has already approved direct push.
- Merge the release commit to `main` before publishing. The trusted-publishing workflow should normally run from `main`.
- If pushing directly to `main`, note any branch-rule bypass reported by GitHub.
- Publish through GitHub trusted publishing using `gh workflow run release.yml --ref main`.
- Watch the workflow with `gh run watch <run-id> --exit-status`.
- The workflow publishes with npm `latest`. For beta/prerelease versions, also ensure `next` points to the released version: `npm dist-tag add "@bjorntech/alchemy-scaleway@<version>" next`.

## GitHub Release

- After npm publish is verified, create a GitHub Release tagged `v<version>` from the release commit.
- Use the promoted changelog entry as the release notes.
- Mark beta/prerelease versions with `--prerelease`.
- Verify the release exists with `gh release view "v<version>"`.

## Verification

- Verify npm after workflow success: `npm view "@bjorntech/alchemy-scaleway@<version>" version dist-tags`.
- Confirm `latest` points to the released version.
- For beta/prerelease versions, also confirm `next` points to the released version.
- Verify GitHub Release metadata: tag `v<version>`, target release commit, and prerelease state for beta versions.
- Confirm final local state with `git status --short --branch`.

## Final Report

- Report the released version, release commit, workflow URL, GitHub Release URL, npm dist-tags, and final git state.
- Mention if release publishing skipped because the exact version already existed.
