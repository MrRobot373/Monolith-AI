# Work AI

Work AI is the agent section of Aatmiq. A person gives it a goal ("clean up this CSV and chart sales
by region"); the agent plans, runs commands and edits files in a private folder for that task, asks
before anything risky, and leaves the results there to download. Tasks keep running when the browser
is closed, can be continued with follow-ups, and can run on a schedule.

The engine is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, MIT), driven
through our own adapter in `packages/harness` (D1). Nothing in the product depends on DSH internals
beyond that package.

## For people

| Where | What |
|---|---|
| **Work AI** (sidebar) | Describe a task, optionally add files and pick a model. Starter prompts help with common jobs. |
| Task page | The live timeline: your messages, the agent's text as it writes, each step (command, file, search, browser action, connector call) with its input and output, approvals, errors. |
| Progress panel | The agent's plan with items checked off, status, steps, tokens and timing. |
| Files panel | The task folder: preview text and images, download anything, add files for the agent. |
| Approvals | Risky steps stop and wait. Approve or reject inline, from the Work AI home ("Waiting for you"), or from the notification. The sidebar shows a badge while anything waits. |
| **Scheduled** | A prompt on a schedule (weekdays at 9:00, every Monday, monthly, hourly or any cron) in your time zone. Each run is a new task. "Run now" for a test. |
| **Skills** | Reusable instructions ("how we write the weekly report"). The agent reads each skill's description and follows it when it fits. Personal skills are yours; organization skills are shared by admins; the **Library** has 59 built-in skills for software, data, documents and business work ([08-skills.md](08-skills.md)). |
| **Connections** | Your own accounts in apps your admin added (Gmail, Calendar, Canva, GitHub…). Connect once; your tasks then act with your access. |

Stopping a task ends its runtime immediately. Sending another message continues the task: the
conversation so far is handed to a fresh runtime and the files are still in the folder.

Tasks are private to the person who started them. Usage counts against the same token allowance as
Chat (section `work` in usage reports).

## For admins

**Admin → Work AI**

- **Approvals**: *before risky actions* (default), *before every change*, or *never*.
  "Risky" means deleting or moving files, system-level commands (`sudo`, `kill`, `chmod`…),
  `git push`/`reset --hard`, sending mail, and (unless network use is allowed) commands that use the
  network or install packages, plus connector tools that match the connector's rule.
- **Web search**: the URL of your SearXNG server, with a test button. Empty turns web search off.
  Searches go only to that server (D27).
- **Browser** (on by default): the agent can open pages in a real browser, click, type and choose
  options, for sites that need JavaScript, logins or forms. See *Browser* below. **Internal sites it
  may open** lists hosts on your private network it may reach anyway (`intranet.acme.com`,
  `*.wiki.acme.internal`); everything else private is refused.
- **Let commands use the network**: off by default, which makes network commands ask first.
- **Tasks per person at once** (others queue) and **how long a finished task stays warm** for instant follow-ups.
- **Connectors**: apps and MCP servers (streamable HTTP) the agent can use as tools. **Add
  connector** opens a catalog of official remote servers (Gmail, Google Calendar/Drive/Docs/Sheets/
  Slides, Canva, Figma, Notion, Slack, GitHub, Jira & Confluence, Linear, Asana, HubSpot, Stripe and
  ~30 more, in `packages/shared/src/connectors.ts`) or takes any custom server. Three ways to sign in:
  - **Each person signs in** (OAuth 2.1, the MCP authorization spec). People connect their own
    account in **Work AI → Connections**, and tasks act with that person's access only. Where the
    service supports dynamic client registration (Canva, Notion, Linear, Atlassian, Figma, Stripe…)
    there is nothing to set up. Google, Slack, GitHub, HubSpot, Box, Zoom and Asana need an OAuth app
    from the admin: the dialog shows the redirect URI (`<app>/api/connectors/oauth/callback`) and
    the steps. Tokens are stored encrypted per person, refreshed when they expire, and revoked on
    disconnect when the service supports it.
  - **Shared token**: request headers the admin enters (stored encrypted, never shown again).
  - **No sign-in**: open servers (DeepWiki, Microsoft Learn, AWS Knowledge, Hugging Face).

  What to set up at each service, Google verification, and the check against the real services:
  [09-connectors.md](09-connectors.md).

  **Approvals** per connector: *ask before changes* (default; tools named `get_*`, `list_*`,
  `search_*`, `read_*`… run freely), *every action*, *never*, or a custom rule of comma-separated
  patterns (`create_*, delete_*`; `!pattern` never asks). **Test** lists the tools (with the admin's
  own sign-in for OAuth connectors).
- **Models**: mark the ones that accept images (**Images** on Admin → Models; detected
  automatically for Ollama, along with the context length). The agent can then look at pictures and
  screenshots (`read_image`).

Who can use Work AI: it must be in the license (`work` section), the model must be enabled for
the *Work AI* section and for the workspace, and members need Work AI enabled on their workspace
membership (org admins always can).

## Model providers and API keys

Any provider in **Admin → Models** works for Work AI, including hosted ones such as **Ollama Cloud**
(type *Ollama*, base URL `https://ollama.com`). A provider can hold **several API keys**, one per line.
Aatmiq uses the current key and, when the provider answers that it has hit a usage limit or isn't
accepted (HTTP 429, 402, 401, 403), rests that key and moves to the next, for chat, Work AI and Code
alike. A rate limit rests a key for its `Retry-After` time (otherwise 15 minutes), a weekly limit for a
day and a rejected key for 6 hours. The provider card shows how many keys are ready and which rest
and why; **Replace API keys** swaps the list without touching models.

Tested with gpt-oss:120b on Ollama Cloud: multi-step tasks with a plan, Python, files, approvals for
package installs and deletions, and the Aatmiq panel writing and testing code.

## How it works

```
 Browser ──SSE──▶ API (Fastify) ── WorkRunner ──spawn──▶ dsh --profile sdk (one per active task)
                    ▲    │                                 │  runs as the task's own Unix user,
                    │    └─ Postgres: tasks, timeline,      │  in /data/work/<task>/files,
                    │       approvals, skills, schedules    │  commands confined by Landlock/bubblewrap
                    │                                       │
                    └──── /api/internal/work (per-task token) ◀── models · approvals · web search
```

- **One runtime per active task.** `WorkRunner` (apps/api/src/services/work.ts) starts
  `dsh --profile sdk` with a generated Cordis patch (packages/harness/src/dsh/patch.ts) and talks
  JSON-RPC over stdio. The patch routes models to Aatmiq, adds our plugin, mounts MCP connectors and
  skills, and switches off everything that could reach a third-party cloud (DeepSeek accounts and
  search), install plugins, export telemetry, or run in-process code runtimes.
- **Models go through Aatmiq.** The runtime's only model provider is
  `/api/internal/work/llm/v1` (OpenAI-compatible). There we check the license and quota, swap in the
  real model and provider key, stream the response through, meter usage (section `work`) and forward
  the text to the browser as it's written. The runtime never sees provider keys.
  Busy servers ("temporarily overloaded", 5xx) get up to three calm retries before the runtime sees
  an error; a call that hasn't started answering in 150 s, or goes quiet that long mid-answer, is
  cut and retried. A failure the runtime then retries past doesn't fail the task.
- **Our DSH plugin** (packages/harness/dsh-plugin/aatmiq.mjs) adds the approval policy
  (`tools/pre-execute` → *ask*), the approval answerer (a person decides in Aatmiq; long-poll; any
  failure counts as *no*), and the `aatmiq` web search provider. It also smooths over common
  tool-call slips before a tool checks its arguments (`tools/execute`, `dsh-plugin/tooling.mjs`):
  a `sandbox_permissions` that asks for nothing (the call's own mode, or a value that isn't a mode)
  is dropped, while a real request to widen still goes to a person; an empty `path` on `glob`/`grep`
  means the working folder; `todo_write` items get `task`
  (or `title`, `text`…) read as `content`, a missing status as `pending`, and loose statuses
  (`done`, `in-progress`) normalized.
- **The plan stays true.** After 3 steps without a plan update (then every 4), the agent gets a short
  reminder appended to the tool result; it's stripped from what people see. When a turn ends
  normally, steps the agent left open are ticked off, so a finished task never shows "0 of 9".
- **The timeline** is DSH's session events normalized into `work_event` rows (`user`, `assistant`,
  `tool_call`, `tool_result`, `approval`, `plan`, `status`) with a per-task sequence number. The
  browser replays from a sequence number over SSE, so reconnecting never loses or repeats steps.
- **Warm and cold follow-ups.** A finished task keeps its runtime for `idleMinutes`. After that (or
  after Stop or a server restart) a new runtime starts and receives the earlier conversation as
  context. DSH's SDK protocol has no way to reopen a stored session (D26).
- **Queue.** Tasks beyond a person's concurrency limit wait as `queued` and start in order.
  Unfinished tasks are marked failed after a server restart ("send a message to continue").
- **Schedules** are checked every 30 seconds. A due schedule is claimed by moving its next run
  forward in one conditional update, so it runs once even with several API instances.

## Security model

What protects what, and the limits:

| Layer | Protects | Notes |
|---|---|---|
| **Own Unix user per task** (D25) | Tasks can't read other tasks' folders, uploaded documents, or the API's environment | Needs the API to run as root (the Docker image does). Task folders are `0700`, the work root `0755` (DSH reads every parent folder of its home when storing an image; listing it shows only task IDs), document storage `0700`. Uids come from a database sequence (100000+). |
| **Command sandbox** | Commands can only *change* the task folder (and a private `/tmp`) | DSH's Landlock/bubblewrap runner, `workspace-write`. Fails closed: if the kernel offers neither, commands error. `WORK_SANDBOX=off` turns it off on such hosts; the per-task user still applies. |
| **Clean environment** | No database URL, app secret or provider keys reach the runtime | The runtime gets PATH, HOME, its task token and a few locale settings only. |
| **Per-task token** | Internal endpoints (models, approvals, search) only answer a running task | Random 256-bit token, valid while the runtime lives. |
| **Approvals** | A person decides on risky steps | Fails closed: no answer, an error or a stopped task count as *no*. DSH's own approval policy is pinned to *ask* (D28). Requests expire after 24 hours. |
| **Quotas and license** | Spending stays within allowances | Checked on every model call, so a long task stops when the allowance runs out. |

Limits today, to know when deploying:

- **Network**: commands can reach the network the API container can reach (the database still needs
  its password, internal endpoints need a task token). "Ask before network use" is an approval rule,
  not a firewall. Use Docker network policies, or wait for container mode (below), if tasks must be
  cut off from the network.
- **Reads**: a task can read world-readable system files (the OS, the app's code). Secrets are not
  world-readable.
- **Resources**: no per-task CPU or memory limits yet beyond the container's own.
- **Connectors**: the agent runtime never holds connector credentials. Its MCP traffic goes to
  Aatmiq's proxy (`/api/internal/work/mcp/:name`, per-task token), which adds the person's own OAuth
  token (refreshing it) or the shared headers and forwards the request. OAuth connectors are only
  given to tasks of people who connected them.

### Browser

`browser_open`, `browser_click`, `browser_type`, `browser_select`, `browser_back`, `browser_read`
and `browser_screenshot`, registered by the Aatmiq DSH plugin when the browser is on. Each call goes
to `/api/internal/work/browser` with the task token; the browser belongs to the API, never to the
agent.

- **One headless Chromium per task**, run as the task's own Unix user (through `setpriv`), with its
  profile in the task's runtime folder (cookies last for the task) and closed when the task stops or
  after 10 idle minutes. Chromium's own sandbox is off (containers lack user namespaces); the Unix
  user and the egress proxy are the boundary.
- **Pages as text**: the page's text with numbered elements (`[4] button "Sign in"`, `[5] textbox
  "Email" (value: …)`), which the agent uses to click and type. `browser_read` pages through long
  pages; `browser_screenshot` saves a PNG under `screenshots/` (the agent can look at it with
  `read_image` when the model sees images). Downloads land in `downloads/`.
- **Network**: every request goes through an egress proxy in the API that refuses loopback, private,
  link-local (cloud metadata), CGNAT and reserved addresses, including names that resolve to them
  (any private answer refuses), unless the host is listed under *Internal sites it may open*. The
  proxy connects to the address it checked, so DNS rebinding can't swap it. Behind a corporate
  proxy (`HTTPS_PROXY`) public sites go through it; allowed internal hosts are reached directly.
  Only `http`/`https` pages open.
- **Approvals**: reading never asks. A click or Enter that would submit a form is held until the
  agent repeats it with `confirm_submit: true`, which asks the person under *before risky actions*;
  under *before every change* every page action asks; *never* asks nothing.
- The Docker image includes Chromium (about 1 GB more). Elsewhere, set `BROWSER_PATH`; without a
  browser the setting is greyed out and the tools aren't offered.

Planned next (P2.1): **container mode**, with one container per person or task through a launcher
(`packages/harness` already separates the launcher), giving network isolation and resource limits
as in D5.

## Running it

**Docker** (deploy/docker-compose.yml): the API image includes the agent runtime and common tools
(bash, git, curl, jq, Python 3 with pandas, openpyxl and matplotlib). Task folders live in the
`/data/work` volume. For private web search:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile search up -d
# then Admin → Work AI → SearXNG URL: http://searxng:8080 → Test → Save
```

| Variable | Default | Meaning |
|---|---|---|
| `WORK_DIR` | `/data/work` (`.data/work` in dev) | Task folders |
| `WORK_SANDBOX` | `on` | `off` only where the kernel has neither Landlock (Linux 5.13+) nor usable bubblewrap |
| `WORK_ISOLATION` | `auto` | `auto`: per-task Unix user when running as root. `off`: tasks run as the API's user (development only) |
| `WORK_CONTROL_URL` | `http://127.0.0.1:<port>/api/internal/work` | How the runtime reaches the API (only change it for custom launchers) |
| `AATMIQ_DSH_CLI` | `/opt/dsh/…/bin.js` in the image | The agent runtime's CLI. The image installs DeepSeek Harness at `/opt/dsh` from `deploy/dsh/package-lock.json` (npm, so its plugins' peer packages are included); in development it comes from `packages/harness`' dev dependency. Keep both versions in step. |

**Development**: `pnpm dev` runs tasks as your own user unless you run the API as root. The fake model
in `tests/e2e/fake-llm.mjs` has an agent mode (`run: …`, `write path: …`, `search: …`,
`use <tool> {json}`, and `demo: …` for a multi-step job with a plan) plus a fake SearXNG
(`/searx`) and MCP server (`/mcp`).

## API

People (cookie session):

| Method | Path | |
|---|---|---|
| GET | `/api/work/info?workspaceId=` | What's on (web search, approval mode, limits) |
| GET/POST | `/api/work/tasks` | List (`workspaceId`, `q`) / start `{workspaceId, prompt, modelId?, projectId?, start?}`. `start: false` creates the task so files can be added first |
| GET/PATCH/DELETE | `/api/work/tasks/:id` | Task + timeline / rename, pin / delete (folder too) |
| GET | `/api/work/tasks/:id/stream?after=` | SSE: `event` (stored), `delta` (live text), `files`, `ready` |
| POST | `/api/work/tasks/:id/messages` | Follow-up `{prompt}` |
| POST | `/api/work/tasks/:id/cancel` | Stop |
| GET/POST | `/api/work/tasks/:id/files` | List / upload (multipart) |
| GET | `/api/work/tasks/:id/files/content?path=&download=1` | Preview or download (HTML/SVG served as text) |
| GET | `/api/work/approvals` · POST `/api/work/approvals/:id` | Pending approvals · `{decision: approve\|reject}` (audited) |
| GET/POST/PATCH/DELETE | `/api/work/skills[/:id]` | Skills (org skills need `org.work.manage`) |
| GET/POST/PATCH/DELETE | `/api/work/schedules[/:id]` · POST `/:id/run` · GET `/preview` | Schedules |

Admins (`org.work.manage`): `GET/PUT /api/admin/work`, `POST /api/admin/work/test-search`,
`GET/POST/PATCH/DELETE /api/admin/connectors[/:id]`, `POST /api/admin/connectors/:id/test`,
`GET /api/admin/connectors/catalog`.

People: `GET /api/connectors`, `POST /api/connectors/:id/connect` → `{url}`,
`DELETE /api/connectors/:id/connection`, `GET /api/connectors/oauth/callback`; public
`GET /api/connectors/oauth/client.json` (client metadata document).

Runtime only (task token): `/api/internal/work/llm/v1/chat/completions`, `/approvals`,
`/approvals/:id?wait=`, `/search`, `/mcp/:name` (MCP proxy).

## Tests

- `packages/harness`: the real DSH runtime against a fake control server (commands, approvals,
  rejection keeps files, confinement, per-task user, web search, browser tools and their approvals).
- `apps/api/src/browser.test.ts`: real Chromium against a local site (page views, held form
  submissions, JavaScript pages, long pages, downloads, screenshots, the private-network rules, the
  corporate proxy, running as the task's user from a deep folder).
- `apps/api/src/work.test.ts`: the whole flow through the API with the real runtime: metering,
  follow-ups, approvals, SSE, restart from history, skills, MCP connector with approval, schedules,
  isolation, cancel.
- `tests/e2e/run-work.sh`: 27 browser checks (task timeline, plan, files, approvals, search, the
  agent's browser on an internal site before and after the admin allows it, uploads, stop and
  continue, isolation, skills, schedules, connectors, light theme, phone layout).
  `API_IMAGE=<tag>` runs the same checks against the API's Docker image.
