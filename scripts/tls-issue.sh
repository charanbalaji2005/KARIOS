#!/usr/bin/env bash
###############################################################################
# KAIROS DB — issue Let's Encrypt certificates
#
#   ./scripts/tls-issue.sh example.com you@example.com
#
# Issues one certificate covering all four subdomains. Requires ports 80 and
# 443 reachable from the internet and DNS already pointing here.
#
# Behind a Cloudflare Tunnel you do NOT need this: Cloudflare terminates TLS
# at the edge. Use a Cloudflare Origin Certificate for nginx instead.
###############################################################################
set -euo pipefail

DOMAIN="${1:?usage: tls-issue.sh <domain> [email]}"
EMAIL="${2:-admin@$DOMAIN}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

docker run --rm \
  -v "$ROOT/infrastructure/nginx/certs:/etc/letsencrypt" \
  -v kairosdb_certbot_webroot:/var/www/certbot \
  certbot/certbot certonly \
    --webroot -w /var/www/certbot \
    --email "$EMAIL" --agree-tos --no-eff-email \
    -d "cloud.$DOMAIN" \
    -d "api.$DOMAIN" \
    -d "realtime.$DOMAIN" \
    -d "files.$DOMAIN"

# nginx reads fixed paths so renewals need no config change.
ln -sf "/etc/letsencrypt/live/cloud.$DOMAIN/fullchain.pem" "$ROOT/infrastructure/nginx/certs/fullchain.pem"
ln -sf "/etc/letsencrypt/live/cloud.$DOMAIN/privkey.pem"   "$ROOT/infrastructure/nginx/certs/privkey.pem"

docker compose -f "$ROOT/docker-compose.prod.yml" exec nginx nginx -s reload
echo "Certificates issued and nginx reloaded."
echo "Renewal runs automatically via the 'tls' compose profile."
