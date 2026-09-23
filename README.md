# KAIROSDB

A self-hostable Database-as-a-Service platform built on PostgreSQL — the same shape of product as Supabase, implemented from the control plane down.

Sign up, create a project, and KAIROSDB provisions you a real PostgreSQL database with its own role and credentials, an auto-generated REST API over your tables, row-level security wired to JWT claims, WebSocket realtime, S3-compatible object storage, webhooks, migrations and `pg_dump` backups.

PostgreSQL is the actual database engine. KAIROSDB is the platform around it.

---

## Quickstart

```bash
git clone <repository>
cd kairosdb

pnpm install
cp .env.example .env

# Generate the three secrets (.env will not validate without them)
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> JWT_REFRESH_SECRET
openssl rand -hex 32   # -> ENCRYPTION_KEY  (must be exactly 64 hex chars)

docker compose up -d   # postgres 17 + pgvector, redis, minio
pnpm db:migrate        # control-plane schema
pnpm db:seed           # development-only account + demo project
pnpm dev
```

Running it as a real server on your own machine — firewall, nginx, TLS, fail2ban — is a different job. One command does it:

```bash
sudo ./scripts/bootstrap.sh          # packages, Docker, secrets, firewall, jails, stack
./scripts/verify-security.sh <host>  # run this from ANOTHER machine
```

See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

Once it is running, the admin panel can manage the machine itself — services,
logs, firewall, storage, backups, and a real terminal:

```bash
sudo ./scripts/install-server.sh     # agent, directories, firewall, systemd
kairos server status                 # live state of the Ubuntu host
```

Then **Admin → Server** in the dashboard. The API never touches the host
directly: it asks a root-owned agent over a Unix socket to perform one of a
fixed set of named operations, so there is no endpoint anywhere that accepts a
command to run. See [docs/SERVER-CONSOLE.md](docs/SERVER-CONSOLE.md).

| Service         | URL                     |
| --------------- | ----------------------- |
| Dashboard       | http://localhost:3000   |
| API             | http://localhost:4000   |
| MinIO console   | http://localhost:9001   |
| Postgres        | localhost:5432          |

**Development seed account** — `dev@kairosdb.local` / `kairosdb-dev-password`.
This exists only for local development. `db:seed` refuses to run when `NODE_ENV=production`.

---

## What a project gets

Creating a project runs the provisioner, which:

1. generates a random role password and encrypts it (AES-256-GCM) before storing it,
2. `CREATE ROLE` + `CREATE DATABASE` for the project,
3. installs `pgcrypto`, `uuid-ossp` and `vector`,
4. creates the `auth` schema with `auth.jwt()`, `auth.uid()` and `auth.role()` reading the `request.jwt.claims` GUC,
5. installs `public.kairos_notify_change()` for realtime,
6. creates a project-local `schema_migrations` table,
7. mints an `anon` key and a `service_role` key (shown once, stored as hashes),
8. creates a default `public` storage bucket.

You are then handed:

```
Project ref        abcdefghijkl
REST URL           http://localhost:4000/rest/v1
Realtime URL       ws://localhost:4000/realtime/v1
Storage URL        http://localhost:4000/storage/v1
anon key           krs_anon_...
service_role key   krs_srv_...       (server-side only)
Direct connection  postgres://<role>:<password>@localhost:5432/<db>
```

---

## Using it

### REST

```bash
curl "http://localhost:4000/rest/v1/profiles?active=eq.true&select=id,email&order=created_at.desc&limit=20" \
  -H "apikey: krs_anon_..."
```

Operators: `eq neq gt gte lt lte like ilike is in cs cd`. Supports `select`, `order`, `limit`, `offset`, `count=exact` (returns `Content-Range`).
`anon` requests run with RLS enforced and the JWT claims applied; `service_role` bypasses RLS. Unfiltered `PATCH`/`DELETE` are rejected.

### SDK

```ts
import { createClient } from "@kairosdb/client";

const db = createClient("http://localhost:4000", "krs_anon_...");

const { data, error } = await db.from("profiles").select("*").eq("active", true);

await db.storage.from("avatars").upload("me.png", file);

db.channel("profiles")
  .on("postgres_changes", { event: "*", table: "profiles" }, console.log)
  .subscribe();
```

### CLI

```bash
kairos login
kairos projects create my-app
kairos projects use my-app
kairos db url
kairos migration create add_profiles
kairos migration push
kairos generate types > database.types.ts
```

---

## Repository layout

```
kairosdb/
├── apps/dashboard/        Next.js 14 dashboard (table editor, SQL editor, keys, overview)
├── services/api/          Fastify API — auth, provisioning, DDL, SQL, REST, realtime,
│   └── src/workers/       storage, webhooks, migrations, backups; BullMQ workers
├── packages/client/       @kairosdb/client TypeScript SDK
├── packages/types/        Shared types
├── cli/                   `kairos` command-line tool
├── tests/integration/     Vitest suites (full API flow + SQL guard unit tests)
├── infrastructure/
│   ├── nginx/             gateway config, vhosts, TLS and header snippets
│   ├── firewall/          UFW, nftables, DOCKER-USER, Windows
│   ├── fail2ban/          jails and filters
│   ├── cloudflared/       tunnel ingress
│   ├── monitoring/        Prometheus scrape config and alert rules
│   └── postgres/          init SQL
├── scripts/               bootstrap, verify-security, backups, TLS, pg tuning
├── docker-compose.yml     development
├── docker-compose.prod.yml  segmented networks, no public data-plane ports
└── docs/
```

Docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) · [docs/NETWORKING.md](docs/NETWORKING.md) · [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) · [docs/PERFORMANCE.md](docs/PERFORMANCE.md) · [docs/QUOTAS.md](docs/QUOTAS.md) · [docs/AUDIT-RESPONSE.md](docs/AUDIT-RESPONSE.md) · [docs/P1-P2.md](docs/P1-P2.md) · [docs/API.md](docs/API.md) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/CLI.md](docs/CLI.md) · [docs/SERVER-CONSOLE.md](docs/SERVER-CONSOLE.md)

---

## Commands

```bash
pnpm dev            # everything in watch mode
pnpm build
pnpm typecheck
pnpm test           # integration tests need the stack running
pnpm test:security  # SSRF, quota and SQL-guard units — no stack needed
pnpm e2e            # Playwright, full browser journey
pnpm bench:load     # concurrency ladder — finds where this machine saturates
pnpm db:migrate
pnpm db:seed
pnpm docker:up / docker:down / docker:logs

pnpm docker:prod       # segmented networks, nginx, no exposed data plane
pnpm security:verify   # perimeter check — run from another machine
pnpm bench             # p50/p95/p99 against your own hardware
pnpm pg:tune           # derive postgresql.conf from this machine's RAM/cores/disk
pnpm backup:run        # dump, rotate, verify, sync offsite
```

---

## Status

Built and wired end to end:

auth (Argon2id, refresh-token rotation with reuse detection, MFA/TOTP with backup codes, Google and GitHub OAuth with PKCE, sessions, password reset) · organizations, invitations and member roles · a platform admin surface · database provisioning · schema introspection · table/column/constraint/index DDL · RLS policy management · SQL runner with statement classification and timeouts · API keys · auto REST · realtime with per-row RLS authorization (LISTEN/NOTIFY → Redis → authorize → WebSocket) · storage with a swappable driver (local disk or S3/MinIO) and signed URLs · webhooks with HMAC signing, retry and SSRF protection · migrations with checksum tamper detection · `pg_dump` backups streamed to storage and verified by reading them back · audit and query logs · real host metrics · per-project resource quotas · generated OpenAPI 3.1 and a rendered reference · CSV/JSON import and export · query plan analysis · per-endpoint p50/p95/p99 histograms and W3C trace ids · TypeScript type generation · SDK · CLI · dashboard.

Edge and operations:

nginx gateway (TLS, four vhosts, two-tier rate limiting, WebSocket proxying, security headers) · UFW and nftables rulesets plus the `DOCKER-USER` fix for Docker bypassing the firewall · fail2ban jails fed by a purpose-built security event log · segmented Docker networks with an `internal: true` data plane · Cloudflare Tunnel config · hardware-aware PostgreSQL tuning · backup rotation with `pg_restore` verification · a benchmark suite that reports p50/p95/p99 · Prometheus metrics and alert rules · a perimeter verification script.

An external audit of this repository found 39 issues. Every one rated *must fix before public deployment* is fixed — realtime RLS authorization, webhook SSRF, the connection budget, real backup verification, CORS, secure remote database access, and the tests that would have caught them. [docs/AUDIT-RESPONSE.md](docs/AUDIT-RESPONSE.md) records what was fixed, what was deliberately left alone, and what is still open.

Scaffolded but not implemented — the architecture makes room for them, the code does not exist yet:

OAuth (Google/GitHub) flows · MFA/TOTP · organization invitations · admin dashboard (quota changes are gated by an email allow-list, not a role) · command palette and global search · GraphQL · OpenAPI/Swagger · OpenTelemetry tracing · Grafana dashboards · CSV/JSON import-export UI · visual query builder · API explorer · schema relationship diagram UI · read replicas and PgBouncer · Kubernetes manifests · Playwright end-to-end tests.

This is a portfolio project, not a hosted product. Read [SECURITY.md](SECURITY.md) and [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) before pointing it at anything real.

## License

MIT
#   K A R I O S  
 