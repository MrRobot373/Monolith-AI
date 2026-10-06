# Aatmiq Code

Aatmiq Code is the IDE section of Aatmiq: the full VS Code–style editor (Code-OSS), running on the
organization's own servers and opened inside the Aatmiq window. People get terminals, Git,
debugging and extensions from Open VSX. The **Aatmiq panel** on the right is a coding agent that
works in the open workspace, built on the same engine as Work AI.

## For people

| Where | What |
|---|---|
| **Code** (sidebar) | Your workspaces. **New workspace** starts an empty folder or clones a Git repository (the name is taken from the address). |
| Workspace page | The IDE, full height inside Aatmiq. **Open in new tab** gives it the whole browser window. |
| Terminal | A real shell on the server, as your own user (`you@…`). Commits carry your Aatmiq name and email (change them with `git config` if you like). |
| **Aatmiq panel** | Describe a change. The agent reads the code, edits files and runs commands in this workspace, and asks before anything risky (same rules as Work AI). Steps open their file; **changed files** open a diff against the last commit; **Review** jumps to Source Control. Right-click a selection → **Ask Aatmiq about the selection**. `Ctrl/⌘+Alt+I` opens the panel. |

Workspaces are private: only their owner can open them. Deleting a workspace deletes its folder,
including work that hasn't been pushed.

Private repositories can be cloned over https with a token in the address for now; SSH keys can be
added from the terminal (`~/.ssh`), since each person's home persists.

## For admins

- Code must be in the license (`code` section), and members need **Code** enabled on their
  workspace membership (org admins always can).
- Models used by the Aatmiq panel must be enabled for the **Code** section (Admin → Models) and for
  the workspace. Usage counts against the person's allowance (section `work`, since the panel runs on
  Work AI).
- Approvals, web search and connectors follow **Admin → Work AI**.

## How it works

```
 Browser ── /code/ide/* (HTTP + WebSocket) ──▶ web (Next rewrite) ──▶ API proxy ──unix socket──▶ person's IDE server
   ▲                                                                   │                          (runs as their own user,
   │                                                                   │                           CODE_DIR/<user>, 0700)
   └── Aatmiq panel (in the IDE) ── /api/internal/code (IDE token) ────┘──▶ Work AI runner (agent in the workspace)
```

- **The distribution** (`apps/code`). `pnpm --filter @aatmiq/code build` takes a pinned Code-OSS
  server build (openvscode-server, MIT; version and checksum in `base.json`) and applies a VSCodium-
  style patch set:
  - product rebrand ("Aatmiq Code", data folders, Open VSX gallery, no telemetry), including the copies
    inlined into the bundles
  - workbench defaults (Aatmiq Dark/Light theme, AI chat features off, no walkthrough) passed as
    workbench options, so they apply before any extension and people can still change them
  - webviews served by Aatmiq itself instead of Microsoft's `vscode-cdn.net` (webview endpoint,
    same-origin frame check with its CSP hash recomputed)
  - Aatmiq icons and watermark, built-in `aatmiq-theme` and `aatmiq` (panel) extensions

  Every patch looks for an exact anchor and fails the build if upstream changed, so a version bump
  can't silently ship an unbranded or broken IDE.
- **One IDE server per person**, started on first open and stopped after `CODE_IDLE_MINUTES` without
  open windows (default 30). It listens on a Unix socket inside the person's home (`0700`), runs as
  the person's own Unix user (D25's isolation), and gets a clean environment: PATH, HOME, an
  [nss_wrapper](https://cwrap.org/nss_wrapper.html) identity (so `whoami`, prompts and tools work
  without touching `/etc/passwd`), Git author settings, and the panel's token.
- **The proxy** (`apps/api/src/routes/code-proxy.ts`) sits in front of Fastify, so request bodies and
  WebSocket upgrades pass through untouched. Every request needs an Aatmiq session (cached for 30 s);
  upgrades must come from the same origin; Aatmiq's cookies are removed before forwarding, so
  extensions and terminals never see them. The IDE's own shipped files (`/static/…`, public code) are
  served straight from the build, with long-lived caching.
- **The Aatmiq panel** calls `/api/internal/code` with the IDE's per-person token. Its tasks are Work AI
  tasks with a `code_workspace_id`: the runtime runs in the workspace folder, as the person, with
  commands confined to that folder, Code-section models and a coding brief. They don't appear in the
  Work AI task list, but their approvals do appear in Work AI's inbox and notifications.

## Security notes

- Isolation: each person's IDE, terminals and agent run as their own Unix user; homes are `0700`,
  the code root `0711`, documents and Work AI task folders are out of reach (needs the API to run as
  root, as in the Docker image).
- **Same origin:** the IDE is served from the Aatmiq origin (`/code/ide`). Extension webviews run in
  same-origin frames, so a malicious extension could send requests to Aatmiq as the person
  (cookies are `HttpOnly` and never forwarded to the IDE, but the browser would attach them to
  requests to `/api`). Only install extensions you trust. A separate hostname for the IDE is planned.
- The panel token is in the IDE's environment, so the person's own terminals and extensions can use
  it. It only allows agent tasks in that person's own Code workspaces, and it ends when the IDE stops.

## Running it

**Docker**: the API image builds and includes Aatmiq Code (`/opt/aatmiq-code`), plus `libnss-wrapper`
and `openssh-client`; homes live in the `/data/code` volume. Nothing else to configure.

| Variable | Default | Meaning |
|---|---|---|
| `CODE_DIR` | `/data/code` (`.data/code` in dev) | People's code homes |
| `AATMIQ_CODE_DIST` | `/opt/aatmiq-code` (`apps/code/dist/aatmiq-code` in dev) | The built IDE |
| `CODE_IDLE_MINUTES` | `30` | Stop an IDE after this long without open windows |

**Development**: `pnpm --filter @aatmiq/code build` once (the download is cached in `apps/code/.cache`),
then `pnpm dev` as usual. Without root, IDEs run as your own user.

**Upgrading the IDE**: change `version` and `sha256` in `apps/code/base.json`, build, and run the Code
browser suite. If a patch anchor moved, the build stops and names it.

## Desktop app (next)

The plan (D2/D3) includes a desktop app. The same patch set will drive a Code-OSS desktop build
(Electron) in CI that connects to the organization's server; it isn't part of this release.

## API

People (cookie session): `GET /api/code/status`, `GET/POST /api/code/workspaces`
(`{workspaceId, name, gitUrl?}`), `PATCH/DELETE /api/code/workspaces/:id`,
`POST /api/code/workspaces/:id/open` → `{url}`. The IDE itself: `/code/ide/*`.

IDE only (per-person token): `/api/internal/code/context`, `/tasks`, `/tasks/:id`,
`/tasks/:id/stream`, `/tasks/:id/messages`, `/tasks/:id/cancel`, `/approvals/:id`.

## Tests

- `apps/api/src/code.test.ts`: workspaces, the proxy with and without a session, WebSocket upgrade
  rules, IDE running as the person's user in a private home.
- `tests/e2e/code.mjs` (13 checks, run with `E2E_SCRIPT=tests/e2e/code.mjs tests/e2e/run-work.sh`):
  the IDE inside Aatmiq, terminal identity, the panel creating a file, an approval-gated delete, steps
  opening files, cloning over HTTP, diffs of agent changes, a failed clone, rename/delete, signed-out
  access refused.
