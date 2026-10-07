# Aatmiq

**Your own AI.** A private, self-hosted AI workplace for organizations: **Chat**, **Work AI** (agent harness) and **Code** (VS Code-based IDE), running on your own servers with open-source models.

*Aatmiq (Sanskrit ātmik, "of the self, one's own"), pronounced AAT-mik.*

- [Master plan](docs/00-master-plan.md) · [Foundation spec](docs/01-foundation.md) · [Connectors setup](docs/09-connectors.md) · [Skill library](docs/08-skills.md) · [Pricing & business](docs/pricing-and-business.md) · [Decision log](docs/decisions.md)

## What works today

| Area | Status |
|---|---|
| Landing page (company profile) | ✅ `/` |
| First-run setup wizard, email/password sign-in, invitations | ✅ |
| Email (SMTP, from Admin → Settings → Email or `SMTP_URL`): emailed invitations, forgot-password links, security notices; admins can send a reset link from Users | ✅ |
| Two-step sign-in with an authenticator app and backup codes; Settings → Security (change password, sign out other devices); admins can turn it off for someone who lost their phone | ✅ |
| Email confirmation links (banner and Settings → Security); admins see unconfirmed addresses | ✅ |
| Admins can require two-step sign-in for everyone who uses a password (Admin → Authentication) | ✅ |
| Roles: org owner/admin, workspace admin, member | ✅ enforced in the API |
| Workspaces (teams) with their own members, models and budget | ✅ |
| Groups: models and a token budget for a set of people across all their workspaces; the group pays for models only it gives ([details](docs/01-foundation.md#61a-groups-built-2026-10-07)) | ✅ |
| Model providers: Ollama, any OpenAI-compatible server (vLLM, LM Studio…), demo model | ✅ health checks, model discovery, keys encrypted at rest |
| Model gateway with streaming and token metering | ✅ |
| Budgets: workspace budget split evenly per member, per-user overrides | ✅ |
| "Request more tokens": member asks, admin approves/declines, notifications | ✅ |
| Chat: streaming, Markdown/code, history, rename/pin/delete, model picker | ✅ |
| Documents: library per workspace (private/shared), PDF/Word/text/code upload, attach in chat (+ upload, @ library), answers with numbered sources and passage preview, keyword + optional vector search (pgvector) | ✅ |
| Projects: instructions, sources (files, pasted text, saved answers, library links), project memory across chats, sharing (private/workspace, chat/edit roles, chats private unless shared), move/archive chats, ⌘K search over messages ([spec](docs/03-projects.md)) | ✅ |
| Chat Phase B: edit & branch (versions), temporary chats, source labels (Confirmed/Assumption/TBD) and versions, Excel and OCR (images, scanned PDFs), export to Word/PDF/Markdown | ✅ |
| Admin console: overview, users, workspaces, models, requests, usage (+CSV), audit log, settings/branding | ✅ |
| Compliance recording notice, branding (name, accent color, logo on sign-in, app, emails and tab icon), dark/light themes | ✅ |
| Docker images + Compose stack | ✅ |
| Background jobs (document processing, housekeeping): inside the API on one server, or a Redis/Valkey queue with separate worker processes (retries, restart recovery, Admin status) | ✅ |
| Uploads on local disk or any S3-compatible bucket (AWS S3, MinIO, Ceph, SeaweedFS, R2…), bundled MinIO profile, copy script for existing installs | ✅ |
| Single sign-on: Google, Microsoft Entra ID, any OpenID Connect provider (Okta, Keycloak…), invite-only or domain auto-join, "require SSO" ([details](docs/04-single-sign-on.md)) | ✅ (SAML: P4) |
| Licensing: Ed25519 license keys verified offline, seats/sections/features/workspace limits, daily check-ins (counts only), grace periods, Admin → License ([details](docs/05-license-server.md)) | ✅ |
| License server + Super Admin console: customers, issue/change/revoke licenses, check-ins, release channel | ✅ `apps/license-server`, `apps/license-console` |
| Work AI: agent tasks on DeepSeek Harness with a live timeline, plan, files, approvals for risky steps, follow-ups, queue, private web search (SearXNG), MCP connectors, skills, schedules, per-task isolation, metering ([details](docs/06-work-ai.md)) | ✅ |
| Connectors: catalog of 45 apps (Gmail, Google Calendar/Drive/Docs, Slack, GitHub, GitLab, Notion, Canva, Jira…), each person signs in to their own account, checked against the real services ([setup](docs/09-connectors.md)) | ✅ |
| Built-in skill library: 59 skills for software, data, documents and business work, admins switch each on or off ([list](docs/08-skills.md)) | ✅ |
| Code: Aatmiq Code (Code-OSS) in the browser, per-person IDE as your own user, terminals, Git (clone, your name on commits), Open VSX extensions, and the Aatmiq panel: a coding agent with approvals and diffs ([details](docs/07-code.md)) | ✅ (desktop app next) |

## Repository layout

```
apps/api            Fastify API (auth, SSO, admin, chat, gateway, quotas, license client)
apps/web            Next.js app: landing, sign-in, chat, admin console
apps/license-server License server (our cloud): signs licenses, receives check-ins
apps/license-console Super Admin console for the license server
packages/db         Drizzle schema + migrations (Postgres)
packages/shared     Roles/permissions, validation schemas, quota maths
packages/model-gateway  Provider adapters (Ollama / OpenAI-compatible), streaming, metering
packages/license    License key format, signing/verification, plan presets, grace rules
packages/ui         Shared design system (buttons, fields, dialogs, charts, theme)
packages/harness    Work AI agent engine adapter (DeepSeek Harness), its plugin and risk policy
apps/code           Aatmiq Code: builds the IDE from a pinned Code-OSS server build + our patches and extensions
deploy/             Dockerfiles and docker-compose stack
docs/               Plans, specs and decisions
```

## Run it locally (development)

Requirements: Node 22, pnpm 10, PostgreSQL 16 with the pgvector extension.

```bash
pnpm install
pnpm --filter @aatmiq/code build        # the IDE (download cached in apps/code/.cache)
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
# add S3_TEST_ENDPOINTS="minio=http://127.0.0.1:9000|key|secret" to also run the storage tests on S3 servers,
# and REDIS_TEST_URL=redis://127.0.0.1:6379/5 for the job queue tests
pnpm --filter @aatmiq/license test
pnpm --filter @aatmiq/harness test   # runs the real agent runtime against a fake model
LICENSE_TEST_DATABASE_URL=postgres://…/aatmiq_license_test pnpm --filter @aatmiq/license-server test
# Browser suites (see tests/e2e/README.md): full.mjs (product), run-work.sh (Work AI; E2E_SCRIPT=code.mjs for Code,
#   account.mjs for email/password reset/email confirmation/two-step sign-in) and run-licensing.sh
# Connectors against the real services (needs internet): cd apps/api && npx tsx ../../tests/connectors/check.mts
```

## Deploy on a server

```bash
cp deploy/.env.example deploy/.env   # set APP_URL, APP_SECRET, POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
# with local models on the same machine:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile ollama up -d --build
# private web search for Work AI (then Admin → Work AI → SearXNG URL http://searxng:8080):
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile search up -d --build
# uploads in a bundled MinIO instead of the files volume (set the S3_* values in .env first):
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile minio up -d --build
# background jobs in a separate worker with Valkey (set REDIS_URL=redis://valkey:6379 in .env first):
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile worker up -d --build
```

The API applies database migrations automatically on start. For invitations and password resets by email, set `SMTP_URL` and `MAIL_FROM` in `deploy/.env` or use Admin → Settings → Email. Uploads (documents, project files, the logo) go to the `files` volume, or to an S3-compatible bucket when `S3_BUCKET` is set (AWS S3, MinIO, Ceph, SeaweedFS, Cloudflare R2…; see `deploy/.env.example`). The API checks it can write, read and delete there before it starts, and `docker compose exec api node dist/copy-files-to-s3.js` moves an existing install's files into the bucket. Work AI task folders and IDE homes always stay on the server's disk. Background jobs (processing uploads, deleting expired temporary chats, the license check-in) run inside the API by default; with `REDIS_URL` set they go through a queue to the `worker` service (`node dist/worker.js`, same image; run several to scale), get retries, and run once however many API copies there are. Admin → Overview shows where they run and whether a worker is alive. Either way, documents left half-processed by a restart are picked up again. Put a TLS reverse proxy (Caddy, Nginx, Traefik) in front of port 3000. Set `LICENSE_PUBLIC_KEY` (from your order) in `deploy/.env`; without it the server runs in development mode.

The license server and Super Admin console run separately, in Aatmiq's cloud: `deploy/license/docker-compose.yml` (see [docs/05-license-server.md](docs/05-license-server.md)).
