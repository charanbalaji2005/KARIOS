# Server console

How the KAIROS admin panel manages the Ubuntu machine it runs on.

This is the feature that makes "your laptop is the cloud" a thing you can act
on rather than a slogan: restart PostgreSQL, read journald, inspect nftables,
take a verified backup — from the dashboard, from the CLI, or from a real
terminal in the browser.

It is also the most dangerous surface in the product, so most of this document
is about what it will *not* do.

---

## The shape of it

```
Browser
   │  HTTPS
   ▼
NGINX ─────────────────────────────────── the only thing on the network
   │
   ▼
KAIROS API              ← unprivileged. Cannot touch the host.
   │  Unix socket, HMAC-signed
   │  /run/kairos/server-agent.sock   (root:kairos, 0660)
   ▼
KAIROS Server Agent     ← root. Holds the allowlist. Not on the network.
   │
   ▼
Ubuntu host             systemd · Docker · nftables · PostgreSQL · files
```

The split is the whole design. The process reachable from the internet has no
privilege on the host; the process with privilege is not reachable from the
internet. Compromising the API gets an attacker the ability to *ask* for one of
roughly forty named operations, which is a much smaller prize than a shell.

---

## The rule that matters

**There is no endpoint, anywhere, that accepts a command to run.**

Requests name an operation *id*:

```jsonc
POST /api/v1/admin/server/services/postgres
{ "action": "restart", "confirm": "RESTART SERVICE" }

// → agent: operation "service_restart", args { service: "postgres" }
// → spawn("/usr/bin/systemctl", ["restart", "postgresql"], { shell: false })
```

Not this, which the codebase does not contain and must not grow:

```jsonc
POST /terminal
{ "command": "systemctl restart postgresql" }
```

Four properties hold this up:

1. **Operations are a fixed table.** `GET /api/v1/admin/server/operations`
   enumerates every one. The set is decided at the agent's compile time; adding
   one means editing a file on the host and restarting a root daemon.

2. **Arguments are enums, not strings.** `service_restart` takes one of nine
   known ids. There is no string a caller can supply that becomes a unit name.
   The two `string` arguments in the whole allowlist — a backup id and a
   challenge nonce — are pattern-constrained and re-checked at use.

3. **Nothing spawns a shell.** `services/server-agent/src/exec.ts` has no entry
   point that takes a command string. Everything is `(binary, args[])` with
   `shell: false`, against a fixed table of absolute paths. A `;` in an argument
   is a character in a filename, not a second command.

4. **Unknown keys are rejected, not ignored.** Silently dropping an unexpected
   argument is how a typo becomes "act on the default".

The exception is the Ubuntu Terminal, which is a real shell and is fenced off
accordingly. See below.

---

## Two terminal modes

### KAIROS Shell — the default

A restricted command environment. Lines are parsed against a fixed grammar and
resolve to the same operations the dashboard buttons use, so there is nothing
you can type here that you could not also click.

```
kairos status                     kairos firewall status
kairos doctor                     kairos firewall rules
kairos services                   kairos backup list
kairos service restart postgres   kairos backup create
kairos database status            kairos logs api 200
kairos redis status               kairos logs sources
kairos storage status             kairos network ports
kairos nginx status               kairos docker ps
```

`help` prints the grammar. `operations` prints the entire allowlist.

`rm -rf /` is not refused by a denylist — it simply does not parse, because
there is no rule in the grammar it could match.

### Ubuntu Terminal — a real root shell

Off by default. Enabling it requires, all of them:

| Requirement | Why |
|---|---|
| Platform operator | Project roles do not apply; this is the machine, not a project |
| Signed in within 15 min | A session left open on an unlocked laptop should not be enough |
| Typed `ENABLE UBUNTU TERMINAL` | Interrupts muscle memory |
| A TOTP code, if enrolled | The account's own second factor |
| A written reason | Recorded beside the grant |

The grant then **expires on its own** after 30 minutes. That is the important
part: the realistic failure is not an attacker, it is somebody enabling it
during an incident and forgetting. Two independent clocks enforce it — the
API's grant record and the agent's own session supervisor — so closing the
browser tab is not what ends the privilege.

Sessions record who, when, from where, and for how long. **Keystrokes are not
recorded**, deliberately: capturing them would capture the password typed into
`sudo`, which is a worse outcome than the gap in the record.

Tunables: `KAIROS_UBUNTU_TERMINAL_TTL_MINUTES`, `KAIROS_RECENT_AUTH_MINUTES`.

---

## Dangerous operations

Operations that affect the whole server or destroy data carry a phrase the
operator must type exactly. The agent checks it independently of the UI — it
has to, since it cannot trust that a request came from the dashboard.

| Operation | Phrase |
|---|---|
| `service_stop` | `STOP SERVICE` |
| `service_restart` | `RESTART SERVICE` |
| `server_reboot` | `REBOOT SERVER` |
| `server_shutdown` | `SHUTDOWN SERVER` |
| `backup_restore` | `RESTORE DATABASE` |
| `backup_prune` | `DELETE OLD BACKUPS` |
| `firewall_apply_baseline` | `APPLY FIREWALL` |
| `firewall_close_https` | `CLOSE HTTPS` |
| `firewall_configure_ssh` | `CHANGE SSH ACCESS` |
| `provision_install_dependencies` | `INSTALL PACKAGES` |

Reboot and shutdown are scheduled a minute out rather than executed at once, so
the dashboard can report that it worked and so `server_power_cancel` exists for
the "wait, wrong machine" that people think about four seconds later.

---

## What is never exposed

`network_ports` reads the host's listening sockets and reports any of these
bound past loopback as **critical**:

| Port | Service | Why it must stay internal |
|---|---|---|
| 5432 | PostgreSQL | Clients go through the API. Never this. |
| 6379 | Redis | Unauthenticated by default; remote code execution is the normal outcome |
| 9000 | Object storage | The API proxies it |
| 9001 | Storage console | An admin UI with no business being reachable |
| 4000 | KAIROS API | Should sit behind NGINX for TLS, limits and headers |
| 3000 | Dashboard | Same |

The firewall guarantee is a **negative** one: those ports appear nowhere in
`infrastructure/firewall/kairos-baseline.nft`. They are not blocked by a deny
rule that could be reordered — the default `policy drop` covers them because
nothing accepts them.

The dashboard shows *intent* (the ruleset) and *reality* (what is listening)
side by side, because those disagree more often than anyone expects, and the
disagreement is where the incident lives.

---

## Audit

Three tables, all written **before** the operation runs:

- `server_operations` — every privileged operation, typed or clicked, with
  arguments, actor, address, request id and outcome.
- `terminal_sessions` — who opened a terminal, in which mode, for how long.
- `terminal_commands` — what was typed in KAIROS Shell and the operation it
  resolved to. Output is never stored: a session running
  `cat /etc/kairos/agent.token` would otherwise put the agent credential in the
  audit table permanently.

Writing the row first is the point. An audit trail written on completion
records only the operations that did not break anything — exactly the wrong
half.

The security log (`/var/log/kairos/security.log`, which fail2ban tails) gains
three events: `HOST_ADMIN_DENIED`, `HOST_TERMINAL_GRANTED`,
`HOST_DANGEROUS_OPERATION`. They are new names rather than reuses of
`FORBIDDEN`, so existing jails keep matching exactly what they matched before.

---

## Installing

```bash
sudo ./scripts/install-server.sh --dry-run   # print what it would do
sudo ./scripts/install-server.sh
```

It installs packages and Docker, creates the `kairos` service account, creates
`/var/lib/kairos/{postgres,redis,storage,backups,logs,config,metrics}` at mode
0750, generates `/etc/kairos/agent.token` (0640, `root:kairos`), installs and
starts the agent under systemd, applies the baseline firewall, and runs a
health check. It is idempotent and will not overwrite an existing credential,
an existing ruleset or existing data.

**The API's user must be in the `kairos` group** or it cannot open the agent
socket:

```bash
sudo usermod -aG kairos $(whoami)   # then log out and back in
```

Then finish in the dashboard: **Admin → Server → Setup**. Each step has a check
that is safe to run any time and, where it makes sense, an apply. A step shows
green because its check said so just now, not because it once succeeded.

### Removing

```bash
sudo ./scripts/uninstall-server.sh            # software only — data kept
sudo ./scripts/uninstall-server.sh --purge    # also deletes all data
```

`--purge` requires typing `DELETE ALL KAIROS DATA`. Note that it removes
`/etc/kairos`, which holds `ENCRYPTION_KEY` — every stored project credential
becomes permanently unrecoverable, including from a backup. `docker compose
down -v` is not in either path.

---

## Backups

One physical directory, `/var/lib/kairos/backups`, written by the agent, the
API's backup worker and `scripts/backup-rotate.sh` alike. Two directories both
called "backups" is how a restore finds yesterday's file.

Every archive is written with `pg_dump --format=custom`, then **read back out
and parsed** with `pg_restore --list` before it is called complete. This is not
ceremony: a truncated dump, a dump written to a full disk, and a dump of a
database the role could not fully read all exit `pg_dump` with status zero.
"The backup job succeeded" and "you have a backup" are different statements.

`backup_prune` never deletes the newest archive, whatever the retention window
says — a retention policy that can empty the directory will, on the day
somebody sets it to 1 day to free space.

---

## PostgreSQL tuning

`provision_check_postgres` derives settings from the machine's actual RAM and
core count and explains each number. It does **not** ship
`max_connections=300`: that figure comes from dedicated database servers, and
this is a laptop also running the API, Redis, NGINX and a browser.

The connection ceiling is derived from `work_mem` rather than picked, because
each connection can allocate `work_mem` several times over for a sort or a hash
join — 300 connections at 8MB is a licence to consume several gigabytes above
`shared_buffers` and be OOM-killed.

Writing the config does not restart PostgreSQL. `shared_buffers` and
`max_connections` need a full restart, and choosing when to take that outage is
the operator's call.

---

## Operating it

### CLI

```bash
kairos server status          # live host state
kairos server doctor          # what is wrong, not a wall of green
kairos server services
kairos server restart postgres
kairos server logs api 500
kairos server backup create
kairos server firewall status
kairos server network         # what is listening, what is exposed
kairos server connect         # how another machine connects to this one
kairos server operations      # the full allowlist
```

The CLI has no privilege of its own and never shells out. `kairos server
restart postgres` is the same audited operation as clicking Restart.

### When the agent is down

The dashboard says so specifically, because the commonest cause is a
development checkout that was never provisioned:

```bash
sudo systemctl status kairos-server-agent
sudo journalctl -u kairos-server-agent -n 50
sudo systemctl start kairos-server-agent
```

`EACCES` on the socket means the API's user is not in the `kairos` group.

### Reboot recovery

The agent is `Restart=always` and enabled on boot. Docker restarts its
containers. The firewall reloads from `/etc/kairos/nftables.conf`. Data on the
volume is untouched. `kairos_doctor` flags any core service that is running now
but *not* enabled on boot — that is the one that will not come back.

---

## Testing it

```bash
pnpm --filter @kairosdb/tests test:server     # 49 tests
pnpm --filter @kairosdb/tests test:security   # plus the rest of the suite
```

The security tests are written as the things an attacker would actually try:
command injection through every argument shape, path traversal in backup ids,
replaying a captured agent request against a different route, prototype-chain
keys slipping past the unknown-argument check, and firewall rules built from a
malformed CIDR. All must fail, and must fail structurally rather than because a
regex happened to match.

The registry tests check the allowlist is internally coherent: no duplicate
ids, every dangerous operation has a phrase, every operation has a timeout, no
operation accepts a free-form path or command, and every command the shell
grammar accepts resolves to an operation that exists.

---

## Extending it

To add a capability:

1. Add an `Operation` in a `services/server-agent/src/ops/*.ts` module.
   Declare its arguments as enums wherever possible.
2. If it can break something, set `danger: true` and give it a
   `confirmPhrase`. `register()` refuses a dangerous operation without one.
3. If it needs a binary, add it to the table in `exec.ts`. That table is the
   security decision; everything downstream refers to a name.
4. If it should be typeable, add a rule to `RULES` in `shell.ts`.
5. Add it to the registry test's danger/read-only lists so a later change
   cannot silently flip it.

Things that should never be added:

- an operation that takes a command, a shell fragment, or a filesystem path
- an operation that runs `sh`, `bash` or `env`
- a way to read `/etc/kairos/server-key.pem` or `agent.token`
- binding the agent to anything but a Unix socket or `127.0.0.1`
- mounting `/var/run/docker.sock` into a public-facing container — the Docker
  socket is root-equivalent, which is why Docker control goes through the agent
