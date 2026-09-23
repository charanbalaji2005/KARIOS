#!/usr/bin/env bash
###############################################################################
# KAIROS DB — private network for direct database access
#
#   sudo ./infrastructure/wireguard/setup.sh
#
# The problem this solves:
#
#   `kairos db connect` hands the developer a postgres:// URL. In production
#   the compose file deliberately does not publish 5432, so that URL does not
#   work from anywhere except inside the Docker network. The feature and the
#   security posture contradicted each other.
#
#   The wrong fix is `ports: ["5432:5432"]`. PostgreSQL's wire protocol on the
#   public internet, protected by one password, indexed by Shodan within hours.
#
#   The right fix is a private network. The developer joins it; PostgreSQL
#   stays unpublished; nothing is exposed to anyone who has not been given a
#   key.
#
# This script sets up WireGuard. Tailscale is an easier alternative and the
# instructions for it are at the bottom — it does NAT traversal for you, which
# matters if the server is behind CGNAT.
###############################################################################
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi

WG_DIR=/etc/wireguard
WG_NET="${WG_NET:-10.77.0.0/24}"
WG_SERVER_IP="${WG_SERVER_IP:-10.77.0.1}"
WG_PORT="${WG_PORT:-51820}"
PEER_NAME="${1:-}"

command -v wg >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq wireguard; }
mkdir -p "$WG_DIR" && chmod 700 "$WG_DIR"

if [[ ! -f "$WG_DIR/server.key" ]]; then
  echo "==> Generating server keys"
  umask 077
  wg genkey > "$WG_DIR/server.key"
  wg pubkey < "$WG_DIR/server.key" > "$WG_DIR/server.pub"
fi

SERVER_KEY=$(cat "$WG_DIR/server.key")
SERVER_PUB=$(cat "$WG_DIR/server.pub")

if [[ ! -f "$WG_DIR/wg0.conf" ]]; then
  echo "==> Writing $WG_DIR/wg0.conf"
  cat > "$WG_DIR/wg0.conf" <<EOF
[Interface]
Address = ${WG_SERVER_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_KEY}

# Route the VPN subnet to the Docker network where PostgreSQL lives, so a peer
# can reach postgres:5432 without that port ever being published to the host.
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -s ${WG_NET} -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -s ${WG_NET} -j MASQUERADE
EOF
  chmod 600 "$WG_DIR/wg0.conf"
fi

if [[ -n "$PEER_NAME" ]]; then
  echo "==> Adding peer: $PEER_NAME"
  umask 077
  PEER_KEY=$(wg genkey)
  PEER_PUB=$(echo "$PEER_KEY" | wg pubkey)

  # Next free address in the subnet.
  LAST=$(grep -oE 'AllowedIPs = 10\.77\.0\.([0-9]+)' "$WG_DIR/wg0.conf" | grep -oE '[0-9]+$' | sort -n | tail -1 || echo 1)
  PEER_IP="10.77.0.$((LAST + 1))"

  cat >> "$WG_DIR/wg0.conf" <<EOF

[Peer]
# ${PEER_NAME}
PublicKey = ${PEER_PUB}
AllowedIPs = ${PEER_IP}/32
EOF

  PUBLIC_HOST="${PUBLIC_HOST:-$(curl -fsS https://api.ipify.org 2>/dev/null || echo CHANGE_ME)}"

  cat > "$WG_DIR/${PEER_NAME}.conf" <<EOF
[Interface]
PrivateKey = ${PEER_KEY}
Address = ${PEER_IP}/32
DNS = 1.1.1.1

[Peer]
PublicKey = ${SERVER_PUB}
Endpoint = ${PUBLIC_HOST}:${WG_PORT}
# Only the VPN subnet is routed. This is NOT a full tunnel — the developer's
# normal browsing does not go through the server, which would be both slow and
# nobody's idea of what "let me reach the database" meant.
AllowedIPs = ${WG_NET}
PersistentKeepalive = 25
EOF
  chmod 600 "$WG_DIR/${PEER_NAME}.conf"
  echo "    peer config: $WG_DIR/${PEER_NAME}.conf  (address ${PEER_IP})"
  echo "    send it over a secure channel, then delete your copy"
fi

systemctl enable --now wg-quick@wg0 2>/dev/null || systemctl restart wg-quick@wg0

echo "==> Opening the WireGuard port"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${WG_PORT}/udp" comment 'kairos wireguard'
fi

wg show

cat <<EOF

Done.

The developer installs their config, brings the interface up, and then:

    kairos db url            # postgres://...@10.77.0.1:5432/...
    kairos db connect

5432 is still not published to the internet. It is reachable only from inside
the VPN, by peers you explicitly added.

Simpler alternative — Tailscale, which handles NAT traversal:

    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up --advertise-routes=172.16.0.0/12
    # on the developer's machine:
    tailscale up --accept-routes

Either way, do not publish 5432.
EOF
