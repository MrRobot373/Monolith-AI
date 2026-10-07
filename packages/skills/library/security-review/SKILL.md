---
name: security-review
description: "Use when checking code for security problems: OWASP issues, injection, access control, secrets in code, dependencies. Has a secret scanner."
category: Software development
---

# Security review

Defensive review of code you were asked to check. Report real, reachable issues with evidence.

## 1. Map the attack surface

- Entry points: HTTP routes, form handlers, file uploads, webhooks, CLI args, message consumers.
- Trust boundaries: what comes from users/third parties vs. what the server controls.
- Sensitive assets: credentials, personal data, payments, admin actions, files.

```bash
grep -rnE "(app|router)\.(get|post|put|patch|delete)\(" --include=*.{js,ts} .
grep -rnE "@(app|router)\.(get|post|put|patch|delete)|def (get|post)\(" --include=*.py .
```

## 2. Find secrets

Run `bash scripts/find_secrets.sh <folder>` (this skill's folder). It greps for keys, tokens,
passwords and private keys, skipping dependencies. Check `.env` files are git-ignored
(`git check-ignore .env`) and not in history (`git log --all --oneline -- .env`). Report found
secrets by file and line with the value masked; recommend rotating them.

## 3. Checklist (OWASP-aligned)

| Area | Look for |
|---|---|
| Access control | Every route that reads/changes a record checks the caller may access *that* record (IDOR); admin routes check roles server-side; no trust in client-sent user ids/roles |
| Injection | SQL built with string concatenation/f-strings; shell commands with user input (`exec`, `subprocess(shell=True)`, `child_process.exec`); template rendering of user input; NoSQL operators from JSON bodies; path traversal (`../`) in file paths |
| XSS | `dangerouslySetInnerHTML`, `v-html`, `innerHTML`, `|safe`, unescaped template output; missing Content-Security-Policy |
| SSRF | Server fetching user-supplied URLs without an allowlist / private-IP block |
| Authentication | Passwords hashed with bcrypt/argon2/scrypt (not md5/sha1/plain); rate limiting on login; secure session cookies (`HttpOnly`, `Secure`, `SameSite`); session invalidation on logout/password change; MFA where needed |
| Crypto | Hard-coded keys; `Math.random()`/`random` for tokens (use `crypto.randomBytes`/`secrets`); ECB mode; disabled TLS verification |
| CSRF | Cookie-authenticated state-changing requests without SameSite/CSRF token/origin check |
| Data exposure | Responses returning whole DB rows (password hashes, tokens); verbose errors/stack traces to clients; logs with secrets or personal data |
| Uploads | No size/type limits; files served from the app origin with user-controlled names; executing uploaded content |
| Dependencies | Known-vulnerable versions: `npm audit --omit=dev`, `pip-audit` (if installable); unpinned versions |
| Config | Debug mode in production, permissive CORS (`*` with credentials), default credentials, open admin panels |

## 4. Confirm before reporting

Trace the data flow from the entry point to the dangerous sink and show the path. If exploitation
needs conditions you couldn't verify, say "possible" and what would confirm it. Don't run attacks
against live systems; confine checks to the code and local test instances.

## 5. Report

```
[High] Broken access control — routes/invoices.ts:58
GET /invoices/:id loads the invoice by id without checking org_id, so any signed-in user can read
any organization's invoices by changing the id.
Fix: query by (id, org_id = req.user.orgId) and return 404 otherwise. Add a test for cross-org access.
```

Severity: **Critical** (remote compromise, mass data exposure), **High**, **Medium**, **Low**,
**Info**. Order by severity; give each a concrete fix.

## Done when

Entry points were mapped, secrets were scanned, each checklist area was checked, findings are
evidenced and prioritized with fixes, and you listed what was out of scope or unverified.
