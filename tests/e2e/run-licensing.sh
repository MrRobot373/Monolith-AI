#!/usr/bin/env bash
# Starts everything the licensing/SSO browser test needs, runs it, then stops it.
#   license server :4100 + Super Admin console :3100
#   a licensed Aatmiq (API :4000, web :3200; the web build proxies /api to :4000) using the license server's public key
#   a mock OpenID provider :11600
# Needs: Postgres on localhost, apps built (pnpm --filter @aatmiq/web build, … license-console build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${LOG_DIR:-$ROOT/tests/e2e/results-licensing}"
mkdir -p "$LOG"
PG="postgres://aatmiq:aatmiq@localhost:5432"
pids=()
# Each service runs in its own process group so the whole tree (npx → node) stops on exit.
start() { setsid bash -c "$1" >"$2" 2>&1 & pids+=($!); }
cleanup() { for p in "${pids[@]}"; do kill -- "-$p" 2>/dev/null || true; done; }
trap cleanup EXIT

reset_db() { psql "$PG/postgres" -qc "drop database if exists $1 with (force)" -c "create database $1"; }
reset_db aatmiq_license_e2e
reset_db aatmiq_lic_e2e
psql "$PG/aatmiq_lic_e2e" -qc "create extension if not exists vector"
DATABASE_URL="$PG/aatmiq_lic_e2e" pnpm --dir "$ROOT" db:migrate >/dev/null

wait_for() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null && return 0; sleep 1; done; echo "timed out waiting for $1"; exit 1; }

start "cd '$ROOT/apps/license-server' && DATABASE_URL='$PG/aatmiq_license_e2e' SERVER_SECRET=e2e-license-secret-e2e-license-secret \
  SUPER_ADMIN_EMAIL=root@aatmiq.test SUPER_ADMIN_PASSWORD=super-secret-password CONSOLE_URL=http://localhost:3100 PORT=4100 \
  exec npx tsx src/server.ts" "$LOG/license-server.log"
wait_for http://localhost:4100/v1/health
PUBKEY="$(psql "$PG/aatmiq_license_e2e" -Atc "select public_pem from signing_key where active limit 1")"

start "cd '$ROOT/apps/license-console' && LICENSE_API_URL=http://localhost:4100 exec npx next start -p 3100" "$LOG/console.log"
start "exec node '$ROOT/apps/api/test/mock-idp.mjs' 11600" "$LOG/idp.log"
STORE="$(mktemp -d)"
export PUBKEY
start "cd '$ROOT/apps/api' && DATABASE_URL='$PG/aatmiq_lic_e2e' APP_SECRET=e2e-app-secret-e2e-app-secret-e2e-app APP_URL=http://localhost:3200 PORT=4000 \
  ALLOW_MOCK_PROVIDER=true STORAGE_DIR='$STORE' LICENSE_PUBLIC_KEY=\"\$PUBKEY\" LICENSE_SERVER_URL=http://localhost:4100 APP_VERSION=1.0.0 \
  exec npx tsx src/server.ts" "$LOG/api.log"
start "cd '$ROOT/apps/web' && API_URL=http://localhost:4000 exec npx next start -p 3200" "$LOG/web.log"
wait_for http://localhost:3100/login
wait_for http://localhost:3200/api/health
wait_for http://127.0.0.1:11600/.well-known/openid-configuration

node "${E2E_SCRIPT:-$ROOT/tests/e2e/licensing.mjs}"
