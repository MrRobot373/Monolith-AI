# Aatmiq

**Your own AI.** A private, self-hosted AI workplace for organizations: **Chat**, **Work AI** (agent harness) and **Code** (VS Code-based IDE), running on your own servers with open-source models.

*Aatmiq (Sanskrit ātmik, "of the self, one's own"), pronounced AAT-mik.*

- [Master plan](docs/00-master-plan.md) · [Foundation spec](docs/01-foundation.md) · [Pricing & business](docs/pricing-and-business.md) · [Decision log](docs/decisions.md)

## What works today (P0 Foundation + first Chat)

| Area | Status |
|---|---|
| Landing page (company profile) | ✅ `/` |
| First-run setup wizard, email/password sign-in, invitations | ✅ |
| Roles: org owner/admin, workspace admin, member | ✅ enforced in the API |
| Workspaces (teams) with their own members, models and budget | ✅ |
| Model providers: Ollama, any OpenAI-compatible server (vLLM, LM Studio…), demo model | ✅ health checks, model discovery, keys encrypted at rest |
| Model gateway with streaming and token metering | ✅ |
| Budgets: workspace budget split evenly per member, per-user overrides | ✅ |
| "Request more tokens": member asks, admin approves/declines, notifications | ✅ |
| Chat: streaming, Markdown/code, history, rename/pin/delete, model picker | ✅ |
| Documents: library per workspace (private/shared), PDF/Word/text/code upload, attach in chat (+ upload, @ library), answers with numbered sources and passage preview, keyword + optional vector search (pgvector) | ✅ |
| Projects: instructions, sources (files, pasted text, saved answers, library links), project memory across chats, sharing (private/workspace, chat/edit roles, chats private unless shared), move/archive chats, ⌘K search over messages ([spec](docs/03-projects.md)) | ✅ |
| Admin console: overview, users, workspaces, models, requests, usage (+CSV), audit log, settings/branding | ✅ |
| Compliance recording notice, accent-color branding, dark/light themes | ✅ |
| Docker images + Compose stack | ✅ |
| SSO (Google/Microsoft/SAML), license server | ⏭ next (P1) |
| Work AI (DeepSeek Harness), Code (VS Code fork) | ⏭ P2 / P3 |

## Repository layout

```
apps/api            Fastify API (auth, admin, chat, gateway, quotas)
apps/web            Next.js app: landing, sign-in, chat, admin console
packages/db         Drizzle schema + migrations (Postgres)
packages/shared     Roles/permissions, validation schemas, quota maths
packages/model-gateway  Provider adapters (Ollama / OpenAI-compatible), streaming, metering
deploy/             Dockerfiles and docker-compose stack
docs/               Plans, specs and decisions
```

## Run it locally (development)

Requirements: Node 22, pnpm 10, PostgreSQL 16 with the pgvector extension.

```bash
pnpm install
cp .env.example .env                 # edit DATABASE_URL / APP_SECRET if needed
createdb aatmiq                      # or use any Postgres you have
pnpm db:migrate                      # reads DATABASE_URL from .env
pnpm dev                             # API on :4000, web on :3000
```

Open http://localhost:3000, click **Sign in**, and the setup wizard creates your organization and owner account. With `ALLOW_MOCK_PROVIDER=true` a built-in **Aatmiq Demo** model is added so chat works without a GPU. Add a real model under **Admin → Models** (for example Ollama at `http://localhost:11434`).

### Tests

```bash
pnpm -r typecheck
pnpm --filter @aatmiq/shared test
pnpm --filter @aatmiq/model-gateway test
TEST_DATABASE_URL=postgres://…/aatmiq_test pnpm --filter @aatmiq/api test   # needs a migrated, disposable database
```

## Deploy on a server

```bash
cp deploy/.env.example deploy/.env   # set APP_URL, APP_SECRET, POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
# with local models on the same machine:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile ollama up -d --build
```

The API applies database migrations automatically on start. Put a TLS reverse proxy (Caddy, Nginx, Traefik) in front of port 3000.
