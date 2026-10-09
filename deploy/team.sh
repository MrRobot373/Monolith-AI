#!/usr/bin/env bash
# Aatmiq for a team on one GPU server (docs/10-team-server.md): the stack with the GPU models,
# HTTPS and nightly backups, using deploy/.env. Any docker compose command works:
#   deploy/team.sh up -d --build        start (or update) everything
#   deploy/team.sh ps                   what's running
#   deploy/team.sh logs -f vllm         watch the main model load
#   deploy/team.sh exec backup /scripts/backup.sh     a backup now
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/.env" ] || { echo "Create deploy/.env first: cp deploy/.env.example deploy/.env (then edit it)"; exit 1; }
# The small model runs unless VLLM_SMALL_URL is set to nothing in .env.
small=(--profile small)
grep -qE '^VLLM_SMALL_URL=\s*$' "$DIR/.env" && small=()
# Each Work AI task in its own container (no network but Aatmiq's, limits, a read-only system),
# unless WORK_CONTAINERS=off in .env.
containers=(-f "$DIR/docker-compose.containers.yml")
grep -qE '^WORK_CONTAINERS=\s*off\s*$' "$DIR/.env" && containers=()
exec docker compose "${small[@]}" \
  -f "$DIR/docker-compose.yml" \
  -f "$DIR/docker-compose.gpu.yml" \
  -f "$DIR/docker-compose.https.yml" \
  -f "$DIR/docker-compose.backup.yml" \
  "${containers[@]}" \
  --env-file "$DIR/.env" "$@"
