# Skill library

Aatmiq ships 59 built-in skills that Work AI and the Aatmiq panel (Code) can use. A skill is a
folder with a `SKILL.md`: a one-line description the agent sees in every task ("Use when…"), and
detailed instructions it loads only when a task matches — a workflow, checklists, templates,
pitfalls and a "Done when" bar. Some skills also ship tested helper scripts the agent runs from the
skill's folder (Markdown → Word/PDF, outline → PowerPoint, formatted Excel export, link checker,
contrast checker, secret scanner, data profiler, chart style).

## For people

**Work AI → Skills → Library** lists every skill by category, with search; click one to read it.
You don't pick skills: the agent sees the descriptions and loads the right one when a task fits
(it also loads one when you name it, e.g. "use the proposals-quotes skill"). Skills you or your
admins write (**New skill**) work the same way and win over a library skill with the same name.

## For admins

Switch library skills on or off for everyone on the same page (the switch on each row; stored as
`disabledLibrarySkills` in the Work AI settings). Work AI tasks get every skill that's on; Code
tasks get the Software development, Data and Apps ones. Each skill adds about 40 tokens (its
description) to every model call; the full library adds about 2,000.

The helper scripts need Python with pandas, openpyxl, matplotlib, python-docx, python-pptx,
reportlab, pypdf and lxml; the Docker image installs them.

## How it works

- `packages/skills/library/<name>/SKILL.md` (+ `scripts/`), loaded by `@aatmiq/skills`.
- When a task starts, Work AI copies the enabled skills into the task's runtime folder next to the
  organization's and the person's own skills; DSH's skill loader lists them and gives the agent a
  `skill` tool that returns the instructions plus the skill's folder path.
- `packages/skills/src/library.test.ts` checks every skill: name and folder match, the description
  starts with "Use when/for" and fits in 160 characters, a "Done when" section exists, every
  script a skill mentions exists and parses, and cross-references point to real skills.

API: `GET /api/work/skills/library`, `GET /api/work/skills/library/:name` (instructions),
`PATCH /api/work/skills/library/:name {enabled}` (admins).

## Writing a new library skill

1. `packages/skills/library/<name>/SKILL.md` with frontmatter `name`, `description` ("Use when …",
   ≤ 160 characters, the words people would use), `category` (one of the five below).
2. Body: a `#` title, the workflow in numbered steps, checklists and templates, environment-specific
   tips (what's installed, which tools exist), pitfalls, and `## Done when`.
3. Helper scripts in `scripts/`, referenced as `scripts/<file>`; test them as a task user.
4. `pnpm --filter @aatmiq/skills test`.

## The skills

### Software development (25)

| Skill | Use it for | Helpers |
|---|---|---|
| `accessibility-audit` — Accessibility audit (WCAG 2.2 AA) | checking or fixing accessibility (WCAG 2.2 AA): contrast, keyboard use, labels, headings, forms. Has a contrast-ratio script. | `contrast.py` |
| `api-documentation` — API documentation | documenting an API: OpenAPI/Swagger specs, endpoint reference, auth guides, examples and changelogs from the route code. | – |
| `backend-api` — Backend API | designing or building a backend/REST API (Node, Python, Go): endpoints, validation, errors, auth, pagination, testing with curl. | – |
| `ci-cd-pipelines` — CI/CD pipelines | creating or fixing CI/CD pipelines (GitHub Actions, GitLab CI): lint/test/build jobs, caching, secrets, deploys, failing runs. | – |
| `code-review` — Code review | reviewing code, a diff or a pull request for bugs, security, performance, readability and tests, with prioritized comments. | – |
| `database-migrations` — Database migrations | changing an existing database schema: migrations (Prisma, Drizzle, Alembic, Django…), backfills, zero-downtime changes. | – |
| `database-schema-design` — Database schema design | designing or reviewing a relational database schema: tables, keys, relationships, constraints, indexes, ER diagrams. | – |
| `debugging` — Debugging | something is broken (error, crash, failing test, wrong output, hang): reproduce, isolate, find the root cause, fix, add a test. | – |
| `docker-deployment` — Docker and deployment | containerizing or deploying an app: Dockerfiles, docker-compose, env and secrets, health checks, go-live checklist. | – |
| `frontend-web-app` — Frontend web app | building or changing a web frontend (HTML/CSS/JS, React, Vue): pages, components, forms, responsive layout, and verifying the build. | – |
| `git-workflow` — Git workflow | Git work: branches, commit messages, merge or rebase, resolving conflicts, undoing mistakes, tags, PR descriptions. | – |
| `mobile-app` — Mobile app development | building or changing a mobile app (React Native/Expo, Flutter, native): screens, navigation, offline data, permissions, release. | – |
| `node-typescript-project` — Node.js and TypeScript project | writing Node.js/TypeScript CLIs, servers or scripts: package.json/tsconfig setup, ESM, async patterns, errors, tests. | – |
| `performance-optimization` — Performance optimization | code, an endpoint, a query or a web page is slow or heavy: profile, find the bottleneck, fix, measure before/after. | – |
| `python-project` — Python project | writing Python scripts, CLIs or projects: packaging, virtualenvs, typing, logging, error handling, files and CSV/JSON, tests. | – |
| `react-typescript` — React with TypeScript | writing React components with TypeScript (Vite, Next.js): props and types, hooks, data fetching, forms, performance, tests. | – |
| `refactoring` — Refactoring | restructuring code without changing behavior: renames across a codebase, extracting functions/modules, removing duplication. | – |
| `security-review` — Security review | checking code for security problems: OWASP issues, injection, access control, secrets in code, dependencies. Has a secret scanner. | `find_secrets.sh` |
| `software-testing` — Software testing | writing or improving automated tests (pytest, unittest, Jest, Vitest, Go): test cases, mocks, fixtures, flaky tests. | – |
| `sql-queries` — SQL queries | writing, fixing or speeding up SQL: joins, aggregations, window functions, reports, EXPLAIN plans, safe UPDATE/DELETE. | – |
| `static-website` — Static website | building a business, marketing or landing website as static HTML/CSS/JS: shared header/footer, SEO tags, forms, link check. | `check_links.py` |
| `system-design` — System design | designing the architecture of a system or major feature: requirements, components, data, scaling, trade-offs, diagrams. | – |
| `technical-documentation` — Technical documentation | writing technical docs: READMEs, how-to guides, architecture overviews, ADRs, runbooks, docstrings, changelogs. | – |
| `ui-ux-design` — UI/UX design | designing or improving a UI or user flow: layout, visual style, design tokens, component states, wireframes, design reviews. | – |
| `web-scraping` — Web scraping and data extraction | extracting data from web pages into CSV/JSON/Excel: polite fetching, parsing HTML tables and lists, pagination, cleanup. | – |

### Data (6)

| Skill | Use it for | Helpers |
|---|---|---|
| `charts-visualization` — Charts and visualization | making charts (bar, line, pie, scatter) with matplotlib: choosing the chart, clean styling, labels, saving PNG/SVG. Has a helper. | `chart_style.py` |
| `data-analysis` — Data analysis | analyzing CSV/Excel/JSON data with pandas: exploring, grouping, trends, comparisons, checked numbers and saved results. | – |
| `data-cleaning` — Data cleaning | data is messy: duplicates, missing values, inconsistent spellings, mixed date/number formats, merging lists. Has a profiler. | `profile_data.py` |
| `excel-spreadsheets` — Excel spreadsheets | creating, reading or editing Excel (.xlsx): formatted sheets, formulas, totals, charts, cleaning messy sheets. Has a helper. | `xlsx_helpers.py` |
| `financial-analysis` — Financial analysis | business finance: P&L, budget vs actual, cash flow and runway, margins, break-even, forecasts, pricing math, ratios. | – |
| `kpi-report` — KPI report and dashboard | producing a recurring KPI report or dashboard: period comparisons, targets, highlights, as Markdown, Excel or HTML. | – |

### Documents & writing (8)

| Skill | Use it for | Helpers |
|---|---|---|
| `business-writing` — Business writing | writing professional emails, memos, announcements, letters or replies: clear structure, right tone, ready to send. | – |
| `meeting-notes` — Meeting notes and agendas | turning a transcript or notes into minutes (decisions, action items with owners and dates) or preparing an agenda. | – |
| `pdf-documents` — PDF documents | working with PDFs: extract text, merge, split, rotate, watermark, or create a polished PDF from Markdown. Has a script. | `md_to_pdf.py` |
| `presentations` — Presentations (.pptx) | making a slide deck (.pptx): pitch, update, sales or training presentations; storyline and a script that builds the deck. | `outline_to_pptx.py` |
| `proofreading-editing` — Proofreading and editing | proofreading or editing text: grammar, spelling, clarity, tone, length, style-guide consistency, with changes shown. | – |
| `report-writing` — Report writing | writing an analytical or research report, business case or executive summary: findings, evidence, recommendations, sources. | – |
| `translation-localization` — Translation and localization | translating or localizing text, documents, websites, app strings or subtitles while keeping formatting and local formats. | – |
| `word-documents` — Word documents (.docx) | creating or editing Word documents (.docx): letters, reports, proposals, policies, or reading .docx files. Has a Markdown converter. | `md_to_docx.py` |

### Business (16)

| Skill | Use it for | Helpers |
|---|---|---|
| `contract-review` — Contract review | reviewing or summarizing a contract (NDA, services, lease, SaaS terms): key terms, dates, risks, questions for a lawyer. | – |
| `customer-support` — Customer support | customer support: replies to customer emails, tickets and reviews, complaints and refunds, help articles, macros, triage. | – |
| `email-campaigns` — Email campaigns | planning or writing marketing emails: newsletters, launches, onboarding or re-engagement sequences, subject lines. | – |
| `hr-recruiting` — HR and recruiting | HR and recruiting: job descriptions, interview plans and scorecards, screening against criteria, letters, onboarding. | – |
| `invoicing-bookkeeping` — Invoicing and bookkeeping | bookkeeping: invoices, categorizing bank/card transactions, reconciling payments, receivables aging, VAT/GST summaries. | – |
| `market-research` — Market research | market and competitor research: comparison tables, market sizing (TAM/SAM/SOM), personas, SWOT, trends, with sources. | – |
| `marketing-content` — Marketing content | creating marketing content: social posts, ads, landing page copy, product descriptions, blog posts, content calendars. | – |
| `privacy-compliance` — Privacy and data protection | privacy and data protection: privacy policies, cookie notices, GDPR/DPDP/CCPA basics, data requests, privacy reviews. | – |
| `product-management` — Product management | product work: PRDs, user stories with acceptance criteria, prioritization (RICE), roadmaps, feedback synthesis. | – |
| `project-management` — Project management | planning and running projects: charters, task breakdown, timelines and Gantt charts, RACI, risks, status reports. | – |
| `proposals-quotes` — Proposals, quotes and statements of work | writing a proposal, quotation, estimate or statement of work: scope, pricing table with checked math, timeline, terms. | – |
| `sales-outreach` — Sales outreach | sales work: prospect research, personalized cold emails, follow-up sequences, call scripts, objections, CRM notes. | – |
| `seo` — SEO | SEO: keyword research, content briefs, optimizing pages, titles and meta descriptions, technical SEO audits, local SEO. | – |
| `sop-process-docs` — SOPs and process documentation | documenting how work is done: SOPs, process maps, checklists, work instructions, training and handover notes. | – |
| `strategy-okrs` — Strategy, plans and OKRs | planning and strategy: OKRs, quarterly or annual plans, business plans, decision memos comparing options. | – |
| `web-research` — Web research | a question needs current or external information from the web: good searches, source checking, cited answers. | – |

### Apps (4)

| Skill | Use it for | Helpers |
|---|---|---|
| `design-with-canva` — Designing with connected apps (Canva, Figma, Miro, Gamma) | making or finding designs in connected design apps (Canva, Figma, Miro, Gamma): social posts, flyers, decks, exports. | – |
| `email-calendar-assistant` — Email and calendar assistant | working with the person's connected email or calendar (Gmail, Google Calendar, Outlook): triage, drafts, scheduling. | – |
| `github-workflow` — GitHub through the connector | working with GitHub through the connected app: issues, pull requests, PR reviews, triage, release notes, CI runs. | – |
| `work-trackers` — Project trackers and team docs (connected apps) | working with connected trackers and team docs (Jira, Confluence, Linear, Asana, Notion…): find, summarize, create tasks. | – |

