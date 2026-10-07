---
name: code-review
description: "Use when reviewing code, a diff or a pull request for bugs, security, performance, readability and tests, with prioritized comments."
category: Software development
---

# Code review

Find what would hurt users or maintainers. Say it clearly, with evidence, in priority order.

## Get the change

- In a Git repo: `git status`, `git diff --stat`, then `git diff` (or `git diff main...HEAD` for a
  branch). For a PR you were given as files, read them whole.
- Read the surrounding code too: callers of changed functions (`grep -rn "functionName("`), the
  tests, the types. A diff alone hides most bugs.
- Understand the intent: the PR description, commit messages, linked issue. Review against it.

## What to look for (in this order)

1. **Correctness**: does it do what it claims for all inputs? Off-by-one, null/undefined, empty
   lists, time zones, rounding of money, concurrency (two requests at once), error paths that
   swallow failures, partial writes without transactions, wrong boolean logic.
2. **Security**: untrusted input reaching SQL, shell, file paths, HTML (XSS) or URLs (SSRF);
   missing permission checks on a resource; secrets in code or logs; weakened validation.
   See `security-review` for depth.
3. **Data and compatibility**: migrations that lose data, API responses that change shape for
   existing clients, config that now needs a new env var.
4. **Performance**: queries in loops (N+1), unbounded lists, missing indexes for new filters,
   work repeated per request that could be cached, large payloads.
5. **Tests**: is the new behavior tested, including a failure path? Would the test fail if the
   code were wrong?
6. **Readability and design**: names that say what things are, functions doing one job,
   duplication of existing helpers, dead code, comments that explain *why*.
7. **Style nits**: only if the project has no formatter; label them as nits.

## Verify, don't guess

- Run the tests and type checker: `npm test`, `pytest -q`, `npx tsc --noEmit`, `go test ./...`.
- If you suspect a bug, prove it: a failing input, a small script, or a test case. A claimed bug
  you couldn't confirm is labeled "possible" with what would confirm it.

## Writing comments

Each finding:

```
[Severity] file.ts:42 — What's wrong, in one sentence.
Why it matters: the concrete failure (input → wrong result / crash / leak).
Suggestion: the fix, ideally as a code snippet.
```

Severities: **Blocker** (bug, security hole, data loss — must fix), **Major** (likely bug or
serious maintainability cost), **Minor** (improvement), **Nit** (optional style).

Be specific and kind: comment on the code, not the person; acknowledge good choices briefly.

## Summary format

1. One-paragraph verdict: ready / ready after fixes / needs rework, and why.
2. Findings, most severe first (table or list as above).
3. What you checked and ran (tests, type check), and what you couldn't check.

## When asked to fix

Fix blockers and majors with minimal changes, add or update tests that cover them, run the checks
again, and report what changed. Don't refactor unrelated code in the same change.

## Done when

Every changed file was read with its context, checks were run, findings are prioritized with
evidence, and the verdict is clear.
