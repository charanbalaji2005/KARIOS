# Architecture

## The split that matters

KAIROSDB separates a **control plane** (who owns what, which databases exist, which keys are valid) from a **data plane** (the user's actual PostgreSQL databases). They live in different databases with different credentials, and the control plane never lets a user's request reach the data plane without first resolving identity and role in SQL.

```
                        Browser / SDK / CLI
                                 │
                    ┌────────────┴────────────┐
                    │      Fastify API        │
                    │  helmet · cors · rate   │
                    │  limit · auth plugin    │
                    └────────────┬────────────┘
                                 │
        ┌────────────────┬───────┴───────┬────────────────┐
        ▼                ▼               ▼                ▼
  CONTROL PLANE     DATA PLANE       STORAGE          EVENTS
  kairos_platform    project DBs      MinIO / S3       Redis + BullMQ
  (one pool)        (pool manager)   (one bucket      (webhooks,
                                      per project)     backups, email)
```

## Request pipeline

Every protected route goes through the same sequence, in this order:

```
Request → CORS → rate limit → authenticate → authorize → validate (Zod) → handler → database
```

Identity is never read from the request body. `project_id`, `organization_id`, `user_id` and `role` are all resolved server-side:

- `requireUser` verifies the dashboard access token and loads the user.
- `requireProject(permission)` takes the project ref from the URL, then resolves the caller's effective role as `GREATEST(project membership, organization membership)` **in a single SQL query**, and checks it against the RBAC permission matrix in `lib/rbac.ts`.
- `requireApiKey` hashes the presented key and looks up the matching non-revoked row, which carries the project and the key kind (`anon` / `service_role` / `secret`).

## Control plane

`kairos_platform` holds users, sessions, email tokens, organizations and members, projects, project members, encrypted database connections, API keys, storage buckets and objects, webhooks and deliveries, migrations, backups, audit logs, query logs and usage metrics. All UUID keys, all timestamped.

Migrations live in `services/api/src/db/migrations/` and are applied by a small checksum-guarded runner: each file is hashed, recorded, and re-running a file whose contents changed is an error rather than a silent no-op.

## Data plane

`DatabaseProvisioner` (`modules/provisioner.ts`) is the only component that holds the superuser connection (`PROVISIONER_URL`). It creates the role and database, installs extensions, and builds the `auth` schema:

```sql
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb
$$;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
```

Those claims are set by the API — never by the client — with `SET LOCAL` inside the transaction that runs the user's query. That is the whole trick behind RLS: a policy like `using (auth.uid() = user_id)` is enforced by PostgreSQL itself, on a value PostgreSQL got from a GUC that only the API can write.

`ConnectionManager` (`db/pool-manager.ts`) keeps one `pg.Pool` per project, decrypts credentials on first use, caches the pool, and reaps pools that have been idle. Connections are never opened per request.

`lib/sql.ts` is the injection boundary. Identifiers pass through an allow-list regex before being quoted; types are checked against an allow-list of base types (including `vector`); every statement is classified as `read`, `write`, `ddl` or `destructive`, and the classification decides which role is allowed to run it.

## Auto-generated REST

`modules/rest.routes.ts` turns `/rest/v1/:table` into PostgREST-shaped CRUD. The query string is parsed into a filter AST, every identifier is validated against live introspection of the project schema, and the SQL is built with parameter placeholders — never string interpolation of values.

Before the query runs, `withIdentity()` opens a transaction and sets `request.jwt.claims` plus `row_security`. A `service_role` key sets `row_security = off`; an `anon` key leaves it on, so the user's own policies decide what comes back.

## Realtime

```
INSERT/UPDATE/DELETE
  → kairos_notify_change() trigger
  → pg_notify('kairos_realtime', payload)
  → per-project LISTEN client in the API
  → Redis PUBLISH realtime:<ref>:<table>
  → psubscribe bridge → WebSocket fan-out to subscribed clients
```

Redis sits in the middle so that multiple API instances each hold their own WebSocket connections but share one stream of database events. Payloads over ~7.5 KB are truncated (PostgreSQL's notify limit), and clients only receive topics they explicitly subscribed to after authenticating with an API key.

## Storage

One physical MinIO bucket per project (`kairos-<ref>`); logical buckets are key prefixes inside it. Uploads stream through `@aws-sdk/lib-storage` — large files never sit in Node's heap. `safePath()` rejects traversal sequences, control characters and excessive nesting before a key is ever constructed.

## Background work

BullMQ queues on Redis:

- **webhooks** — HMAC-SHA256 signs the body as `x-kairos-signature`, 10 s abort timeout, writes a delivery row, and throws on failure so BullMQ applies exponential backoff.
- **backups** — `pg_dump --format=custom` is piped *directly* into an S3 multipart upload. The dump never touches local disk.
- **email** — SMTP when configured, otherwise logged.

## The edge

`nginx` terminates TLS and routes four vhosts (dashboard, api, realtime,
storage), each with limits suited to its traffic: 5 MB bodies on the API, 1 GB
and unbuffered streaming on storage, buffering off and hour-long timeouts on
realtime. Unknown hostnames get `return 444` — connection closed, nothing
learned.

Rate limiting is two layers on purpose. Nginx sees IP addresses and nothing
else, so it caps 1 r/s on auth routes and 15 r/s on the API; the application
keeps Redis limiters keyed on IP *and* user *and* API key, because one
authenticated client spread across fifty addresses is invisible to nginx.

Fail2Ban is fed by `lib/security-log.ts`, which writes a second, plain-text copy
of security events because fail2ban cannot parse pino's JSON. Most events are
emitted centrally from the error handler keyed on the error code, so a new route
cannot forget to log them.

`TRUST_PROXY_HOPS` replaces Fastify's `trustProxy: true`. Trusting every hop
lets any client set `X-Forwarded-For` and choose its own apparent IP, which
defeats rate limiting and lets it frame an innocent address for a ban.

## Performance

The critical path is deliberately short: nginx → Fastify → `pg.Pool` →
PostgreSQL. No service sits between the API and the database. Redis is used
where it earns its place — rate limits, pub/sub fan-out, job queues, sessions —
and nowhere else.

`scripts/tune-postgres.sh` derives `shared_buffers`, `work_mem`,
`effective_cache_size`, `random_page_cost` and the parallelism settings from the
machine's actual RAM, core count and whether the disk is rotational. Fixed
values copied from a blog post are wrong by a factor of eight between an 8 GB
laptop and a 64 GB workstation, and this platform is meant to run on whichever
you own.

`tests/benchmark/` measures p50, p95 and p99 under load. Means are not
headlined: a mean of 12ms made of 11ms requests and occasional 900ms stalls
describes an experience nobody has had. On a laptop the tail is where checkpoint
stalls, autovacuum and thermal throttling appear.

## Scaling seams

The abstractions that would need to change for real scale are already isolated: `DatabaseProvisioner` (where databases get placed), `ConnectionManager` (where pooling or PgBouncer goes), and the Redis pub/sub bridge (which already assumes more than one API process). Read replicas would slot in as a routing decision inside `ConnectionManager` rather than a rewrite of every route.

## Frontend

Next.js 14 App Router, TanStack Query, Monaco for the SQL editor. `lib/api.ts` owns the envelope contract (`{ data, error }`), holds the access token, and transparently retries once through `/auth/refresh` on a 401. The dashboard never holds database credentials and never talks to PostgreSQL directly.
