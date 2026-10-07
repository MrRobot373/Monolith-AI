#!/usr/bin/env bash
# Runs the model matrix against a throwaway Aatmiq API (fresh database) and the fixtures server.
#   OLLAMA_KEYS_FILE=/path/to/keys.txt tests/models/run-matrix.sh
# Needs Postgres on localhost. Results land in tests/models/results (git-ignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${OLLAMA_KEYS_FILE:?set OLLAMA_KEYS_FILE to a file with one Ollama API key per line}"
LOG="${LOG_DIR:-$ROOT/tests/models/results}"
mkdir -p "$LOG"
PG="postgres://aatmiq:aatmiq@localhost:5432"
DB="${MATRIX_DB:-aatmiq_matrix}"
API_PORT="${API_PORT:-4100}"
pids=()
start() { setsid bash -c "$1" >"$2" 2>&1 & pids+=($!); }
cleanup() { for p in "${pids[@]}"; do kill -- "-$p" 2>/dev/null || true; done; }
trap cleanup EXIT

if [ -z "${KEEP_DB:-}" ]; then
  psql "$PG/postgres" -qc "drop database if exists $DB with (force)" -c "create database $DB"
  psql "$PG/$DB" -qc "create extension if not exists vector"
  DATABASE_URL="$PG/$DB" pnpm --dir "$ROOT" db:migrate >/dev/null
fi
WORK="${WORK_DIR:-$(mktemp -d)}"
STORE="$(mktemp -d)"
start "exec node '$ROOT/tests/models/fixtures.mjs'" "$LOG/fixtures.log"
start "cd '$ROOT/apps/api' && DATABASE_URL='$PG/$DB' APP_SECRET=matrix-secret-matrix-secret-matrix-12 APP_URL=http://localhost:$API_PORT PORT=$API_PORT \
  STORAGE_DIR='$STORE' WORK_DIR='$WORK' CODE_DIR='$WORK/code' LICENSE_SERVER_URL= exec npx tsx src/server.ts" "$LOG/api.log"
for _ in $(seq 1 60); do curl -sf "http://localhost:$API_PORT/api/health" >/dev/null && break; sleep 1; done
APP="http://localhost:$API_PORT" node "$ROOT/tests/models/matrix.mjs"
