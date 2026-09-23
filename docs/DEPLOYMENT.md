# Deployment

## Local

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed      # development only
pnpm dev
```

`docker-compose.yml` brings up PostgreSQL 17 (`pgvector/pgvector:pg17`, with `pg_stat_statements` preloaded and `wal_level=logical`), Redis, MinIO, the API, the worker and the dashboard, each with a healthcheck and a named volume (`pgdata`, `redisdata`, `miniodata`).

```bash
docker compose logs -f api
docker compose restart worker
docker compose down          # add -v to wipe volumes
```

## Environment

Every variable is validated by Zod at boot; the process exits rather than starting misconfigured.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | control plane (`kairos_platform`) |
| `PROVISIONER_URL` | **superuser** — used only to `CREATE ROLE` / `CREATE DATABASE` |
| `PROJECT_DB_HOST` / `PROJECT_DB_PORT` | what users see in their connection strings |
| `REDIS_URL` | |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | exactly 64 hex characters |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` | |
| `API_URL`, `FRONTEND_URL`, `NEXT_PUBLIC_API_URL` | |
| `SMTP_*`, `MAIL_FROM` | unset in dev → mail is logged |
| `PORT`, `LOG_LEVEL`, `NODE_ENV` | |

## Building images

```bash
docker build -t kairosdb/api       -f services/api/Dockerfile .
docker build -t kairosdb/dashboard -f apps/dashboard/Dockerfile .
```

Both are multi-stage. The API image includes `postgresql-client` because the backup worker shells out to `pg_dump`; the dashboard uses Next.js `standalone` output.

## Going to production

The pieces you must change before this is safe to expose:

1. **Rotate every secret.** Nothing in `.env.example` is a credential, it is a placeholder.
2. **Do not run `db:seed`.** It refuses under `NODE_ENV=production`; leave that check alone.
3. **Give the provisioner its own isolated deployment** with the superuser credential, reachable only from the API's network. Do not run it on a public-facing container.
4. **Terminate TLS** in front of the API and dashboard (nginx, Caddy or your platform's load balancer) and set `FRONTEND_URL`/`API_URL` to `https://` origins so cookies are issued `secure`.
5. **Set CORS** to your real dashboard origin.
6. **Persist and back up `pgdata`.** The backup worker backs up *project* databases; the control plane is your responsibility.
7. **Put a connection pooler** (PgBouncer) in front of PostgreSQL once you have more than a handful of projects. `ConnectionManager` is where that routing change belongs.

## Scaling shape

The API is stateless apart from WebSocket connections, so it scales horizontally behind a load balancer: each instance runs its own `LISTEN` clients and its own socket fan-out, and Redis pub/sub keeps them consistent. Workers scale independently — add BullMQ consumers without touching the API.

Read replicas, sharding and regional placement all slot into `DatabaseProvisioner` and `ConnectionManager` rather than requiring changes to route handlers.

## Production

`docker-compose.prod.yml` is written and is the file to use. It differs from the
development compose in the way that matters: PostgreSQL, Redis and MinIO have
no `ports:` mapping and sit on a network declared `internal: true`. There is no
route from the outside to port 5432, so no misconfiguration elsewhere can
expose it.

```bash
sudo ./scripts/bootstrap.sh              # everything, on a fresh Ubuntu machine
pnpm docker:prod                         # or just the stack
./scripts/verify-security.sh <host>      # from another machine
```

Optional compose profiles:

```bash
--profile tunnel     cloudflared — public hostname with zero inbound ports
--profile security   fail2ban (host network, NET_ADMIN)
--profile tls        certbot auto-renewal
--profile offsite    rclone sync of backups to a remote
```

Tune PostgreSQL for the machine it is actually running on:

```bash
./scripts/tune-postgres.sh > infrastructure/postgres/postgresql.tuned.conf
```

Then measure, before and after:

```bash
pnpm bench
```

The full edge setup — firewall, nginx vhosts, fail2ban jails, Cloudflare Tunnel,
monitoring, backup rotation — is documented in
[SELF-HOSTING.md](SELF-HOSTING.md).

## Still not included

Kubernetes manifests, Grafana dashboards, and an OpenTelemetry collector.
`infrastructure/monitoring/` has the Prometheus scrape config and alert rules
but nothing renders them yet; the dashboard's Server page covers day-to-day use.
