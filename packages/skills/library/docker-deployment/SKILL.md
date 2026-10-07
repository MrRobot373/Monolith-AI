---
name: docker-deployment
description: "Use when containerizing or deploying an app: Dockerfiles, docker-compose, env and secrets, health checks, go-live checklist."
category: Software development
---

# Docker and deployment

## Dockerfile (multi-stage, small, non-root)

Node example:

```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```

Python example base: `python:3.12-slim`, `pip install --no-cache-dir -r requirements.txt`, run with
`gunicorn`/`uvicorn` as a non-root user.

Rules:
- Pin base images to a version (not `latest`); copy dependency manifests first for layer caching.
- `.dockerignore`: `node_modules`, `.git`, `.env`, build output, logs.
- No secrets in the image (no `COPY .env`, no `ARG TOKEN` baked into layers).
- One process per container; log to stdout/stderr.
- Run as a non-root user; only expose the needed port.

## docker-compose

```yaml
services:
  app:
    build: .
    env_file: .env            # not committed; provide .env.example
    ports: ["3000:3000"]
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD} }
    volumes: [dbdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 10 }
volumes:
  dbdata:
```

## Configuration

- Twelve-factor: all config from environment variables, validated at startup with clear errors.
- Ship `.env.example` with every variable, a comment, and safe defaults.
- Database migrations run as a separate step (or a one-shot service) before the new version
  serves traffic.

## Going live checklist

- [ ] HTTPS in front (reverse proxy: Caddy/Traefik/nginx) with HTTP→HTTPS redirect.
- [ ] Health endpoint used by the orchestrator; graceful shutdown on SIGTERM.
- [ ] Persistent data on volumes; backups scheduled and a restore tested.
- [ ] Logs collected; basic metrics/uptime alert.
- [ ] Resource limits (memory/CPU) set; restart policy set.
- [ ] Secrets in the platform's secret store or an `.env` with restricted permissions.
- [ ] Rollback plan: previous image tag kept; migrations backward compatible.

## Verify here

Docker may not be available inside the task. Still: lint the Dockerfile by reading it against the
rules, validate compose YAML (`python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"`),
and run the app's start command directly to be sure the CMD works. Say what you could not test.

## Done when

The image builds small and non-root (or the files are ready to build), config is documented in
`.env.example`, health checks exist, and the deploy steps are written down.
