#!/usr/bin/env bash
# Starts what the Work AI browser test needs, runs it, then stops it.
#   fake model + MCP + SearXNG server :11500, Aatmiq API :4000 (fresh database), web :3300
# Needs: Postgres on localhost and the web app built (pnpm --filter @aatmiq/web build).
# API_IMAGE=<tag> runs the API from its Docker image instead of the source tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${LOG_DIR:-$ROOT/tests/e2e/results-work}"
mkdir -p "$LOG"
PG="postgres://aatmiq:aatmiq@localhost:5432"
pids=()
start() { setsid bash -c "$1" >"$2" 2>&1 & pids+=($!); }
cleanup() {
  for p in "${pids[@]}"; do kill -- "-$p" 2>/dev/null || true; done
  [ -n "${API_IMAGE:-}" ] && docker rm -f aatmiq-e2e-api >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql "$PG/postgres" -qc "drop database if exists aatmiq_work_e2e with (force)" -c "create database aatmiq_work_e2e"
psql "$PG/aatmiq_work_e2e" -qc "create extension if not exists vector"
DATABASE_URL="$PG/aatmiq_work_e2e" pnpm --dir "$ROOT" db:migrate >/dev/null

wait_for() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null && return 0; sleep 1; done; echo "timed out waiting for $1"; exit 1; }

STORE="$(mktemp -d)"
WORK="$(mktemp -d)"
start "exec node '$ROOT/tests/e2e/fake-llm.mjs'" "$LOG/fake-llm.log"
if [ -n "${API_IMAGE:-}" ]; then
  # The API from its Docker image (host network: it reaches Postgres and the fake model on localhost).
  start "exec docker run --rm --name aatmiq-e2e-api --network host -e DATABASE_URL='$PG/aatmiq_work_e2e' \
    -e APP_SECRET=e2e-app-secret-e2e-app-secret-e2e-app -e APP_URL=http://localhost:3300 -e PORT=4000 \
    -e ALLOW_MOCK_PROVIDER=true -e LICENSE_SERVER_URL= -e WORK_SANDBOX=${WORK_SANDBOX:-on} '$API_IMAGE'" "$LOG/api.log"
else
  start "cd '$ROOT/apps/api' && DATABASE_URL='$PG/aatmiq_work_e2e' APP_SECRET=e2e-app-secret-e2e-app-secret-e2e-app APP_URL=http://localhost:3300 PORT=4000 \
    ALLOW_MOCK_PROVIDER=true STORAGE_DIR='$STORE' WORK_DIR='$WORK' LICENSE_SERVER_URL= exec npx tsx src/server.ts" "$LOG/api.log"
fi
start "cd '$ROOT/apps/web' && API_URL=http://localhost:4000 exec npx next start -p 3300" "$LOG/web.log"
wait_for http://localhost:11500/v1/models
wait_for http://localhost:3300/api/health

node "${E2E_SCRIPT:-$ROOT/tests/e2e/work.mjs}"
