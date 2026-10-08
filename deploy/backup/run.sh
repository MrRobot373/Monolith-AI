#!/bin/sh
# The backup service: a backup every day at $BACKUP_TIME (server time zone, TZ), forever.
set -eu
# `docker compose run backup /scripts/restore.sh …` and the like: run that instead.
[ $# -eq 0 ] || exec "$@"
TIME="${BACKUP_TIME:-02:30}"
echo "backup: daily at $TIME ($(date +%Z)), keeping ${BACKUP_KEEP:-14}, into ${BACKUP_DIR:-/backups}"
while :; do
  now=$(date +%s)
  next=$(date -d "today $TIME" +%s)
  [ "$next" -gt "$now" ] || next=$(date -d "tomorrow $TIME" +%s)
  sleep $((next - now))
  /scripts/backup.sh || echo "backup: the backup failed; the next try is tomorrow (or run it by hand)"
done
