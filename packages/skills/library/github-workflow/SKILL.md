---
name: github-workflow
description: "Use when working with GitHub through the connected app: issues, pull requests, PR reviews, triage, release notes, CI runs."
category: Apps
---

# GitHub through the connector

Tools appear as `mcp__github__…` (or the prefix the admin chose) when GitHub is connected in
**Work AI → Connections** or set up with a shared token. Reading is free; creating or changing
issues, comments, labels, branches or PRs asks the person to approve. For local Git work in a
repository folder, use the `git-workflow` skill instead.

## Find things

- Search issues/PRs with GitHub search syntax: `repo:acme/app is:issue is:open label:bug`,
  `is:pr is:merged merged:>=2026-09-01`, `author:@me`, `review-requested:@me`.
- Always name the repository explicitly (`owner/repo`); list the person's repos first if unsure.
- Read the full issue/PR (body, comments, linked items, changed files) before summarizing.

## Triage issues

For each open issue: type (bug/feature/question), area, severity, reproducible?, duplicate of?,
suggested labels and owner, next action. Present as a table; apply labels/comments only after the
person approves.

## Review a pull request

1. Read the description and linked issue for intent.
2. Get changed files and diffs; read the surrounding code where needed.
3. Check CI status (workflow runs/check runs) and failing logs.
4. Apply the `code-review` checklist; prioritize findings by severity with file:line references.
5. Offer to post the review as comments (approval needed); keep each comment specific and kind.

## Write issues and PR descriptions

- **Bug**: summary · steps to reproduce · expected vs actual · environment · logs/screenshots ·
  severity.
- **Feature**: problem · proposal · acceptance criteria · alternatives.
- **PR**: what · why (link issue: "Closes #123") · how to test · screenshots · risks/migrations.

## Release notes

List PRs merged since the last release/tag; group into Added / Changed / Fixed / Security by labels
or titles; write user-facing lines (not commit subjects); credit authors if the project does.

## CI troubleshooting

Find the failing workflow run and job, read the first error in its log, relate it to the PR's
changes, and propose a fix (see `ci-cd-pipelines`).

## Done when

Answers cite the exact issues/PRs (repo#number with links), summaries reflect the full threads,
and any change on GitHub happened only with the person's approval.
