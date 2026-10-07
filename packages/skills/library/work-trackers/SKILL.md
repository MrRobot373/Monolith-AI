---
name: work-trackers
description: "Use when working with connected trackers and team docs (Jira, Confluence, Linear, Asana, Notion…): find, summarize, create tasks."
category: Apps
---

# Project trackers and team docs (connected apps)

Tools appear with the connector's prefix (for example `mcp__atlassian__…`, `mcp__linear__…`,
`mcp__notion__…`) once connected in **Work AI → Connections**. Reads run freely; creating or
changing tasks, pages or comments asks the person to approve.

## Find before you create

- Search for existing items before creating new ones (avoid duplicates).
- Identify the right project/team/board/database; list options if ambiguous.
- Read full items (description, comments, status, assignee, due date, links).

## Summaries

**Status or sprint summary** — table: item (key + link), title, assignee, status, due, notes; then
totals by status, overdue items, blocked items with reasons, and what changed since the last summary.
Follow the `project-management` status report shape for a written update.

**Search team docs** (Confluence, Notion) — answer with quotes and links to the pages used; say when
pages look outdated (last edited date).

## Creating items from notes

From meeting notes, an email or a plan:
1. Extract action items (verb + object, owner, due date, acceptance criteria).
2. Show the proposed items as a table (title, description, assignee, due, labels, project).
3. After approval, create them; return the keys/links.

Item quality: a title that says the outcome ("Add EU VAT rates to checkout"), description with
context and acceptance criteria, correct project, assignee and due date only if known.

## Updating

Change status, assignee, dates or fields only as asked; add a comment explaining larger changes.
Bulk changes: show the list of affected items first.

## Tool-specific notes

| Tool | Notes |
|---|---|
| Jira | JQL search (`project = APP AND status != Done AND duedate < now()`); issue types matter (Bug/Story/Task) |
| Linear | Teams, cycles, projects; issue identifiers like `ENG-123` |
| Asana / monday / ClickUp | Projects/boards with sections/groups; custom fields vary per workspace |
| Notion / Airtable | Databases with properties; match property names and types exactly |
| Confluence | Spaces and pages; cite page title + space |

## Done when

Answers reference real items with links, new items are well-formed and approved, and no change was
made without the person's approval.
