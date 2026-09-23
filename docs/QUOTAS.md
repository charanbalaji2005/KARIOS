# Resource quotas

The machine is shared. Without ceilings the failure mode is not "one project degrades" — it is one project's bulk import filling the disk, at which point PostgreSQL refuses writes for *everyone* and uploads and backups fail too. Refusing the import would have been the smaller outage.

`statement_timeout` bounds a single query and nothing else. These quotas bound the rest.

---

## What is limited

| Resource | Default | Enforced |
| --- | --- | --- |
| `database_bytes` | 5 GB | sampled |
| `storage_bytes` | 10 GB | sampled |
| `max_file_bytes` | 50 MB | live, per upload |
| `max_connections` | 20 | sampled |
| `max_tables` | 200 | live, on CREATE TABLE |
| `api_requests_per_hour` | 100,000 | Redis counter |
| `realtime_connections` | 50 | sampled |
| `background_jobs_per_day` | 500 | Redis counter |

Defaults are conservative on purpose. A project that needs more can be raised in one row; a project that quietly consumed 200 GB cannot be un-consumed. Override any of them with `QUOTA_*` in `.env`.

`NULL` means unlimited. `0` means blocked — a real and useful state, since it is how a project gets suspended without being deleted. The code keeps those distinct and there is a test asserting it.

---

## Three enforcement strategies

**Live** — counted at the moment of the request. Used where the check is cheap and the limit must not be crossed even briefly: file size, table count. Creating a table runs one `information_schema` count first.

**Sampled** — read from `project_usage`, refreshed every five minutes by the worker. Used where an exact count is expensive: `pg_database_size` and walking the storage tree across every project is not something to do on each upload.

The honest consequence: **a project can overshoot by whatever it writes between two samples.** That is the trade, not an oversight. Shorten `USAGE_SAMPLE_INTERVAL_MS` to narrow the window, at the cost of more background IO. If you need a hard boundary, put it on `max_file_bytes`, which is live.

Errors from sampled checks include `sampledAt` so a developer who thinks the number is wrong can see how stale it is rather than assuming quotas are broken.

**Counter** — a fixed window in Redis. Fixed rather than sliding because a sliding window costs a sorted set per project per resource, and for an hourly ceiling the boundary effect (up to 2× across a window edge) does not matter. It would matter for a per-second limit, which is why request rate limiting is a separate mechanism.

The expiry is set only on the first increment of a window. Re-expiring on every request would slide the window and it would never reset — an easy bug to ship unnoticed, so there is a test for it.

---

## Three layers of limiting, deliberately

They are not redundant:

- **nginx** caps requests per IP. Stops one address hammering the server.
- **`lib/rate-limit.ts`** caps per IP *and* user *and* API key. Stops one client hammering the API from many addresses.
- **quotas** cap per project. Stops one project consuming the machine's capacity across a hundred well-behaved clients.

A project distributing 100k requests/hour across fifty polite clients is invisible to the first two and caught by the third.

---

## Failure behaviour

**Missing quota row → defaults, not unlimited.** A project created by a code path that forgot to initialise quotas fails closed.

**Redis down → counters fail open.** Refusing every request because the counter is unavailable turns a cache outage into a full outage. There is a warning logged at the call site so it is visible rather than silent.

**Sampling failure → previous figure kept, not zero.** A transient error that reset usage to 0 would hand the project unlimited headroom until the next successful sample. Each measurement is taken independently, so an unreachable database still produces an accurate storage figure.

---

## HTTP status

`QUOTA_EXCEEDED` returns **413, not 429**. A rate limit says "slower"; a quota says "this project cannot hold any more of this". Retrying the identical request will never succeed, and 429 invites a client to back off and retry forever.

```json
{
  "data": null,
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "This project's file storage limit is 10 GB. It is currently using 9.8 GB.",
    "details": { "resource": "storage_bytes", "limit": 10737418240, "current": 10522669875, "sampledAt": "..." }
  }
}
```

The message names the resource and both numbers. "Quota exceeded" with no figures forces the developer to guess which resource and by how much.

---

## Endpoints

```
GET   /api/v1/projects/:ref/quotas              limits, usage, per-resource summary
GET   /api/v1/projects/:ref/quotas/violations   what was refused and when
POST  /api/v1/projects/:ref/quotas/resample     force a fresh measurement
PATCH /api/v1/projects/:ref/quotas              raise or lower (operator only)
GET   /api/v1/quotas/defaults                   what a new project receives
```

Reading is open to any project member — a developer hitting a ceiling needs to see the ceiling. The project overview page shows the same figures with meters.

`resample` is there for the case where a bulk delete leaves the stored figure stale in the direction that keeps a project locked out of writes it should now be allowed.

---

## Who can raise a limit

Not the project owner. An owner who can lift their own limits has no limits, which defeats the point on shared hardware.

There is no admin role in the schema yet, so operator status comes from an allow-list:

```
PLATFORM_OPERATORS=you@example.com
```

Empty means nobody can change quotas through the API — edit `project_quotas` directly.

This is a blunt instrument and worth naming as such. A proper platform-admin role with its own audit trail is the right answer; an email allow-list is the honest placeholder, and preferable to a `role = 'admin'` column that nothing ever sets.

Every change writes an audit row with the changed fields and the operator's note, so a support conversation six months later can find out who agreed to what.

---

## Violations are recorded, not just refused

A project sitting at its ceiling for a week is a conversation to have, not an error to swallow. Every refusal writes to `quota_violations`. Without it the only trace is a 413 the client saw and nobody else did.

---

## Not covered

- **CPU and memory per project.** Docker limits the whole stack (`deploy.resources` in `docker-compose.prod.yml`); PostgreSQL does not partition CPU between databases. One expensive query still slows everyone, bounded only by `statement_timeout`.
- **Bandwidth.** Not measured or capped.
- **Organization-level aggregates.** Quotas are per project. Ten projects each at their limit is ten times the limit.
- **Enforcement at the edge.** All checks happen in the application, so a project past its quota still costs a TCP connection, TLS and an auth lookup before being refused.
