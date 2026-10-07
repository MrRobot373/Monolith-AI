---
name: debugging
description: "Use when something is broken (error, crash, failing test, wrong output, hang): reproduce, isolate, find the root cause, fix, add a test."
category: Software development
---

# Debugging

Don't guess-and-patch. Find the root cause, prove it, fix it, and keep it fixed.

## 1. Reproduce

- Get the exact symptom: full error message and stack trace, the input, the command, the
  environment (versions, OS, config). Write it down in one line: "X happens when Y; expected Z".
- Make it happen on demand with the smallest possible command or test. A failing test is the best
  reproduction because it becomes the regression test.
- If you can't reproduce it, collect more evidence (logs, the exact data) before changing code.

## 2. Read the evidence

- Read the stack trace bottom-up to find the first frame in *our* code. Open that file at that line.
- Read the error message literally. "undefined is not a function" names what was undefined.
- Check recent changes: `git log --oneline -15`, `git diff HEAD~1` — regressions usually come from
  the latest change. `git bisect` finds the breaking commit when the history is long:
  `git bisect start; git bisect bad; git bisect good <sha>; git bisect run <test command>`.

## 3. Isolate

- Binary search the problem space: comment out half, hard-code inputs, call the inner function
  directly, swap the real dependency for a stub.
- Add temporary logging at boundaries (inputs and outputs of the suspect function), with values and
  types: `print(repr(x), type(x))`, `console.log(JSON.stringify(x))`.
- Check assumptions explicitly: the file exists, the env var is set, the version is what you think
  (`node -v`, `python3 -c "import pkg; print(pkg.__version__)"`), the data has the shape you expect.

## 4. Hypothesize and test

Write 1–3 hypotheses ranked by likelihood. For each, predict what you'd see if it were true, then
run the one experiment that distinguishes them. Discard hypotheses the evidence rules out.

Common causes worth checking early:
- Wrong types or encodings (string vs number, bytes vs str, UTF-8 BOM, CRLF line endings).
- Off-by-one, inclusive/exclusive ranges, empty collections.
- Time zones and daylight saving; locale-dependent formatting.
- Caching (stale build, stale dependency, browser cache, memoized value).
- Async ordering: missing `await`, race between two writers, unhandled promise rejection.
- Environment differences: missing env var, different working directory, file permissions.
- Dependency version changes (lockfile, transitive updates).

## 5. Fix the root cause

- Fix where the bad state is *created*, not where it's noticed.
- Keep the change minimal; don't refactor while fixing.
- Add a regression test that fails before the fix and passes after.
- Remove the temporary logging.

## 6. Verify

Run the reproduction, the new test, and the full test suite. For performance issues, measure before
and after with the same input.

## Report

- **Symptom** · **Root cause** (the actual mechanism, with file:line) · **Fix** · **Test added** ·
  **How to verify** · anything else that could have the same problem.

## Done when

You can explain why it broke, the fix addresses that cause, a test proves it, and the suite passes.
