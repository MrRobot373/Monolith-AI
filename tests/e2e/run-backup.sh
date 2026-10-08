#!/usr/bin/env bash
# Backups end to end on the Compose stack (deploy/docker-compose.backup.yml): make data, back it up,
# change it, restore, and check the data is back, files included. Needs Docker and the images
# aatmiq-api:dev and aatmiq-web:dev. KEEP=1 leaves the stack running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
APP=http://localhost:3998
cat > "$T/images.yml" <<'YML'
services:
  api:
    image: aatmiq-api:dev
    pull_policy: never
  web:
    image: aatmiq-web:dev
    pull_policy: never
YML
cat > "$T/.env" <<ENV
HTTP_PORT=3998
APP_URL=$APP
APP_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
LICENSE_SERVER_URL=
BACKUP_DIR=$T/backups
BACKUP_KEEP=2
TZ=Asia/Kolkata
ENV
mkdir -p "$T/backups"
C=(docker compose -p aatmiq-backup-test -f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/docker-compose.backup.yml" -f "$T/images.yml" --env-file "$T/.env")
cleanup() { [ -n "${KEEP:-}" ] && { echo "Left running ($T)."; return; }; "${C[@]}" down -v >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT

pass=0 fail=0
check() { if eval "$2"; then echo "PASS $1"; pass=$((pass + 1)); else echo "FAIL $1"; fail=$((fail + 1)); fi; }
api() { curl -sS -b "$T/jar" -c "$T/jar" -H "origin: $APP" ${3:+-H "content-type: application/json" -d "$3"} -X "$1" "$APP$2"; }
up() { for _ in $(seq 1 90); do curl -sf "$APP/api/health" >/dev/null && return; sleep 2; done; echo "Aatmiq didn't start"; "${C[@]}" logs api | tail -20; exit 1; }

"${C[@]}" up -d --no-build postgres api web backup >/dev/null 2>&1
up
check "the backup service runs, on the configured schedule and time zone" '"${C[@]}" logs backup 2>&1 | grep -q "daily at 02:30 (IST)"'

api POST /api/setup '{"orgName":"Acme","name":"Asha Owner","email":"owner@acme.test","password":"correct-horse-battery"}' >/dev/null
WS=$(api GET /api/me | jq -r '.workspaces[0].id')
PID=$(api POST /api/projects "{\"workspaceId\":\"$WS\",\"name\":\"Launch plan\"}" | jq -r .id)
DOC=$(api POST "/api/projects/$PID/sources/note" '{"title":"Budget","content":"The launch budget is 42 lakh."}' | jq -r .id)
check "data to back up: a project with a file" '[ "$(api GET /api/documents/$DOC/file)" = "The launch budget is 42 lakh." ]'

"${C[@]}" exec -T backup /scripts/backup.sh > "$T/backup.log" 2>&1 || { cat "$T/backup.log"; exit 1; }
B=$(ls -1 "$T/backups" | grep '^aatmiq-' | head -1)
check "a backup holds the database, the files and a summary" '[ -s "$T/backups/$B/db.dump" ] && [ -s "$T/backups/$B/files.tar.gz" ] && grep -q database_bytes "$T/backups/$B/backup.info"'
check "the files archive has the uploaded file" 'tar -tzf "$T/backups/$B/files.tar.gz" | grep -q "^./files/"'

# Retention: three more backups with BACKUP_KEEP=2 leave the newest two.
for _ in 1 2 3; do sleep 1; "${C[@]}" exec -T backup /scripts/backup.sh >/dev/null 2>&1; done
check "old backups beyond BACKUP_KEEP are removed" '[ "$(ls -1 "$T/backups" | grep -c "^aatmiq-")" = 2 ]'
B=$(ls -1 "$T/backups" | grep '^aatmiq-' | sort | tail -1)

# Lose the data.
api DELETE "/api/projects/$PID" >/dev/null
check "the project is gone" '[ "$(api GET /api/projects/$PID | jq -r .error)" != "null" ]'

check "restore refuses without --yes" '! "${C[@]}" run --rm -T backup /scripts/restore.sh "$B" >/dev/null 2>&1'
refused() { local out; out=$("${C[@]}" run --rm -T backup /scripts/restore.sh "$B" --yes 2>&1) || true; grep -q "still running" <<<"$out" || { echo "$out" | tail -5; return 1; }; }
check "restore refuses while Aatmiq is running" refused
"${C[@]}" stop api web >/dev/null 2>&1
"${C[@]}" run --rm -T backup /scripts/restore.sh "$B" --yes > "$T/restore.log" 2>&1 || { cat "$T/restore.log"; exit 1; }
"${C[@]}" up -d --no-build api web >/dev/null 2>&1
up
check "after the restore the project is back, signed in as before" '[ "$(api GET /api/projects/$PID | jq -r .name)" = "Launch plan" ]'
check "and its file reads the same" '[ "$(api GET /api/documents/$DOC/file)" = "The launch budget is 42 lakh." ]'
check "files keep their owners and modes" '[ "$("${C[@]}" exec -T api stat -c %a /data/files)" = 700 ]'

echo
echo "$pass/$((pass + fail)) passed"
[ "$fail" = 0 ]
