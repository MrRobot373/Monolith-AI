# A team on one GPU server

How to run Aatmiq for a team of about 25 people on one server with one 48 GB NVIDIA GPU (RTX A6000,
RTX 6000 Ada, L40S): the models, HTTPS and nightly backups, with one command.

## What you need

| | Minimum | Recommended |
|---|---|---|
| GPU | one NVIDIA GPU with 48 GB | the same |
| CPU | 8 cores | 16 cores |
| Memory (system RAM, not the GPU's) | 32 GB | 64 GB if many people keep the Code editor open |
| Disk | 300 GB SSD | 500 GB SSD, plus another disk or a network share for backups |
| System | Ubuntu 22.04 or 24.04 with the NVIDIA driver, Docker Engine with Compose, and the NVIDIA Container Toolkit | |
| Address | a name for the server in your network (`aatmiq.yourcompany.lan`) or a public domain | |

Memory adds up as (measured, see *Capacity*): about 2 GB for Aatmiq and its database, about
350 MB for each person with the Code editor open, about 150 MB for each agent task kept ready (plus
whatever its commands use), and the operating system. 25 people with the editor open and 16 tasks
ready come to about 13 GB. Check yours with `free -h` and `nproc`.

## What runs

```
 people ──https──▶ caddy ──▶ web ──▶ api ──▶ vllm         main model, 68% of the GPU
                                      │  ├─▶ vllm-small   small model, 19% of the GPU
                                      │  └─▶ embeddings   EmbeddingGemma 2 on Ollama, about 1 GB
                                      └─▶ postgres ◀── backup (every night, to BACKUP_DIR)
```

All of it starts with `deploy/team.sh up -d --build`, which combines `docker-compose.yml` with
`docker-compose.gpu.yml` (the models), `docker-compose.https.yml` (Caddy),
`docker-compose.backup.yml` (backups) and `docker-compose.containers.yml` (each Work AI task in its
own container; see [Security](#security)).

## The models

| | Main model | Small model |
|---|---|---|
| Model | Qwen3.6-35B-A3B, 4-bit (`QuantTrio/Qwen3.6-35B-A3B-AWQ`) | Gemma 4 E2B, Google's 4-bit build (`google/gemma-4-E2B-it-qat-w4a16-ct`) |
| License | Apache-2.0 | Apache-2.0 |
| Download | 25 GB | 8 GB |
| GPU share | 68% (`VLLM_GPU_MEMORY`) | 19% (`VLLM_SMALL_GPU_MEMORY`) |
| Used for | Chat, Work AI, Code (the default) | Chat, for quick jobs (people pick "Gemma 4 E2B (fast)") |
| Longest conversation | 65,536 tokens | 32,768 tokens |
| Reads images | yes | not set up |

Why these fit one GPU:

- Qwen3.6-35B-A3B is a *mixture of experts*: about 3B of its 35B parameters work for each token,
  so it writes about as fast as a 3B model while answering like a much bigger one.
- Only 10 of its 40 layers keep a growing memory of the conversation (the rest use linear
  attention with a fixed-size state). A token of conversation costs about 20 KB of GPU memory,
  against 96 KB for Qwen3-30B-A3B, so the 68% share leaves room for several hundred thousand tokens
  shared by everyone working at that moment.
- Gemma 4 E2B shares most of its attention memory between layers, so it needs little beyond its
  8 GB of weights.

**Thinking** is off by default: answers start sooner and the GPU serves more people. To turn it on
for every request, set `VLLM_THINKING=true` (slower; better on hard multi-step problems) together
with Qwen's sampling for thinking: `VLLM_TEMPERATURE=1.0`, `VLLM_TOP_P=0.95`,
`VLLM_PRESENCE_PENALTY=0`. Without thinking the defaults are Qwen's recommended 0.7, 0.8 and 1.5.

**Small models and the GPU.** On this GPU the main model is already fast, because so little of it
works per token. What the small model brings is a second, separate queue for quick questions
(rewording, translating, short answers) that never waits behind long agent tasks. It isn't meant
for Work AI or Code: models this size are unreliable with tools. Options:

- **Gemma 4 E4B instead** (better answers, 11.5 GB): `VLLM_SMALL_MODEL=google/gemma-4-E4B-it-qat-w4a16-ct`,
  `VLLM_SMALL_MODEL_NAME=gemma-4-e4b`, `VLLM_SMALL_MODEL_DISPLAY_NAME="Gemma 4 E4B (fast)"`,
  `VLLM_SMALL_GPU_MEMORY=0.25`, `VLLM_GPU_MEMORY=0.62`.
- **No small model** (more room for the main one): `VLLM_SMALL_URL=` (empty) and
  `VLLM_GPU_MEMORY=0.87`.
- **Another main model**: `VLLM_MODEL`, `VLLM_MODEL_NAME`, `VLLM_MODEL_DISPLAY_NAME` and, if it
  writes tool calls differently, `VLLM_TOOL_PARSER` and `VLLM_REASONING_PARSER` (see vLLM's docs).

### Documents and embeddings

Search in documents (chat attachments, project sources) uses keywords and, with an embedding
model, meaning: a question finds the passage that answers it even in other words. The embedding
model here is **EmbeddingGemma 2** (Google, Apache-2.0), its text part (`embeddinggemma-2:270m`,
378 MB) on Ollama:

- It's trained with short task instructions, which Aatmiq adds: `task: search result | query: …`
  before questions and `title: <document name> | text: …` before passages (Admin → Models → *Task
  prefixes*, filled in automatically for EmbeddingGemma).
- Ollama runs EmbeddingGemma 2 with its MLX engine on the GPU. That needs an NVIDIA driver with
  **CUDA 13** (driver 580 or newer; `nvidia-smi` shows *CUDA Version: 13.x*). It takes about 1 GB
  of GPU memory, which is why the two chat models leave some room.
- On an older driver, or to keep it off the GPU, use EmbeddingGemma 1 instead, which Ollama runs
  on the CPU too: `EMBEDDING_MODEL=embeddinggemma`, `EMBEDDING_MODEL_DISPLAY_NAME="EmbeddingGemma"`.
- Changing the workspace's embedding model (Admin → Models, per workspace) indexes its documents
  again in the background; until then they're still found by keywords.
- Check it works: `deploy/team.sh exec api curl -s http://embeddings:11434/api/embed -d
  '{"model":"embeddinggemma-2:270m","input":"hello"}' | head -c 120` prints numbers.

Models are registered in Aatmiq at first setup. After that, change them in **Admin → Models**.

## Install

1. **The GPU in Docker.** Install the NVIDIA driver and the NVIDIA Container Toolkit, then check
   that containers see the GPU:
   ```bash
   nvidia-smi
   docker run --rm --gpus all ubuntu nvidia-smi
   ```
2. **Get Aatmiq and configure it.**
   ```bash
   git clone <your Aatmiq repository> aatmiq && cd aatmiq
   cp deploy/.env.example deploy/.env
   ```
   In `deploy/.env` set at least:
   ```bash
   APP_URL=https://aatmiq.yourcompany.lan     # the address people open
   DOMAIN=aatmiq.yourcompany.lan              # the same host
   APP_SECRET=...                             # openssl rand -hex 32
   POSTGRES_PASSWORD=...                      # openssl rand -hex 16
   CADDY_TLS=internal                         # or your email (Let's Encrypt), or certificate files
   BACKUP_DIR=/mnt/backup/aatmiq              # another disk or a network share
   TZ=Asia/Kolkata                            # your time zone, for the backup time
   ```
   Keep a copy of this file somewhere safe: `APP_SECRET` is needed to read stored keys and tokens,
   also after restoring a backup.
3. **Start.**
   ```bash
   deploy/team.sh up -d --build
   deploy/team.sh logs -f vllm vllm-small embeddings   # the first start downloads about 34 GB
   ```
   Aatmiq itself is up in a minute or two. The models are ready when their logs say the server
   started, and `deploy/team.sh ps` shows both as *healthy* (the small one starts after the main).
4. **Set up.** Open `https://aatmiq.yourcompany.lan`, create the owner account, and the models are
   already there. Then in **Admin**:
   - **Settings → Email**: an SMTP server, so invitations and password resets are emailed.
   - **Users → Invite people → Invite several people at once**: paste the team's addresses.
     Each gets a link (emailed, or copy them all at once).
   - **Single sign-on** if the team signs in with Google or Microsoft (see
     [04-single-sign-on.md](04-single-sign-on.md)).
   - **Workspaces → members**: turn on Work AI and Code for the people who need them.
   - **Usage**: token budgets per person or group, if you want them.

### Certificates (`CADDY_TLS`)

- `internal`: Caddy makes its own certificates. Install its root certificate on the team's
  computers once, or browsers warn:
  ```bash
  deploy/team.sh exec caddy cat /data/caddy/pki/authorities/local/root.crt > aatmiq-root.crt
  ```
  Windows: double-click → Install Certificate → Local Machine → Trusted Root Certification
  Authorities. macOS: open it in Keychain Access → System → Always Trust. Ubuntu: copy it to
  `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`.
- an email address: Let's Encrypt, when the name is in public DNS and ports 80 and 443 reach the
  server.
- `/certs/fullchain.pem /certs/key.pem`: your company's certificate, copied into
  `deploy/caddy/certs/`.

## Settings for 25 people

| Setting | Where | Default here | Why |
|---|---|---|---|
| Tasks working at once (organization) | Admin → Work AI | 8 | Agent tasks the GPU works on at once; more wait in line, oldest first. Tasks waiting for someone's approval don't count. |
| Tasks per person at once | Admin → Work AI | 2 | Nobody fills the line alone. |
| Requests the model answers at once | `VLLM_MAX_SEQS` | 32 | Chats and agent steps together; more wait inside vLLM. |
| Keep a finished task ready | Admin → Work AI | 15 min | Instant follow-ups. Idle tasks beyond twice the limit are stopped (they restart from history). |
| Editor closes when unused | `CODE_IDLE_MINUTES` | 30 | Frees the editor's memory. |

If answers get slow when everyone is busy, lower *Tasks working at once* (6) before anything else;
if the GPU is often idle while tasks wait, raise it (10–12).

## Security

What keeps people's work apart, and away from the server's own services:

- **Work AI tasks run in containers** (`team.sh` adds `docker-compose.containers.yml`): each task
  gets only its own folder, a read-only system, CPU and memory limits (Admin → Work AI →
  Containers) and a network with nothing on it but Aatmiq. The internet, when allowed, goes through
  Aatmiq's filtering proxy, which refuses private and internal addresses. The API needs the Docker
  socket for this, which is root on the server: keep the server itself locked down.
  `WORK_CONTAINERS=off` in `.env` runs tasks as plain processes instead (each as its own Unix user,
  files confined), with the firewall below as their only network fence.
- **A firewall for task and IDE users.** Each person's IDE (and, without containers, each task)
  runs in the API container as its own Unix user. The API image's entrypoint walls off private
  networks for those users (`deploy/api/firewall.sh`): they reach Aatmiq and the public internet
  (`npm install`, `git clone` from GitHub) but not the database, the model servers, Valkey, your
  office network or cloud metadata. It needs the `NET_ADMIN` capability, which
  `docker-compose.yml` gives the API; if it's missing, the API logs a warning at start. To let
  them reach an internal host anyway (an internal GitLab, say):
  `USER_ALLOWED_NETWORKS=10.20.0.15/32, 192.168.40.0/24`.
- **Secrets**: `APP_SECRET` encrypts provider keys, connector tokens and email passwords in the
  database; keep it (and the backups, which hold the database) safe. Valkey, when you use the
  worker profile, needs `VALKEY_PASSWORD`.
- Tests: `tests/e2e/run-containers.sh` (task containers) and `tests/e2e/run-firewall.sh` (the
  firewall).

## Backups

Every night at `BACKUP_TIME` (default 02:30), the database and the `files` volume (uploads, task
folders, Code homes, without `node_modules` and caches) go to `BACKUP_DIR/aatmiq-<date>`; the
newest `BACKUP_KEEP` (14) are kept. The models aren't backed up (they download again).

```bash
deploy/team.sh exec backup /scripts/backup.sh                 # a backup now
ls /mnt/backup/aatmiq                                         # what there is
deploy/team.sh stop api web                                   # restore: stop Aatmiq…
deploy/team.sh run --rm backup /scripts/restore.sh aatmiq-20261008-023000 --yes
deploy/team.sh up -d                                          # …and start it again
```

Restore refuses while Aatmiq is running. Test a restore once, on a spare machine if you can.

## Updating

```bash
deploy/team.sh exec backup /scripts/backup.sh
git pull
deploy/team.sh up -d --build
```

Database changes are applied when the API starts.

## Keeping an eye on it

- `deploy/team.sh ps`: everything *running* or *healthy*.
- `nvidia-smi`: GPU memory about 90% used is normal (vLLM reserves it); the GPU busy while people
  work.
- `df -h`: disk space (Code homes and task folders grow; old tasks can be deleted by their owners).
- **Admin → Usage**: who uses how much.
- `deploy/team.sh logs --tail 100 api`: what went wrong, when something did.

## Capacity

Measured with `tests/load/run-team.sh` (25 people for 5 minutes, each chatting, starting agent
tasks or opening pages every 5–15 seconds, 5 with the Code editor open in a real browser), with
the model replaced by a stand-in paced like a GPU (0.4 s to the first word, then 40 words a
second), so the numbers are Aatmiq's own, on a smaller machine than this guide asks for (4 cores,
16 GB):

| 25 people, 5 minutes | Typical (p50) | Worst 5% (p95) | Worst |
|---|---|---|---|
| Chat: first word (the stand-in model alone takes 400 ms) | 420 ms | 459 ms | 641 ms |
| Chat: whole answer | 1.0 s | 1.1 s | |
| Agent task: waiting for a slot (8 at once) | 0.5 s | 1.6 s | 2.6 s |
| Page data (API) | 8 ms | 23 ms | 70 ms |

399 chat answers, 130 agent tasks and 146 page loads with **no errors**; the model got at most 7
requests at a time. Memory: the API 405 MB at peak, about 145 MB per agent task's runtime (20 at
once), about 340 MB per open Code editor, 4.8 GB for the whole machine at its busiest. Real agent
tasks run longer than these (each step waits for the real model), so more of them wait for a slot
at busy moments; that's the limit doing its job.

On the real server the model's speed decides most of what people feel. Measure your GPU with
vLLM's own benchmark before inviting everyone: 16 requests at a time, each with a 3,000-token
prompt (an agent step with its instructions) and a 300-token answer:

```bash
deploy/team.sh exec vllm vllm bench serve --backend openai --model qwen3.6-35b-a3b \
  --tokenizer QuantTrio/Qwen3.6-35B-A3B-AWQ --dataset-name random \
  --random-input-len 3000 --random-output-len 300 --num-prompts 64 --max-concurrency 16
```

Look at *Median TTFT* (time to the first word; under 2–3 s feels fine) and *Median TPOT* (time per
word after that; under 50 ms reads faster than people do). If they're worse, lower
`VLLM_MAX_SEQS` and *Tasks working at once*, or leave the small model out.

## Limits

- One server: Aatmiq isn't set up to spread over several machines. That matters at a few hundred
  people, not at 25.
- Not security-audited yet: keep very sensitive data (customer personal data, finances,
  passwords) out until it is.
- The model server is untested on a real A6000 by us: the settings come from vLLM 0.30.0's
  options and the models' published configurations. Watch the first start's logs.
