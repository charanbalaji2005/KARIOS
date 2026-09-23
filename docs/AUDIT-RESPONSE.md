# Audit response

An external review found the platform "substantially implemented, not just a UI mockup" and listed 39 findings. This records what was fixed, what was deliberately not fixed, and what is still open.

Everything marked **P0 — must fix before public deployment** is now done. The P1 feature list mostly is not, and pretending otherwise would be the same mistake as the original README claiming `pg_restore` verification that did not exist.

---

## Fixed

### 1. Realtime bypassed RLS 🔴

The worst of the findings, and correct. The subscription object carried `bypassRls` and `userId` and **consulted neither**. A project could write a flawless `using (auth.uid() = user_id)` policy, watch REST honour it perfectly, and still have every row broadcast over the WebSocket to every subscriber of that table.

`lib/realtime-authz.ts` now asks PostgreSQL the same question REST asks it — *can this identity select this row?* — rather than reimplementing policy evaluation in TypeScript, which would be a second, subtly different copy of the rules and therefore a leak waiting for the one policy nobody tested.

```
change event → primary key → for each distinct subscriber identity:
    SET LOCAL request.jwt.claims = <identity>
    SELECT EXISTS (SELECT 1 FROM tbl WHERE pk = ...)
  → visible? deliver : drop
```

Two properties, both deliberate:

- **Fails closed.** Unknown table, missing primary key, database error, RLS that cannot be enforced — the event is dropped for RLS-bound subscribers. A dropped event is a bug report; a leaked row is an incident.
- **One query per (event × distinct identity)**, not per subscriber. Fifty sockets belonging to one user are one check.

`service_role` still bypasses, exactly as it does over REST.

**A second bug found while fixing the first.** PostgreSQL exempts a table's owner from its own policies unless the table is `FORCE ROW LEVEL SECURITY`, and the project's pooled role owns every table it creates. So `ENABLE ROW LEVEL SECURITY` alone left RLS **inert for the very connection the API uses** — the visibility probe would have returned true for every row, and REST was in the same position. Table creation and the seed now issue `FORCE`, and the authorizer refuses to authorise anything on a table where it detects RLS cannot be enforced.

Regression test: `tests/integration/isolation.test.ts`.

### 2. Webhook SSRF 🔴

Also correct, and worse on a self-hosted box than on a normal cloud. The webhook worker runs *inside* the `internal: true` network — the whole point of which is that the internet cannot route there. A user-supplied URL therefore made the worker a proxy into the private network: `http://postgres:5432`, `http://redis:6379`, `http://169.254.169.254/`, the user's own router.

`lib/ssrf.ts` validates the URL, resolves **every** address the hostname maps to, rejects private and reserved ranges (including IPv4-mapped IPv6, which is the same host by another spelling), and then **pins the connection to the address that was checked**.

That last part is the one that matters. Checking `evil.com` resolves publicly and then calling `fetch('https://evil.com/...')` lets the attacker answer the second lookup with `127.0.0.1`. The gap between the two lookups *is* the attack. Redirects are refused for the same reason.

URLs are vetted at creation for a useful error message, and **again on every delivery** because DNS is mutable — the creation check is for the user, the delivery check is the boundary.

`WEBHOOK_ALLOWED_HOSTS` allows exact hostnames for a deliberate LAN webhook. Exact matches only; a wildcard allow-list here is how the protection quietly stops protecting, and there is a test asserting `evil.nas.local` does not match `nas.local`.

24 tests in `tests/integration/ssrf.test.ts`.

### 3. Connection quota not enforced 🟠

The arithmetic in the audit was right: `max: 10` per pool with no ceiling on pool count, against `max_connections=300`, means 30 active projects consumes the entire database — including the slots the platform, the realtime listeners, the workers and a human with `psql` need. The failure is not graceful, and the first thing refused is usually the monitoring that would have explained why.

`db/pool-manager.ts` now has an explicit budget: a platform reserve is held back, the remainder is shared, and **each project's slice shrinks as more projects become active** rather than being a fixed number that only works below some unstated project count. The project's own `max_connections` quota is the other bound; the smaller wins. Under pressure, idle pools are reclaimed before a new one is refused.

`poolManager.stats()` is exposed through `kairos server info` and the doctor check.

### 4. Backup verification was a claim, not a check 🟠

The README said `pg_restore` verification. The worker checked `pg_dump`'s exit code. Those are different claims, and the gap covers the realistic failures: a lost multipart part, a disk that filled on the last block, silent corruption at rest.

`lib/backup-verify.ts` reads the archive **back out of storage** — not from the local pipe, which would prove nothing about what was stored — runs `pg_restore --list` over it, and hashes the bytes on the way through. A backup that does not parse is marked `failed`, not `completed`. `checksum`, `verified_at` and `table_count` are recorded.

`verifyBackupByRestore()` does the stronger check — restore into a scratch database, confirm it is queryable, drop it — behind `BACKUP_DEEP_VERIFY=true`. It is off by default because it costs a full restore per backup, and that is a trade the operator should make knowingly.

`kairos db verify` lists any completed-but-unverified backups. So does `kairos doctor`.

### 5. CORS 🟠

The old policy reflected **every** origin *and* set `credentials: true`. That combination lets any website make cookie-bearing requests to the dashboard API on behalf of a logged-in user — CSRF with extra steps.

The two surfaces have genuinely different requirements, so they now get different rules:

| Surface | Auth | Policy |
| --- | --- | --- |
| `/api/v1` | cookies + bearer | strict origin list, credentials allowed |
| `/rest/v1`, `/storage/v1` | API key | any origin, credentials **never** |

A public anon key in a browser is public by definition; the boundary there is RLS, not the origin. But it must never be paired with cookies.

Private-range origins are allowed when `KAIROS_NETWORK_MODE` is not `remote`, because reaching your own server from your phone on the same Wi-Fi is most of the point of self-hosting — and forcing people to disable CORS to make that work would be worse than the hole being closed.

### 6. Direct database connectivity contradicted the security posture 🟠

`kairos db connect` handed out a `postgres://` URL to a port production deliberately does not publish. The feature and the posture disagreed.

The wrong fix is `ports: ["5432:5432"]`. `infrastructure/wireguard/setup.sh` is the right one: the developer joins a private network, PostgreSQL stays unpublished, and nothing is exposed to anyone without a key. Tailscale instructions are included for the CGNAT case.

`kairos db url` now **hides the password by default** and requires `--reveal`, because a connection string printed by habit ends up in shell history, CI logs and pasted bug reports.

### 7. SDK and docs had drifted 🟠

The README documented a three-argument `on('postgres_changes', filter, handler)`; the SDK implemented two arguments and ignored the filter. Fixed by making the documented form real — with the two-argument form kept as an overload, since breaking working code to match a document is fixing the wrong half. Filters now actually filter, and `subscribe(callback)` reports status.

### 8. E2E and isolation tests 🔴

`tests/e2e/` (Playwright) covers signup → project → table → SQL → REST with a real browser. `tests/integration/isolation.test.ts` covers cross-tenant access, RLS over REST, **RLS over realtime**, and SSRF refusal at the API boundary.

---

## Also done

- **Server identity and network modes.** `local` / `lan` / `remote`, a locally-generated server id, `kairos server info`, `kairos doctor`. Nothing phones home; an installation is independent by design.
- **CLI completion**: `server info`, `server status`, `doctor`, `logs`, `quotas`, `db restore`, `db verify`, `db url --reveal`.

---

## Deliberately not done

**The network-mode endpoint does not reconfigure the firewall.** It records intent and prints what to change. An API that can open the machine's ports is an API an attacker can use to open the machine's ports.

**No central control plane, agent daemon, or installer-as-a-service.** The local-first requirement is already met — every installation is independent, nothing phones home, and it works offline. A control plane would add the coupling the requirement exists to avoid.

**Deep backup verification is opt-in.** It is the only check that proves a backup is *usable*, and it costs a full restore. That should be an explicit decision.

---

## Still open

Honest list. Nothing below is stubbed or half-wired — it does not exist.

**Auth:** OAuth (Google/GitHub), MFA/TOTP, organization invitations, email-verification enforcement (currently optional and undocumented as a policy).

**Dashboard:** admin surface, storage UI, webhooks UI, backups/restore UI, logs, analytics, settings, members, API explorer, relationship diagram, import/export.

**Platform:** OpenAPI generation, GraphQL, OpenTelemetry tracing, Grafana dashboards, per-endpoint p50/p95/p99 histograms in Prometheus, PgBouncer, read replicas, storage versioning and resumable uploads.

**Quota gaps:** CPU and memory are not partitioned per project — PostgreSQL will not do it. Organization-level aggregates do not exist: ten projects each at their limit is ten times the limit.

**Operational:** the perimeter has not been tested from another machine, the Cloudflare Tunnel path has not been validated end to end, and load testing beyond the single benchmark suite has not been done. Those need a real deployment, not more code.

**The laptop is still a single point of failure.** Power, disk, OS, ISP. Offsite backups are the only mitigation, and they are configured but — like everything else here — unverified until someone actually restores from one.
