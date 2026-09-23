# API Reference

Base: `http://localhost:4000`
Platform routes are prefixed `/api/v1`. The data-plane routes (`/rest/v1`, `/realtime/v1`, `/storage/v1/public`) are unprefixed so they can be handed to end users directly.

## Envelope

```json
{ "data": [], "error": null, "meta": { "page": 1, "limit": 50 } }
```

```json
{ "data": null, "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

Codes: `AUTH_REQUIRED` `INVALID_TOKEN` `FORBIDDEN` `NOT_FOUND` `PROJECT_NOT_FOUND` `TABLE_NOT_FOUND` `DATABASE_ERROR` `VALIDATION_ERROR` `RATE_LIMITED` `QUOTA_EXCEEDED` `STORAGE_ERROR` `CONFLICT` `INTERNAL_ERROR`.

## Authentication

Dashboard requests: `Authorization: Bearer <access token>`.
Data-plane requests: `apikey: <anon|service_role key>`, optionally plus `Authorization: Bearer <project end-user token>` to populate `auth.uid()`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/auth/signup` | creates user + personal organization |
| POST | `/api/v1/auth/login` | returns access + refresh tokens |
| POST | `/api/v1/auth/refresh` | rotates; reuse revokes the token family |
| POST | `/api/v1/auth/logout` | |
| GET | `/api/v1/auth/me` | |
| GET | `/api/v1/auth/sessions` | |
| DELETE | `/api/v1/auth/sessions/:id` | |
| POST | `/api/v1/auth/password/forgot` · `/reset` | |
| POST | `/api/v1/auth/verify-email` | |

## Organizations and projects

| Method | Path |
| --- | --- |
| GET / POST | `/api/v1/organizations` |
| GET / POST | `/api/v1/projects` |
| GET | `/api/v1/projects/:ref` |
| GET | `/api/v1/projects/:ref/connection` — `?reveal=true` is owner-only and audited |
| DELETE | `/api/v1/projects/:ref` — body must confirm the project ref |
| GET / POST | `/api/v1/projects/:ref/keys` |
| DELETE | `/api/v1/projects/:ref/keys/:keyId` |
| POST | `/api/v1/projects/:ref/tokens` — mint an end-user token for this project |

`POST /projects` returns the `anon` and `service_role` keys **once**. They are not retrievable afterwards.

## Database

| Method | Path |
| --- | --- |
| GET | `/api/v1/projects/:ref/database/tables` |
| GET | `/api/v1/projects/:ref/database/tables/:table` — columns, constraints, indexes, policies |
| GET | `/api/v1/projects/:ref/database/tables/:table/rows` — paginated browsing |
| GET | `/api/v1/projects/:ref/database/relationships` · `/extensions` |
| POST / PATCH / DELETE | `/api/v1/projects/:ref/database/tables[/:table]` |
| POST / PATCH / DELETE | `.../tables/:table/columns[/:column]` |
| POST | `.../tables/:table/constraints` — pk, unique, fk, check |
| POST / DELETE | `.../tables/:table/indexes` — btree, gin, gist, brin, ivfflat, hnsw |
| POST / DELETE | `.../tables/:table/policies[/:policy]` — RLS |
| POST | `.../tables/:table/realtime` — toggle the change trigger |

## SQL

```http
POST /api/v1/projects/:ref/sql
{ "query": "select * from profiles limit 10", "timeoutMs": 15000 }
```

Reads run inside a `READ ONLY` transaction. DDL and destructive statements require the matching role. Every execution is logged.

`GET .../sql/history` · `GET .../sql/stats` (pg_stat_statements, falling back to query logs).

## Auto REST

```
GET    /rest/v1/:table
POST   /rest/v1/:table
PATCH  /rest/v1/:table?<filter>
DELETE /rest/v1/:table?<filter>
```

Filters are `column=op.value`:

```
?active=eq.true&age=gte.18&name=ilike.*ada*&status=in.(open,pending)&deleted_at=is.null
```

`eq neq gt gte lt lte like ilike is in cs cd`

Modifiers: `select=id,email`, `order=created_at.desc`, `limit`, `offset`.
Send `Prefer: count=exact` to get a `Content-Range` header.

`PATCH` and `DELETE` without a filter are rejected.

## Storage

| Method | Path |
| --- | --- |
| GET / POST | `/api/v1/projects/:ref/storage/buckets` |
| DELETE | `.../buckets/:bucket` |
| GET | `.../buckets/:bucket/objects` |
| POST | `.../buckets/:bucket/upload` — multipart, streamed |
| GET | `.../buckets/:bucket/download?path=` |
| POST | `.../buckets/:bucket/signed-url` — `{ "path": "...", "expiresIn": 3600, "method": "get" \| "put" }` |
| DELETE | `.../buckets/:bucket/objects?path=` |
| GET | `/storage/v1/public/:ref/:bucket/*` — public buckets only |

## Realtime

```
ws://localhost:4000/realtime/v1?apikey=<key>&token=<optional project token>
```

Frames:

```json
{ "type": "subscribe",   "table": "profiles", "event": "*" }
{ "type": "unsubscribe", "table": "profiles" }
{ "type": "ping" }
```

Server pushes `{ "type": "change", "table", "event", "record", "old_record" }`.
`GET /api/v1/projects/:ref/realtime/status` reports listener counts.

## Operations

| Method | Path |
| --- | --- |
| GET / POST | `/api/v1/projects/:ref/webhooks` |
| DELETE | `.../webhooks/:id` |
| GET | `.../webhooks/:id/deliveries` |
| POST | `.../webhooks/:id/test` |
| GET / POST | `.../migrations` |
| GET | `.../migrations/:id/preview` — flags destructive statements |
| POST | `.../migrations/:id/apply` · `/rollback` — checksum verified before apply |
| GET / POST | `.../backups` — `pg_dump` streamed to object storage |
| GET | `.../logs/audit` |
| GET | `.../usage` |
| GET | `.../types` — generated TypeScript `Database` interface |

## Quotas

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/projects/:ref/quotas` | limits, sampled usage, per-resource summary |
| GET | `/api/v1/projects/:ref/quotas/violations` | what was refused and when |
| POST | `/api/v1/projects/:ref/quotas/resample` | force a fresh measurement |
| PATCH | `/api/v1/projects/:ref/quotas` | raise or lower — platform operator only |
| GET | `/api/v1/quotas/defaults` | what a new project receives |

Exceeding a quota returns **413 `QUOTA_EXCEEDED`**, not 429: retrying the same
request will never succeed. See [QUOTAS.md](QUOTAS.md).

## Server

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/server/metrics` | measured CPU, memory, disk, network, PostgreSQL, Redis |
| GET | `/api/v1/server/prometheus` | same figures in text exposition format |

Both require an authenticated platform user. Host metrics tell an attacker when
you are loaded and where the disk pressure is, which is free reconnaissance.

## Signed URLs

`POST /api/v1/projects/:ref/storage/buckets/:bucket/signed-url` returns a URL
whose shape depends on `STORAGE_DRIVER`:

- **s3** — a presigned S3 URL, verified by the storage endpoint.
- **local** — `/storage/v1/signed/:token`, an HMAC over ref, key, action and
  expiry, verified by the API. Unauthenticated by design: holding a valid,
  unexpired token *is* the authorisation.

## Health

`GET /api/health` · `GET /api/ready` (probes postgres, redis, storage) · `GET /api/version`.
