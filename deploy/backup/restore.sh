#!/bin/sh
# Restore an Aatmiq backup made by backup.sh. Stop Aatmiq first, then:
#   docker compose … stop api web worker
#   docker compose … -f deploy/docker-compose.backup.yml run --rm backup /scripts/restore.sh aatmiq-20261008-023000 --yes
#   docker compose … up -d
# It REPLACES the database and everything in the files volume with the backup's contents.
set -eu
DIR="${BACKUP_DIR:-/backups}"
NAME="${1:-}"
[ -n "$NAME" ] || { echo "Which backup? Available:"; ls -1 "$DIR" | grep '^aatmiq-' || true; exit 2; }
SRC="$DIR/$(basename "$NAME")"
[ -f "$SRC/db.dump" ] || { echo "No backup at $SRC"; exit 2; }
[ "${2:-}" = "--yes" ] || { echo "This replaces the current database and files with $NAME. Run again with --yes to go ahead."; exit 2; }
# Aatmiq must be stopped: its API answering, or anything else connected to the database, stops here.
running=""
for host in api; do
  timeout 3 bash -c "echo > /dev/tcp/$host/4000" 2>/dev/null && running="$running $host"
done
others=$(psql -tAc "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()")
if [ -n "$running" ] || [ "$others" != "0" ]; then
  echo "Aatmiq is still running (${running# }${running:+, }$others database connections). Stop it first: docker compose … stop api web worker"
  exit 3
fi
echo "Restoring the database from $NAME…"
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$PGDATABASE" "$SRC/db.dump"
if [ -f "$SRC/files.tar.gz" ]; then
  echo "Restoring files…"
  find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar --extract --gzip --file="$SRC/files.tar.gz" --directory=/data --same-owner --numeric-owner
fi
echo "Restored $NAME. Start Aatmiq again: docker compose … up -d"
