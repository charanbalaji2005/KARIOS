#!/usr/bin/env bash
###############################################################################
# KAIROS DB — perimeter verification
#
#   ./scripts/verify-security.sh [host]
#
# Checks the things people assume are true and usually are not. Run it from
# ANOTHER machine to test what the internet actually sees; run it locally and
# it will only tell you what the loopback sees, which always looks fine.
###############################################################################
set -uo pipefail

HOST="${1:-localhost}"
PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
info() { echo "        $1"; }

port_closed() {
  local port="$1" label="$2"
  if timeout 3 bash -c "</dev/tcp/$HOST/$port" 2>/dev/null; then
    bad "$label (tcp/$port) is REACHABLE from $HOST"
  else
    ok  "$label (tcp/$port) is closed"
  fi
}

port_open() {
  local port="$1" label="$2"
  if timeout 3 bash -c "</dev/tcp/$HOST/$port" 2>/dev/null; then
    ok  "$label (tcp/$port) is reachable"
  else
    bad "$label (tcp/$port) is NOT reachable"
  fi
}

echo "Kairos perimeter check against $HOST"
echo

echo "Data plane must be closed:"
port_closed 5432 "PostgreSQL"
port_closed 6379 "Redis"
port_closed 9000 "MinIO API"
port_closed 9001 "MinIO console"
port_closed 4000 "API (direct)"
port_closed 3000 "Dashboard (direct)"

echo
echo "Public surface must be open:"
port_open 443 "HTTPS"
port_open 80  "HTTP"

echo
echo "Application behaviour:"

if curl -fsS "http://$HOST/api/health" >/dev/null 2>&1 || curl -fsSk "https://$HOST/api/health" >/dev/null 2>&1; then
  ok "health endpoint responds"
else
  bad "health endpoint does not respond"
fi

headers="$(curl -sSIk "https://$HOST/" 2>/dev/null || curl -sSI "http://$HOST/" 2>/dev/null)"
for header in "x-content-type-options" "x-frame-options" "referrer-policy"; do
  if grep -qi "^$header:" <<<"$headers"; then
    ok "$header present"
  else
    bad "$header missing"
  fi
done

if grep -qi "^server: nginx/" <<<"$headers"; then
  bad "nginx version is advertised (set server_tokens off)"
else
  ok "server version not advertised"
fi

echo
echo "Rate limiting (20 rapid auth attempts):"
limited=0
for _ in $(seq 1 20); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' \
    -d '{"email":"probe@example.com","password":"wrong"}' \
    "https://$HOST/api/v1/auth/login" 2>/dev/null || echo 000)
  [[ "$code" == "429" ]] && limited=1 && break
done
if [[ $limited -eq 1 ]]; then
  ok "auth endpoint rate limits"
else
  bad "auth endpoint did NOT rate limit in 20 attempts"
fi

echo
if command -v fail2ban-client >/dev/null 2>&1; then
  echo "Fail2ban jails:"
  for jail in kairos-auth kairos-apikey kairos-abuse kairos-nginx-scan; do
    if fail2ban-client status "$jail" >/dev/null 2>&1; then
      ok "jail $jail is active"
    else
      bad "jail $jail is not running"
    fi
  done
else
  info "fail2ban-client not on this machine; skipping jail check"
fi

echo
echo "-------------------------------------------"
echo "  $PASS passed, $FAIL failed"
echo "-------------------------------------------"
[[ $FAIL -eq 0 ]] || exit 1
