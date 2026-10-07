---
name: technical-documentation
description: "Use when writing technical docs: READMEs, how-to guides, architecture overviews, ADRs, runbooks, docstrings, changelogs."
category: Software development
---

# Technical documentation

Write for a specific reader with a specific goal. Verify every command and path against the code.

## Pick the document type

| Reader wants to… | Write | Shape |
|---|---|---|
| Know what this is and get it running | README | What · Quick start · Configuration · Usage · Development · License |
| Do one specific thing | How-to guide | Goal, prerequisites, numbered steps, expected result, troubleshooting |
| Learn by doing | Tutorial | One small project end to end; every step works |
| Look something up | Reference | Tables of options, endpoints, commands; complete and terse |
| Understand why it's built this way | Architecture / ADR | Context, decision, consequences, diagrams |
| Fix it at 3 a.m. | Runbook | Symptoms → checks → commands → escalation |

## README template

````markdown
# Project name
One sentence: what it does and for whom.

## Quick start
```bash
git clone … && cd project
cp .env.example .env        # set DATABASE_URL
npm install && npm run dev  # http://localhost:3000
```

## Configuration
| Variable | Default | Meaning |
|---|---|---|

## Usage
The 2–3 most common tasks, with examples.

## Development
Tests, lint, project layout, how to contribute.
````

## ADR template (`docs/adr/0007-use-postgres-queue.md`)

```markdown
# 7. Use Postgres as the job queue
Date: 2026-10-07 · Status: accepted
## Context
What forces are at play (load, team, constraints).
## Decision
What we chose, stated plainly.
## Consequences
What gets easier, what gets harder, what we'll watch.
## Alternatives considered
Each with the reason it lost.
```

## Runbook entry

```markdown
## Alert: API error rate > 5%
1. Check recent deploys: `git log -5 --oneline origin/main`; roll back with `./deploy.sh rollback` if one is < 30 min old.
2. Check the database: `psql -c "select count(*) from pg_stat_activity"` (> 90 = pool exhaustion).
3. Logs: `docker logs api --since 15m | grep -i error | tail -50`.
Escalate to: #platform-oncall.
```

## Writing rules

- Lead with the outcome; put prerequisites before steps.
- One action per numbered step; show the exact command and the expected output.
- Use the real names from the code (env vars, flags, file paths). Run commands to confirm them.
- Explain *why* in comments and docs; the code already says *what*.
- Diagrams in Mermaid so they live in the repo:
  ```mermaid
  flowchart LR
    Browser --> API --> DB[(Postgres)]
    API --> Queue --> Worker
  ```
- Keep docs next to the code they describe; update them in the same change.

## Docstrings

Public functions: one-line summary, arguments, return value, errors raised, and an example for
anything non-obvious. Follow the project's style (Google/NumPy docstrings, JSDoc/TSDoc).

## Done when

The reader can achieve their goal using only the doc, every command and name was checked against
the project, and nothing outdated remains in the sections you touched.
