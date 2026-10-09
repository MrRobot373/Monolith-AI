#!/usr/bin/env bash
# The API image's user firewall (deploy/api/firewall.sh, run by its entrypoint): Unix users from id
# 100000 (Work AI tasks, IDEs) reach this machine and the public internet but no private network;
# root (the API) is unaffected; USER_ALLOWED_NETWORKS makes exceptions; without NET_ADMIN the API
# starts anyway and says the firewall failed. Needs Docker and the API image (API_IMAGE, default
# aatmiq-api:dev) plus valkey/valkey:8-alpine as a stand-in private service.
set -euo pipefail
IMAGE="${API_IMAGE:-aatmiq-api:dev}"
NET=aatmiq-fw-test
pass=0
fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }
cleanup() { docker rm -f fw-private >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null
docker run -d --name fw-private --network "$NET" valkey/valkey:8-alpine >/dev/null
PRIVATE_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" fw-private)

# Inside the API image: a dev server on loopback, then connection attempts as a task user and as root.
PROBE='
try() { if [ "$1" = root ]; then u=""; else u="setpriv --reuid=$1 --regid=$1 --clear-groups"; fi
  if $u python3 -c "import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 3)" "$2" "$3" 2>/dev/null; then echo "$4=open"; else echo "$4=refused"; fi; }
python3 -m http.server 18080 --bind 127.0.0.1 >/dev/null 2>&1 &
for i in $(seq 50); do python3 -c "import socket; socket.create_connection((\"127.0.0.1\", 18080), 1)" 2>/dev/null && break; sleep 0.2; done
echo "firewall=$AATMIQ_USER_FIREWALL"
try 100500 fw-private 6379 task-private
try 100500 169.254.169.254 80 task-metadata
try 100500 127.0.0.1 18080 task-loopback
try root fw-private 6379 root-private
try 99999 fw-private 6379 system-user-private
'
run() { docker run --rm --network "$NET" --entrypoint /app/deploy/entrypoint.sh "$@" "$IMAGE" sh -c "$PROBE" 2>&1; }
has() { grep -qx "$2" <<<"$1" && ok "$3" || { bad "$3"; echo "$1" | sed 's/^/      /'; }; }

echo "With NET_ADMIN (as deploy/docker-compose.yml runs the API):"
out=$(run --cap-add NET_ADMIN)
has "$out" "firewall=on" "the entrypoint sets up the firewall"
has "$out" "task-private=refused" "a task user can't reach a private service (the database, Valkey…)"
has "$out" "task-metadata=refused" "…nor cloud metadata"
has "$out" "task-loopback=open" "…but reaches services on this machine (Aatmiq, its own dev server)"
has "$out" "root-private=open" "the API (root) still reaches its database"
has "$out" "system-user-private=open" "system users below id 100000 are left alone"

echo "With an exception for that service:"
out=$(run --cap-add NET_ADMIN -e USER_ALLOWED_NETWORKS="$PRIVATE_IP/32, not-an-address")
has "$out" "task-private=open" "USER_ALLOWED_NETWORKS lets tasks reach it"
has "$out" "task-metadata=refused" "…and nothing else private"
grep -q 'skipping "not-an-address"' <<<"$out" && ok "a malformed entry is skipped with a warning" || bad "a malformed entry is skipped with a warning"

echo "Without NET_ADMIN:"
out=$(run)
has "$out" "firewall=failed" "the API still starts and reports the firewall failed"
grep -q "WARNING: the user firewall couldn't be set up" <<<"$out" && ok "…with a warning naming the fix" || bad "…with a warning naming the fix"

echo "USER_FIREWALL=off:"
out=$(run --cap-add NET_ADMIN -e USER_FIREWALL=off)
has "$out" "firewall=off" "turned off on purpose"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
