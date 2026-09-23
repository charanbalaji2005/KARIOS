# Security

A platform whose whole job is to run other people's SQL has a large attack surface. This document records what is defended and, just as importantly, what is not.

## Passwords and tokens

- Passwords are hashed with **Argon2id**. Login always performs a verify — against a dummy hash when the email does not exist — so response timing does not leak account existence.
- Access tokens are short-lived JWTs. Refresh tokens are **rotated on every use**, and reuse of an already-rotated token is treated as theft: the entire token family is revoked and every session in it dies.
- Sessions are listable and individually revocable.
- Project end-user tokens are signed with a **per-project secret**, stored encrypted. A token minted for one project is meaningless in another.

## Secrets at rest

Database role passwords and per-project JWT secrets are encrypted with **AES-256-GCM** under `ENCRYPTION_KEY` (64 hex characters, validated at boot). API keys are stored as SHA-256 hashes — the plaintext is shown exactly once, at creation, and cannot be recovered afterwards.

Nothing in `.env` is committed. `env.ts` validates the whole environment with Zod and exits rather than starting half-configured.

## SQL injection

The platform executes user-authored DDL and SQL by design, so the boundary is drawn carefully:

- **Identifiers** (table, column, index, policy names) are matched against an allow-list regex, then quoted. Anything else is rejected outright — there is a test asserting that `users"; DROP TABLE x; --` does not get through.
- **Types** are matched against an allow-list of base types.
- **Values** are always parameter placeholders. No user value is ever interpolated into SQL text.
- **Statements** in the SQL runner are classified (`read` / `write` / `ddl` / `destructive`) and the classification is checked against the caller's role before execution. Reads run in a `READ ONLY` transaction.
- `SET LOCAL statement_timeout` bounds every query; connection and pool timeouts bound the rest.

## Authorization

RBAC roles: `owner` → `admin` → `developer` → `viewer`, with a permission matrix in `lib/rbac.ts`. Effective role is computed in SQL as the greater of the project and organization memberships. No endpoint trusts `role`, `user_id`, `project_id` or `organization_id` from a request body.

## Row Level Security

RLS is enforced by PostgreSQL, not by the API.

**`ENABLE ROW LEVEL SECURITY` is not enough on its own.** PostgreSQL exempts a
table's owner from its own policies, and the project's pooled role owns every
table it creates — so `ENABLE` alone leaves RLS inert for exactly the
connection the API uses. Table creation issues `FORCE ROW LEVEL SECURITY` as
well. If you create tables by hand, do the same, or your policies are
decorative.

**Realtime authorizes every row.** Subscribing to a table is permission to be
told *about* that table, not permission to read rows the policies would refuse
over REST. Each change event is checked against the subscriber's identity with
the same GUC mechanism REST uses, and anything that cannot be positively
confirmed visible is dropped. See [docs/AUDIT-RESPONSE.md](docs/AUDIT-RESPONSE.md). The API's only contribution is setting `request.jwt.claims` from a verified token via `SET LOCAL` inside the query transaction, so `auth.uid()` returns a value the client could not have forged. `service_role` keys deliberately bypass RLS and must therefore never be shipped to a browser — the dashboard only ever reveals them behind an explicit, audited, owner-only action.

## REST hardening

- Unfiltered `PATCH` and `DELETE` are rejected. Wiping a table requires saying so explicitly in SQL.
- Results are always bounded; `count=exact` returns a `Content-Range` header rather than unbounded rows.
- Filter columns are validated against live schema introspection, so you cannot filter on an invented identifier.

## Perimeter

Everything above the application is documented in
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md). In summary: default-deny firewall
with only 80 and 443 open; the `DOCKER-USER` chain closed so Docker cannot
publish a port past UFW; nginx as the sole gateway with per-route rate limits
and security headers; fail2ban jails fed by a dedicated plain-text security log;
and a Docker data-plane network declared `internal: true`, which has no gateway
— so PostgreSQL, Redis and object storage have no route to or from the internet
regardless of what anyone writes in a compose file later.

`./scripts/verify-security.sh <host>`, run from another machine, checks that the
data-plane ports are actually closed and that rate limiting actually fires.
Run it from the server itself and it only tells you what the loopback sees.

## Storage

`safePath()` rejects `..` sequences, absolute paths, control characters, null bytes and excessive depth before a key is built, which is what stops the classic `../../../../etc/passwd` shape. Uploads stream rather than buffer. Signed URLs carry explicit expiry. Public access is limited to buckets explicitly marked public, served from a separate `/storage/v1/public/` path.

The local disk driver adds a second check on top of `safePath()`: the resolved
absolute path must still sit inside the project's own directory. That is not
redundant — `safePath()` is one validator on one code path, and a resolved-path
comparison catches symlinks and unicode normalisation tricks that a regex on the
raw string never sees.

Its signed URLs are HMAC tokens over ref, key, action and expiry, keyed
separately from `JWT_SECRET` so that rotating or leaking one does not affect the
other. Expired, forged and malformed tokens all return the same message: telling
a caller which of the three it was is a free oracle.

## Outbound requests (SSRF)

The webhook worker runs inside the `internal: true` network, which the internet
cannot route to. A user-supplied URL would therefore make it a proxy into the
private network — `http://postgres:5432`, `http://redis:6379`,
`http://169.254.169.254/`, the router.

`lib/ssrf.ts` resolves every address a hostname maps to, rejects private and
reserved ranges including IPv4-mapped IPv6, and **pins the connection to the
address it checked**. That pinning is what defeats DNS rebinding: checking a
name and then fetching it by name leaves a gap for the attacker to answer the
second lookup differently. Redirects are refused. URLs are re-vetted on every
delivery, because DNS is mutable.

## Webhooks

Bodies are signed with HMAC-SHA256 as `x-kairos-signature`. Verify it on your side with a constant-time comparison. Deliveries time out after 10 seconds, are retried with exponential backoff, and every attempt is recorded.

## CORS

Two surfaces, two policies. The dashboard API is cookie-authenticated and takes
a strict origin allow-list with credentials permitted. The data plane is
API-key authenticated, accepts any origin, and **never** sets
`access-control-allow-credentials` — a public anon key in a browser is public
by definition, but it must not be paired with the user's dashboard session.

Reflecting every origin while allowing credentials, which this replaced, is
CSRF with extra steps.

## Transport and headers

`helmet` sets CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and HSTS. CORS is configured per environment and does not default to `*` for authenticated endpoints. Cookies are `httpOnly`, `sameSite` and `secure` outside development.

## Rate limiting

Redis fixed-window limiters with distinct budgets per class: authentication, general API, SQL execution, storage uploads and password reset. Exceeding a budget returns `429` with retry information.

## Auditing

Privileged actions write an audit row capturing actor, organization, project, action, resource type and id, metadata, IP and user agent. Query logs record statement, duration, rows, success and error. Both are read-only to ordinary project users.

## Errors

A single error handler emits `{ data: null, error: { code, message } }` using a fixed code vocabulary. Stack traces are never returned; the detail goes to the structured pino log, which redacts `authorization`, `apikey`, `cookie` and `password`.

## Client IP trust

`TRUST_PROXY_HOPS` must match the number of proxies actually in front of the
API — 0 direct, 1 behind nginx, 2 behind Cloudflare and nginx. The blanket
`trustProxy: true` this replaced trusts every hop, which means any client can
set `X-Forwarded-For` and pick its own apparent address: rate limits stop
working and an attacker can get an innocent IP banned.

The matching risk at the edge is a stale Cloudflare IP list. If
`cloudflare-realip.conf` is out of date, real client IPs are replaced by
Cloudflare's, and fail2ban eventually bans a Cloudflare edge node — taking a
slice of your users offline alongside the attacker. Refresh it monthly with
`scripts/update-cloudflare-ips.sh`.

## Known limitations

Be honest with yourself before deploying this:

- The provisioner holds superuser credentials. That process is the crown jewel — isolate it.
- Project databases share one PostgreSQL instance. Isolation is by role and database, not by machine. A determined tenant with `CREATE FUNCTION` rights is in the same blast radius as every other tenant.
- There is no CPU, memory or disk quota per project. A runaway query is bounded by `statement_timeout` and nothing else.
- OAuth, invitations, and the admin surface are unimplemented.
- CSRF protection applies to cookie-authenticated routes only; the token-authenticated API assumes bearer usage.
- No dependency scanning or SBOM in CI yet.
- MFA/TOTP is not implemented. Neither are OAuth flows.
- Backups are not encrypted at rest. If you sync them offsite, the destination bucket's encryption is all that protects them.
- Disk encryption is not configured. Anyone holding the laptop holds the database.
- The fail2ban filters depend on the exact format of the security log line. Change `lib/security-log.ts` and the jails stop matching silently — a filter that matches nothing produces a jail that bans nobody, and `fail2ban-client status` looks identical either way. Re-run `fail2ban-regex` after any change and check the match count.
- The seed account (`dev@kairosdb.local`) is development-only, and `db:seed` refuses to run under `NODE_ENV=production`. Do not weaken that check.

## Reporting

This is a portfolio project, not a maintained product. If you are reusing the code and find a flaw, open an issue — but do not treat this as production-audited software.
