# Browser end-to-end suite

109 checks that drive the real app in Chromium: setup, chat, projects, message versions,
temporary chats, documents (Excel, OCR), export, models, workspaces, invites, roles, quotas
and token requests, workspace admins, user management, settings, audit, usage, sign-in
flows and mobile layout.

Run against a **fresh** install (empty database) with `ALLOW_MOCK_PROVIDER=true`:

```bash
cd tests/e2e && npm install
node fake-llm.mjs &                     # fake Ollama/OpenAI-compatible server on :11500
CHROMIUM_PATH=/path/to/chrome node full.mjs   # BASE_URL defaults to http://localhost:3000
```

Each step reports PASS/FAIL; failures save a screenshot to `results/`.

## Work AI

`run-work.sh` starts the fake model (which also plays SearXNG and an MCP server) on :11500, a fresh
API on :4000 and the built web app on :3300, then runs `work.mjs` (20 checks) against the real agent
runtime: a multi-step task with a plan and files, approvals (reject, approve from the inbox), web
search, uploads, stop and continue, isolation (own Unix user, no writes outside the folder), skills,
schedules, connectors, light theme and phone layout.

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

`account.mjs` (16 checks) runs on the same stack. It starts its own test mail server and points
Aatmiq at it from Admin → Settings → Email, then checks: a test email, emailed invitations,
forgot password with the emailed link (once only), setting up two-step sign-in (QR, wrong and right
codes, backup codes), signing in with a code and with a backup code, the admin turning it off,
admin reset links and changing the password (also at phone width), confirming an email address
from the banner (and a broken link), and requiring two-step sign-in: the admin must have it first,
then a person without it only gets the setup page (also at phone width) until it's on. Screenshots go to
`results-account/`.

```bash
E2E_SCRIPT=$PWD/tests/e2e/account.mjs tests/e2e/run-work.sh
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
