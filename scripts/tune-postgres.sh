#!/usr/bin/env bash
###############################################################################
# KAIROS DB — hardware-aware PostgreSQL tuning
#
#   ./scripts/tune-postgres.sh > infrastructure/postgres/postgresql.tuned.conf
#
# Reads the machine's actual RAM, core count and storage type, then derives
# settings from them. Nothing below is a fixed number copied from a blog post,
# because the correct value for shared_buffers on a 64 GB workstation is wrong
# on a 8 GB laptop by a factor of eight — and this platform is meant to run on
# whatever machine you happen to own.
#
# Override anything with an environment variable:
#   PG_MAX_CONNECTIONS=500 STORAGE_TYPE=hdd ./scripts/tune-postgres.sh
###############################################################################
set -euo pipefail

# ---------------------------------------------------------------- detection
if [[ -r /proc/meminfo ]]; then
  TOTAL_RAM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
elif command -v sysctl >/dev/null 2>&1; then
  TOTAL_RAM_KB=$(( $(sysctl -n hw.memsize) / 1024 ))
else
  echo "Cannot determine system memory on this platform." >&2
  exit 1
fi
TOTAL_RAM_MB=$(( TOTAL_RAM_KB / 1024 ))

CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

# Rotational disks need far more conservative random-IO assumptions.
detect_storage() {
  [[ -n "${STORAGE_TYPE:-}" ]] && { echo "$STORAGE_TYPE"; return; }
  local root_dev
  root_dev=$(findmnt -no SOURCE / 2>/dev/null | sed 's|/dev/||; s|[0-9]*$||; s|p$||') || true
  if [[ -n "$root_dev" && -r "/sys/block/$root_dev/queue/rotational" ]]; then
    [[ "$(cat "/sys/block/$root_dev/queue/rotational")" == "1" ]] && echo hdd || echo ssd
  else
    echo ssd
  fi
}
STORAGE=$(detect_storage)

# ---------------------------------------------------------------- derivation
MAX_CONNECTIONS="${PG_MAX_CONNECTIONS:-$(( CORES * 25 ))}"
(( MAX_CONNECTIONS < 100 )) && MAX_CONNECTIONS=100
(( MAX_CONNECTIONS > 500 )) && MAX_CONNECTIONS=500

# shared_buffers: 25% of RAM is the long-standing rule. Capped at 8 GB because
# past that point PostgreSQL's buffer manager stops being the bottleneck and
# the OS page cache does the job better.
SHARED_BUFFERS_MB=$(( TOTAL_RAM_MB / 4 ))
(( SHARED_BUFFERS_MB > 8192 )) && SHARED_BUFFERS_MB=8192
(( SHARED_BUFFERS_MB < 128 )) && SHARED_BUFFERS_MB=128

# effective_cache_size is a hint, not an allocation — it tells the planner how
# much data it can assume is cached. 75% of RAM less shared_buffers.
EFFECTIVE_CACHE_MB=$(( TOTAL_RAM_MB * 3 / 4 ))

# work_mem is per sort, per node, per connection. Multiply it by
# max_connections before believing the number: a generous work_mem with 300
# connections is how a laptop gets OOM-killed mid-query.
WORK_MEM_MB=$(( (TOTAL_RAM_MB / 4) / (MAX_CONNECTIONS * 2) ))
(( WORK_MEM_MB < 4 )) && WORK_MEM_MB=4
(( WORK_MEM_MB > 64 )) && WORK_MEM_MB=64

MAINTENANCE_WORK_MEM_MB=$(( TOTAL_RAM_MB / 16 ))
(( MAINTENANCE_WORK_MEM_MB < 64 )) && MAINTENANCE_WORK_MEM_MB=64
(( MAINTENANCE_WORK_MEM_MB > 2048 )) && MAINTENANCE_WORK_MEM_MB=2048

WAL_BUFFERS_MB=$(( SHARED_BUFFERS_MB / 32 ))
(( WAL_BUFFERS_MB < 4 )) && WAL_BUFFERS_MB=4
(( WAL_BUFFERS_MB > 16 )) && WAL_BUFFERS_MB=16

# random_page_cost tells the planner how much more a random read costs than a
# sequential one. The default of 4.0 assumes spinning rust and will steer the
# planner away from index scans it should be using on NVMe.
if [[ "$STORAGE" == "ssd" ]]; then
  RANDOM_PAGE_COST=1.1
  EFFECTIVE_IO_CONCURRENCY=200
else
  RANDOM_PAGE_COST=4.0
  EFFECTIVE_IO_CONCURRENCY=2
fi

PARALLEL_WORKERS=$CORES
PARALLEL_PER_GATHER=$(( CORES / 2 ))
(( PARALLEL_PER_GATHER < 2 )) && PARALLEL_PER_GATHER=2
(( PARALLEL_PER_GATHER > 8 )) && PARALLEL_PER_GATHER=8

# ------------------------------------------------------------------- output
cat <<EOF
# =============================================================================
# KAIROS DB — PostgreSQL configuration
# Generated $(date -Is) by scripts/tune-postgres.sh
#
# Detected:  ${TOTAL_RAM_MB} MB RAM · ${CORES} cores · ${STORAGE} storage
#
# Regenerate after changing hardware. Do not edit by hand — edit the script,
# so the reasoning stays with the number.
# =============================================================================

listen_addresses = '*'
max_connections = ${MAX_CONNECTIONS}

# ----- Memory -----------------------------------------------------------
shared_buffers = ${SHARED_BUFFERS_MB}MB
effective_cache_size = ${EFFECTIVE_CACHE_MB}MB
work_mem = ${WORK_MEM_MB}MB
maintenance_work_mem = ${MAINTENANCE_WORK_MEM_MB}MB

# ----- Write-ahead log --------------------------------------------------
wal_level = logical                  # required for realtime change capture
wal_buffers = ${WAL_BUFFERS_MB}MB
min_wal_size = 1GB
max_wal_size = 4GB

# Spread checkpoint IO over 90% of the interval. The default of 0.5 bunches
# writes into bursts, which on a laptop shows up as the whole platform
# stuttering every few minutes.
checkpoint_completion_target = 0.9
checkpoint_timeout = 15min

# ----- Planner ----------------------------------------------------------
random_page_cost = ${RANDOM_PAGE_COST}
effective_io_concurrency = ${EFFECTIVE_IO_CONCURRENCY}
default_statistics_target = 100

# ----- Parallelism ------------------------------------------------------
max_worker_processes = ${PARALLEL_WORKERS}
max_parallel_workers = ${PARALLEL_WORKERS}
max_parallel_workers_per_gather = ${PARALLEL_PER_GATHER}
max_parallel_maintenance_workers = ${PARALLEL_PER_GATHER}

# ----- Observability ----------------------------------------------------
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = all
track_io_timing = on
track_activity_query_size = 4096

log_min_duration_statement = 1000    # log anything over a second
log_connections = on
log_disconnections = on
log_lock_waits = on
log_temp_files = 0                   # any spill to disk means work_mem is low
log_checkpoints = on
log_line_prefix = '%m [%p] %q%u@%d '

# ----- Safety -----------------------------------------------------------
# statement_timeout is set per-connection by the API rather than globally:
# a 15s ceiling that is right for a dashboard query would kill a legitimate
# migration or a backup halfway through.
statement_timeout = 0
idle_in_transaction_session_timeout = 300000   # 5 min — reclaim abandoned txns
lock_timeout = 10000

# ----- Autovacuum -------------------------------------------------------
# More aggressive than default. This platform creates and drops tables
# constantly, and a laptop has no spare capacity to absorb a bloat crisis.
autovacuum = on
autovacuum_max_workers = 3
autovacuum_naptime = 30s
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.025
EOF

cat >&2 <<EOF

Derived from ${TOTAL_RAM_MB} MB RAM, ${CORES} cores, ${STORAGE} storage:

  max_connections        ${MAX_CONNECTIONS}
  shared_buffers         ${SHARED_BUFFERS_MB}MB
  effective_cache_size   ${EFFECTIVE_CACHE_MB}MB
  work_mem               ${WORK_MEM_MB}MB   (×${MAX_CONNECTIONS} connections × 2 nodes worst case
                                = $(( WORK_MEM_MB * MAX_CONNECTIONS * 2 ))MB if everything sorts at once)
  random_page_cost       ${RANDOM_PAGE_COST}

Apply it:
  ./scripts/tune-postgres.sh > infrastructure/postgres/postgresql.tuned.conf
  # mount it in docker-compose and add:
  #   command: postgres -c config_file=/etc/postgresql/postgresql.conf
  docker compose -f docker-compose.prod.yml restart postgres

Then benchmark before and after — see tests/benchmark/.
EOF
