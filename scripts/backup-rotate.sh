#!/usr/bin/env bash
###############################################################################
# KAIROS DB — backup rotation
#
#   ./scripts/backup-rotate.sh
#
# Retention:  7 daily, 4 weekly, 3 monthly.
#
# The laptop being the cloud is the whole appeal and also the whole risk: one
# failed SSD takes the database, the uploads and every backup sitting next to
# them. OFFSITE_REMOTE is not optional if you care about the data.
#
# Cron:  0 3 * * *  /opt/kairos/scripts/backup-rotate.sh >> /var/log/kairos/backup.log 2>&1
###############################################################################
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/kairos/backups}"
OFFSITE_REMOTE="${OFFSITE_REMOTE:-}"        # e.g. remote:kairos-backups
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=3

DATE=$(date +%F)
DOW=$(date +%u)     # 7 = Sunday
DOM=$(date +%d)

mkdir -p "$BACKUP_ROOT"/{daily,weekly,monthly}

echo "==> Dumping platform database"
PLATFORM_DUMP="$BACKUP_ROOT/daily/platform-$DATE.dump"
docker compose -f "$(dirname "$0")/../docker-compose.prod.yml" exec -T postgres \
  pg_dump -U postgres --format=custom --compress=9 kairos_platform > "$PLATFORM_DUMP"
echo "    $(du -h "$PLATFORM_DUMP" | cut -f1)  $PLATFORM_DUMP"

echo "==> Dumping project databases"
PROJECT_DBS=$(docker compose -f "$(dirname "$0")/../docker-compose.prod.yml" exec -T postgres \
  psql -U postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'kairos\_%' AND datname <> 'kairos_platform'")

for db in $PROJECT_DBS; do
  out="$BACKUP_ROOT/daily/${db}-$DATE.dump"
  docker compose -f "$(dirname "$0")/../docker-compose.prod.yml" exec -T postgres \
    pg_dump -U postgres --format=custom --compress=9 "$db" > "$out"
  echo "    $(du -h "$out" | cut -f1)  $out"
done

# Promote, don't re-dump. A weekly that is a copy of Sunday's daily is the
# same bytes; dumping twice just doubles the IO on a laptop SSD.
if [[ "$DOW" == "7" ]]; then
  echo "==> Promoting to weekly"
  cp "$BACKUP_ROOT"/daily/*-"$DATE".dump "$BACKUP_ROOT/weekly/" 2>/dev/null || true
fi

if [[ "$DOM" == "01" ]]; then
  echo "==> Promoting to monthly"
  cp "$BACKUP_ROOT"/daily/*-"$DATE".dump "$BACKUP_ROOT/monthly/" 2>/dev/null || true
fi

prune() {
  local dir="$1" keep="$2"
  # Group by date so a whole night's set is kept or dropped together.
  local dates
  dates=$(find "$dir" -name '*.dump' -printf '%f\n' 2>/dev/null \
          | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort -ru)
  local n=0
  while read -r d; do
    [[ -z "$d" ]] && continue
    n=$((n+1))
    if (( n > keep )); then
      echo "    pruning $dir/*$d*"
      rm -f "$dir"/*"$d"*.dump
    fi
  done <<< "$dates"
}

echo "==> Pruning"
prune "$BACKUP_ROOT/daily"   "$KEEP_DAILY"
prune "$BACKUP_ROOT/weekly"  "$KEEP_WEEKLY"
prune "$BACKUP_ROOT/monthly" "$KEEP_MONTHLY"

echo "==> Verifying today's dumps are readable"
failed=0
for f in "$BACKUP_ROOT"/daily/*-"$DATE".dump; do
  [[ -e "$f" ]] || continue
  if pg_restore --list "$f" >/dev/null 2>&1; then
    echo "    ok  $(basename "$f")"
  else
    echo "    CORRUPT  $(basename "$f")"
    failed=1
  fi
done
# An unverified backup is a guess. Checking the archive is readable costs
# seconds and is the difference between having a backup and hoping you do.
[[ $failed -eq 0 ]] || { echo "Backup verification FAILED"; exit 1; }

if [[ -n "$OFFSITE_REMOTE" ]]; then
  echo "==> Syncing offsite to $OFFSITE_REMOTE"
  rclone sync "$BACKUP_ROOT" "$OFFSITE_REMOTE" --stats-one-line --transfers 4
else
  echo "==> OFFSITE_REMOTE not set. Backups exist only on this machine."
  echo "    A disk failure will take the data and the backups together."
fi

echo "==> Done. $(du -sh "$BACKUP_ROOT" | cut -f1) total."
