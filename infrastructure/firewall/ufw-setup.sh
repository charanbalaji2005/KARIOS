#!/usr/bin/env bash
###############################################################################
# KAIROS DB — UFW firewall setup (Ubuntu / Debian)
#
#   sudo ./infrastructure/firewall/ufw-setup.sh
#
# Default posture:
#   incoming  DENY
#   outgoing  ALLOW
#   forward   DENY
#
# Only 80 and 443 are opened. PostgreSQL, Redis and MinIO are never exposed —
# they are reachable only over the Docker internal network, from the API.
###############################################################################
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This must run as root." >&2
  exit 1
fi

# Set SSH_ALLOW_FROM to your trusted IP or VPN subnet to keep SSH reachable.
# Leave it empty and SSH will NOT be opened to the internet — which is the
# right answer if you administer the laptop physically or over Tailscale.
SSH_ALLOW_FROM="${SSH_ALLOW_FROM:-}"

# Set to "true" only if you run cloudflared and want to reject direct hits.
CLOUDFLARE_ONLY="${CLOUDFLARE_ONLY:-false}"

echo "==> Resetting UFW to a known state"
ufw --force reset

echo "==> Default policies"
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed

echo "==> Loopback"
ufw allow in on lo
ufw deny in from 127.0.0.0/8
ufw deny in from ::1

if [[ "$CLOUDFLARE_ONLY" == "true" ]]; then
  echo "==> Public HTTP/HTTPS restricted to Cloudflare edge ranges"
  while read -r cidr; do
    [[ -z "$cidr" || "$cidr" == \#* ]] && continue
    ufw allow from "$cidr" to any port 443 proto tcp comment 'cloudflare https'
    ufw allow from "$cidr" to any port 80  proto tcp comment 'cloudflare http'
  done < "$(dirname "$0")/cloudflare-ips.txt"
else
  echo "==> Public HTTP/HTTPS"
  ufw allow 80/tcp  comment 'kairos http'
  ufw allow 443/tcp comment 'kairos https'
fi

if [[ -n "$SSH_ALLOW_FROM" ]]; then
  echo "==> SSH restricted to ${SSH_ALLOW_FROM}"
  ufw limit from "$SSH_ALLOW_FROM" to any port 22 proto tcp comment 'kairos ssh (trusted)'
else
  echo "==> SSH NOT opened (set SSH_ALLOW_FROM=<ip/cidr> to change this)"
fi

###############################################################################
# Explicitly deny the data-plane ports.
#
# The default-deny policy already covers these. They are listed anyway so that
# `ufw status` documents the intent, and so a careless `ports:` mapping added
# to docker-compose later does not silently become internet-facing.
#
# NOTE: Docker writes its own iptables rules in the DOCKER-USER chain and can
# bypass UFW entirely. The hard guarantee is the absence of a host port
# mapping in docker-compose.prod.yml, not this rule. See docker-user.sh.
###############################################################################
echo "==> Explicit denies for data-plane ports"
for port in 5432 6379 9000 9001 4000 3000 5050 8080; do
  ufw deny "${port}/tcp" comment 'kairos internal only'
done

echo "==> Rate limiting is handled by nginx and the API; UFW only limits SSH"

ufw logging medium
ufw --force enable

echo
ufw status verbose
echo
cat <<'EOF'
Done.

Verify from another machine that these all fail:

  nc -zv <laptop-ip> 5432
  nc -zv <laptop-ip> 6379
  nc -zv <laptop-ip> 9000

and that these succeed:

  curl -I http://<laptop-ip>/
  curl -I https://<your-domain>/

If 5432 answers, Docker has punched through UFW. Run
infrastructure/firewall/docker-user.sh and remove the port mapping.
EOF
