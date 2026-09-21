#!/usr/bin/env bash
# Run on the host: HTTPS through Caddy, health, readiness, security headers, web page.
set -euo pipefail
HOSTNAME_="${LUME_PUBLIC_HOST:-lume.localhost}"
PORT="${SMOKE_PORT:-8443}"
base="https://$HOSTNAME_:$PORT"
c() { curl -sS -k --resolve "$HOSTNAME_:$PORT:127.0.0.1" "$@"; }
check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@"; then printf '  ok  %s\n' "$desc"; else printf '  FAIL %s\n' "$desc"; exit 1; fi
}
status() { c -o /dev/null -w '%{http_code}' "$@"; }

check "GET /healthz 200" test "$(status "$base/healthz")" = 200
ready="$(c -w '\n%{http_code}' "$base/readyz")"
check "GET /readyz 200 ${ready%%$'\n'*}" test "${ready##*$'\n'}" = 200
headers="$(c -D - -o /dev/null "$base/")"
for h in "strict-transport-security: max-age=63072000" "x-content-type-options: nosniff" \
  "content-security-policy: default-src 'self'" "frame-ancestors 'none'"; do
  check "header $h" grep -qi "$h" <<<"$headers"
done
no_server_header() { ! grep -qi "^server:" <<<"$headers"; }
page_has_brand() { c "$base/" | grep -q LUME; }
check "no Server header" no_server_header
check "web page renders" page_has_brand
check "unknown API route 404" test "$(status -H 'Origin: https://evil.example' "$base/api/v1/nope")" = 404
echo "smoke passed"
