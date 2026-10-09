#!/bin/sh
# The API image's entrypoint. As root (the default), it first walls off private networks for the
# Unix users that run Work AI tasks and IDEs (firewall.sh), then runs the command (the API or the
# worker). USER_FIREWALL=off skips that.
if [ "$(id -u)" = 0 ] && [ "${USER_FIREWALL:-on}" != off ]; then
  if out=$(/app/deploy/firewall.sh 2>&1); then
    echo "$out"
    export AATMIQ_USER_FIREWALL=on
  else
    echo "$out" >&2
    echo "aatmiq: WARNING: the user firewall couldn't be set up, so tasks and IDEs can reach private networks. Give the container the NET_ADMIN capability (cap_add: [NET_ADMIN], as in deploy/docker-compose.yml)." >&2
    export AATMIQ_USER_FIREWALL="failed"
  fi
else
  export AATMIQ_USER_FIREWALL=off
fi
exec "$@"
