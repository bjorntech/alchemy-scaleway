---
name: pr-merge-workflow
description: Use when creating, pushing, opening, merging, or deleting PR branches for this repo; covers PR/PD merge workflow, git preflight, CI checks, and branch cleanup.
license: MIT
compatibility: opencode
metadata:
  domain: delivery
  repo: alchemy-scaleway
---

# PR Merge Workflow

Use this skill when the user asks to create a branch, commit, push, open a PR, merge a PR, or delete PR branches.

## Preflight

- Inspect `git status --short`, `git diff`, `git diff --cached`, and `git log --oneline -10` before committing.
- Never stage secrets, `.env` files, tool-output logs, or unrelated user changes.
- If the worktree contains unexpected unrelated changes, leave them alone and stage only intended files.
- Run required quality gates before opening or merging when code changed: `bun run check`, `bun test`, `bun run coverage`, `bun run crap`.
- Run `git diff --check` before committing.

## Branch And Commit

- Create a named feature/release branch unless the user explicitly asks to commit directly to `main`.
- Use non-interactive git commands.
- Use a concise conventional commit message that matches existing history, for example `feat: ...`, `fix: ...`, `docs: ...`, or `chore: release ...`.
- Push with upstream tracking: `git push -u origin <branch>`.

## Pull Request

- Before creating a PR, inspect branch tracking, included commits with `git log --oneline <base>..HEAD`, and diff summary with `git diff --stat <base>...HEAD`.
- Create PRs with `gh pr create --base main --head <branch> --title ... --body ...`.
- Include a short summary and a verification list in the PR body.
- After opening a PR, check mergeability and CI with `gh pr view ... --json state,mergeable,reviewDecision,statusCheckRollup,url` and `gh pr checks ... --watch`.

## Merge And Cleanup

- Merge only after required checks pass unless the user explicitly approves otherwise.
- Prefer `gh pr merge <number> --merge --delete-branch` unless the repo style or user requests squash/rebase.
- After merge, verify local `main` and `origin/main` are synced with `git status --short --branch`.
- Confirm the remote branch is deleted with `git ls-remote --heads origin <branch>`.
- Delete a remaining local feature branch only if it still exists and is fully merged.

## Final Report

- Include the PR URL, merge commit or final commit, checks result, and branch cleanup status.
- Mention any bypassed branch protection or manual intervention if it occurred.
