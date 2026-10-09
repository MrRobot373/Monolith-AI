#!/bin/sh
# Network rules for the Unix users that run Work AI tasks and people's IDEs (ids from 100000; the
# API itself runs as root and isn't affected). They can reach this machine's own services (Aatmiq's
# API, its filtering proxy, their own dev servers) and the public internet, but nothing private or
# internal: not the database, Valkey, the model servers, the office network or cloud metadata.
# USER_ALLOWED_NETWORKS lets them reach chosen internal networks anyway (e.g. an internal GitLab:
# "10.20.0.15/32, 192.168.40.0/24").
#
# Needs root and the NET_ADMIN capability (deploy/docker-compose.yml gives it to the API).
# Run again at any time: it replaces its own rules. `firewall.sh off` removes them.
set -eu

FIRST_UID=100000
LAST_UID=2000000000
CHAIN=AATMIQ_USERS
PRIVATE4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
PRIVATE6="fc00::/7 fe80::/10 ff00::/8 ::ffff:0:0/96 64:ff9b::/96"
# Allowed networks: well-formed addresses only; a typo is skipped (with a warning), never fatal.
ALLOWED=""
for net in $(echo "${USER_ALLOWED_NETWORKS:-}" | tr ',' ' '); do
  if echo "$net" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9a-fA-F:]+:[0-9a-fA-F:]*(/[0-9]{1,3})?$'; then
    ALLOWED="$ALLOWED $net"
  else
    echo "aatmiq: USER_ALLOWED_NETWORKS: skipping \"$net\" (use addresses like 10.20.0.15/32)" >&2
  fi
done
ALLOWED="${ALLOWED# }"

rules() { # $1: iptables or ip6tables, $2: the private ranges, $3: "4" or "6"
  t="$1 -w"
  # Start clean: unhook and drop the chain if it's there.
  while $t -D OUTPUT -m owner --uid-owner "$FIRST_UID-$LAST_UID" -j "$CHAIN" 2>/dev/null; do :; done
  $t -F "$CHAIN" 2>/dev/null || true
  $t -X "$CHAIN" 2>/dev/null || true
  [ "${MODE:-on}" = off ] && return 0

  $t -N "$CHAIN"
  # This machine itself (Aatmiq's API, its proxy, Docker's DNS, the person's own dev servers).
  $t -A "$CHAIN" -o lo -j RETURN
  for net in $ALLOWED; do
    case "$net" in
      *:*) if [ "$3" = 6 ]; then $t -A "$CHAIN" -d "$net" -j RETURN; fi ;;
      *) if [ "$3" = 4 ]; then $t -A "$CHAIN" -d "$net" -j RETURN; fi ;;
    esac
  done
  for net in $2; do $t -A "$CHAIN" -d "$net" -j REJECT; done
  $t -I OUTPUT 1 -m owner --uid-owner "$FIRST_UID-$LAST_UID" -j "$CHAIN"
}

MODE="${1:-on}"
rules iptables "$PRIVATE4" 4
# IPv6 is optional: many containers have none.
if ip6tables -w -L OUTPUT -n >/dev/null 2>&1; then rules ip6tables "$PRIVATE6" 6; fi
if [ "$MODE" = off ]; then echo "aatmiq: user firewall removed"; else echo "aatmiq: user firewall on (ids $FIRST_UID+: private networks refused${ALLOWED:+ except $ALLOWED})"; fi
