---
name: git-workflow
description: "Use for Git work: branches, commit messages, merge or rebase, resolving conflicts, undoing mistakes, tags, PR descriptions."
category: Software development
---

# Git workflow

## Look before acting

```bash
git status            # branch, staged/unstaged, untracked
git log --oneline -10 # recent history
git branch -vv        # local branches and their upstreams
git remote -v
```

Pushing, force-pushing, rewriting shared history and deleting branches affect other people: do
them only when asked, and say what will happen first. Pushes ask for approval here.

## Branches

- One branch per change: `feature/invoice-pdf`, `fix/login-timeout`, following the repo's naming
  if it has one.
- Start from an up-to-date main: `git switch main && git pull --ff-only && git switch -c fix/…`.

## Commits

- Small and focused: one logical change that builds and passes tests on its own.
- Stage deliberately: `git add -p` or specific paths; check `git diff --staged` before committing.
  Never commit secrets, `.env` files, build output or large binaries (check `.gitignore`).
- Message format (or the repo's convention, e.g. Conventional Commits):

```
Short summary in imperative mood (≤ 72 chars)

Why the change was needed and what it does, wrapped at ~72 columns.
Mention side effects, migrations or follow-ups.
```

## Merge or rebase

- Keep a feature branch current: `git fetch && git rebase origin/main` for a private branch, or
  `git merge origin/main` when others share the branch (never rebase shared history).
- After a rebase that rewrote pushed commits you'd need `git push --force-with-lease` — ask first.

## Resolving conflicts

1. `git status` lists conflicted files. Open each and find `<<<<<<<`, `=======`, `>>>>>>>`.
2. Understand both sides: `git log --oneline -3 -- <file>` on each branch, or
   `git diff :1:<file> :2:<file>` / `:3:`. Keep the intent of both changes, not just one side.
3. Remove the markers, then run the build and tests.
4. `git add <file>` and continue (`git rebase --continue` or `git commit`).
5. Regenerate lockfiles with the package manager instead of hand-merging them.

## Undoing things

| Situation | Command |
|---|---|
| Unstage a file | `git restore --staged <file>` |
| Discard local edits to a file (destructive) | `git restore <file>` |
| Fix the last unpushed commit | `git commit --amend` |
| Undo a pushed commit safely | `git revert <sha>` |
| Find a lost commit | `git reflog` |
| Temporarily set work aside | `git stash push -m "msg"` / `git stash pop` |

Avoid `git reset --hard` and `git clean -fd` unless the person asked; they destroy uncommitted work.

## Pull request description

```markdown
## What
One paragraph on the change.
## Why
The problem or issue (link it).
## How to test
Commands or steps, expected result.
## Notes
Migrations, config changes, screenshots, follow-ups.
```

## Releases

Tag with the project's versioning scheme (`git tag -a v1.4.0 -m "v1.4.0"`), write release notes from
the commit log grouped as Added / Changed / Fixed.

## Done when

The history is clean and focused, nothing unintended is committed, tests pass on the branch, and
any action affecting the remote was confirmed.
