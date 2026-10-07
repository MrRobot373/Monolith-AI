---
name: product-management
description: "Use for product work: PRDs, user stories with acceptance criteria, prioritization (RICE), roadmaps, feedback synthesis."
category: Business
---

# Product management

## PRD (product requirements document)

```markdown
# PRD: Recurring invoices
**Owner**: Maya · **Status**: Draft · **Updated**: 7 Oct 2026

## Problem
Who has it, how often, what it costs them today (evidence: tickets, interviews, data).
## Goals and non-goals
Goals with metrics ("cut time to bill monthly retainers from 30 min to 2 min"); explicit non-goals.
## Users and scenarios
Primary persona; 3–5 key scenarios in prose.
## Requirements
| ID | Requirement | Priority | Notes |
|---|---|---|---|
| R1 | Create a schedule (weekly/monthly/yearly) from any invoice | Must | |
## User experience
Flow, key screens or wireframe links, states (empty/error), copy notes.
## Success metrics
Leading and lagging metrics with targets and how they're measured.
## Rollout
Phases, feature flag, migration, support/docs needed.
## Risks and open questions
```

## User stories

`As a <role>, I want <capability>, so that <outcome>.` + acceptance criteria in Given/When/Then:

```
Story: As an account manager, I want invoices to send automatically each month,
so that retainer clients are billed on time without manual work.

AC1 Given a monthly schedule starting 1 Nov, when 1 Nov 06:00 (org time zone) arrives,
    then an invoice is created from the template and emailed to the client.
AC2 Given the client's email bounces, when sending fails, then the owner is notified within 1 hour.
AC3 Given a schedule is paused, when its date arrives, then no invoice is created.
```

Stories should be INVEST: independent, negotiable, valuable, estimable, small, testable. Split big
ones by workflow step, data variation, or rule.

## Prioritization

- **RICE** = Reach × Impact (0.25–3) × Confidence (%) ÷ Effort (person-weeks). Show the table and
  sort; state assumptions behind each number.
- **MoSCoW** for a release scope: Must / Should / Could / Won't (this time).
- Value vs effort 2×2 for quick conversations.

## Roadmap

Now / Next / Later by outcome (problems to solve), not a feature wish list with false dates. Each
item: goal, why now (evidence), success metric, rough size.

## Feedback synthesis

From tickets, interviews or survey exports: tag each item (theme, persona, severity), count by theme,
pull representative quotes, and output a table of themes ranked by frequency × impact with
recommended actions. Keep raw data linked.

## Release notes

User-facing: what's new and why it helps, how to use it, fixes, anything changed or removed. Plain
language, grouped (New / Improved / Fixed), link to docs.

## Done when

Requirements trace to a real problem with evidence, stories have testable acceptance criteria,
priorities are justified, and open questions are listed.
