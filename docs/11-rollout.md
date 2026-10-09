# Rollout: three phases, then a product

The plan for taking Aatmiq from the first server to 25 people, and from there to something we
sell. Each phase ends at a **gate**: a short list that has to be true before the next one starts.
Dates assume the server is ready in week 0; move them, not the gates.

| Phase | Who | Weeks | Ends with |
|---|---|---|---|
| 0. The server | You | 0 | Admin → Health all green on the real GPU |
| 1. Daily use | You + 3 | 1–2 | The demo for the boss |
| 2. Testing | IT team (10) | 3–6 | No open serious issue; drills done |
| 3. Everyone | Office staff (+15) | 7–10 | Two calm weeks with all 25 |
| 4. Product | Us | 9–12 | The readiness checklist below |

## Phase 0: the server (week 0)

On the A6000 server (48 GB GPU, 500 GB disk), following [10-team-server.md](10-team-server.md):

1. Ubuntu 24.04, the NVIDIA driver **580 or newer** (CUDA 13: EmbeddingGemma 2 on Ollama needs it;
   with an older driver set `EMBEDDING_MODEL=embeddinggemma`), Docker and the NVIDIA Container
   Toolkit.
2. `cp deploy/.env.example deploy/.env`, then set `DOMAIN`, `APP_URL`, `APP_SECRET`,
   `POSTGRES_PASSWORD`, `CADDY_TLS` (your company certificate, or `internal`), `BACKUP_DIR` on
   **another disk or a network share**, and `SMTP_URL`/`MAIL_FROM` (alerts and password resets).
   Keep a copy of `.env` somewhere safe: `APP_SECRET` is needed to read stored keys after a restore.
3. `deploy/team.sh up -d --build`. The first start downloads about 35 GB of models;
   `deploy/team.sh logs -f vllm vllm-small embeddings` shows progress.
4. Create the owner account, then **Admin → Health**: every area should be green except *Backups*
   (none yet). Make one: `deploy/team.sh exec backup /scripts/backup.sh`, and check Health again.
5. Restore drill, once, on a copy: the steps in [10-team-server.md#backups](10-team-server.md#backups).

**What we haven't been able to test ourselves** and you check here: vLLM loading both models in
their memory shares on the real A6000, EmbeddingGemma 2 on the GPU, and speed with real models
(`tests/load/run-team.sh` against the real stack, 4 people at first). If vLLM runs out of memory,
lower `VLLM_GPU_MEMORY` to 0.65 or `VLLM_MAX_MODEL_LEN` to 49152.

**Gate:** Health green (backups included); a chat answer, a document search with sources and a
Work AI task (a Word report) work end to end on the real models; the restore drill worked.

## Phase 1: you and three colleagues (weeks 1–2)

Use it for real work every day, and write down every rough edge (a shared document is enough: what
you did, what happened, what you expected).

- Invite the three (Admin → Users → **Invite several**). One workspace is fine.
- Defaults are right for now: approvals *before risky actions*, 8 tasks at once, 2 per person.
- Each day, try at least one of: a chat about a company document (check the sources), a project
  with its files and instructions, a Work AI task that produces a file (Word, Excel, a chart), a
  scheduled task, and for whoever codes, Aatmiq Code with the agent panel.
- Watch **Admin → Health** and **Usage** once a day; Health emails you when something breaks.

**The demo (15 minutes)**, rehearsed twice on the real server:

1. *Private by design*: everything runs on our server; no document or prompt leaves it.
2. *Chat with documents*: upload a real policy PDF, ask a question, open a numbered source.
3. *Projects*: a project with sources and instructions; a teammate's shared chat and Work AI task
   show up in its memory.
4. *Work AI*: "From these two sales sheets, make a Word report with a chart and a summary
   table." Show the plan, the approval it asks for, the timeline, and download the file. Then
   "save it to Documents" and find it by asking a question in Chat.
5. *Code*: open a repository in Aatmiq Code and ask the panel for a small fix; review the diff.
6. *Admin*: users and groups with token budgets, usage, the audit log, Health.

**Gate to the demo:** five working days without a red check in Health; each demo step done three
times in a row on the real models; no lost work; the four of you would keep using it.

## Phase 2: the IT team, 10 people (weeks 3–6)

Their job is to break it. Give them this list and a place to report.

- **Accounts:** require two-step sign-in with a week's grace (Admin → Authentication). If the
  company uses Microsoft 365 or Google Workspace, add single sign-on (Enterprise license).
- **Security:** try to reach another person's chats, documents, tasks or projects (by link or
  id); from a Work AI task or an IDE terminal, try to reach the database, the model servers or
  the office network (it should fail: [10-team-server.md#security](10-team-server.md#security));
  try the agent with a prompt that tells it to do something harmful and check what it asks before
  doing. Automated versions of these run on every push (`authz.test.ts`, `tools.test.ts`,
  `run-firewall.sh`).
- **Load:** everyone at once at a fixed time (say 10:00): chats, a few agent tasks each, editors
  open. Note answer speed and how long tasks wait (Health shows waiting tasks).
- **Drills:** restore a backup onto a spare machine; update the server
  (`git pull && deploy/team.sh up -d --build`) and check nothing was lost; stop the model server
  and check the Health email arrives, then the "fixed" one.
- If an internal Git server must be reachable from the IDE: `USER_ALLOWED_NETWORKS`.

**Gate:** no open issue marked serious; the load hour felt fine (chat starts answering within 2
seconds, tasks wait under 5 minutes); both drills done; alerts reached the admins.

## Phase 3: office staff, 15 more (weeks 7–10)

For people who don't think about software. What makes this phase go well is preparation:

- **Structure:** a workspace per team (or one for all), groups per department with a monthly token
  budget, Work AI for those who need it, Code for IT only (Admin → Workspaces → members' sections).
- **Ready-made help:** organization skills for the office's recurring jobs ("our letter format",
  "monthly expense summary", "meeting minutes"), a few projects with the documents people ask
  about most (policies, price lists, templates), and the starter prompts.
- **Training:** one 30-minute session (chat, documents, projects, a Work AI task, where approvals
  show up) and a one-page guide. Office hours twice a week for the first two weeks.
- Invite in two batches a week apart, so feedback from the first shapes the second.

**Gate:** two weeks with all 25 without a red check; a short survey (would you miss it?) mostly
yes; the capacity numbers from phase 2 still hold with 25.

## Phase 4: ready to sell (weeks 9–12)

What we have, and what's left before a customer pays for it.

### Done (and tested on every push)

| Area | What |
|---|---|
| Chat | Streaming answers, model choice, versions, temporary chats, export, documents with numbered sources |
| Documents | PDF, Word, Excel, images (OCR), text; keyword + meaning search (EmbeddingGemma 2); Confirmed/Assumption/TBD labels |
| Projects | Instructions, sources, memory over chats and Work AI tasks, sharing with roles |
| Work AI | 29 tools (files, shell, web, browser, documents, skills, helpers, background jobs, connected apps), approvals, plans, schedules, 59 built-in skills, 45 app connectors |
| Code | Code-OSS in the browser per person, agent panel with diffs, desktop app (Windows, macOS, Linux) |
| Admin | Users, invitations in bulk, groups, budgets, token requests, usage, audit log, Health with email alerts |
| Accounts | Passwords, two-step sign-in (with a grace period), single sign-on, email, signed-in devices |
| Operations | One-command team install, HTTPS, nightly backups with a recorded status, restore, licensing |
| Isolation | Each task and IDE as its own user, tasks in containers, a firewall from private networks, an egress proxy |
| Quality | 180 API tests, 24 runtime tests, 115 + 31 + 18 + 14 browser checks, an authorization sweep of every route, a 25-person load test; CI on every push builds the images and runs them |

### Before the first sale

| # | Item | Why |
|---|---|---|
| 1 | Validate on the real GPU (phase 0) and write the measured capacity into [10-team-server.md](10-team-server.md#capacity) | Our sizing numbers are calculated, not measured |
| 2 | An independent security assessment (a penetration test of the server and the agent), and fixing what it finds | Customers will ask; we've done an internal review only |
| 3 | Signed desktop apps: a Windows code-signing certificate and an Apple Developer ID (notarization); add them as CI secrets | Unsigned installers trigger warnings |
| 4 | Versioned releases: tag `v1.0.0`, images pushed to a registry, a changelog, and an upgrade test from each released version | Customers update in place |
| 5 | An offline install bundle: the images and the models in one download | Many on-premises customers have no internet on the server |
| 6 | Personal data: export everything about one person, and erase a person with their data | Privacy law (India's DPDP Act, GDPR) and customer contracts |
| 7 | Legal: the license agreement (EULA), privacy notice, a data-processing addendum template, and the list of open-source licenses and model licenses we ship | Required to sell |
| 8 | Customer documentation: a short user guide, an admin guide (from these docs), a hardware sizing table | So customers install without us |
| 9 | Support: where customers report issues, response times per plan, which versions we support | Part of what they buy |
| 10 | Pricing and plans set up in the license server ([pricing-and-business.md](pricing-and-business.md)) | So orders turn into license keys |

### Nice to have

Nightly CI runs of the slow suites (the IDE build, container mode, the HTTPS stack), an
accessibility pass (keyboard and screen readers), more interface languages (Hindi first), SAML
single sign-on.

## Risks

| Risk | Sign | What we do |
|---|---|---|
| The GPU is slower than calculated | Answers take long in the load hour | Lower *Tasks working at once*; use the small model for quick chats; a second GPU later |
| Disk fills (task folders, editors, documents) | Health warns at 15% free | Ask people to delete old tasks; move backups off the server; a bigger disk |
| A model update breaks tool calling | Work AI tasks fail after an update | Pin model versions (we do); update on a test machine first |
| People paste sensitive data before the security assessment | — | Say so in phase 3 training: no customer personal data or passwords yet |
| One server is a single point of failure | Server down | Nightly backups off the machine; a written restore procedure; a spare machine identified |
