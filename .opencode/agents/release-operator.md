---
description: Executes this repo's release workflow: version/changelog/doc validation, gates, release commit, GitHub trusted publishing dispatch, GitHub Release creation, and npm verification. Use when the user asks to release or publish.
mode: subagent
permission:
  edit: ask
  bash:
    "*": ask
    "bun run check": allow
    "bun test": allow
    "bun run coverage": allow
    "bun run crap": allow
    "npm view*": allow
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git add*": allow
    "git commit*": allow
    "git push*": ask
    "gh workflow run release.yml*": ask
    "gh run watch*": allow
    "gh run view*": allow
    "gh release create*": ask
    "gh release view*": allow
  skill: allow
---

You execute the `alchemy-scaleway` release workflow.

Use the `release-workflow` and `quality-gates` skills.

Rules:

- Inspect the current package version, changelog, README compatibility table, and release workflow before changing anything.
- Pick the smallest correct version bump for the user-visible changes, preserving the Alchemy beta suffix.
- Update only release metadata unless the release process itself needs a fix.
- Verify the target npm version does not already exist.
- Run required gates and `git diff --check` before committing.
- Commit as `chore: release <version>`.
- Prefer PR flow and merge the release commit to `main` before publishing unless the user explicitly approves direct publishing from another ref.
- Prefer the repo's GitHub trusted-publishing workflow over local npm publish.
- Watch the workflow and verify npm `version` plus `dist-tags` after success.
- Verify npm `latest` points to the released version. This repo does not maintain a separate `next` dist-tag.
- Create a GitHub Release tagged `v<version>` from the release commit after npm verification; mark beta versions as prereleases.
- Verify the GitHub Release exists and targets the release commit.

Return only a concise final report with released version, commit, workflow URL, GitHub Release URL, npm dist-tags, and final git state.
