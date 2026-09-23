#!/usr/bin/env node
/**
 * kairos — the command line interface.
 *
 *   kairos login
 *   kairos projects list
 *   kairos db connect
 *   kairos migration create add_profiles
 *   kairos generate types > database.types.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

const CONFIG_DIR = join(homedir(), '.kairosdb');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface Config {
  apiUrl: string;
  accessToken?: string;
  refreshToken?: string;
  projectId?: string;
  projectRef?: string;
}

const colors = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Config;
  } catch {
    return { apiUrl: process.env.KAIROS_API_URL ?? 'http://localhost:4000' };
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
  config?: Config,
  retry = true,
): Promise<T> {
  let cfg = config ?? (await loadConfig());
  let response: Response;
  try {
    response = await fetch(`${cfg.apiUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  } catch (err: unknown) {
    const error = err as Error;
    if (error.message.includes('fetch failed')) {
      throw new Error(`Cannot connect to KairosDB API at ${cfg.apiUrl}. Is the server running? Run "pnpm dev" to start it.`);
    }
    throw error;
  }

  // Automatic token refresh on 401 Unauthorized
  if (response.status === 401 && retry && cfg.refreshToken) {
    try {
      const refreshRes = await fetch(`${cfg.apiUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: cfg.refreshToken }),
      });
      if (refreshRes.ok) {
        const refreshData = (await refreshRes.json()) as { data?: { accessToken: string; refreshToken?: string } };
        if (refreshData?.data?.accessToken) {
          cfg = {
            ...cfg,
            accessToken: refreshData.data.accessToken,
            ...(refreshData.data.refreshToken ? { refreshToken: refreshData.data.refreshToken } : {}),
          };
          await saveConfig(cfg);
          return api<T>(path, init, cfg, false);
        }
      }
    } catch {
      // Refresh attempt failed, continue to standard error formatting below
    }
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return (await response.text()) as T;
  }

  const body = (await response.json()) as Record<string, any>;
  if (!response.ok || (body && body.error)) {
    let msg = `HTTP ${response.status}`;
    if (body?.error && typeof body.error === 'object' && body.error.message) {
      msg = body.error.message;
    } else if (typeof body?.message === 'string') {
      msg = body.message;
    } else if (typeof body?.error === 'string') {
      msg = body.error;
    }
    if (response.status === 401) {
      throw new Error(`Authentication failed (${msg}). Run "kairos login" to re-authenticate.`);
    }
    throw new Error(msg);
  }

  return (body.data !== undefined ? body.data : body) as T;
}

function table(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) return console.log(colors.dim('Nothing to show yet.'));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(colors.bold(columns.map((c, i) => c.padEnd(widths[i]!)).join('  ')));
  for (const row of rows) {
    console.log(columns.map((c, i) => String(row[c] ?? '').padEnd(widths[i]!)).join('  '));
  }
}

async function prompt(question: string, silent = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (!silent || !process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  // Masked input with visual asterisks feedback for passwords.
  process.stdout.write(question);
  rl.close();
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const char of str) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        } else if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        } else if (char === '\u007f' || char === '\b' || char === '\x08') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (char >= ' ') {
          value += char;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

/* ------------------------------------------------- server agent helpers */

/**
 * Ask the API whether the privileged agent is answering.
 *
 * Never throws: "is the agent up" is itself the question, and a thrown error
 * would make the caller unable to distinguish "no agent" from "no API".
 */
async function agentStatus(): Promise<{ configured: boolean; reachable: boolean; detail: string }> {
  try {
    return await api<{ configured: boolean; reachable: boolean; detail: string }>('/api/v1/admin/server/agent');
  } catch (err) {
    return { configured: false, reachable: false, detail: (err as Error).message };
  }
}

/**
 * Run one allowlisted operation and return the text the agent rendered.
 *
 * The agent formats its own output so the CLI, the dashboard terminal and
 * `kairos doctor` all print the same thing — three formatters for one set of
 * facts is three chances for them to disagree.
 */
async function runOperationText(operation: string): Promise<string> {
  const READ_PATHS: Record<string, string> = {
    kairos_status: '/api/v1/admin/server/status',
    kairos_doctor: '/api/v1/admin/server/doctor',
    service_list: '/api/v1/admin/server/services',
    backup_list: '/api/v1/admin/server/backups',
    logs_sources: '/api/v1/admin/server/logs',
    firewall_status: '/api/v1/admin/server/inspect/firewall',
    firewall_rules: '/api/v1/admin/server/inspect/firewall-rules',
    network_ports: '/api/v1/admin/server/inspect/ports',
    storage_status: '/api/v1/admin/server/inspect/storage',
  };
  const path = READ_PATHS[operation];
  if (!path) throw new Error(`No CLI route for operation ${operation}`);
  const result = await api<{ output?: string; ruleset?: string }>(path);
  return result.output ?? result.ruleset ?? JSON.stringify(result, null, 2);
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async whoami() {
    const config = await loadConfig();
    if (!config.accessToken) {
      console.log(colors.yellow('Not signed in. Run "kairos login" to authenticate.'));
      return;
    }
    const data = await api<{
      user: { id: string; email: string; full_name: string | null; is_platform_admin: boolean; created_at: string };
      organizations: { id: string; name: string; slug: string; role: string }[];
    }>('/api/v1/auth/me', {}, config);

    console.log(colors.bold('Authenticated Session:'));
    console.log(`  email:         ${colors.green(data.user.email)}`);
    console.log(`  user id:       ${data.user.id}`);
    if (data.user.full_name) {
      console.log(`  name:          ${data.user.full_name}`);
    }
    console.log(`  admin:         ${data.user.is_platform_admin ? colors.green('yes') : 'no'}`);
    console.log(`  api server:    ${config.apiUrl}`);
    console.log(`  active project:${config.projectRef ? ' ' + colors.green(config.projectRef) : ' ' + colors.dim('(none — use "kairos projects use <ref>")')}`);
    if (data.organizations?.length) {
      console.log(`  organizations: ${data.organizations.map((o) => `${o.name} (${o.role})`).join(', ')}`);
    }
  },

  async login(args: string[] = []) {
    const config = await loadConfig();
    let email = '';
    let password = '';

    if (args.includes('--dev')) {
      email = 'dev@kairosdb.local';
      password = 'kairosdb-dev-password';
    } else {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if ((arg === '--email' || arg === '-e') && args[i + 1]) {
          email = args[i + 1]!;
          i++;
        } else if ((arg === '--password' || arg === '-p') && args[i + 1]) {
          password = args[i + 1]!;
          i++;
        } else if (!email && !arg.startsWith('-')) {
          email = arg;
        } else if (email && !password && !arg.startsWith('-')) {
          password = arg;
        }
      }
      if (!email) email = await prompt('Email: ');
      if (!password) password = await prompt('Password: ', true);
    }

    const data = await api<{ accessToken: string; refreshToken: string; user: { email: string } }>(
      '/api/v1/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      config,
    );
    await saveConfig({ ...config, accessToken: data.accessToken, refreshToken: data.refreshToken });
    console.log(colors.green(`Signed in as ${data.user.email}`));
  },

  async logout() {
    const config = await loadConfig();
    await api('/api/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: config.refreshToken }) }, config)
      .catch(() => undefined);
    await saveConfig({ apiUrl: config.apiUrl });
    console.log('Signed out.');
  },

  async projects(args) {
    const [sub, ...rest] = args;
    if (sub === 'list' || !sub) {
      const projects = await api<Record<string, unknown>[]>('/api/v1/projects');
      return table(projects, ['ref', 'name', 'status', 'region', 'created_at']);
    }
    if (sub === 'create') {
      const name = rest[0] ?? (await prompt('Project name: '));
      const orgs = await api<{ id: string; name: string }[]>('/api/v1/organizations');
      if (orgs.length === 0) throw new Error('Create an organization in the dashboard first');
      const project = await api<{ ref: string; keys: { anon: string; serviceRole: string } }>(
        '/api/v1/projects',
        { method: 'POST', body: JSON.stringify({ name, organizationId: orgs[0]!.id }) },
      );
      console.log(colors.green(`Created ${project.ref}`));
      console.log(`anon key:         ${project.keys.anon}`);
      console.log(`service role key: ${project.keys.serviceRole}`);
      console.log(colors.dim('Store these now — they are not shown again.'));
      return;
    }
    if (sub === 'use') {
      const ref = rest[0] ?? (await prompt('Project ref: '));
      const project = await api<{ id: string; ref: string }>(`/api/v1/projects/${ref}`);
      const config = await loadConfig();
      await saveConfig({ ...config, projectId: project.id, projectRef: project.ref });
      console.log(colors.green(`Using ${project.ref}`));
      return;
    }
    throw new Error(`Unknown projects command: ${sub}`);
  },

  async db(args) {
    const config = await loadConfig();
    if (!config.projectId) throw new Error('Pick a project first: kairos projects use <ref>');
    const [sub] = args;

    if (sub === 'connect') {
      const conn = await api<{ direct: string }>(`/api/v1/projects/${config.projectId}/connection?reveal=true`);
      const child = spawn('psql', [conn.direct], { stdio: 'inherit' });
      return new Promise((resolve) => child.on('close', () => resolve()));
    }
    if (sub === 'url') {
     
      const reveal = args.includes('--reveal');
      const conn = await api<{ direct: string; directWithPassword?: string; connectionString?: string; host: string; port: number; database: string; user: string }>(
        `/api/v1/projects/${config.projectId}/connection${reveal ? '?reveal=true' : ''}`,
      );
      if (!reveal) {
        console.log(`postgres://${conn.user}:********@${conn.host}:${conn.port}/${conn.database}`);
        console.log(colors.dim('Password hidden. Use --reveal to print it, and mind your shell history.'));
        return;
      }
      if (process.stdout.isTTY) {
        console.error(colors.yellow('This prints a live database password. Ctrl-C now if that is being recorded.'));
      }
      console.log(conn.connectionString ?? conn.directWithPassword ?? conn.direct);
      return;
    }

    if (sub === 'restore') {
      const backupId = args[1];
      if (!backupId) throw new Error('Usage: kairos db restore <backup-id>');
      // Restoring overwrites the live database. Typing the project ref is the
      // same confirmation the dashboard asks for before a delete.
      const typed = await prompt(`Type the project ref to confirm restoring over the live database: `);
      const result = await api<{ status: string }>(
        `/api/v1/projects/${config.projectId}/backups/${backupId}/restore`,
        { method: 'POST', body: JSON.stringify({ confirm: typed }) },
      );
      console.log(colors.green(`Restore ${result.status}.`));
      return;
    }

    if (sub === 'verify') {
      const backups = await api<{ id: string; verified_at: string | null; status: string }[]>(
        `/api/v1/projects/${config.projectId}/backups`,
      );
      const unverified = backups.filter((b) => b.status === 'completed' && !b.verified_at);
      if (unverified.length === 0) {
        console.log(colors.green('Every completed backup has been verified.'));
      } else {
        console.log(colors.yellow(`${unverified.length} completed backups were never verified.`));
        console.log(colors.dim('An unverified backup is not a backup. Investigate before relying on it.'));
      }
      return table(backups, ['id', 'status', 'verified_at', 'size_bytes', 'created_at']);
    }
    if (sub === 'dump') {
      const backup = await api<{ id: string }>(`/api/v1/projects/${config.projectId}/backups`, { method: 'POST', body: '{}' });
      console.log(colors.green(`Backup queued (${backup.id}). Check status with: kairos db backups`));
      return;
    }
    if (sub === 'backups') {
      const backups = await api<Record<string, unknown>[]>(`/api/v1/projects/${config.projectId}/backups`);
      return table(backups, ['id', 'status', 'size_bytes', 'created_at']);
    }
    throw new Error(`Unknown db command: ${sub}`);
  },

  /**
   * Server-level commands: this installation, not a project inside it.
   *
   * Everything that touches the host goes through the admin API to the server
   * agent, exactly as the dashboard does. The CLI has no privilege of its own
   * and never shells out — `kairos server restart postgres` is the same
   * audited operation as clicking Restart, invoked from a different place.
   */
  async server(args) {
    const [sub, ...rest] = args;

    /* ---- install / uninstall: scripts, not API calls --------------- */

    if (sub === 'install' || sub === 'uninstall') {
      // Deliberately not run from here. These need root, prompt for
      // confirmation, and rewrite the firewall — all of which belong in a
      // terminal the operator is looking at, not behind an API token.
      console.log(
        [
          colors.bold(`kairos server ${sub}`),
          '',
          'Run the script directly on the Ubuntu machine, as root:',
          '',
          colors.bold(`  sudo ./scripts/${sub}-server.sh`),
          '',
          sub === 'install'
            ? colors.dim('Add --dry-run to print what it would do without changing anything.')
            : colors.dim('It keeps your data by default. Deleting it needs a second, typed confirmation.'),
        ].join('\n'),
      );
      return;
    }

    /* ---- info ------------------------------------------------------ */

    if (!sub || sub === 'info') {
      const info = await api<{
        serverId: string; serverName: string; networkMode: string;
        versions: Record<string, string>; storage: { driver: string; dataRoot: string };
        reachableAt: string[];
        connections: { allocated: number; projectBudget: number; pools: number };
      }>('/api/v1/server/info');

      console.log(colors.bold(`${info.serverName}  ${colors.dim(info.serverId)}`));
      console.log(`  mode        ${info.networkMode}`);
      console.log(`  kairos      ${info.versions.kairos}`);
      console.log(`  postgres    ${info.versions.postgres}`);
      console.log(`  redis       ${info.versions.redis}`);
      console.log(`  storage     ${info.storage.driver} at ${info.storage.dataRoot}`);
      console.log(`  connections ${info.connections.allocated}/${info.connections.projectBudget} across ${info.connections.pools} pools`);
      console.log(`  reachable   ${info.reachableAt.join(', ')}`);
      return;
    }

    /* ---- status ---------------------------------------------------- */

    if (sub === 'status') {
      const agent = await agentStatus();
      if (!agent.reachable) {
        // Fall back to the platform's own health endpoint. It cannot see the
        // host, but "the API is up and the agent is not" is a materially
        // different answer from "nothing responds", and worth distinguishing.
        console.log(colors.yellow('The server agent is not reachable, so host state is unavailable.'));
        console.log(colors.dim(`  ${agent.detail}`));
        console.log('');
        const health = await api<{ status: string; services: Record<string, string> }>('/api/ready');
        console.log(`Platform: ${health.status === 'healthy' ? colors.green('healthy') : colors.yellow('degraded')}`);
        for (const [name, state] of Object.entries(health.services)) {
          console.log(`  ${name.padEnd(10)} ${state === 'healthy' ? colors.green('ok') : colors.red(state)}`);
        }
        process.exitCode = 1;
        return;
      }

      // The agent already renders this. Printing its text keeps the CLI and the
      // dashboard terminal identical rather than two formatters that drift.
      console.log(await runOperationText('kairos_status'));
      return;
    }

    /* ---- doctor ---------------------------------------------------- */

    if (sub === 'doctor') {
      console.log(await runOperationText('kairos_doctor'));
      return;
    }

    /* ---- services -------------------------------------------------- */

    if (sub === 'services') {
      console.log(await runOperationText('service_list'));
      return;
    }

    if (sub === 'start' || sub === 'stop' || sub === 'restart') {
      const service = rest[0];
      if (!service) throw new Error(`Usage: kairos server ${sub} <service>`);

      const phrase = sub === 'stop' ? 'STOP SERVICE' : sub === 'restart' ? 'RESTART SERVICE' : null;
      let confirm: string | undefined;

      if (phrase) {
        console.log(colors.yellow(`This ${sub}s ${service} on the host. Connections to it will drop.`));
        const typed = await prompt(`Type ${colors.bold(phrase)} to continue: `);
        if (typed !== phrase) {
          console.log('Not confirmed. Nothing was changed.');
          process.exitCode = 1;
          return;
        }
        confirm = phrase;
      }

      const result = await api<{ state: string; output: string }>(
        `/api/v1/admin/server/services/${encodeURIComponent(service)}`,
        { method: 'POST', body: JSON.stringify({ action: sub, ...(confirm ? { confirm } : {}) }) },
      );
      console.log(result.output);
      return;
    }

    /* ---- logs ------------------------------------------------------ */

    if (sub === 'logs') {
      const source = rest[0];
      if (!source) {
        console.log(await runOperationText('logs_sources'));
        console.log('');
        console.log(colors.dim('Usage: kairos server logs <source> [lines]'));
        return;
      }
      const lines = Number(rest[1] ?? 200);
      const result = await api<{ lines: string[]; available: boolean; output: string }>(
        `/api/v1/admin/server/logs/${encodeURIComponent(source)}?lines=${Number.isFinite(lines) ? lines : 200}`,
      );
      console.log(result.available ? result.output : colors.yellow(result.output));
      return;
    }

    /* ---- backups --------------------------------------------------- */

    if (sub === 'backup') {
      const action = rest[0] ?? 'list';

      if (action === 'list') {
        console.log(await runOperationText('backup_list'));
        return;
      }
      if (action === 'create') {
        console.log(colors.dim('Dumping and verifying. On a large database this takes a while.'));
        const result = await api<{ output: string }>('/api/v1/admin/server/backups', { method: 'POST', body: '{}' });
        console.log(result.output);
        return;
      }
      if (action === 'verify') {
        const id = rest[1];
        if (!id) throw new Error('Usage: kairos server backup verify <archive>');
        const result = await api<{ output: string; ok: boolean }>(
          `/api/v1/admin/server/backups/${encodeURIComponent(id)}/verify`,
          { method: 'POST', body: '{}' },
        );
        console.log(result.output);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (action === 'restore') {
        const id = rest[1];
        if (!id) throw new Error('Usage: kairos server backup restore <archive>');
        console.log(colors.red('This overwrites the live platform database. Everything written since that archive is gone.'));
        const typed = await prompt(`Type ${colors.bold('RESTORE DATABASE')} to continue: `);
        if (typed !== 'RESTORE DATABASE') {
          console.log('Not confirmed. Nothing was changed.');
          process.exitCode = 1;
          return;
        }
        const result = await api<{ output: string }>(
          `/api/v1/admin/server/backups/${encodeURIComponent(id)}/restore`,
          { method: 'POST', body: JSON.stringify({ confirm: typed }) },
        );
        console.log(result.output);
        return;
      }
      throw new Error('Usage: kairos server backup [list|create|verify <id>|restore <id>]');
    }

    /* ---- firewall -------------------------------------------------- */

    if (sub === 'firewall') {
      const action = rest[0] ?? 'status';

      if (action === 'status') {
        console.log(await runOperationText('firewall_status'));
        return;
      }
      if (action === 'rules') {
        console.log(await runOperationText('firewall_rules'));
        return;
      }
      if (action === 'apply') {
        console.log(colors.yellow('This replaces the KAIROS nftables table. Established connections are kept.'));
        const typed = await prompt(`Type ${colors.bold('APPLY FIREWALL')} to continue: `);
        if (typed !== 'APPLY FIREWALL') {
          console.log('Not confirmed.');
          process.exitCode = 1;
          return;
        }
        const result = await api<{ output: string }>('/api/v1/admin/server/firewall/baseline', {
          method: 'POST',
          body: JSON.stringify({ confirm: typed }),
        });
        console.log(result.output);
        return;
      }
      throw new Error('Usage: kairos server firewall [status|rules|apply]');
    }

    /* ---- network / storage ----------------------------------------- */

    if (sub === 'network') {
      console.log(await runOperationText('network_ports'));
      return;
    }

    if (sub === 'storage') {
      console.log(await runOperationText('storage_status'));
      return;
    }

    /* ---- connect --------------------------------------------------- */

    if (sub === 'connect') {
      const info = await api<{
        serverId: string; serverName: string; networkMode: string; reachableAt: string[];
      }>('/api/v1/server/info');

      const endpoint = info.reachableAt[0] ?? 'http://localhost:4000';

      console.log(colors.bold('Connect another machine to this server'));
      console.log('');
      console.log(`  Server    ${info.serverName} ${colors.dim(info.serverId)}`);
      console.log(`  Endpoint  ${endpoint}`);
      console.log(`  Mode      ${info.networkMode}`);
      if (info.networkMode === 'local') {
        console.log('');
        console.log(colors.yellow('  The server is in local mode, so only this machine can reach it.'));
        console.log(colors.dim('  Switch to lan or remote to connect another device.'));
      }
      console.log('');
      console.log(colors.bold('  JavaScript'));
      console.log('    npm install @kairosdb/client');
      console.log('');
      console.log('    import { createClient } from "@kairosdb/client";');
      console.log(`    const db = createClient("${endpoint}", "krs_anon_...");`);
      console.log('    const { data } = await db.from("profiles").select("*");');
      console.log('');
      console.log(colors.bold('  curl'));
      console.log(`    curl "${endpoint}/rest/v1/profiles?select=*" -H "apikey: krs_anon_..."`);
      console.log('');
      console.log(colors.dim("  The anon key comes from your project's Keys page. PostgreSQL itself is never exposed."));
      return;
    }

    /* ---- operations ------------------------------------------------ */

    if (sub === 'operations') {
      const result = await api<{ operations: { id: string; summary: string; danger: boolean }[] }>(
        '/api/v1/admin/server/operations',
      );
      const width = Math.max(...result.operations.map((operation) => operation.id.length));
      for (const operation of result.operations) {
        const mark = operation.danger ? colors.red('[danger]') : '        ';
        console.log(`  ${operation.id.padEnd(width)}  ${mark} ${operation.summary}`);
      }
      console.log('');
      console.log(colors.dim('This is everything the agent can do. Nothing outside this list exists.'));
      return;
    }

    throw new Error(
      `Unknown server command: ${sub}\n` +
        'Try: info, status, doctor, services, start, stop, restart, logs, backup, firewall, network, storage, connect, operations',
    );
  },

  /**
   * `doctor` reports problems, not numbers. A wall of green metrics is not
   * what someone wants when something is wrong.
   */
  async doctor() {
    const result = await api<{
      serverId: string;
      healthy: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    }>('/api/v1/server/doctor');

    for (const check of result.checks) {
      const mark = check.ok ? colors.green('  ok  ') : colors.red(' warn ');
      console.log(`${mark} ${check.name.padEnd(22)} ${check.detail}`);
    }
    console.log('');
    console.log(result.healthy ? colors.green('No problems found.') : colors.yellow('Some checks need attention.'));
    if (!result.healthy) process.exitCode = 1;
  },

  async logs(args) {
    const config = await loadConfig();
    if (!config.projectId) throw new Error('Pick a project first: kairos projects use <ref>');
    const kind = args[0] ?? 'audit';
    if (kind === 'audit') {
      const rows = await api<Record<string, unknown>[]>(`/api/v1/projects/${config.projectId}/logs/audit`);
      return table(rows, ['created_at', 'action', 'resource_type', 'resource_id']);
    }
    if (kind === 'queries') {
      const rows = await api<Record<string, unknown>[]>(`/api/v1/projects/${config.projectId}/sql/history`);
      return table(rows, ['created_at', 'duration_ms', 'rows', 'success']);
    }
    throw new Error('Usage: kairos logs [audit|queries]');
  },

  async quotas() {
    const config = await loadConfig();
    if (!config.projectId) throw new Error('Pick a project first: kairos projects use <ref>');
    const result = await api<{ summary: { label: string; used: number; limit: number | null; percent: number | null }[]; note: string }>(
      `/api/v1/projects/${config.projectId}/quotas`,
    );
    for (const entry of result.summary) {
      const usage = entry.limit === null ? `${entry.used} (no limit)` : `${entry.used} / ${entry.limit}`;
      const pct = entry.percent === null ? '' : ` ${entry.percent}%`;
      const colour = (entry.percent ?? 0) >= 90 ? colors.red : (entry.percent ?? 0) >= 75 ? colors.yellow : colors.green;
      console.log(`  ${entry.label.padEnd(24)} ${colour(usage + pct)}`);
    }
    console.log('');
    console.log(colors.dim(result.note));
  },

  async migration(args) {
    const config = await loadConfig();
    if (!config.projectId) throw new Error('Pick a project first: kairos projects use <ref>');
    const [sub, ...rest] = args;

    if (sub === 'create') {
      const name = rest[0];
      if (!name) throw new Error('Give the migration a name: kairos migration create add_profiles');
      const dir = join(process.cwd(), 'migrations');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${Date.now()}_${name}.sql`);
      await writeFile(file, `-- up\n\n\n-- down\n\n`);
      console.log(colors.green(`Created ${file}`));
      return;
    }
    if (sub === 'push') {
      const file = rest[0];
      if (!file) throw new Error('Point at a migration file: kairos migration push migrations/xyz.sql');
      const contents = await readFile(file, 'utf8');
      const [up = '', down = ''] = contents.split(/^-- down\s*$/m);
      const name = file.split('/').pop()!.replace(/\.sql$/, '').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      const created = await api<{ id: string }>(`/api/v1/projects/${config.projectId}/migrations`, {
        method: 'POST',
        body: JSON.stringify({ name, up: up.replace(/^-- up\s*$/m, '').trim(), down: down.trim() || undefined }),
      });
      console.log(colors.green(`Uploaded migration ${name} (${created.id})`));
      return;
    }
    if (sub === 'up') {
      const migrations = await api<{ id: string; name: string; applied_at: string | null }[]>(
        `/api/v1/projects/${config.projectId}/migrations`,
      );
      const pending = migrations.filter((m) => !m.applied_at);
      if (pending.length === 0) return console.log('Everything is already applied.');
      for (const migration of pending) {
        await api(`/api/v1/projects/${config.projectId}/migrations/${migration.id}/apply`, { method: 'POST', body: '{}' });
        console.log(colors.green(`Applied ${migration.name}`));
      }
      return;
    }
    if (sub === 'status') {
      const migrations = await api<Record<string, unknown>[]>(`/api/v1/projects/${config.projectId}/migrations`);
      return table(migrations, ['name', 'applied_at', 'created_at']);
    }
    throw new Error(`Unknown migration command: ${sub}`);
  },

  async generate(args) {
    const config = await loadConfig();
    if (!config.projectId) throw new Error('Pick a project first: kairos projects use <ref>');
    if (args[0] !== 'types') throw new Error('Usage: kairos generate types');
    const types = await api<string>(`/api/v1/projects/${config.projectId}/types`);
    process.stdout.write(types);
  },

  async storage(args) {
    const config = await loadConfig();
    if (!config.projectId) throw new Error('Pick a project first: kairos projects use <ref>');
    const [sub, ...rest] = args;

    if (sub === 'list') {
      const bucket = rest[0];
      if (!bucket) {
        const buckets = await api<Record<string, unknown>[]>(`/api/v1/projects/${config.projectId}/storage/buckets`);
        return table(buckets, ['name', 'public', 'object_count', 'total_bytes']);
      }
      const objects = await api<Record<string, unknown>[]>(
        `/api/v1/projects/${config.projectId}/storage/buckets/${bucket}/objects`,
      );
      return table(objects, ['path', 'size', 'mime_type', 'created_at']);
    }
    throw new Error(`Unknown storage command: ${sub}`);
  },

  async help() {
    console.log(`
${colors.bold('kairos')} — KairosDB command line

  ${colors.bold('kairos whoami')}                     Display current authenticated session
  ${colors.bold('kairos login')}                      Sign in and store a session
  ${colors.bold('kairos logout')}                     Sign out and clear the session

  ${colors.bold('kairos projects list')}              Show every project you can reach
  ${colors.bold('kairos projects create <name>')}     Create a project and print its keys
  ${colors.bold('kairos projects use <ref>')}         Pick the project later commands act on

  ${colors.bold('kairos server info')}                Server id, versions, network mode, pools
  ${colors.bold('kairos server status')}              Live state of the Ubuntu host
  ${colors.bold('kairos server doctor')}              Report problems with this installation
  ${colors.bold('kairos server services')}            Every managed service and its state
  ${colors.bold('kairos server start|stop|restart')}  Control one service (asks for confirmation)
  ${colors.bold('kairos server logs')} <source> [n]   Read a service log from the host
  ${colors.bold('kairos server backup')} [list|create|verify|restore]
  ${colors.bold('kairos server firewall')} [status|rules|apply]
  ${colors.bold('kairos server network')}             What is listening, and what is exposed
  ${colors.bold('kairos server storage')}             Disk usage across the KAIROS directories
  ${colors.bold('kairos server connect')}             How another machine connects to this one
  ${colors.bold('kairos server operations')}          The full agent allowlist
  ${colors.bold('kairos server install')}             How to provision this machine
  ${colors.bold('kairos doctor')}                     Report problems with this installation
  ${colors.bold('kairos quotas')}                     Resource usage against this project's limits
  ${colors.bold('kairos logs')} [audit|queries]       Recent activity

  ${colors.bold('kairos db url')} [--reveal]          Connection string (password hidden by default)
  ${colors.bold('kairos db restore')} <backup-id>     Restore over the live database
  ${colors.bold('kairos db verify')}                  Check every backup has actually been verified
  ${colors.bold('kairos db connect')}                 Open psql against the project
  ${colors.bold('kairos db dump')}                    Start a backup
  ${colors.bold('kairos db backups')}                 List backups

  ${colors.bold('kairos migration create <name>')}    Write a new migration file
  ${colors.bold('kairos migration push <file>')}      Upload a migration
  ${colors.bold('kairos migration up')}               Apply everything pending
  ${colors.bold('kairos migration status')}           Show applied and pending migrations

  ${colors.bold('kairos storage list [bucket]')}      Browse buckets and files
  ${colors.bold('kairos generate types')}             Print TypeScript types for the schema
`);
  },
};

async function main() {
  const rawArg = process.argv[2] ?? 'help';
  const cleanArg = rawArg.replace(/^--?/, '');
  const aliasMap: Record<string, string> = {
    l: 'login',
    h: 'help',
    v: 'version',
  };
  const resolved = commands[rawArg] ? rawArg : commands[cleanArg] ? cleanArg : aliasMap[cleanArg] ?? 'help';
  const handler = commands[resolved] ?? commands['help']!;
  const args = process.argv.slice(commands[rawArg] || commands[cleanArg] || aliasMap[cleanArg] ? 3 : 2);
  try {
    await handler(args);
  } catch (err) {
    console.error(colors.red((err as Error).message));
    process.exit(1);
  }
}

void main();
