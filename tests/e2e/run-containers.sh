#!/usr/bin/env bash
# Container mode end to end: the Compose stack with deploy/docker-compose.containers.yml, the fake
# model on the host, then containers.mjs. Needs Docker and the images aatmiq-api:dev and aatmiq-web:dev.
# KEEP=1 leaves the stack running afterwards (docker compose -p aatmiq down -v to remove it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
cat > "$T/images.yml" <<'YML'
services:
  api:
    image: aatmiq-api:dev
    pull_policy: never
    extra_hosts: ["host.docker.internal:host-gateway"]
  web:
    image: aatmiq-web:dev
    pull_policy: never
YML
cat > "$T/.env" <<ENV
APP_URL=http://localhost:3999
HTTP_PORT=3999
APP_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
LICENSE_SERVER_URL=
AATMIQ_API_IMAGE=aatmiq-api:dev
ENV
C=(docker compose -f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/docker-compose.containers.yml" -f "$T/images.yml" --env-file "$T/.env")
node "$ROOT/tests/e2e/fake-llm.mjs" > "$T/fake.log" 2>&1 &
FAKE=$!
cleanup() { [ -n "${KEEP:-}" ] && { echo "Left running (fake model pid $FAKE)."; return; }; kill $FAKE 2>/dev/null || true; "${C[@]}" down -v >/dev/null 2>&1 || true; docker rm -f $(docker ps -aq --filter label=aatmiq.task) >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${C[@]}" up -d --no-build >/dev/null
for _ in $(seq 1 90); do curl -sf http://localhost:3999/api/health >/dev/null && break; sleep 2; done
BASE_URL=http://localhost:3999 node "$ROOT/tests/e2e/containers.mjs"
