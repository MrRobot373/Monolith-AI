# Connectors: setup and verification

Connectors let Work AI use people's apps (Gmail, Google Calendar, GitHub, Slack, Notion…) through
their official remote MCP servers. How they work inside Aatmiq (catalog, per-person sign-in,
the proxy that keeps tokens away from the agent, approvals) is in [06-work-ai.md](06-work-ai.md).
This page covers what an admin sets up at each service, and what has been checked against the
real services.

## Three kinds of sign-in

| Kind | Examples | What the admin does |
|---|---|---|
| **Automatic** (OAuth, Aatmiq registers itself) | Notion, Canva, Linear, Atlassian, Figma, GitLab, Stripe… (30) | Nothing. Add it from the catalog; each person clicks **Connect**. |
| **Admin's OAuth app** | Gmail, Google Calendar/Drive/Docs/Sheets/Slides, Slack, GitHub, Box, Zoom, Asana, HubSpot (12) | Create an OAuth app at the service once, with Aatmiq's redirect URI, and paste its client ID and secret. |
| **Shared token** or **open** | GitHub (token); DeepWiki, Microsoft Learn, AWS Knowledge, Hugging Face (open) | Paste a token, or nothing. |

The **redirect URI** for every OAuth app is `APP_URL/api/connectors/oauth/callback`, for example
`https://ai.acme.com/api/connectors/oauth/callback`. The add-connector dialog shows it with a copy
button. `APP_URL` must be the address people actually use, over HTTPS.

## Setting up the admin's OAuth apps

**Google (Gmail, Calendar, Drive, Docs, Sheets, Slides).** One OAuth client works for all six.
1. In Google Cloud, create a project. For each product you want, enable its API and its MCP API
   (for example `gmail.googleapis.com` and `gmailmcp.googleapis.com`).
2. Configure the OAuth consent screen (Google Auth Platform → Branding/Audience):
   - **Internal** if everyone who will connect is in your own Google Workspace. Internal apps
     need **no Google verification** and have no user cap. This is the right choice for most
     organizations.
   - **External** only if people outside your Workspace (or personal @gmail.com accounts) must
     connect. See "Google verification" below.
3. Create an OAuth client of type **Web application** with the redirect URI above.
4. In Aatmiq, add Gmail (and the others) from the catalog and paste the client ID and secret.

**Slack.** At api.slack.com/apps, create an app in your workspace, add the redirect URI under
*OAuth & Permissions*, and turn on its MCP access (Slack's MCP server docs). Paste the client ID
and secret.

**GitHub.** Settings → Developer settings → OAuth Apps → New OAuth App. Use the redirect URI as
the *Authorization callback URL*. Paste the client ID and a client secret. (For a shared bot
account instead, use **GitHub (token)** with a fine-grained personal access token.)

**GitLab** (automatic, nothing to register). A GitLab admin allows MCP access first: on GitLab.com
for the top-level group (*Settings → General → Permissions*), on your own GitLab for the instance
(*Admin → Settings → General → Visibility and access controls*). For your own GitLab (18.6 or
later), change the server URL to `https://<your GitLab>/api/v4/mcp` when adding it; it must be
reachable from the Aatmiq server.

**Box, Zoom, Asana, HubSpot.** Create an OAuth app in the service's developer console (Box
Developer Console; Zoom App Marketplace, *General app*; Asana developer console; HubSpot,
*Development → MCP Auth Apps*) with the redirect URI, then paste the client ID and secret.

## Google verification

Because Aatmiq is self-hosted, **each organization uses its own Google OAuth app**; there is no
shared Aatmiq app for Google to verify.

- **Internal** consent screen (Workspace organizations): no verification, no security assessment,
  no 100-user cap. Use this whenever you can.
- **External**, publishing status *Testing*: works for up to 100 listed test users, but Google
  shows an "unverified app" warning and **sign-ins expire after 7 days**, so people must
  reconnect weekly. Fine for a trial, not for daily use.
- **External**, *In production*: Gmail scopes (`gmail.readonly`, `gmail.compose`) and
  `drive.readonly` are **restricted** scopes. Google requires app verification **and** a yearly
  third-party security assessment (CASA) before outside users can connect. Calendar, Docs, Sheets
  and Slides scopes are *sensitive*: verification, but no security assessment. Plan weeks for this.
  To lower the bar, connect only the products you need, and prefer `drive.file` over
  `drive.readonly`.

## Checked against the real services

`tests/connectors/check.mts` runs Aatmiq's own connector code against every catalog entry:

- **Open servers:** connect, list tools and call one read-only tool.
- **OAuth servers:** the discovery Aatmiq runs when an admin adds the connector (protected-resource
  metadata, then authorization-server metadata), and whether a client can be obtained: a
  registration endpoint (or client metadata documents) for *automatic* entries, the expected sign-in
  server (Google, Slack, GitHub…) for *admin* entries.
- **Token servers:** that they refuse requests without a token.

It never registers clients or signs anyone in, so it creates nothing at the services. Run it with:

```bash
cd apps/api && NODE_USE_ENV_PROXY=1 npx tsx ../../tests/connectors/check.mts
```

**Result on 2026-10-07: 44/44 passed.** GitLab was added later the same day and passes (signs in
at gitlab.com, registers itself). On that rerun, Netlify's MCP host reset connections from our test
machine while netlify.com itself answered; the entry is unchanged.

| | Result |
|---|---|
| Open (4) | DeepWiki, Microsoft Learn, AWS Knowledge, Hugging Face: connected, tools listed, a real tool call answered |
| Automatic sign-in (30) | All publish OAuth metadata and accept self-registration (dynamic client registration) |
| Admin's OAuth app (12) | All six Google connectors sign in at accounts.google.com; Slack, GitHub, Box, Zoom, Asana and HubSpot at their own sign-in servers |
| Token (1) | GitHub refuses requests without a token (401), as expected |

What the check can't do is the last step: a person signing in with a real account and the agent
using the tools with that account. That needs real accounts (and, for admin entries, the
organization's own OAuth app), so do it once per service you turn on:

1. Admin → Work AI → **Add connector** → pick it from the catalog (paste the OAuth app for admin
   entries). **Test** should list the tools.
2. Work AI → **Connections** → **Connect** → sign in at the service → you return with
   "Connected".
3. Start a task that reads something ("List my next 3 calendar events", "Summarize my latest
   unread email") and one that changes something; the change should ask for approval first.
4. Disconnect, and check the service's "connected apps" page shows Aatmiq's access removed.

The same flow runs end to end in the automated tests against a fake OAuth MCP server
(`apps/api/src/work.test.ts`, `tests/e2e/work.mjs`): discovery, registration, PKCE, token
exchange, refresh, proxying with the person's token, and disconnect with revocation.
