# Browser end-to-end suite

115 checks that drive the real app in Chromium: setup, chat, projects, message versions,
temporary chats, documents (Excel, OCR), export, models, workspaces, invites, roles, quotas
and token requests, workspace admins, user management, groups, settings (with the logo), audit, health,
usage, sign-in flows and mobile layout.

Run against a **fresh** install (empty database) with `ALLOW_MOCK_PROVIDER=true`:

```bash
cd tests/e2e && npm install
node fake-llm.mjs &                     # fake Ollama/OpenAI-compatible server on :11500
CHROMIUM_PATH=/path/to/chrome node full.mjs   # BASE_URL defaults to http://localhost:3000
```

Each step reports PASS/FAIL; failures save a screenshot to `results/`.

## Work AI

`run-work.sh` starts the fake model (which also plays SearXNG and an MCP server) on :11500, a fresh
API on :4000 and the built web app on :3300, then runs `work.mjs` (27 checks) against the real agent
runtime: a multi-step task with a plan and files, approvals (reject, approve from the inbox), web
search, the agent's browser (an internal sign-up page refused, then allowed by the admin, with the
form submission approved), uploads, stop and continue, isolation (own Unix user, no writes outside
the folder), skills, schedules, connectors, light theme and phone layout. Outside the Docker image,
set `BROWSER_PATH` to a Chromium binary for the browser checks.

```bash
pnpm --filter @aatmiq/web build
CHROMIUM_PATH=/path/to/chrome tests/e2e/run-work.sh     # E2E_SCRIPT=…/full.mjs BASE_URL=http://localhost:3300 runs the product suite on the same stack
docker build -f deploy/Dockerfile.api -t aatmiq-api . && API_IMAGE=aatmiq-api tests/e2e/run-work.sh   # the API from its image
```

## Code

`code.mjs` (13 checks) runs on the same stack as Work AI and needs the IDE build
(`pnpm --filter @aatmiq/code build`): workspaces, the IDE inside Aatmiq, terminal identity, the
Aatmiq panel (file creation, approval-gated delete, opening files, diffs), cloning from a local HTTP
Git server, and access rules.

```bash
E2E_SCRIPT=$PWD/tests/e2e/code.mjs tests/e2e/run-work.sh
# the IDE on its own host (adds a check that it can't reach Aatmiq, and a fresh link per new tab):
IDE_URL=http://ide.localhost:3300 E2E_SCRIPT=$PWD/tests/e2e/code.mjs tests/e2e/run-work.sh
```

## Accounts: email, password reset, email confirmation, two-step sign-in

`account.mjs` (18 checks) runs on the same stack. It starts its own test mail server and points
Aatmiq at it from Admin → Settings → Email, then checks: a test email, emailed invitations,
forgot password with the emailed link (once only), setting up two-step sign-in (QR, wrong and right
codes, backup codes), signing in with a code and with a backup code, the admin turning it off,
admin reset links and changing the password (also at phone width), confirming an email address
from the banner (and a broken link), and requiring two-step sign-in: the admin must have it first,
then, with a grace period, people without it keep working with a reminder and a notification; required right away, a person without it only gets the setup page (also at phone width) until it's on. Screenshots go to
`results-account/`.

```bash
E2E_SCRIPT=$PWD/tests/e2e/account.mjs tests/e2e/run-work.sh
```

## Desktop app

`desktop.mjs` drives the real Electron app (`apps/desktop`, built first) against the stack
`run-work.sh` starts, under Xvfb when there's no display: connecting, signing in, what pages may and
may not do, the IDE in its own window, remembering the server, the offline page. Needs the IDE build
too. Screenshots go to `results-desktop/`.

```bash
pnpm --filter @aatmiq/desktop build
E2E_SCRIPT=$PWD/tests/e2e/desktop.mjs LOG_DIR=$PWD/tests/e2e/results-desktop tests/e2e/run-work.sh
```

## Team server: backups and HTTPS

`run-backup.sh` checks `deploy/docker-compose.backup.yml` on the Compose stack: the nightly service
and its time zone, what a backup holds, retention, restore refusing without `--yes` or while Aatmiq
runs, and a restore bringing back a deleted project with its file (11 checks). `run-https.sh`
checks `deploy/docker-compose.https.yml`: Caddy's certificate, the redirect from http, plain HTTP
not published, HSTS, Secure cookies and a chat answer streaming through the proxy (7 checks). Both
need the images `aatmiq-api:dev` and `aatmiq-web:dev` (and `caddy:2.11.3`).

## Work AI container mode

`run-containers.sh` starts the Compose stack with `deploy/docker-compose.containers.yml` (images
`aatmiq-api:dev` and `aatmiq-web:dev`, on :3999) and the fake model on the host, then
`containers.mjs` checks from inside real task containers: the task's own user, CPU and memory
limits (cgroup v1 or v2), only its own folder, a read-only system; the network (an allowed internal
host through Aatmiq's proxy, the database refused, nothing direct, and *Internet: none* refused even
with the proxy set by hand); new limits for the next task; clean-up on stop and after an API
restart. `KEEP=1` leaves the stack running.

```bash
docker build -f deploy/Dockerfile.api -t aatmiq-api:dev . && docker build -f deploy/Dockerfile.web -t aatmiq-web:dev .
tests/e2e/run-containers.sh
```

## Screenshots of every page

`screens.mjs` captures each app page in dark, light and phone views with sample data (after
`work.mjs`), and `screens-license.mjs` the license console and a licensed install:

```bash
E2E_SCRIPT=$PWD/tests/e2e/screens-after-work.mjs tests/e2e/run-work.sh
E2E_SCRIPT=$PWD/tests/e2e/screens-license.mjs tests/e2e/run-licensing.sh
```

## Licensing and single sign-on

`run-licensing.sh` starts the license server (:4100), the Super Admin console (:3100), a mock
OpenID provider (:11600) and a **licensed** Aatmiq (API :4000, web :3200, fresh databases),
then runs `licensing.mjs` (18 checks): issuing a key in the console, setup with that key,
check-ins, seat limits, term changes and revocation reaching the deployment, OIDC sign-in
(invited, not invited, cancelled, invite link) and "require SSO".

```bash
pnpm --filter @aatmiq/web build && pnpm --filter @aatmiq/license-console build
CHROMIUM_PATH=/path/to/chrome tests/e2e/run-licensing.sh
```

Logs and failure screenshots go to `results-licensing/`.
