# 01 — Foundation Spec

Phase **P0**. Everything the three sections (Chat, Work AI, Code) sit on: tenancy, identity, roles, models, the model gateway, budgets, the admin portal, licensing and deployment.

Status: **Draft for review** · Depends on: `00-master-plan.md`, `decisions.md`

---

## 1. Tenancy model

```
Install (one customer server)
└─ Organization            ← one per install (license is bound to it)
   ├─ Workspaces (teams)   ← e.g. "Engineering", "Sales", "Finance"
   │   ├─ Members (users, with a role per workspace)
   │   ├─ Models enabled for this workspace
   │   ├─ Token budget for this workspace
   │   ├─ Connectors enabled for this workspace
   │   └─ Content: chats, folders, documents, tasks, skills, IDE projects
   └─ Org-level: users directory, SSO, providers, branding, audit, license
```

- A **user** belongs to the org and can be a member of **several workspaces**. A workspace switcher sits at the top-left, like Slack or Linear.
- **All content is scoped to a workspace.** Moving a chat or document between workspaces is an explicit action and is written to the audit log.
- Every org starts with a default workspace called "General".
- *Personal space:* each user also gets a private area inside each workspace. Content is private by default and can be shared to the workspace.

---

## 2. Roles

| Role | Scope | Summary |
|---|---|---|
| **Super Admin** | License server (our cloud) | Manages customers, licenses, the model catalog and "managed LLM" configs. No access to org content. |
| **Org Owner** | Organization | The first admin, and billing/license contact. Cannot be removed without transferring ownership. |
| **Org Admin** | Organization | Users, SSO, providers, all workspaces, budgets, branding, audit. |
| **Workspace Admin** | One workspace | Members, model access, user quotas and connectors *inside that workspace*, within the budget the Org Admin gave it. Approves "more tokens" requests. |
| **Member** | One workspace | Uses the sections enabled for them. |
| **Viewer** *(optional, P4)* | One workspace | Read-only access to shared chats and results. |

### Permission matrix (org side)

| Permission | Org Owner | Org Admin | WS Admin | Member |
|---|:-:|:-:|:-:|:-:|
| Invite/remove users (org) | ✅ | ✅ | — | — |
| Create/delete workspaces | ✅ | ✅ | — | — |
| Add members to workspace | ✅ | ✅ | ✅ (own WS) | — |
| Configure SSO / login methods | ✅ | ✅ | — | — |
| Add/edit model providers | ✅ | ✅ (self-managed mode) | — | — |
| Enable models for a workspace | ✅ | ✅ | — | — |
| Grant models to users within WS | ✅ | ✅ | ✅ | — |
| Set workspace budget | ✅ | ✅ | — | — |
| Set user quotas within WS | ✅ | ✅ | ✅ | — |
| Approve token requests | ✅ | ✅ | ✅ (own WS) | — |
| Enable sections (Chat/Work/Code) per user | ✅ | ✅ | ✅ (within license) | — |
| Enable connectors | ✅ | ✅ | ✅ (own WS, from org-allowed list) | Connect own account |
| View usage analytics | ✅ all | ✅ all | ✅ own WS | Own usage |
| Audit log | ✅ | ✅ | Own WS | — |
| Branding | ✅ | ✅ | — | — |
| License / billing | ✅ | view | — | — |

Implementation: permissions are **named capabilities** (e.g. `workspace.members.manage`) mapped to roles in code. Custom roles are possible later without a schema change.

---

## 3. Identity and authentication

Library: **Better Auth** (self-hosted, TypeScript). Sessions are stored in Postgres, using HTTP-only secure cookies.

### Login methods (the Org Admin enables each)
1. **Email + password.** Passwords are hashed with argon2id. There's a password policy, optional **two-factor codes** (authenticator app), and backup codes.
2. **Google Workspace / Microsoft Entra ID** sign-in, which can be restricted to allowed email domains.
3. **SAML 2.0 / OIDC** (Okta, Entra, Keycloak, JumpCloud…). *P0 ships OIDC; SAML lands by P1.*
4. *(Later)* LDAP / Active Directory.

### Flows
- **First run:** the installer opens `/setup`. You enter the license key, then the org name, then create the Org Owner account, then pick the branding accent (pre-filled from the license).
- **Invite:** an admin invites by email (single or CSV bulk) and picks workspaces and a role. The user gets a link, sets a password or uses SSO, and lands in their workspace.
- **Domain auto-join (optional):** anyone who signs in with SSO from `@company.com` joins the default workspace as a Member.
- **Password reset**, **email verification**, and **session management** (see active devices, revoke).
- **Desktop IDE sign-in:** the desktop app opens the browser, the user signs in, and a one-time code is handed back to the app. It works like `gh auth login` or VS Code's "Sign in with GitHub".
- **Deactivating a user** revokes all sessions and API tokens immediately. Their content stays in the workspace.
- **Email delivery:** SMTP is configured by the admin. Without SMTP, invites show a copyable link.

### Security defaults
Login rate limiting and lockout, CSRF protection, secure headers, 12h idle / 30d absolute session limits (configurable), and every auth event written to the audit log.

---

## 4. Models: catalog, providers, access

### 4.1 Two management modes (per org, set by the license)

| Mode | Who manages LLMs | How it works |
|---|---|---|
| **Monolith-managed** | **Super Admin** | We set up and operate the org's model servers. The license server pushes a **model config** (providers, models, default parameters). The Org Admin can only enable/disable those models per workspace. |
| **Self-managed** | **Org Admin** | The org runs its own Ollama/vLLM/API endpoints. The Org Admin adds providers and models in the portal. The Super Admin's catalog appears as *suggestions*. |

In both modes, **prompts and responses never pass through our cloud.** Only configuration flows down from the license server.

### 4.2 Model catalog (Super Admin–curated)
- The Super Admin maintains a catalog in the license server. Each entry has: model id, family, sizes, context length, capabilities (chat / vision / tools / code / embeddings), a recommended hardware tier, default parameters, and a license note.
- Deployments sync the catalog once a day, and it shows up in the Org Admin's "Add model" screen as one-click presets.
- The Super Admin decides the starting models when the product launches (a research list sized to hardware tiers is prepared separately in `docs/model-catalog.md`).

### 4.3 Providers
| Type | Examples | Notes |
|---|---|---|
| `ollama` | Local Ollama | Auto-discover pulled models, optionally pull a new one from the UI |
| `openai_compatible` | vLLM, LM Studio, TGI, llama.cpp server, DeepSeek API, Together, Groq, Azure OpenAI… | Base URL + key |
| `anthropic` / `gemini` *(optional)* | For orgs that allow some cloud use | Can be disabled by license |

Each provider shows a health check (reachable, latency, models listed). Keys are encrypted at rest with the org key.

### 4.4 Access
- **Org** enables a model, then **Workspace** enables it for the workspace, then (optionally) **User/Group** grants inside the workspace. Default: every workspace member gets all of the workspace's models.
- The admin sets which **sections** can use a model (e.g. "Qwen-Coder only in Code + Work AI").
- There are **default models** per section per workspace, and **role models** for embeddings and summarization (used internally for retrieval and titles).

---

## 5. Model Gateway (`packages/model-gateway`)

The single path for **every** model call, whether from Chat, Work AI, Code, or internal jobs.

```
caller → authz(user, workspace, model, section)
       → quota check (user → workspace → org)
       → route to provider (+ fallback list)
       → stream tokens back
       → meter (input/output/cached tokens, latency)
       → write usage_event, update counters (Redis) → flush to Postgres
```

- **API:** internal TypeScript client plus an **OpenAI-compatible HTTP endpoint** (`/v1/chat/completions`, `/v1/embeddings`), so DSH, the IDE, and customers' own scripts can use it with **personal API tokens** that are metered to that user.
- **Token counting:** uses the provider's reported usage. When that's missing, it falls back to a tokenizer estimate (tiktoken/HF tokenizer per model family), and those events are flagged `estimated=true`.
- **Routing:** each model can have several provider endpoints (e.g. two GPU boxes), balanced round-robin by health. If they fail, it falls back to the next model in the list the admin set.
- **Rate limits:** requests per minute and concurrent streams per user, to protect shared GPUs.
- **Logging:** metadata is always logged. Full prompt/response logging is **off by default** and can be turned on by the Org Admin, with a notice shown to users.
- **Virtual cost:** optional price per 1M input/output tokens per model, so admins see a cost even for local models.

---

## 6. Budgets, quotas and "Request more tokens"

### 6.1 Hierarchy
```
Org pool (optional, e.g. 500M tokens/month from license or admin)
 └─ Workspace budget (e.g. Engineering 200M/month)
     └─ User quota (default per member, overridable per user)
```
- Each level has a **period** (daily / weekly / monthly, with a reset day) and optional **per-model limits** (e.g. "large model max 2M/month").
- A request is allowed only if **all** levels have room. The most restrictive level blocks it.
- Soft alerts at **80%** and **95%** go to the user, and at the workspace level to its admins.

### 6.2 When a user hits their limit
1. The composer is replaced by a calm banner: *"You've used your monthly token allowance."* with a **Request more** button. A running agent task **pauses** instead of failing.
2. The request form has presets (+1M, +5M, custom), a duration (just this period / permanently), and a reason (optional text). It can show the task that is waiting.
3. **Workspace Admins** (then Org Admins, if the workspace budget is also exhausted) get an in-app notification, an email, and *(P2)* a Slack message if connected.
4. The admin sees a **Requests inbox** with the user's usage history and can **Approve**, **Approve a different amount**, or **Deny with a note**.
5. The user is notified. On approval, a paused task resumes automatically.
6. Everything is audit-logged.

**Auto-approve rules (optional):** e.g. "auto-approve up to +1M once per month for Engineering".

---

## 7. Usage analytics (admin)

- **Overview:** tokens by day, split by section / model / workspace. Active users. Top users. Budget burn-down with a projection to period end.
- **Per-user drill-down:** usage by model and section, and requests history. Content is never shown here.
- **Per-model:** traffic, latency (p50/p95), errors, tokens/sec (helps with GPU sizing).
- **Export** to CSV. *(P4)* scheduled email reports.
- **Users** see their own usage in Settings, which reads out as e.g. "62% of monthly allowance".

---

## 8. Admin portal: screens

`/admin` (Org Admin and Owner), plus a workspace-scoped subset for Workspace Admins.

1. **Overview**: health (providers, workers, disk, GPU if reported), usage summary, pending requests, license status.
2. **Users**: table (name, email, workspaces, role, status, last active, usage), invite, bulk CSV, deactivate, reset 2FA.
3. **Workspaces**: list, then detail with tabs: Members · Models · Budget & quotas · Sections · Connectors · Settings.
4. **Models**: providers (health), models (enable, sections, default params, virtual cost), catalog presets.
5. **Budgets**: org pool, workspace budgets, default user quotas, auto-approve rules.
6. **Requests**: token requests inbox.
7. **Usage**: analytics (§7).
8. **Authentication**: login methods, SSO connections, domain auto-join, session policy, 2FA enforcement.
9. **Branding**: product name override, logo (light/dark), accent color (with contrast check), login page message.
10. **Data & privacy**: retention (auto-delete chats after N days), prompt logging toggle, export org data.
11. **Audit log**: filterable and exportable.
12. **License**: tier, seats used/total, features, expiry, last check-in, "Enter new key".
13. **System**: SMTP, storage, version and update available, backups.

## 9. User settings

Profile (name, avatar, job title), Appearance (dark/light/system, density), Default model per section, Personal instructions ("custom instructions"), Notifications, Security (password, 2FA, sessions, personal API tokens), Usage, Connected accounts (P2), Keyboard shortcuts.

---

## 10. Licensing client (inside each deployment)

- **License key** is a signed token (Ed25519 JWS) issued by the license server, with claims:
  `org_id, customer_name, tier, seats, features[], sections[], model_mode (managed|self), branding{accent, logo_url, name}, issued_at, expires_at, check_in_interval`.
- It's verified **offline** with our public key, which is embedded in the build, so a missing network never breaks auth.
- **Check-in** (every 24h): the deployment sends `license_id, version, active_seats, aggregate tokens per section/model (counts only), health`. It receives a renewed token, catalog/managed-model config updates, and an update-available notice.
- **Grace:** if check-in fails, 14 days of full function, then a banner, then read-only for admin actions (users can still work) at day 30. Hard stop only at **expiry** + 14 days.
- **Seat enforcement:** a seat is an active (non-deactivated) user. Inviting beyond seats is blocked, with a notice to upgrade.
- **Feature gating:** sections, SSO/SAML, audit export, and connectors, all checked through one `hasFeature()` helper, both server-side and in the UI.

---

## 11. Deployment (P0 target: Docker Compose)

```
services: caddy (TLS) · web · api · worker · postgres(+pgvector) · redis · minio
optional profiles: ollama (GPU) · searxng (P2) · sandbox-manager (P2) · otel/grafana
```
- **Installer:** `curl -fsSL https://get.<domain>/install.sh | sh`. It checks Docker, asks for the domain and license key, generates secrets, writes `.env`, and starts the stack.
- **Minimum:** 4 vCPU / 16 GB RAM / 100 GB SSD without local models. GPU sizing is documented per model tier.
- **Updates:** `monolith update` pulls signed images and runs DB migrations. Rollback keeps the previous image tag.
- **Backups:** `monolith backup` (pg_dump + MinIO mirror). A cron template is included.
- **Air-gapped (P4):** offline image bundle + offline signed license.

---

## 12. Data model (P0 tables)

```
organizations(id, name, slug, license_id, settings jsonb, created_at)
users(id, org_id, email, name, avatar_url, status[active|invited|deactivated], org_role[owner|admin|member], created_at, last_active_at)
auth_accounts / auth_sessions / two_factor  (Better Auth managed)
sso_connections(id, org_id, type[oidc|saml|google|microsoft], config_enc, domains[], enabled)
workspaces(id, org_id, name, slug, icon, settings jsonb, archived_at)
workspace_members(workspace_id, user_id, role[admin|member|viewer], sections[] )
groups(id, workspace_id, name) · group_members(group_id, user_id)

model_providers(id, org_id, type, name, base_url, api_key_enc, managed_by[org|monolith], health jsonb)
models(id, org_id, provider_id, model_key, display_name, capabilities[], context_len, default_params jsonb, sections[], cost_in, cost_out, enabled, catalog_ref)
workspace_models(workspace_id, model_id, is_default_for[] )
model_grants(workspace_id, subject_type[user|group], subject_id, model_id)

budgets(id, scope_type[org|workspace|user], scope_id, workspace_id, period[day|week|month], reset_anchor, token_limit, per_model jsonb)
usage_events(id, org_id, workspace_id, user_id, model_id, section[chat|work|code|system|api], input_tokens, output_tokens, cached_tokens, estimated bool, latency_ms, status, created_at)   -- partitioned monthly
usage_counters(scope_type, scope_id, period_start, tokens)    -- hot copy in Redis
token_requests(id, workspace_id, user_id, amount, duration[period|permanent], reason, status[pending|approved|denied], decided_by, decided_amount, note, task_ref, created_at, decided_at)
auto_approve_rules(id, workspace_id, max_amount, per_period_count)

api_tokens(id, user_id, name, hash, scopes[], last_used_at, expires_at)
notifications(id, user_id, type, payload jsonb, read_at)
audit_logs(id, org_id, workspace_id, actor_id, action, target_type, target_id, meta jsonb, ip, created_at)
license(id, token, status, last_check_in_at, payload jsonb)
```

---

## 13. API surface (P0, REST + SSE)

```
POST /auth/*                         (Better Auth)
GET  /me · PATCH /me · GET /me/usage
GET  /workspaces · POST /workspaces · GET|PATCH|DELETE /workspaces/:id
GET|POST|PATCH|DELETE /workspaces/:id/members
GET|POST|PATCH /admin/users · POST /admin/users/invite · POST /admin/users/import
GET|POST|PATCH|DELETE /admin/providers · POST /admin/providers/:id/test
GET|POST|PATCH /admin/models · GET /admin/catalog
GET|PUT /workspaces/:id/models · GET|PUT /workspaces/:id/budget
GET|POST /token-requests · POST /token-requests/:id/decide
GET /admin/usage?group_by=&from=&to= · GET /admin/usage/export
GET /admin/audit · GET|PUT /admin/branding · GET|PUT /admin/auth-settings
GET /admin/license · PUT /admin/license
POST /v1/chat/completions · POST /v1/embeddings · GET /v1/models   (OpenAI-compatible gateway)
GET /notifications (SSE stream)
```

---

## 14. Audit events (minimum)

auth.login / login_failed / logout / 2fa_enabled · user.invited / deactivated / role_changed · workspace.created / member_added / member_removed · provider.created / updated · model.enabled / disabled / granted · budget.changed · token_request.created / decided · branding.changed · license.updated · data.exported · settings.changed

---

## 15. P0 milestones and acceptance criteria

| # | Milestone | Done when |
|---|---|---|
| F1 | Monorepo + CI + design tokens | `pnpm dev` runs web+api+db. Lint/typecheck/tests in CI. Accent token switches the theme live |
| F2 | Auth + setup wizard | Fresh install can enter the license, create the Owner, and log in with email/pw + 2FA. Google/Microsoft SSO works |
| F3 | Orgs, workspaces, roles | Invite users, create workspaces, assign roles. Permission tests cover the matrix in §2 |
| F4 | Providers + models + gateway | Add Ollama and an OpenAI-compatible provider, health check, stream a completion through `/v1/chat/completions` with metering |
| F5 | Budgets + requests | Limits enforced at user/workspace/org. The request → approve → resume flow works end to end with notifications |
| F6 | Admin portal + usage | All §8 screens (except P2+ items) usable. Usage charts and CSV export |
| F7 | License client + Compose installer | Signed license verified offline, check-in works, grace behavior tested. One-command install on a clean Ubuntu VM |

---

## 16. Open questions (to settle before F2)
1. Should Workspace Admins be allowed to **invite new people to the org**, or only add existing org users? (Proposed: only existing users. Org Admins invite.)
2. Default user quota when a workspace is created? (Proposed: the workspace budget ÷ member count, rounded, adjustable.)
3. Is **prompt/response logging** for compliance something customers will ask for (e.g. finance)? (Proposed: off by default, admin toggle, users see a notice.)
4. The product name needs a trademark check (see `pricing-and-business.md` §4) before we buy a domain. All UI strings pull the name from config, so renaming is cheap.
