---
name: refactoring
description: "Use when restructuring code without changing behavior: renames across a codebase, extracting functions/modules, removing duplication."
category: Software development
---

# Refactoring

Change the structure, keep the behavior. Every step must leave the code working.

## Before you start

1. Know the goal in one sentence ("split invoice.ts so PDF rendering is separate").
2. Make sure behavior is pinned by tests. Run them now and record the result. If the code you'll
   touch has no tests, write characterization tests first: call the code with typical and edge
   inputs and assert on what it currently returns.
3. Make a plan of small steps in your todo list. Each step should be checkable on its own.

## Find every use

```bash
grep -rnw "calc_total" --include=*.py .            # whole-word matches
grep -rn "calc_total\b" --include=*.{ts,tsx,js} .   # including member access and imports
grep -rn "calc_total" .                              # anything else: docs, configs, templates
```

Check strings and dynamic uses too (`getattr(obj, "calc_total")`, `obj["calcTotal"]`, route names,
serialized field names): renaming those may change external behavior and needs care.

## Safe moves

| Smell | Refactoring |
|---|---|
| Long function | Extract function (name it after *what*, not *how*) |
| Same code in 3 places | Extract a shared helper; replace one call site at a time |
| Confusing name | Rename everywhere in one step, including tests and docs |
| Deep nesting | Guard clauses / early returns |
| Long parameter list | Group into an object/dataclass |
| Flag argument that switches behavior | Two functions |
| Module doing two jobs | Move functions to a new module; re-export from the old path temporarily if outside code imports it |
| Magic numbers/strings | Named constants |

## The loop

For each step: make the change → run the type checker and the affected tests → fix anything
broken before moving on. Use `edit` with exact `old_string`s; for a rename across many files, edit
each occurrence (or use a careful `sed -i` on whole-word matches and review `git diff` afterwards).

## Don'ts

- Don't mix refactoring with behavior changes or bug fixes in the same step; note bugs you find and
  handle them separately.
- Don't change public APIs (exported names, HTTP routes, database columns) without saying so; keep
  a compatibility alias when outside code may depend on them.
- Don't reformat whole files you didn't otherwise touch; it hides the real change.

## Verify

- `grep` again for the old name: zero hits (except intentional aliases).
- Full test suite, type check and linter pass.
- `git diff --stat` shows only the intended files.

## Done when

The goal is reached, behavior is unchanged as proven by passing tests, no stray references remain,
and you summarized the structural changes.
