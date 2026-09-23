# Performance

Two rules govern everything here.

**Keep the database path short.** The critical path is nginx → Fastify → `pg.Pool` → PostgreSQL, with nothing in between. Redis is used where it earns its place — rate limits, pub/sub fan-out, job queues — and never sits between the API and a query.

**Never quote a latency number you did not measure.** Every figure below is something you produce on your own hardware, not something this document tells you.

---

## Measuring

```bash
pnpm db:seed          # need a project and an account to hit
pnpm bench
```

```
BENCH_URL=https://api.example.com   target (default localhost:4000)
BENCH_CONCURRENCY=16                parallel workers
BENCH_DURATION=10                   seconds per case
BENCH_WARMUP=3                      discarded before recording
BENCH_ANON_KEY=krs_anon_...         enables the auto-REST case
BENCH_JSON=results.json             write a machine-readable summary
```

Cases run: `/api/health` (no database), an authenticated single-query route, schema introspection, `SELECT 1` through the SQL runner, and auto-REST with RLS on.

### Reading the output

The warm-up window is discarded because the first samples measure JIT compilation, a cold pool and an empty page cache. Real costs, but not the steady state anyone is trying to learn.

`p50`, `p95` and `p99` are reported; the mean is shown but not headlined. A mean of 12ms made of 11ms requests and the occasional 900ms stall describes an experience nobody has had.

- **p99 far above p95** — usually checkpoint stalls, autovacuum, or a laptop thermal-throttling. Not slow queries. Check the Server page in the dashboard before touching a query plan.
- **`/api/health` itself slow** — the bottleneck is the event loop or the proxy, not PostgreSQL.
- **Everything slow over a tunnel** — network round-trip dominates and no amount of database tuning moves p50. Benchmark on the LAN to see what the machine can actually do, then accept the WAN number for what it is.

---

## Tuning PostgreSQL

```bash
./scripts/tune-postgres.sh > infrastructure/postgres/postgresql.tuned.conf
```

It reads the machine's RAM, core count and whether the root device is rotational, then derives `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, WAL and checkpoint settings, `random_page_cost`, `effective_io_concurrency` and the parallelism limits. It prints the reasoning to stderr so you can see what it concluded and why.

Nothing in it is a fixed number copied from a blog post. The right `shared_buffers` for a 64 GB workstation is wrong on an 8 GB laptop by a factor of eight, and this platform is meant to run on whichever one you own.

Two settings worth understanding before you override them:

**`work_mem` is per sort, per node, per connection.** Multiply it by `max_connections` before believing it. A generous `work_mem` with 300 connections is how a laptop gets OOM-killed mid-query. The script prints that worst-case total.

**`random_page_cost` defaults to 4.0**, which assumes a spinning disk. On NVMe that steers the planner away from index scans it should be using. The script sets 1.1 when it detects an SSD.

Mount the result and restart:

```yaml
volumes:
  - ./infrastructure/postgres/postgresql.tuned.conf:/etc/postgresql/postgresql.conf:ro
command: postgres -c config_file=/etc/postgresql/postgresql.conf
```

Then **benchmark again**. Tuning often changes nothing measurable, and knowing that is worth more than assuming it helped.

---

## What the platform already does

- **Connection pooling.** One `pg.Pool` per project, cached, with an idle reaper. Connections are never opened per request.
- **Parameterised queries everywhere.** No user value is ever interpolated into SQL text — which is a security property first and a prepared-statement-reuse property second.
- **Bounded results.** Every REST and row-browsing endpoint has a limit. `count=exact` returns a `Content-Range` header instead of unbounded rows.
- **Streaming.** Uploads and downloads stream through the storage driver; `pg_dump` pipes straight into storage without staging on disk.
- **Statement timeouts.** `SET LOCAL statement_timeout` per query, so one runaway cannot hold a connection forever.
- **Background work off the request path.** Webhooks, backups and email go to BullMQ.
- **Compression and keep-alive** at nginx, with upstream keepalive pools.
- **`pg_stat_statements`** preloaded, with a `query_logs` fallback for the per-project view.

---

## What is not done

- **No CPU or memory partitioning per project.** Quotas now cover database size, storage, file size, tables, connections, API requests and background jobs ([QUOTAS.md](QUOTAS.md)) — but PostgreSQL does not divide CPU between databases, so one expensive query still slows everyone, bounded only by `statement_timeout`.
- **No PgBouncer.** `pg.Pool` is adequate until you have many projects with many idle connections; after that, transaction pooling belongs in `ConnectionManager`.
- **No read replicas.** The seam exists (`ConnectionManager` decides where a query goes) but there is nothing to route to.
- **No p50/p95/p99 tracking in production.** The benchmark measures on demand; the API does not export request-latency histograms. `infrastructure/monitoring/` has the scrape config to hang that off, but the histograms are not implemented.
- **No load testing beyond this suite.** No sustained soak test, no test of what happens when the disk fills mid-write.
