---
description: Executes this repo's release workflow: version/changelog/doc validation, gates, release commit, GitHub trusted publishing dispatch, and npm verification. Use when the user asks to release or publish.
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
- Prefer the repo's GitHub trusted-publishing workflow over local npm publish.
- Watch the workflow and verify npm `version` plus `dist-tags` after success.

Return only a concise final report with released version, commit, workflow URL, npm tag, and final git state.
