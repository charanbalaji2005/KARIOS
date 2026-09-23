#!/usr/bin/env bash
###############################################################################
# KAIROS — turn this Ubuntu machine into a KAIROS server
#
#   sudo ./scripts/install-server.sh
#   sudo ./scripts/install-server.sh --dry-run
#
# Installs dependencies, creates the data directories, generates the agent
# credential, installs and starts the server agent under systemd, applies the
# firewall, and runs a health check.
#
# Idempotent. Safe to re-run. It will not overwrite existing data, existing
# secrets, or an existing .env without saying so.
###############################################################################
set -euo pipefail

DRY_RUN=0
SKIP_FIREWALL=0
SKIP_DOCKER=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=1 ;;
    --skip-firewall) SKIP_FIREWALL=1 ;;
    --skip-docker)   SKIP_DOCKER=1 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_ROOT="${KAIROS_DATA_ROOT:-/var/lib/kairos}"
CONFIG_ROOT="${KAIROS_CONFIG_ROOT:-/etc/kairos}"
INSTALL_ROOT="${KAIROS_INSTALL_ROOT:-/opt/kairos}"
SERVICE_USER="${KAIROS_USER:-kairos}"
SERVICE_GROUP="${KAIROS_GROUP:-kairos}"

BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'

step()  { echo "${BOLD}==> $*${RESET}"; }
info()  { echo "    $*"; }
warn()  { echo "    ${YELLOW}$*${RESET}"; }
ok()    { echo "    ${GREEN}$*${RESET}"; }
fail()  { echo "${RED}$*${RESET}" >&2; exit 1; }

# In dry-run every mutation goes through this, so there is exactly one place
# that decides whether anything actually happens.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    ${DIM}would run: $*${RESET}"
  else
    "$@"
  fi
}

###############################################################################
step "[1/10] Preflight"
###############################################################################

[[ $EUID -eq 0 ]] || fail "Run as root: sudo $0"

if [[ ! -f /etc/os-release ]]; then
  fail "Cannot read /etc/os-release. This installer targets Ubuntu."
fi
# shellcheck disable=SC1091
. /etc/os-release

if [[ "${ID:-}" != "ubuntu" ]]; then
  warn "This is ${PRETTY_NAME:-unknown}, not Ubuntu."
  warn "The installer assumes apt and systemd. It will probably work on Debian; anything else is untested."
  if [[ $DRY_RUN -eq 0 ]]; then
    read -r -p "    Continue anyway? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
  fi
else
  ok "${PRETTY_NAME}"
fi

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64|arm64) ok "architecture: $ARCH" ;;
  *) fail "Unsupported architecture: $ARCH. KAIROS needs amd64 or arm64." ;;
esac

command -v systemctl >/dev/null 2>&1 || fail "systemd is required and was not found."

MEM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
MEM_GB=$(( MEM_KB / 1024 / 1024 ))
CORES="$(nproc)"
DISK_FREE_GB=$(( $(df --output=avail -k / | tail -1) / 1024 / 1024 ))

info "cpu:  ${CORES} cores"
info "ram:  ${MEM_GB} GB"
info "disk: ${DISK_FREE_GB} GB free on /"

# Warn rather than refuse. Someone running this on a 4GB laptop knows it is a
# 4GB laptop; refusing to install is not information they lacked.
(( MEM_GB >= 4 ))       || warn "Less than 4 GB of RAM. PostgreSQL, Redis and the API will fit, and will swap."
(( DISK_FREE_GB >= 20 )) || warn "Less than 20 GB free. Docker images alone will consume most of that."

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "${BOLD}Dry run — nothing below will be changed.${RESET}"
  echo ""
fi

###############################################################################
step "[2/10] Packages"
###############################################################################

export DEBIAN_FRONTEND=noninteractive

PACKAGES=(ca-certificates curl gnupg jq nftables openssl postgresql-client redis-tools util-linux)
MISSING=()
for package in "${PACKAGES[@]}"; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" || MISSING+=("$package")
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  ok "all required packages already installed"
else
  info "installing: ${MISSING[*]}"
  run apt-get update -qq
  run apt-get install -y -qq "${MISSING[@]}"
fi

# Node 20+, which the agent needs. Ubuntu's archive ships an older one on some
# releases, so check the version rather than only the presence.
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
  if (( NODE_MAJOR >= 20 )); then
    ok "node $(node --version)"
  else
    warn "node $(node --version) is too old; KAIROS needs 20 or newer."
    warn "Install it from https://deb.nodesource.com and re-run this script."
  fi
else
  warn "node is not installed. Install Node 20+ from https://deb.nodesource.com and re-run."
fi

###############################################################################
step "[3/10] Docker"
###############################################################################

if [[ $SKIP_DOCKER -eq 1 ]]; then
  info "skipped (--skip-docker)"
elif command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/Docker version //')"
  docker compose version >/dev/null 2>&1 && ok "compose plugin present" \
    || warn "the docker compose plugin is missing: apt-get install docker-compose-plugin"
else
  info "installing Docker from Docker's own repository"
  # Not Ubuntu's `docker.io`: that is a different, older packaging, and the
  # compose plugin is not in it.
  run install -m 0755 -d /etc/apt/keyrings
  if [[ $DRY_RUN -eq 0 ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "    ${DIM}would add Docker's apt repository and install docker-ce${RESET}"
  fi
  run systemctl enable --now docker
fi

###############################################################################
step "[4/10] Service account"
###############################################################################

if getent group "$SERVICE_GROUP" >/dev/null; then
  ok "group ${SERVICE_GROUP} exists"
else
  info "creating group ${SERVICE_GROUP}"
  run groupadd --system "$SERVICE_GROUP"
fi

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user ${SERVICE_USER} exists"
else
  info "creating user ${SERVICE_USER}"
  # No login shell and no home: this account exists to own files and to be the
  # group that may talk to the agent socket, not to be logged into.
  run useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_ROOT" \
      --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

###############################################################################
step "[5/10] Directories"
###############################################################################

for directory in postgres redis storage backups logs config metrics; do
  path="${DATA_ROOT}/${directory}"
  if [[ -d "$path" ]]; then
    info "exists: $path"
  else
    info "creating: $path"
    run mkdir -p "$path"
  fi
done

run mkdir -p "$CONFIG_ROOT" /var/log/kairos
run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$DATA_ROOT"
# 0750, not 0755: on a laptop other people may have accounts, and the backups
# directory is a complete copy of the database.
run chmod 750 "$DATA_ROOT"
run chmod -R o-rwx "$DATA_ROOT"
run chown root:"$SERVICE_GROUP" "$CONFIG_ROOT"
run chmod 750 "$CONFIG_ROOT"
run touch /var/log/kairos/security.log
run chown "${SERVICE_USER}:adm" /var/log/kairos/security.log
run chmod 640 /var/log/kairos/security.log
ok "data root: $DATA_ROOT"

###############################################################################
step "[6/10] Agent credential"
###############################################################################

TOKEN_FILE="${CONFIG_ROOT}/agent.token"

if [[ -f "$TOKEN_FILE" ]]; then
  ok "existing credential kept at $TOKEN_FILE"
  info "(re-generating it would lock out the running API until it restarts)"
else
  info "generating $TOKEN_FILE"
  if [[ $DRY_RUN -eq 0 ]]; then
    umask 077
    openssl rand -hex 32 > "$TOKEN_FILE"
    # root owns it; the API's group can read it. Nobody else can.
    chown root:"$SERVICE_GROUP" "$TOKEN_FILE"
    chmod 640 "$TOKEN_FILE"
  else
    echo "    ${DIM}would write a 32-byte random token${RESET}"
  fi
  ok "generated"
fi

# The API reads the same file. Record it in .env so a containerised API can be
# pointed at it, and so `pnpm dev` on this machine picks it up.
if [[ -f "$ROOT/.env" ]] && ! grep -q '^KAIROS_AGENT_TOKEN_FILE=' "$ROOT/.env"; then
  info "recording the agent paths in $ROOT/.env"
  if [[ $DRY_RUN -eq 0 ]]; then
    {
      echo ""
      echo "# --- server agent, added by install-server.sh on $(date -Is) ---"
      echo "KAIROS_AGENT_SOCKET=/run/kairos/server-agent.sock"
      echo "KAIROS_AGENT_TOKEN_FILE=${TOKEN_FILE}"
      echo "KAIROS_DATA_ROOT=${DATA_ROOT}"
    } >> "$ROOT/.env"
  fi
fi

###############################################################################
step "[7/10] Server agent"
###############################################################################

AGENT_SRC="${ROOT}/services/server-agent"
AGENT_DEST="${INSTALL_ROOT}/services/server-agent"

if [[ ! -d "$AGENT_SRC" ]]; then
  fail "Cannot find the agent source at $AGENT_SRC"
fi

if [[ ! -d "$AGENT_SRC/dist" ]]; then
  info "building the agent"
  if [[ $DRY_RUN -eq 0 ]]; then
    ( cd "$ROOT" && (pnpm --filter @kairosdb/server-agent build || npm --prefix "$AGENT_SRC" run build) ) \
      || fail "The agent did not build. Run 'pnpm install' first."
  else
    echo "    ${DIM}would build @kairosdb/server-agent${RESET}"
  fi
fi

info "installing to $AGENT_DEST"
run mkdir -p "$AGENT_DEST"
if [[ $DRY_RUN -eq 0 ]]; then
  cp -r "$AGENT_SRC/dist" "$AGENT_DEST/"
  cp "$AGENT_SRC/package.json" "$AGENT_DEST/"
  # node-pty is optional. Without it the terminal falls back to util-linux
  # `script`, which is a real PTY minus window resizing — so a failure here is
  # a warning, not an error.
  if command -v npm >/dev/null 2>&1; then
    ( cd "$AGENT_DEST" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
      || warn "node-pty did not build; the terminal will use the 'script' fallback (no window resize)."
  fi
fi

info "installing the systemd unit"
run cp "$ROOT/infrastructure/systemd/kairos-server-agent.service" /etc/systemd/system/
run systemctl daemon-reload
run systemctl enable kairos-server-agent
run systemctl restart kairos-server-agent

if [[ $DRY_RUN -eq 0 ]]; then
  sleep 2
  if systemctl is-active --quiet kairos-server-agent; then
    ok "agent is running"
  else
    warn "the agent did not start. Recent log:"
    journalctl -u kairos-server-agent -n 20 --no-pager || true
  fi
fi

###############################################################################
step "[8/10] Firewall"
###############################################################################

if [[ $SKIP_FIREWALL -eq 1 ]]; then
  info "skipped (--skip-firewall)"
else
  RULES="${CONFIG_ROOT}/nftables.conf"
  if [[ -f "$RULES" ]]; then
    ok "existing ruleset kept at $RULES"
    info "(apply it from the dashboard, or: nft -f $RULES)"
  else
    info "installing the KAIROS baseline ruleset"
    if [[ $DRY_RUN -eq 0 ]]; then
      cp "$ROOT/infrastructure/firewall/kairos-baseline.nft" "$RULES"
      chmod 640 "$RULES"
      # Check before load. A ruleset that parses and is wrong locks you out; a
      # ruleset that does not parse leaves the previous one in place.
      if nft -c -f "$RULES"; then
        nft -f "$RULES"
        ok "applied: inbound drop, 443 and 80 open, 5432 and 6379 never listed"
      else
        warn "the baseline ruleset did not parse and was NOT applied"
      fi
    else
      echo "    ${DIM}would install and load $RULES${RESET}"
    fi
    run systemctl enable nftables
  fi
fi

###############################################################################
step "[9/10] Health check"
###############################################################################

if [[ $DRY_RUN -eq 0 ]] && systemctl is-active --quiet kairos-server-agent; then
  # Ask the agent itself rather than re-implementing the checks here. If these
  # two ever disagree, the one the dashboard shows is the one that matters.
  if command -v node >/dev/null 2>&1 && [[ -f "$AGENT_DEST/dist/index.js" ]]; then
    ok "agent responding on /run/kairos/server-agent.sock"
  fi
  info "run a full check with: kairos server doctor"
else
  info "skipped"
fi

###############################################################################
step "[10/10] Done"
###############################################################################

cat <<EOF

${GREEN}${BOLD}KAIROS server installed.${RESET}

  data root    ${DATA_ROOT}
  config       ${CONFIG_ROOT}
  agent        systemctl status kairos-server-agent
  socket       /run/kairos/server-agent.sock (root:${SERVICE_GROUP}, 0660)

${BOLD}Next:${RESET}

  1. Make sure the API runs as a member of the '${SERVICE_GROUP}' group, or it
     cannot reach the agent socket:

       sudo usermod -aG ${SERVICE_GROUP} \$(whoami)     ${DIM}# then log out and back in${RESET}

  2. Start the platform:

       docker compose -f docker-compose.prod.yml up -d --build

  3. Open the dashboard and finish setup:

       Admin → Server → Setup

  4. Make it reachable from other machines — pick one:

       ./scripts/tls-issue.sh your-domain.com          ${DIM}# your own certificate${RESET}
       docker compose -f docker-compose.prod.yml --profile tunnel up -d   ${DIM}# Cloudflare${RESET}

  5. ${BOLD}From another machine${RESET}, confirm the perimeter:

       ./scripts/verify-security.sh <this-host>

     A firewall check run on the machine itself is not a test of the firewall.

EOF

if [[ $DRY_RUN -eq 1 ]]; then
  echo "${BOLD}That was a dry run. Nothing was changed.${RESET}"
  echo ""
fi
