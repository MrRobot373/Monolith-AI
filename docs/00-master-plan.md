# Monolith AI — Master Plan

> A private, self-hosted AI workplace for small and mid-size organizations:
> **Chat**, **Work AI** (agent harness) and **Code** (VS Code–based IDE) in one product,
> running on the customer's own servers with open-source models. Their data never leaves their infrastructure.

Status: **Planning** · Owner: Super Admin (product owner) · Last updated: 2026-09-28

---

## 1. Product vision

| Problem | Monolith answer |
|---|---|
| Claude Code, Codex, Cursor, ChatGPT etc. send prompts, code and documents to a vendor cloud. | Everything runs on the org's server. Models are open source (Ollama / vLLM) or a provider the org chooses. |
| Orgs buy 3–5 separate AI tools (chat, agents, coding) with separate admin, billing and data policies. | One product, one login, one admin portal, one usage/quota system. |
| Small companies can't build or run AI infrastructure. | Installs with one command (Docker Compose), with a managed update channel and license. |

**Target customer:** 10–500 person startups and mid-size companies (IT/software services, agencies, finance, healthcare, legal, government contractors) with privacy or compliance needs.

---

## 2. Market scan (what we learn from each)

| Product | Category | What to borrow | Gap Monolith fills |
|---|---|---|---|
| ChatGPT / Claude.ai (Team/Enterprise) | Chat + docs | Clean chat UX, projects/folders, file upload, model picker | Cloud-only; data leaves the org |
| Claude Code / Claude Cowork / OpenAI Codex | Agent harness | Task → plan → tool calls → diffs, approvals, skills, MCP connectors | Closed models, cloud-hosted |
| Cursor / Windsurf / Google Antigravity | AI IDE (VS Code forks) | Right-side agent panel, inline diffs, accept/reject, agent writes directly in the workspace | Cloud models, per-seat SaaS |
| **DeepSeek Harness (dsh)** — MIT, Aug 2026 | Open agent runtime | "Everything is a plugin": models, tools, skills, sessions, sandboxes, storage | Developer preview only, no product/admin/UI for orgs → **we build the product on top** |
| Open WebUI / LibreChat | Self-hosted chat | Ollama integration, admin model management | Chat only; no real agent, no IDE, weak quotas |
| Continue / Tabby | Self-hosted coding assistant | Local model coding | Extension only; no chat/agent workspace |
| Coder / Gitpod | Remote dev environments | Container-per-user workspaces, browser VS Code | No AI product layer |

**Positioning:** *"Claude Code + ChatGPT + Cursor, private, on your own server, with admin controls."* Nobody currently ships all three sections with org admin, quotas and white-label branding as one self-hosted product.

**DSH risk:** DSH is marked as a developer preview with breaking changes promised. We isolate it behind our own `packages/harness` adapter interface so we can pin versions, patch, or swap engines without touching the product.

---

## 3. Users and roles

| Capability | Super Admin (us) | Org Admin | User |
|---|---|---|---|
| Create orgs, issue/revoke licenses, set seat limits and feature tiers | ✅ (license server) | — | — |
| Set org branding (accent color, logo, name) | ✅ (sets defaults per contract) | ✅ within license | — |
| Add model providers (Ollama, vLLM, OpenAI-compatible, etc.) | — | ✅ | — |
| Grant model access per user or group | — | ✅ | — |
| Set token quotas (per user/group, daily/monthly) | — | ✅ | — |
| View usage dashboards (per user / model / section) | Aggregate counts only | ✅ full | Own usage |
| Enable connectors (Slack, Gmail, Drive, GitHub, GitLab…) | — | ✅ org-wide | Connect own accounts |
| Enable sections (Chat / Work AI / Code) per user | License tier | ✅ | — |
| Use Chat, Work AI, Code | — | ✅ | ✅ |

**Privacy boundary:** the Super Admin **never** sees org content (chats, files, code). The license server receives only license status, seat count, version and aggregate token counts.

---

## 4. The product surfaces

### 4.1 Public website + login (`monolith` marketing site)
- Landing page: product story, three sections, privacy pitch, screenshots and demo, pricing/contact, "Request a demo". This doubles as the company profile you can share.
- Login: email + password (with optional two-factor codes), Google / Microsoft SSO, SAML/OIDC (Okta, Azure AD).
- Each deployment serves its own branded login at `ai.<customer>.com`. The marketing site is hosted by us.

### 4.2 Section 1 — Chat
Plain assistant. **No tool calling.**
- Conversations, rename, pin, folders/projects, search, share inside the org.
- Model picker (only models the admin granted this user).
- Document upload (PDF, DOCX, XLSX, PPTX, TXT, MD, images → OCR). Q&A over documents with citations (retrieval over Postgres + pgvector).
- Streaming answers, markdown, code blocks, copy, regenerate, edit the prompt, stop.

### 4.3 Section 2 — Work AI (agent harness, "Cowork")
The user assigns a task and the agent carries it out.
- Engine: DSH wrapped by `packages/harness`. Runs inside the **user's isolated container**.
- Tools: file system, shell, code execution, web search (self-hosted SearXNG, so searches stay private), browser, skills.
- Connectors (via MCP): Slack, Gmail, Google Drive, Google Calendar, GitHub, GitLab, Jira, Notion, Confluence… The admin enables them; each user signs in to their own accounts.
- Task UI: plan → live steps timeline → tool calls with inputs/outputs → approvals for risky actions → final result/artifacts.
- Background tasks, scheduled tasks, task history, and a skills library (org-shared plus personal).

### 4.4 Section 3 — Code (Monolith IDE)
- **Fork of Code-OSS** (the MIT-licensed VS Code source), rebranded to Monolith.
- Two builds from one fork:
  - **Desktop app** (Electron) for Win/macOS/Linux; connects to the org server.
  - **Web IDE** (the browser version served from the org server, like code-server) that opens inside the Monolith web app.
- Workspaces live in the user's container, so the terminal, run/debug, git and extensions all work there. It is fully usable without AI.
- Extensions come from **Open VSX** plus an optional private org registry. Microsoft's Marketplace is not permitted for forks.
- **Monolith AI panel** built into the right-side (secondary) sidebar, collapsible: chat, agent task, live activity feed, inline diffs with accept/reject, checkpoints/undo. It reuses the Work AI engine, so the agent edits files directly in the workspace.

### 4.5 Org Admin portal
Users and groups, invitations, roles, SSO config, model providers, model access, token quotas, usage analytics, connectors, audit log, branding, data retention, license status.

### 4.6 Super Admin console (our license server)
Customers/orgs, licenses (seats, tier, features, expiry, branding defaults), update channel, health heartbeats, aggregate usage for billing.

---

## 5. Architecture

```
                        ┌──────────────── Monolith License Server (our cloud) ───────────────┐
                        │ Super Admin console · license signing · update channel · heartbeats│
                        └──────────────▲─────────────────────────────────────────────────────┘
                                       │ license + aggregate counts only (no content)
┌───────────────────────── Customer server (self-hosted, Docker Compose / Helm) ──────────────────────────┐
│                                                                                                          │
│  Browser / Desktop IDE ──HTTPS──► Reverse proxy (Caddy/Traefik, TLS)                                     │
│                                        │                                                                 │
│             ┌──────────────────────────┼───────────────────────────┐                                     │
│             ▼                          ▼                           ▼                                     │
│   apps/web (Next.js)          apps/api (Fastify, TS)       IDE server (Code-OSS web server)              │
│   login · chat · work ·       auth · RBAC · chat ·         per-user, runs in user container              │
│   admin · settings            tasks · admin · WS/SSE                                                     │
│                                        │                                                                 │
│        ┌───────────────┬───────────────┼────────────────┬──────────────────┐                             │
│        ▼               ▼               ▼                ▼                  ▼                             │
│   Model Gateway    apps/worker     Harness runner   Sandbox manager    Connectors (MCP)                  │
│   quotas/metering  (BullMQ): doc   (DSH adapter)    Docker: 1 container Slack/Gmail/Drive/               │
│   routing/fallback ingest, embeds, ─────────────►   per user, CPU/RAM   GitHub/GitLab…                   │
│        │           scheduled tasks                  /disk limits                                         │
│        ▼                                                                                                 │
│   Ollama / vLLM / OpenAI-compatible providers        Postgres(+pgvector) · Redis · MinIO(S3) · SearXNG   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key rule:** every model call, from any section, goes through the **Model Gateway**. That gives one place for access checks, quotas, token metering, logging, routing and fallback.

---

## 6. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | Same as DSH (Node) and VS Code |
| Monorepo | pnpm workspaces + Turborepo | Shared types/UI across apps |
| Web app | Next.js (App Router), React, Tailwind, shadcn/ui (Radix), Framer Motion | Modern, accessible, micro-animations |
| API | Fastify + Zod, SSE/WebSocket streaming | Fast, typed, streaming-friendly |
| Auth | Better Auth (email/password, 2FA, OAuth, SSO/SAML/OIDC plugins) | TS-native, self-hosted, covers all chosen login types |
| DB | PostgreSQL 16 + pgvector, Drizzle ORM | One DB for app data and retrieval vectors |
| Cache/queue | Redis + BullMQ | Streams, rate limits, background jobs |
| Files | MinIO (S3-compatible) | Self-hosted object storage |
| Doc parsing | Unstructured-style pipeline (pdf.js, mammoth, sheetjs, Tesseract OCR) | Local, no cloud |
| Models | Ollama (simple), vLLM (high concurrency), any OpenAI-compatible API | Admin configurable |
| Agent | DeepSeek Harness (dsh) behind `packages/harness` | Open, plugin-based |
| Connectors | MCP servers | Industry standard, reusable |
| Web search | SearXNG (self-hosted) | Private search |
| Sandboxes | Docker (one container per user), Kubernetes later | Isolation |
| IDE | Code-OSS fork (separate repo `monolith-ide`) | True VS Code parity |
| Deploy | Docker Compose (v1), Helm chart (v2) | Simple for small orgs, scalable for mid-size |
| Observability | OpenTelemetry, Prometheus/Grafana (optional bundle) | Ops |

---

## 7. Repository layout (planned)

```
Monolith-AI/
├─ apps/
│  ├─ web/              # Next.js: login, chat, work AI, admin portal, settings
│  ├─ api/              # Fastify API + realtime
│  ├─ worker/           # BullMQ jobs: ingestion, embeddings, scheduled tasks
│  ├─ marketing/        # Public landing site (can share with web initially)
│  └─ license-server/   # Super Admin console + license API (our cloud)
├─ packages/
│  ├─ ui/               # Design system (tokens, components, motion)
│  ├─ db/               # Drizzle schema + migrations
│  ├─ auth/             # Better Auth config, RBAC helpers
│  ├─ model-gateway/    # Providers, routing, metering, quotas
│  ├─ harness/          # DSH adapter + our tools/skills
│  ├─ sandbox/          # Container lifecycle
│  ├─ connectors/       # MCP connector registry + OAuth
│  └─ shared/           # Types, zod schemas, utils
├─ deploy/              # docker-compose, env templates, Helm (later)
└─ docs/                # This plan + per-part specs
```
The IDE fork lives in a **separate repo** (`monolith-ide`) because Code-OSS is huge and has its own build. It communicates with `apps/api` over a documented API.

---

## 8. Core data model (first draft)

`organizations` · `users` · `memberships(role)` · `groups` · `group_members` · `sessions` · `sso_connections`
`model_providers` · `models` · `model_grants(user|group → model)` · `quotas(scope, period, token_limit)` · `usage_events(user, model, section, in/out tokens, cost)`
`chats` · `chat_folders` · `messages` · `attachments` · `documents` · `document_chunks(vector)`
`tasks` · `task_steps` · `tool_calls` · `approvals` · `skills` · `schedules`
`connectors` · `connector_accounts(user, encrypted tokens)`
`workspaces` · `containers`
`audit_logs` · `org_settings(branding, retention)` · `license`

---

## 9. Tokens, quotas and metering
- The gateway counts input/output tokens per call (from the provider response, or a tokenizer estimate as a fallback) and writes a `usage_event`.
- Quotas are checked before each call; there is a soft warning at 80%, then a hard stop or approval request at 100%.
- Quota scopes: org → group → user (the most specific wins). Periods: daily/weekly/monthly.
- Optional cost per model (so admins can show "virtual cost" even for local models).

---

## 10. Security and privacy
- All data stays in the customer's Postgres/MinIO. Encryption at rest is optional (disk-level), and connector tokens are encrypted with an org key.
- RBAC is enforced in the API. Row-level org scoping everywhere.
- Sandboxes: containers run without root privileges, with resource limits, network egress policy set by the admin, and no host mounts.
- Agent safety: approval gates for destructive shell commands, sending external messages (email/Slack), and git push. Every tool call goes into the audit log.
- License check-ins carry **no content**. There is a documented data-flow diagram for customer security reviews.

---

## 11. Design system
- Palette: **black / grays / white**, with a single **accent** (default cyan, `#22D3EE`), exposed as the `--accent` CSS token. Each org's license/branding overrides it, along with the logo and product name.
- Dark mode first, with light mode included. Typeface: Inter (UI) + JetBrains Mono (code).
- Minimal, dense-but-calm layouts inspired by Claude.ai, ChatGPT, Linear and VS Code.
- Micro-animations: 120–200 ms ease-out for hover/press, panel slide, streaming caret, skeletons. Respects `prefers-reduced-motion`.
- The IDE fork ships a matching "Monolith Dark" theme, with the accent injected from org branding.

---

## 12. Roadmap

| Phase | Scope | Result |
|---|---|---|
| **P0 Foundation** | Monorepo, design system, auth (email/pw + Google/Microsoft), orgs/roles, admin portal (users, providers, models, grants, quotas, usage), model gateway, Docker Compose, license client | Installable, admin-manageable shell |
| **P1 Chat** | Chat UI, streaming, folders/rename/search, document upload and retrieval with citations | **First sellable version** |
| **P2 Work AI** | DSH adapter, sandbox containers, tools, SearXNG, MCP connectors, approvals, task UI, skills, schedules | Cowork-class agent |
| **P3 Code** | Code-OSS fork, branding, Open VSX, web + desktop builds, Monolith AI panel wired to the harness | Cursor-class IDE |
| **P4 Enterprise** | SAML/OIDC, audit exports, retention policies, Helm/K8s, offline licenses, backups, SOC2-style docs | Mid-size readiness |
| **Parallel** | Marketing site + Super Admin license server | Sales and customer management |

---

## 13. How we plan from here
Each part gets its own detailed spec in `docs/` before implementation:

1. `01-foundation.md` — auth, roles, admin portal, gateway, quotas, deployment ✅ draft
2. `02-chat.md`
3. `03-work-ai.md`
4. `04-code-ide.md`
5. `05-website-and-license-server.md`
6. `06-design-system.md` — UI/UX, screens, motion, branding

Decisions already made are recorded in `docs/decisions.md`. Pricing and name: `docs/pricing-and-business.md`.
