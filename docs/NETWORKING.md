# Networking & Remote Access Guide

This guide covers how to make KAIROSDB and its PostgreSQL database accessible to other devices on your local network (LAN) and securely over the public Internet.

---

## 1. Same Wi-Fi / LAN Setup (Local Network)

Use this setup when you want other laptops, phones, or devices on the same Wi-Fi network to connect to your KAIROSDB instance.

```text
Laptop A (Host)
192.168.1.10
PostgreSQL :5432 / KAIROSDB :4000
      │
      │ LAN (Same Wi-Fi)
      ▼
Laptop B / Phone / Application
```

### Step 1 — Find your host machine's LAN IP

- **On Linux:**
  ```bash
  hostname -I
  # or
  ip addr show | grep inet
  ```
- **On Windows (PowerShell):**
  ```powershell
  Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -like "192.168.*" } | Select-Object -ExpandProperty IPAddress
  # or simply:
  ipconfig
  ```

Suppose your LAN IP is `192.168.1.10`.

---

### Step 2 — Configure PostgreSQL for LAN Access

If you want external devices to directly query PostgreSQL:

1. **Find the config file:**
   - Linux:
     ```bash
     sudo -u postgres psql -c "SHOW config_file;"
     ```
   - Docker container (`kairos_postgres`):
     PostgreSQL inside Docker is already bound to `0.0.0.0:5433` (or `5432` depending on compose mapping).

2. **Allow listen on all network interfaces:**
   In `postgresql.conf`:
   ```conf
   listen_addresses = '*'
   ```

3. **Allow authentication from your LAN subnet:**
   In `pg_hba.conf` (e.g. `/etc/postgresql/*/main/pg_hba.conf`):
   ```conf
   # TYPE  DATABASE        USER            ADDRESS                 METHOD
   host    all             all             192.168.1.0/24          scram-sha-256
   ```
   *(Replace `192.168.1.0/24` with your local network CIDR block).*

4. **Restart PostgreSQL:**
   - Linux native:
     ```bash
     sudo systemctl restart postgresql
     ```
   - Docker:
     ```bash
     docker compose restart postgres
     ```

---

### Step 3 — Allow Traffic through the Firewall

- **Linux (UFW):**
  ```bash
  sudo ufw allow from 192.168.1.0/24 to any port 5432 proto tcp
  # For the KAIROSDB API (port 4000) and Dashboard (port 3000):
  sudo ufw allow from 192.168.1.0/24 to any port 4000 proto tcp
  sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
  ```

- **Windows (PowerShell as Administrator):**
  ```powershell
  New-NetFirewallRule -DisplayName "KairosDB LAN" -Direction Inbound -LocalPort 3000,4000,5432,5433 -Protocol TCP -Action Allow -RemoteAddress 192.168.1.0/24
  ```

---

### Step 4 — Connect from Another Device on LAN

- **Direct PostgreSQL connection:**
  ```bash
  psql -h 192.168.1.10 -p 5432 -U postgres -d <project_db>
  ```
  Connection details:
  ```text
  Host:     192.168.1.10
  Port:     5432 (or 5433 for docker)
  Database: <project_db>
  User:     postgres / <project_role>
  Password: ********
  ```

- **Web Dashboard & REST API:**
  - Dashboard: `http://192.168.1.10:3000`
  - REST API: `http://192.168.1.10:4000/rest/v1/...`

---

## 2. Internet Access — Do NOT Expose Port 5432 Directly

> [!CAUTION]
> **Never open raw PostgreSQL port 5432 directly to the public internet.**
> Exposing database ports invites automated brute-force attacks, port scanning, and denial-of-service. PostgreSQL should remain isolated on a private loopback or internal Docker network.

### The Recommended Architecture

```text
Client Application (Internet)
            │
            │ HTTPS (Encrypted)
            ▼
   Cloudflare Tunnel / Tailscale
            │
            ▼
      NGINX Reverse Proxy (:443)
            │
            ▼
       KAIROSDB API (:4000)
            │
            ▼
     PostgreSQL (:5432)
   (Private Network / Loopback)
```

Clients interact exclusively with the **KAIROSDB API** using JWT authentication or API keys. The database engine executes queries securely behind the API:

```typescript
import { createClient } from '@kairosdb/client';

const db = createClient('https://kairos.example.com', 'krs_anon_your_api_key');

// The client executes REST/GraphQL over HTTPS — no psql or port 5432 required
const { data, error } = await db
  .from('users')
  .select('*')
  .eq('active', true);
```

---

## 3. Exposing KAIROSDB to the Internet

You have two primary options for secure remote access:

### Option A: Cloudflare Tunnel (Recommended for Public Access)

Cloudflare Tunnels create an encrypted outbound connection from your laptop to Cloudflare's edge. **No router port-forwarding or public IP required.**

1. **Install `cloudflared`:**
   - Linux: `sudo apt install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`

2. **Authenticate with Cloudflare:**
   ```bash
   cloudflared tunnel login
   ```

3. **Create the tunnel:**
   ```bash
   cloudflared tunnel create kairos-tunnel
   ```

4. **Configure ingress (`~/.cloudflared/config.yml`):**
   ```yaml
   tunnel: <TUNNEL_UUID>
   credentials-file: /path/to/<TUNNEL_UUID>.json

   ingress:
     # Dashboard
     - hostname: kairos.yourdomain.com
       service: http://localhost:3000
     # API & Data Plane
     - hostname: api-kairos.yourdomain.com
       service: http://localhost:4000
     - service: http_status:404
   ```

5. **Route DNS and run:**
   ```bash
   cloudflared tunnel route dns kairos-tunnel kairos.yourdomain.com
   cloudflared tunnel route dns kairos-tunnel api-kairos.yourdomain.com
   cloudflared tunnel run kairos-tunnel
   ```

6. **Update `.env` in KAIROSDB:**
   ```env
   API_URL=https://api-kairos.yourdomain.com
   FRONTEND_URL=https://kairos.yourdomain.com
   NEXT_PUBLIC_API_URL=https://api-kairos.yourdomain.com
   ADDITIONAL_ORIGINS=https://kairos.yourdomain.com
   ```

---

### Option B: Tailscale (Recommended for Private / Team Access)

If only you and your team need access without making anything public to the general internet, **Tailscale** is the simplest and most secure option:

1. Install Tailscale on your host machine: [tailscale.com/download](https://tailscale.com/download)
2. Sign in:
   ```bash
   tailscale up
   ```
3. Note your laptop's Tailscale IP (e.g. `100.x.y.z` or `your-laptop.tailnet.ts.net`).
4. Other devices on your Tailnet can now access:
   - Dashboard: `http://100.x.y.z:3000`
   - API: `http://100.x.y.z:4000`
   - PostgreSQL (if permitted): `100.x.y.z:5432`

All traffic is end-to-end encrypted with WireGuard and never exposed to the public internet.

---

## 4. Checklist for Production Remote Access

Before taking your instance live:

- [ ] Change all default passwords (`kairosadmin`, `kairos`, JWT secrets, encryption keys in `.env`).
- [ ] Confirm port 5432, 6379, and 9000 are **NOT** open to `0.0.0.0` on your public router.
- [ ] Set `ADDITIONAL_ORIGINS` in `.env` to your public HTTPS domain for CORS validation.
- [ ] Ensure automatic backups are configured (`pnpm kairos db dump` or `scripts/backup-rotate.sh`).
