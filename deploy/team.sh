#!/usr/bin/env bash
# Aatmiq for a team on one GPU server (docs/10-team-server.md): the stack with the GPU models,
# HTTPS and nightly backups, using deploy/.env. Any docker compose command works:
#   deploy/team.sh up -d --build        start (or update) everything
#   deploy/team.sh ps                   what's running
#   deploy/team.sh logs -f vllm         watch the main model load
#   deploy/team.sh exec backup /scripts/backup.sh     a backup now
#
# LINEUP in deploy/.env picks the models (deploy/docker-compose.gpu.yml explains each):
#   qwen-nemotron (default), nemotron, nemotron-super, gemma-qwen.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/.env" ] || { echo "Create deploy/.env first: cp deploy/.env.example deploy/.env (then edit it)"; exit 1; }

# A value from .env (empty when unset).
env_value() { sed -n "s/^$1=\(.*\)$/\1/p" "$DIR/.env" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }
# Use a lineup's value unless .env sets one.
default() { [ -n "$(env_value "$1")" ] || export "$1=$2"; }

lineup="$(env_value LINEUP)"
lineup="${lineup:-qwen-nemotron}"
profiles=()
case "$lineup" in
  qwen-nemotron)
    profiles=(--profile vllm --profile ollama-chat)
    default OLLAMA_CHAT_MODELS "nemotron-3-nano:4b"
    ;;
  nemotron | nemotron-super)
    profiles=(--profile ollama-chat)
    default OLLAMA_CHAT_MODELS "nemotron-3-nano:4b nemotron-3-nano:30b"
    default OLLAMA_CHAT_CONTEXT 65536
    default MAIN_URL "http://ollama-chat:11434"
    default MAIN_PROVIDER ollama
    default MAIN_MODEL "nemotron-3-nano:30b"
    default MAIN_MODEL_DISPLAY_NAME "Nemotron 3 Nano 30B"
    default MAIN_CONTEXT 65536
    default MAIN_VISION false
    if [ "$lineup" = nemotron-super ]; then
      profiles+=(--profile large)
      default LARGE_URL "http://ollama-large:11434"
    fi
    ;;
  gemma-qwen)
    profiles=(--profile vllm --profile small)
    default FAST_URL "http://vllm-small:8000/v1"
    default FAST_PROVIDER openai_compatible
    default FAST_MODEL "$(v="$(env_value VLLM_SMALL_MODEL_NAME)"; echo "${v:-gemma-4-e2b}")"
    default FAST_MODEL_DISPLAY_NAME "Gemma 4 E2B"
    default FAST_CONTEXT "$(v="$(env_value VLLM_SMALL_MAX_MODEL_LEN)"; echo "${v:-32768}")"
    default FAST_THINKING fixed
    ;;
  *)
    echo "LINEUP=$lineup isn't known. Use qwen-nemotron, nemotron, nemotron-super or gemma-qwen."
    exit 1
    ;;
esac

# Each Work AI task in its own container (no network but Aatmiq's, limits, a read-only system),
# unless WORK_CONTAINERS=off in .env.
containers=(-f "$DIR/docker-compose.containers.yml")
grep -qE '^WORK_CONTAINERS=\s*off\s*$' "$DIR/.env" && containers=()
exec docker compose "${profiles[@]}" \
  -f "$DIR/docker-compose.yml" \
  -f "$DIR/docker-compose.gpu.yml" \
  -f "$DIR/docker-compose.https.yml" \
  -f "$DIR/docker-compose.backup.yml" \
  "${containers[@]}" \
  --env-file "$DIR/.env" "$@"
