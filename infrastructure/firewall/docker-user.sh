#!/usr/bin/env bash
###############################################################################
# KAIROS DB — close the Docker/UFW hole
#
#   sudo ./infrastructure/firewall/docker-user.sh
#
# Docker inserts its own iptables rules ahead of UFW's. A container published
# with `ports: ["5432:5432"]` is therefore reachable from the internet even
# though `ufw status` says 5432 is DENY. This surprises people and it is how
# self-hosted databases end up in Shodan.
#
# Two defences, use both:
#   1. Do not publish data-plane ports at all (docker-compose.prod.yml).
#   2. Filter in DOCKER-USER, which Docker evaluates before its own rules.
###############################################################################
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This must run as root." >&2
  exit 1
fi

# Subnets allowed to reach published container ports directly.
# Add your LAN here if you want to hit the dashboard from your phone.
TRUSTED="${TRUSTED:-127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"

echo "==> Flushing DOCKER-USER"
iptables -F DOCKER-USER 2>/dev/null || iptables -N DOCKER-USER

# Established traffic keeps flowing.
iptables -A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# Internal Docker networks talk to each other freely.
for net in $TRUSTED; do
  iptables -A DOCKER-USER -s "$net" -j RETURN
done

# Anything else arriving from outside for a data-plane port is dropped,
# regardless of what docker-compose published.
for port in 5432 6379 9000 9001; do
  iptables -A DOCKER-USER -p tcp --dport "$port" -j DROP
  echo "    dropped external tcp/$port"
done

# Everything else falls through to UFW / Docker's own chains.
iptables -A DOCKER-USER -j RETURN

echo "==> Persisting rules"
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
elif command -v iptables-save >/dev/null 2>&1; then
  iptables-save > /etc/iptables/rules.v4
  echo "    saved to /etc/iptables/rules.v4"
else
  echo "    WARNING: no persistence tool found. Rules are lost on reboot."
  echo "    Install iptables-persistent: apt install iptables-persistent"
fi

echo
iptables -L DOCKER-USER -n --line-numbers
