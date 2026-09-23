# Self-hosting Kairos on your own machine

The premise: your laptop provides the compute, the database, the object storage and the network, and Kairos turns it into a cloud platform other people can use. This document covers the layer between the internet and the application — the part that decides whether that is a portfolio project or an incident.

The uncomfortable version first. **The laptop is a single point of failure for everything at once.** Power cut, dead SSD, corrupted filesystem, a Windows update at 3am, the ISP renegotiating your IP — any one of those takes the service down, and a dead disk takes the database, the uploads and every backup sitting beside them in the same stroke. Nothing in this document fixes that. Offsite backups are the only thing that does, which is why they appear twice below.

> For step-by-step guidance on connecting devices over local Wi-Fi (LAN) or securely routing traffic via Cloudflare Tunnels and Tailscale without exposing port 5432, see [docs/NETWORKING.md](NETWORKING.md).

---

## The layers

```
Internet
   ↓
Cloudflare            DNS, DDoS absorption, optional tunnel
   ↓
Firewall              UFW / nftables / Windows Firewall — 80 and 443 only
   ↓
Fail2Ban              reads the logs, bans the addresses that misbehave
   ↓
Nginx                 TLS, routing, rate limits, security headers, size caps
   ↓
Authentication        JWT, Argon2id, session rotation
   ↓
Authorization         RBAC, resolved in SQL
   ↓
Application           Fastify, Zod validation, Redis rate limits
   ↓
Internal Docker network   (no route to the host, no route to the internet)
   ↓
PostgreSQL · Redis · MinIO
```

Each layer assumes the ones above it will fail. That is the point: nginx's rate limiter does not know about users, so the application has its own; the firewall does not know about HTTP, so nginx filters what it cannot.

---

## Setup

On a fresh Ubuntu machine, one command does the lot:

```bash
sudo ./scripts/bootstrap.sh
```

It installs packages and Docker, creates `/var/lib/kairos` and `/var/log/kairos`, generates every secret into `.env` (mode 600), applies the firewall, installs the fail2ban jails, and brings up `docker-compose.prod.yml`.

Then verify — **from another machine**, because running it locally only tells you what the loopback sees:

```bash
./scripts/verify-security.sh your-host
```

It checks that 5432, 6379, 9000, 9001, 4000 and 3000 are closed, that 80 and 443 are open, that the security headers are present, that nginx is not advertising its version, and that the login endpoint actually rate limits.

---

## 1. Firewall

`infrastructure/firewall/ufw-setup.sh` sets deny-incoming, allow-outgoing, deny-routed, then opens 80 and 443 and nothing else. SSH stays shut unless you pass `SSH_ALLOW_FROM`:

```bash
sudo SSH_ALLOW_FROM=192.168.1.0/24 ./infrastructure/firewall/ufw-setup.sh
```

### The Docker trap

This is the one that catches people. Docker writes its own iptables rules *ahead* of UFW's, so a container published with `ports: ["5432:5432"]` is reachable from the internet even though `ufw status` reports 5432 as DENY. The UI says you are safe; you are not. It is how self-hosted databases end up indexed by Shodan.

Two defences, use both:

```bash
sudo ./infrastructure/firewall/docker-user.sh   # filters in the DOCKER-USER chain
```

and, more importantly, `docker-compose.prod.yml` publishes no data-plane ports at all. Those services sit on `kairos_internal`, which is declared `internal: true` — a network with no gateway. There is no route from outside to port 5432, so there is nothing for a misconfiguration to expose.

Prefer nftables? `infrastructure/firewall/nftables.conf` is the equivalent ruleset with per-source connection metering and a `banned_v4` set that fail2ban populates. Use one or the other, never both.

Windows: `infrastructure/firewall/windows-firewall.ps1`.

---

## 2. Nginx

`infrastructure/nginx/nginx.conf` plus `sites/kairos.conf` define four vhosts:

| Hostname | Serves | Notable |
| --- | --- | --- |
| `cloud.` | dashboard | immutable caching for `/_next/static/` |
| `api.` | Fastify | 5 MB bodies, 1 r/s on auth routes |
| `realtime.` | WebSocket | buffering off, 1 hour read timeout |
| `files.` | storage | 1 GB bodies, request buffering off so uploads stream |

Requests to an unknown hostname get `return 444` — the connection closes with no response, so a scanner learns nothing.

No domain yet? Rename `sites/kairos-local.conf.example` to `default.conf` and delete `kairos.conf`. It does path-based routing on plain HTTP for LAN use.

### Rate limiting is two layers, deliberately

nginx sees IP addresses and nothing else:

```
kairos_auth     1  r/s    login, signup, password reset
kairos_api      15 r/s    general API
kairos_upload   5  r/s    storage writes
kairos_general  30 r/s    dashboard and public reads
```

That protects the machine. It does nothing about one authenticated user with a valid key hammering the SQL runner from fifty addresses, so the application keeps its own Redis limiters keyed on IP *and* user *and* API key. Neither layer is redundant.

### Getting the client IP right

Behind Cloudflare, `$remote_addr` is a Cloudflare edge node. Without `snippets/cloudflare-realip.conf`, every request appears to come from the same handful of addresses, rate limits become meaningless, and fail2ban eventually bans Cloudflare — taking a slice of your users offline alongside the attacker.

The matching setting on the application side is `TRUST_PROXY_HOPS`. The old code used Fastify's `trustProxy: true`, which trusts every hop and lets any client pick its own apparent IP by sending an `X-Forwarded-For` header. Set the real number instead: `1` behind nginx, `2` behind Cloudflare and nginx.

Cloudflare's ranges change. Refresh them monthly:

```bash
./scripts/update-cloudflare-ips.sh && pnpm nginx:reload
```

---

## 3. Fail2Ban

Nginx returns 429 to an abusive client, which still costs a TCP handshake, a TLS negotiation and a log write on every attempt. Fail2Ban drops the address at the firewall so those attempts stop arriving.

Jails in `infrastructure/fail2ban/jail.local`:

| Jail | Watches | Trigger | Ban |
| --- | --- | --- | --- |
| `kairos-auth` | failed logins | 6 in 10m | 1h |
| `kairos-apikey` | invalid API keys | 20 in 5m | 6h |
| `kairos-abuse` | traversal, rejected identifiers, token replay | 3 in 30m | 24h |
| `kairos-nginx-limit` | repeatedly tripping the rate limiter | 10 in 5m | 2h |
| `kairos-nginx-scan` | `/wp-admin`, `/.env`, scanner agents | 3 in 10m | 1w |
| `recidive` | banned by any jail repeatedly | 5 in 1w | 30d |

`bantime.increment` is on, so each repeat offence doubles the sentence up to a week. A mistyped password stays a ten-minute inconvenience; a script gets progressively less welcome.

### How the application feeds it

Fail2Ban cannot parse JSON, and pino writes JSON. So `services/api/src/lib/security-log.ts` writes security events twice — once through the structured logger for humans and Grafana, once as a fixed-shape plain-text line for the jails:

```
2026-09-21T18:04:11.204Z event=AUTH_FAILURE ip=203.0.113.9 user=- project=- agent="curl/8.4.0" detail="login"
```

Events: `AUTH_FAILURE`, `TOKEN_REUSE`, `INVALID_API_KEY`, `FORBIDDEN`, `RATE_LIMITED`, `PATH_TRAVERSAL`, `SQL_IDENTIFIER_REJECTED`. Most are emitted centrally from the error handler in `app.ts`, keyed on the error code, so a new route cannot forget to log them.

**That line format is load-bearing.** Change it and the jail regexes stop matching — silently, because a filter matching nothing produces a jail that bans nobody and `fail2ban-client status` looks identical either way. After any change:

```bash
fail2ban-regex /var/log/kairos/security.log /etc/fail2ban/filter.d/kairos-auth.conf
```

Check the match count, not the exit code.

Note what is deliberately absent from that line: no email address, no full API key. A failed login should not write someone's address into a file half a dozen processes can read, and a mistyped key should not become a valid credential sitting in a log.

---

## 4. Network segmentation

```
kairos_public     nginx, cloudflared, certbot          ← internet
kairos_edge       nginx ↔ api ↔ dashboard
kairos_internal   postgres, redis, minio               internal: true
```

`internal: true` removes the default gateway from that bridge. Those containers cannot reach the internet and the internet cannot reach them. If a project's SQL somehow ran `COPY ... TO PROGRAM`, there is no egress path for it to use.

Resource limits are set per service so a runaway query starves PostgreSQL rather than the whole laptop.

---

## 5. Public access

Two options.

**Port forwarding.** Forward 80 and 443 on the router, point DNS at your IP, issue certificates:

```bash
./scripts/tls-issue.sh example.com you@example.com
```

Renewal is automatic via the `tls` compose profile. This publishes your home IP address in DNS and needs a static IP or dynamic DNS.

**Cloudflare Tunnel** (better). `cloudflared` dials *out* to Cloudflare and traffic arrives down that connection. No inbound ports, no published home IP, works behind CGNAT.

```bash
cloudflared tunnel create kairos
cloudflared tunnel route dns kairos api.example.com
docker compose -f docker-compose.prod.yml --profile tunnel up -d
```

Then delete nginx's `ports:` block and set the firewall to deny everything inbound. Nothing needs to be open. Ingress rules are in `infrastructure/cloudflared/config.yml`; set `TRUST_PROXY_HOPS=2`.

---

## 6. Monitoring

A hosted platform hides the host from you. Here it is the product, so the dashboard has a **Server** page (`/server`) showing measured values: CPU utilisation sampled over a 200ms window rather than the since-boot average `os.cpus()` reports, memory, disk on both the data volume and root, network throughput, PostgreSQL size and connection pool usage, Redis memory and hit rate, and the slowest queries of the last hour.

It also reads CPU temperature from `/sys/class/thermal`, which is not a metric anyone puts on a rack server. Laptops throttle. Above about 85°C the CPU halves its clock, and a query that "suddenly got slow" has nothing wrong with its plan — the machine is too hot. The page says so rather than leaving you to tune indexes for an afternoon.

`/api/v1/server/prometheus` exposes the same figures in text exposition format. Both endpoints require an authenticated platform user: publishing host metrics tells an attacker exactly when you are loaded and where the disk pressure is.

`infrastructure/monitoring/alerts.yml` covers disk above 85% and 95%, memory above 92%, CPU above 85°C and 95°C, API crash loops, and — the one that matters most — no successful backup in 48 hours.

---

## 7. Backups

Say it again: a backup on the same disk as the database is not a backup.

```bash
./scripts/backup-rotate.sh
```

Dumps the platform database and every project database with `pg_dump --format=custom --compress=9`, keeps 7 daily / 4 weekly / 3 monthly, promotes rather than re-dumps (a weekly copy of Sunday's daily is the same bytes, and dumping twice just doubles the IO on an SSD), then **verifies every dump with `pg_restore --list`** and exits non-zero if one is unreadable. An unverified backup is a guess.

Set `OFFSITE_REMOTE` to an rclone target, or run the `offsite` profile, and put it in cron:

```
0 3 * * * /opt/kairos/scripts/backup-rotate.sh >> /var/log/kairos/backup.log 2>&1
```

Restore drill, on a spare machine, at least once — before you need it:

```bash
pg_restore -U postgres -d kairos_platform_restore --clean --if-exists platform-2026-09-21.dump
```

---

## What this does not protect against

- **Tenant isolation.** Project databases share one PostgreSQL instance. Isolation is by role and database, not by machine. A tenant with `CREATE FUNCTION` rights is in the same blast radius as everyone else.
- **CPU and memory per project.** Disk, storage, tables, connections and request rate are now capped ([QUOTAS.md](QUOTAS.md)), but PostgreSQL does not partition CPU between databases. One expensive query still slows everyone.
- **Physical access.** Disk encryption is not configured here. Anyone holding the laptop holds the database.
- **A determined DDoS.** Cloudflare absorbs a lot; a home uplink is still a home uplink.
- **The laptop itself.** Power, disk, OS, ISP. Offsite backups, and accepting the downtime.

Treat it as a well-defended personal cloud, not as audited production infrastructure.
