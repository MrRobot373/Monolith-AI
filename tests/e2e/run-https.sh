#!/usr/bin/env bash
# HTTPS end to end (deploy/docker-compose.https.yml): Caddy with its own certificate authority in
# front of the Compose stack. Checks the certificate, the redirect from http, that plain HTTP isn't
# published, secure cookies, and a streamed chat answer through the proxy. Needs Docker and the
# images aatmiq-api:dev, aatmiq-web:dev and caddy:2.11.3. KEEP=1 leaves the stack running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
HOST=aatmiq.localhost
APP=https://$HOST:8443
cat > "$T/images.yml" <<'YML'
services:
  api:
    image: aatmiq-api:dev
    pull_policy: never
  web:
    image: aatmiq-web:dev
    pull_policy: never
  caddy:
    pull_policy: never
YML
cat > "$T/.env" <<ENV
APP_URL=$APP
APP_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
LICENSE_SERVER_URL=
ALLOW_MOCK_PROVIDER=true
DOMAIN=$HOST
CADDY_TLS=internal
HTTPS_PORT=8443
HTTP_REDIRECT_PORT=8080
ENV
C=(docker compose -p aatmiq-https-test -f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/docker-compose.https.yml" -f "$T/images.yml" --env-file "$T/.env")
cleanup() { [ -n "${KEEP:-}" ] && { echo "Left running ($T)."; return; }; "${C[@]}" down -v >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT

pass=0 fail=0
check() { if eval "$2"; then echo "PASS $1"; pass=$((pass + 1)); else echo "FAIL $1"; fail=$((fail + 1)); fi; }
R=(--resolve "$HOST:8443:127.0.0.1" --resolve "$HOST:8080:127.0.0.1")
api() { curl -sS "${R[@]}" --cacert "$T/root.crt" -b "$T/jar" -c "$T/jar" -H "origin: $APP" ${3:+-H "content-type: application/json" -d "$3"} -X "$1" "$APP$2"; }

"${C[@]}" up -d --no-build >/dev/null 2>&1
for _ in $(seq 1 90); do curl -sfk "${R[@]}" "$APP/api/health" >/dev/null 2>&1 && break; sleep 2; done
"${C[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$T/root.crt"

check "Aatmiq answers over HTTPS with a certificate from Caddy's authority" 'curl -sf "${R[@]}" --cacert "$T/root.crt" "$APP/api/health" | grep -q ok'
check "plain http redirects to https" '[ "$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "${R[@]}" "http://$HOST:8080/app")" = "308 https://$HOST/app" ]'
check "the web container isn't published on its own" '[ -z "$(docker port aatmiq-https-test-web-1 2>/dev/null)" ]'
check "browsers are told to stay on https" 'curl -sI "${R[@]}" --cacert "$T/root.crt" "$APP/login" | grep -qi "strict-transport-security: max-age=31536000"'

api POST /api/setup '{"orgName":"Acme","name":"Asha Owner","email":"owner@acme.test","password":"correct-horse-battery"}' >/dev/null
check "the sign-in cookie is Secure" 'grep -q "#HttpOnly_$HOST.*TRUE.*better-auth.session_token" "$T/jar"'
WS=$(api GET /api/me | jq -r '.workspaces[0].id')
CHAT=$(api POST /api/chats "{\"workspaceId\":\"$WS\"}" | jq -r .id)
# The answer streams: its first part arrives well before the whole answer is done.
curl -sS -N "${R[@]}" --cacert "$T/root.crt" -b "$T/jar" -H "origin: $APP" -H "content-type: application/json" \
  -d '{"content":"Write three short paragraphs about the sea."}' "$APP/api/chats/$CHAT/messages" \
  | while IFS= read -r line; do printf '%s %s\n' "$(date +%s%N)" "$line"; done > "$T/stream.txt"
check "a chat answer streams through the proxy" '[ "$(grep -c "^[0-9]* data:" "$T/stream.txt")" -gt 5 ]'
first=$(grep -m1 '^[0-9]* data:' "$T/stream.txt" | cut -d" " -f1); last=$(grep '^[0-9]* data:' "$T/stream.txt" | tail -1 | cut -d" " -f1)
check "…in pieces, not all at once at the end ($(((last - first) / 1000000)) ms apart)" '[ $(((last - first) / 1000000)) -gt 200 ]'

echo
echo "$pass/$((pass + fail)) passed"
[ "$fail" = 0 ]
