#!/bin/sh
# One backup of Aatmiq into $BACKUP_DIR/aatmiq-<date>: the database (pg_dump, custom format) and
# the files volume (uploads, Work AI task folders, Code homes), then old backups beyond
# $BACKUP_KEEP are removed. Run by the backup service every night, or by hand:
#   docker compose … -f deploy/docker-compose.backup.yml exec backup /scripts/backup.sh
set -eu
DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-14}"
NAME="aatmiq-$(date +%Y%m%d-%H%M%S)"
WORK="$DIR/.$NAME.partial"
log() { echo "$(date '+%F %T') backup: $*"; }
# Tell Aatmiq how it went (Admin → Health); older databases without the table are skipped quietly.
record() { # ok name bytes
  psql -qtAX -v ON_ERROR_STOP=1 -c "insert into system_status (key, value, updated_at) values ('backup', jsonb_build_object('ok', $1, 'name', '$2', 'bytes', $3, 'at', now(), 'lastOk', case when $1 then to_jsonb(now()) else (select value->'lastOk' from system_status where key = 'backup') end), now()) on conflict (key) do update set value = excluded.value, updated_at = now()" >/dev/null 2>&1 || true
}
trap 'rm -rf "$WORK"; log "FAILED"; record false "$NAME" 0' EXIT

mkdir -p "$WORK"
log "database…"
pg_dump --format=custom --compress=6 --no-owner --file="$WORK/db.dump"
# A dump that can't be listed can't be restored either.
pg_restore --list "$WORK/db.dump" >/dev/null

if [ -d /data ] && [ -n "$(ls -A /data 2>/dev/null)" ]; then
  log "files…"
  # Rebuildable folders are left out (package installs, caches); BACKUP_EXCLUDE adds more.
  set -- --exclude=node_modules --exclude=.cache --exclude=__pycache__ --exclude=.venv --exclude=.npm
  for p in ${BACKUP_EXCLUDE:-}; do set -- "$@" "--exclude=$p"; done
  # Files that change while the archive is made (a running task) are warned about, not fatal.
  tar --create --gzip --file="$WORK/files.tar.gz" --directory=/data --warning=no-file-changed "$@" . || [ $? -eq 1 ]
fi

{
  echo "created=$(date -Iseconds)"
  echo "database_bytes=$(stat -c %s "$WORK/db.dump")"
  [ -f "$WORK/files.tar.gz" ] && echo "files_bytes=$(stat -c %s "$WORK/files.tar.gz")"
  echo "excluded=node_modules .cache __pycache__ .venv .npm ${BACKUP_EXCLUDE:-}"
} > "$WORK/backup.info"
mv "$WORK" "$DIR/$NAME"
trap - EXIT
record true "$NAME" "$(du -sb "$DIR/$NAME" | cut -f1)"

# Keep the newest $KEEP complete backups.
ls -1d "$DIR"/aatmiq-* 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do rm -rf "$old"; log "removed $(basename "$old")"; done
log "done: $NAME ($(du -sh "$DIR/$NAME" | cut -f1))"
