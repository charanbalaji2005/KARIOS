#!/usr/bin/env bash
###############################################################################
# KAIROS — remove the server software from this machine
#
#   sudo ./scripts/uninstall-server.sh              # software only, data kept
#   sudo ./scripts/uninstall-server.sh --purge      # also delete ALL data
#   sudo ./scripts/uninstall-server.sh --dry-run
#
# Default behaviour removes the KAIROS software and leaves every byte of your
# data alone: the database, your project files, and your backups all stay.
#
# --purge deletes them, and asks you to type a phrase first, because there is
# no undo and on this product /var/lib/kairos is frequently the only copy.
###############################################################################
set -euo pipefail

DRY_RUN=0
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --purge)   PURGE=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

DATA_ROOT="${KAIROS_DATA_ROOT:-/var/lib/kairos}"
CONFIG_ROOT="${KAIROS_CONFIG_ROOT:-/etc/kairos}"
INSTALL_ROOT="${KAIROS_INSTALL_ROOT:-/opt/kairos}"
SERVICE_USER="${KAIROS_USER:-kairos}"
SERVICE_GROUP="${KAIROS_GROUP:-kairos}"

BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'

step() { echo "${BOLD}==> $*${RESET}"; }
info() { echo "    $*"; }
warn() { echo "    ${YELLOW}$*${RESET}"; }
ok()   { echo "    ${GREEN}$*${RESET}"; }
fail() { echo "${RED}$*${RESET}" >&2; exit 1; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    ${DIM}would run: $*${RESET}"
  else
    "$@"
  fi
}

[[ $EUID -eq 0 ]] || fail "Run as root: sudo $0"

###############################################################################
# What is actually here, before anything is removed
###############################################################################

echo ""
echo "${BOLD}This will remove the KAIROS server software from this machine.${RESET}"
echo ""

if [[ -d "$DATA_ROOT" ]]; then
  DB_SIZE="$(du -sh "$DATA_ROOT/postgres" 2>/dev/null | cut -f1 || echo '-')"
  FILES_SIZE="$(du -sh "$DATA_ROOT/storage" 2>/dev/null | cut -f1 || echo '-')"
  BACKUP_SIZE="$(du -sh "$DATA_ROOT/backups" 2>/dev/null | cut -f1 || echo '-')"
  BACKUP_COUNT="$(find "$DATA_ROOT/backups" -name '*.dump' 2>/dev/null | wc -l | tr -d ' ')"

  echo "  Data currently on this machine:"
  echo "    database      ${DB_SIZE}"
  echo "    project files ${FILES_SIZE}"
  echo "    backups       ${BACKUP_SIZE}  (${BACKUP_COUNT} archives)"
  echo ""
fi

if [[ $PURGE -eq 1 ]]; then
  echo "  ${RED}${BOLD}--purge was given. Everything above will be permanently deleted.${RESET}"
else
  echo "  ${GREEN}Your data will be kept.${RESET} Only the software is removed."
  echo "  ${DIM}Re-run with --purge to delete the data as well.${RESET}"
fi
echo ""

if [[ $DRY_RUN -eq 0 ]]; then
  read -r -p "  Continue? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "  Nothing was changed."; exit 0; }
fi

###############################################################################
step "[1/5] Stopping services"
###############################################################################

if systemctl list-unit-files 2>/dev/null | grep -q '^kairos-server-agent.service'; then
  run systemctl stop kairos-server-agent || true
  run systemctl disable kairos-server-agent || true
  ok "agent stopped"
else
  info "agent unit not installed"
fi

if command -v docker >/dev/null 2>&1; then
  RUNNING="$(docker ps -a --filter 'name=kairos_' --format '{{.Names}}' 2>/dev/null || true)"
  if [[ -n "$RUNNING" ]]; then
    info "stopping containers: $(echo "$RUNNING" | tr '\n' ' ')"
    # Stop and remove the containers, but never the volumes — `docker compose
    # down -v` is the command that silently deletes a database, and it is not
    # in this script even under --purge.
    for container in $RUNNING; do
      run docker stop "$container" >/dev/null || true
      run docker rm "$container" >/dev/null || true
    done
    ok "containers removed (volumes untouched)"
  else
    info "no KAIROS containers"
  fi
fi

###############################################################################
step "[2/5] Removing the software"
###############################################################################

run rm -f /etc/systemd/system/kairos-server-agent.service
run systemctl daemon-reload

if [[ -d "$INSTALL_ROOT" ]]; then
  info "removing $INSTALL_ROOT"
  run rm -rf "$INSTALL_ROOT"
fi

run rm -f /run/kairos/server-agent.sock
ok "software removed"

###############################################################################
step "[3/5] Firewall"
###############################################################################

if command -v nft >/dev/null 2>&1 && nft list tables 2>/dev/null | grep -q 'inet kairos'; then
  # The KAIROS table is removed; anything else in nftables is left exactly as
  # it was, because this script did not put it there.
  info "removing the 'inet kairos' nftables table"
  run nft delete table inet kairos || true
  warn "inbound traffic is no longer filtered by KAIROS rules."
  warn "If nothing else is managing this machine's firewall, it is now open."
else
  info "no KAIROS firewall table loaded"
fi

###############################################################################
step "[4/5] Data"
###############################################################################

if [[ $PURGE -eq 0 ]]; then
  ok "kept: $DATA_ROOT"
  ok "kept: $CONFIG_ROOT (secrets and the server key)"
  echo ""
  info "To delete them later:"
  info "  sudo $0 --purge"
else
  echo ""
  echo "  ${RED}${BOLD}About to permanently delete:${RESET}"
  echo "    ${DATA_ROOT}/postgres   ${DIM}the database${RESET}"
  echo "    ${DATA_ROOT}/storage    ${DIM}every uploaded file${RESET}"
  echo "    ${DATA_ROOT}/backups    ${DIM}every backup${RESET}"
  echo "    ${CONFIG_ROOT}          ${DIM}the encryption key and the server identity${RESET}"
  echo ""
  echo "  ${RED}Deleting ${CONFIG_ROOT} destroys ENCRYPTION_KEY. Every stored project"
  echo "  credential becomes permanently unrecoverable, including from a backup.${RESET}"
  echo ""

  if [[ $DRY_RUN -eq 0 ]]; then
    read -r -p "  Type ${BOLD}DELETE ALL KAIROS DATA${RESET} to confirm: " typed
    if [[ "$typed" != "DELETE ALL KAIROS DATA" ]]; then
      echo ""
      echo "  ${GREEN}Not confirmed. Your data was NOT deleted.${RESET}"
      echo "  The software is removed; re-installing will find the data where it was."
      exit 0
    fi
  fi

  run rm -rf "$DATA_ROOT"
  run rm -rf "$CONFIG_ROOT"
  run rm -rf /var/log/kairos
  ok "data deleted"

  if command -v docker >/dev/null 2>&1; then
    VOLUMES="$(docker volume ls --filter 'name=kairos' --format '{{.Name}}' 2>/dev/null || true)"
    if [[ -n "$VOLUMES" ]]; then
      info "removing docker volumes: $(echo "$VOLUMES" | tr '\n' ' ')"
      for volume in $VOLUMES; do
        run docker volume rm "$volume" >/dev/null || true
      done
    fi
  fi
fi

###############################################################################
step "[5/5] Service account"
###############################################################################

if [[ $PURGE -eq 1 ]]; then
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    run userdel "$SERVICE_USER" || true
    ok "user ${SERVICE_USER} removed"
  fi
  if getent group "$SERVICE_GROUP" >/dev/null; then
    run groupdel "$SERVICE_GROUP" || true
    ok "group ${SERVICE_GROUP} removed"
  fi
else
  # Files under the data root are owned by this account. Removing it would
  # leave them owned by a bare numeric uid, which is how a later reinstall ends
  # up unable to read its own database.
  info "kept: ${SERVICE_USER}:${SERVICE_GROUP} (your data files are owned by it)"
fi

echo ""
if [[ $PURGE -eq 1 ]]; then
  echo "${BOLD}KAIROS and all of its data have been removed.${RESET}"
else
  echo "${BOLD}KAIROS software removed. Your data is still at ${DATA_ROOT}.${RESET}"
fi
if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "${BOLD}That was a dry run. Nothing was changed.${RESET}"
fi
echo ""
