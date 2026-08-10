---
name: github-flow
description: Use when changing code or Git history in this single-developer repository. Enforces direct development on master, safe synchronization, verification before commits, and preservation of unrelated work. Feature branches, worktrees, and pull requests are used only when the user explicitly requests them.
---

# Master Direct Development

This repository is maintained by one developer. Develop and commit directly on `master` by default.

## Core workflow

1. Inspect `git status`, the current branch, and recent commits.
2. Work on `master`. If another branch is checked out, switch only when doing so preserves all uncommitted changes.
3. Do not create a feature branch, worktree, or pull request unless the user explicitly requests one.
4. Preserve unrelated tracked and untracked changes. Never reset, discard, overwrite, or include them in a commit.
5. Implement the requested change and run the relevant tests, checks, and build.
6. Update Graphify after code or documentation changes when `graphify-out/` exists.
7. Review the diff and stage only files belonging to the request.
8. Commit directly to `master` using Conventional Commits.
9. Push only when the user explicitly requests publishing or the active task already includes it.

## Starting work

```powershell
git status --short
git branch --show-current
git log -5 --oneline
```

If remote synchronization is requested and the worktree is safe to update:

```powershell
git switch master
git pull --ff-only origin master
```

Never use a destructive reset to make synchronization succeed. Report a divergence or conflict instead.

## Commit rules

Use this format:

```text
<type>(<scope>): <short description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

Before committing:

- Confirm the current branch is `master`.
- Confirm relevant tests and checks pass.
- Inspect `git diff` and `git diff --cached`.
- Exclude unrelated user changes and temporary files.
- Do not amend, force-push, or rewrite published history unless explicitly requested.

## Existing branches

When the user asks to integrate an existing branch:

1. Verify both worktrees are clean enough for the operation.
2. Prefer a fast-forward when `master` is an ancestor of the source branch.
3. Otherwise perform a normal merge and verify conflicts explicitly.
4. Switch ongoing development back to `master`.
5. Remove the source branch or worktree only when it is clean and no longer needed.

## Exceptions

Use a feature branch, isolated worktree, or pull request only when the user explicitly asks for one, when an external contribution requires review, or when repository protection prevents direct master commits. State the reason before creating it.

## Completion checklist

- Current branch is `master`.
- Requested changes are verified.
- Unrelated changes remain untouched.
- Graphify is current when applicable.
- Commit history is not rewritten.
- No feature branch or worktree was created without explicit authorization.
