# Licensing and the license server

Two parts:

- **License server and Super Admin console:** run by us (Aatmiq), in our cloud. `apps/license-server` (API, port 4100) and `apps/license-console` (Next.js, port 3100). Deployed with `deploy/license/docker-compose.yml`.
- **License client:** built into every customer deployment (`apps/api/src/services/license.ts`, Admin → License).

**Privacy boundary (D4).** The license server never sees customer content. A check-in carries only:
- the license key
- a random installation ID
- the version
- the number of active seats
- token counts per section since the previous check-in
- basic health (workspace count, Node version, uptime)

## License keys

A license key is a JWT signed with **Ed25519** (`EdDSA`, `typ: aatmiq-license+jwt`). Its claims:

| Claim | Meaning |
|---|---|
| `lid`, `cid`, `customer` | License, customer ID and name |
| `tier` | `chat`, `work`, `complete` or `enterprise` (presets for sections, features and workspace limit) |
| `seats` | Active (non-deactivated) people allowed |
| `sections` | `chat`, `work`, `code` |
| `features` | `sso`, `oidc`, `audit_export`, `connectors`, `managed_models` |
| `modelMode` | `self` or `managed` |
| `workspaceLimit` | Number of workspaces, or no limit |
| `branding.accent` | Default accent colour at setup |
| `checkInHours` | Check-in interval (default 24) |
| `iat`, `exp` | Issued and expires |

Deployments verify the key **offline** with Aatmiq's public key (`LICENSE_PUBLIC_KEY`). That means a network outage never breaks sign-in. Signing and verification code is shared in `packages/license`.

Without `LICENSE_PUBLIC_KEY` a deployment runs in **development mode**: no license is needed and every feature is on. Production images set the key.

## What the license controls

| Rule | Where |
|---|---|
| A valid key is needed to finish setup (the setup wizard previews customer, plan, seats and expiry) | `POST /api/setup`, `/api/public/license/preview` |
| **Seats.** Active users plus pending invitations can't exceed `seats`. This applies to invitations, SSO auto-join and reactivating a user. A re-invite replaces the open invitation, so it doesn't use another seat. | `LicenseService.requireSeats` |
| **Workspace limit** (Chat plan: 3, Work: 10) | Creating a workspace |
| **Sections.** Unlicensed sections are hidden in the sidebar, and Chat routes refuse when `chat` isn't licensed. | `/api/me` → `license.sections` |
| **Features.** Google/Microsoft SSO need `sso`; custom OIDC needs `oidc`. | `LicenseService.hasFeature` |

## Status and grace

| State | When | People | Admins |
|---|---|---|---|
| `valid` | Signed, not expired, checked in recently | Work normally | Work normally (renewal notice in the last 30 days) |
| `check_in_overdue` | No check-in for 14 days past the interval | Work | Warning banner |
| `admin_locked` | No check-in for 30 days | Work | Admin changes paused (Admin → License still works) |
| `expiring_grace` | Expired less than 14 days ago | Work, with a banner | Banner with days left |
| `expired` / `revoked` / `missing` / `invalid` | — | **Read-only**: they can sign in and read their history, but changes are refused (`402 license_inactive`) | Can enter a new key |

Enforcement is one `preHandler` hook on every change, so a new route can't forget it. Sign-in, setup, invitations and Admin → License are always open.

## Check-ins

The deployment checks in on start and then hourly whenever a check-in is due. It posts to `POST {LICENSE_SERVER_URL}/v1/check-in` (default `https://license.aatmiq.com`; set it empty for air-gapped installs).

The answer contains:
- `status`: `active` or `revoked`
- the **latest signed key**: when the Super Admin changes seats, plan or expiry, the deployment picks up the new key at its next check-in, with no re-entry needed. A key is accepted only if it verifies and has the same `lid`.
- the **current release** (shown as "Update available" in Admin → License)

The license server flags a key that checks in from two installations (`instanceConflict`). It still answers, so a server migration doesn't break. The Super Admin can **Reset installation**.

## Super Admin console

- **Overview:** customers, active licenses, seats sold and used, quiet deployments (no check-in for 3+ days), a 30-day token chart from check-ins, and a "needs attention" list (expiring soon, over seats, key on 2 servers, silent).
- **Customers:** create and edit customers; issue a license (plan presets, seats, expiry, sections/features overrides, model mode, default accent); *Copy key*; *Change terms* (re-signs the key); *Revoke* / *Restore*; *Reset installation*; recent check-ins.
- **Settings:** the public key as a ready-to-paste `LICENSE_PUBLIC_KEY=…` line, the release channel (latest version, notes, link), and the activity log.

Security:
- Super Admin passwords use scrypt.
- Sessions use an HttpOnly, SameSite=Lax cookie (Secure over https), last 7 days, and are stored hashed.
- Every change must carry the `x-aatmiq-console: 1` header, which cross-site requests can't send without CORS.
- Sign-in is rate-limited, with a lockout after 10 failures in 15 minutes.
- The signing key is generated on first start and stored encrypted with `SERVER_SECRET`. You can supply your own instead with `LICENSE_SIGNING_KEY`. Rotating the key means re-issuing every license.
- The first Super Admin comes from `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` on an empty database.

## Later

- Offline (air-gapped) license files with manual renewal (P4)
- Signing-key rotation with several active keys
- Billing integration
- Managed-model config pushed down with check-ins (`modelMode: managed`)
