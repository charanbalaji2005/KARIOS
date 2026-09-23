/**
 * Server provisioning — the steps behind the setup wizard.
 *
 * Every step is idempotent and every step is split into a *check* and an
 * *apply*. The wizard runs the checks on load, so a half-provisioned laptop
 * shows you where it got to instead of starting over; the applies are the only
 * things that change the machine, and each one is a separate deliberate act.
 *
 * Nothing here reports success it did not observe. `provision_check_storage`
 * does not return "created" because it ran mkdir — it stats the directory
 * afterwards and reports what it found.
 */
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { register } from '../registry.js';
import { run, tryRun, binaryAvailable } from '../exec.js';
import { config } from '../config.js';
import { MANAGED_DIRECTORIES } from '../units.js';
import { osRelease, dependencies, dockerComposeVersion, diskUsage, formatBytes } from './system.js';
import { firewallStatus } from './firewall.js';
import { postgresHealth, redisHealth, nginxHealth } from './database.js';
import { runDoctor } from './health.js';

/* --------------------------------------------------------- step 1: host */

/**
 * Minimums, chosen from what the stack actually needs rather than from a round
 * number: PostgreSQL plus Redis plus the API plus a Next.js build is
 * comfortably over 2GB, and a 64-bit kernel is not optional for any of it.
 */
const MINIMUM_MEMORY_BYTES = 4 * 1024 ** 3;
const MINIMUM_DISK_BYTES = 20 * 1024 ** 3;

export async function checkSystem() {
  const os = await osRelease();
  const memory = totalmem();
  const cores = cpus().length;
  const disk = (await diskUsage('/')) ?? null;
  const architecture = process.arch;

  const findings: { ok: boolean; blocking: boolean; message: string }[] = [];

  findings.push({
    ok: os?.isUbuntu ?? false,
    // Debian and its derivatives work. The scripts are written and tested
    // against Ubuntu, so anything else is "probably fine, untested" rather
    // than a hard stop.
    blocking: false,
    message: os
      ? os.isUbuntu
        ? `${os.prettyName}${os.isLts ? '' : ' — not an LTS release, so it stops getting security updates sooner'}`
        : `${os.prettyName} is not Ubuntu. The setup scripts assume apt and systemd; expect to adjust them.`
      : 'Could not read /etc/os-release. This does not look like a Linux host.',
  });

  findings.push({
    ok: architecture === 'x64' || architecture === 'arm64',
    blocking: true,
    message: `${architecture} architecture`,
  });

  findings.push({
    ok: memory >= MINIMUM_MEMORY_BYTES,
    blocking: false,
    message: `${formatBytes(memory)} RAM${memory < MINIMUM_MEMORY_BYTES ? ` — below the ${formatBytes(MINIMUM_MEMORY_BYTES)} this stack wants. It will run and it will swap.` : ''}`,
  });

  findings.push({ ok: cores >= 2, blocking: false, message: `${cores} CPU cores` });

  findings.push({
    ok: (disk?.freeBytes ?? 0) >= MINIMUM_DISK_BYTES,
    blocking: false,
    message: disk
      ? `${formatBytes(disk.freeBytes)} free on /${disk.freeBytes < MINIMUM_DISK_BYTES ? ` — below ${formatBytes(MINIMUM_DISK_BYTES)}, which Docker images alone will eat` : ''}`
      : 'could not read the root filesystem',
  });

  findings.push({
    ok: process.getuid?.() === 0,
    blocking: true,
    message: process.getuid?.() === 0 ? 'agent is running as root' : 'agent is not running as root and cannot manage the host',
  });

  return {
    os,
    memoryBytes: memory,
    cores,
    architecture,
    disk,
    findings,
    ready: findings.every((finding) => finding.ok || !finding.blocking),
    blocked: findings.filter((finding) => !finding.ok && finding.blocking).map((finding) => finding.message),
  };
}

/* ------------------------------------------------------ step 3: storage */

export async function checkStorage() {
  const results = await Promise.all(
    MANAGED_DIRECTORIES.map(async (entry) => {
      const path = join(config.dataRoot, entry.path);
      try {
        const stats = await stat(path);
        const mode = (stats.mode & 0o7777).toString(8).padStart(4, '0');
        return {
          id: entry.id,
          path,
          exists: stats.isDirectory(),
          mode,
          // 0750 or tighter. A world-readable backups directory on a laptop
          // that other people use is a copy of the database for each of them.
          secure: (stats.mode & 0o007) === 0,
        };
      } catch {
        return { id: entry.id, path, exists: false, mode: null, secure: null };
      }
    }),
  );

  return {
    dataRoot: config.dataRoot,
    directories: results,
    ready: results.every((entry) => entry.exists),
    insecure: results.filter((entry) => entry.exists && entry.secure === false).map((entry) => entry.path),
  };
}

async function applyStorage(emit: (text: string) => void) {
  await mkdir(config.dataRoot, { recursive: true, mode: 0o750 });
  for (const entry of MANAGED_DIRECTORIES) {
    const path = join(config.dataRoot, entry.path);
    await mkdir(path, { recursive: true, mode: 0o750 });
    emit(`  ${path}\n`);
  }
  // mkdir's mode is masked by the process umask, so set it explicitly after.
  if (binaryAvailable('chmod')) {
    await run('chmod', ['750', config.dataRoot], { timeoutMs: 10_000, allowNonZeroExit: true });
    for (const entry of MANAGED_DIRECTORIES) {
      await run('chmod', ['750', join(config.dataRoot, entry.path)], { timeoutMs: 10_000, allowNonZeroExit: true });
    }
  }
  return await checkStorage();
}

/* ------------------------------------------------------- step 5: docker */

const DOCKER_NETWORK = 'kairos_internal';

export async function checkDockerNetwork() {
  if (!binaryAvailable('docker')) {
    return { available: false, exists: false, detail: 'Docker is not installed' };
  }
  const raw = await tryRun('docker', ['network', 'inspect', DOCKER_NETWORK, '--format', '{{.Name}}\t{{.Driver}}\t{{.Internal}}'], {
    timeoutMs: 15_000,
  });
  if (!raw) return { available: true, exists: false, detail: `${DOCKER_NETWORK} does not exist` };
  const [name = '', driver = '', internal = ''] = raw.trim().split('\t');
  return { available: true, exists: true, name, driver, internal: internal === 'true', detail: `${name} (${driver})` };
}

/* --------------------------------------------- step 6: postgres tuning */

export interface PostgresTuning {
  maxConnections: number;
  sharedBuffers: string;
  effectiveCacheSize: string;
  workMem: string;
  maintenanceWorkMem: string;
  walBuffers: string;
  randomPageCost: number;
  effectiveIoConcurrency: number;
  maxWorkerProcesses: number;
  maxParallelWorkers: number;
  rationale: string[];
}

/**
 * Derive PostgreSQL settings from the hardware that is actually present.
 *
 * The usual advice — max_connections=300, shared_buffers=25% — comes from
 * dedicated database servers. This is a laptop that is also running the API,
 * Redis, NGINX, a browser and probably a video call, so the shares are smaller
 * and the connection ceiling is derived from work_mem rather than picked.
 *
 * The connection number is the one that matters: each connection can allocate
 * work_mem several times over for a sort or a hash join, so 300 connections
 * with 8MB work_mem is a licence to consume several gigabytes above
 * shared_buffers and be OOM-killed.
 */
export function tunePostgres(memoryBytes: number, cores: number): PostgresTuning {
  const mb = memoryBytes / 1024 ** 2;
  const rationale: string[] = [];

  // Leave the rest of the platform room to breathe.
  const budgetMb = Math.floor(mb * 0.5);
  rationale.push(`Half of ${formatBytes(memoryBytes)} is budgeted to PostgreSQL; the API, Redis and the OS need the rest.`);

  const sharedBuffersMb = Math.max(128, Math.min(Math.floor(budgetMb * 0.4), 8192));
  rationale.push(`shared_buffers is 40% of that budget, capped at 8GB where the returns flatten.`);

  const workMemMb = Math.max(4, Math.min(64, Math.floor(budgetMb / 64)));
  // Derive the ceiling from what a connection can actually consume.
  const perConnectionMb = workMemMb * 2;
  const connectionBudgetMb = budgetMb - sharedBuffersMb;
  const maxConnections = Math.max(20, Math.min(200, Math.floor(connectionBudgetMb / perConnectionMb)));
  rationale.push(
    `max_connections is ${maxConnections}, derived from work_mem: a connection can use roughly ${perConnectionMb}MB ` +
      `for sorts and hashes, and ${formatBytes(connectionBudgetMb * 1024 ** 2)} remains after shared_buffers.`,
  );

  const effectiveCacheSizeMb = Math.floor(mb * 0.5);
  const maintenanceWorkMemMb = Math.max(64, Math.min(1024, Math.floor(budgetMb / 16)));

  return {
    maxConnections,
    sharedBuffers: `${sharedBuffersMb}MB`,
    effectiveCacheSize: `${effectiveCacheSizeMb}MB`,
    workMem: `${workMemMb}MB`,
    maintenanceWorkMem: `${maintenanceWorkMemMb}MB`,
    walBuffers: '16MB',
    // An NVMe laptop is nothing like the spinning disk the 4.0 default assumes.
    randomPageCost: 1.1,
    effectiveIoConcurrency: 200,
    maxWorkerProcesses: cores,
    maxParallelWorkers: Math.max(1, Math.floor(cores / 2)),
    rationale: [
      ...rationale,
      'random_page_cost is 1.1 and effective_io_concurrency is 200, which assume SSD/NVMe. Lower both if this is a spinning disk.',
    ],
  };
}

function renderPostgresConf(tuning: PostgresTuning): string {
  return [
    '# Generated by the KAIROS server agent from this machine\'s actual RAM and',
    '# core count. Include it from postgresql.conf, or drop it in conf.d.',
    '#',
    ...tuning.rationale.map((line) => `# ${line}`),
    '',
    `max_connections = ${tuning.maxConnections}`,
    `shared_buffers = ${tuning.sharedBuffers}`,
    `effective_cache_size = ${tuning.effectiveCacheSize}`,
    `work_mem = ${tuning.workMem}`,
    `maintenance_work_mem = ${tuning.maintenanceWorkMem}`,
    `wal_buffers = ${tuning.walBuffers}`,
    `random_page_cost = ${tuning.randomPageCost}`,
    `effective_io_concurrency = ${tuning.effectiveIoConcurrency}`,
    `max_worker_processes = ${tuning.maxWorkerProcesses}`,
    `max_parallel_workers = ${tuning.maxParallelWorkers}`,
    `max_parallel_workers_per_gather = ${Math.max(1, Math.floor(tuning.maxParallelWorkers / 2))}`,
    '',
    '# Required by KAIROS: logical decoding for realtime, statement stats for',
    '# the slow-query view.',
    "shared_preload_libraries = 'pg_stat_statements'",
    'wal_level = logical',
    '',
    '# Log the queries that are actually worth looking at.',
    'log_min_duration_statement = 1000',
    "log_line_prefix = '%m [%p] %q%u@%d '",
    '',
  ].join('\n');
}

/* ---------------------------------------------------------- operations */

register(
  {
    id: 'provision_check_system',
    summary: 'Step 1 — verify the host can run KAIROS',
    category: 'provision',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const result = await checkSystem();
      const text = result.findings
        .map((finding) => `${finding.ok ? '  ok  ' : finding.blocking ? ' FAIL ' : ' warn '} ${finding.message}`)
        .join('\n');
      return { data: result, text };
    },
  },
  {
    id: 'provision_check_dependencies',
    summary: 'Step 2 — which packages are present',
    category: 'provision',
    danger: false,
    timeoutMs: 60_000,
    async run() {
      const [list, compose] = await Promise.all([dependencies(), dockerComposeVersion()]);
      const missing = list.filter((entry) => entry.required && !entry.installed).map((entry) => entry.package);
      if (compose === null) missing.push('docker-compose-plugin');

      const text = [
        ...list.map((entry) => `${entry.installed ? '  ok  ' : entry.required ? ' FAIL ' : ' warn '} ${entry.name.padEnd(22)} ${entry.version ?? 'not installed'}`),
        `${compose ? '  ok  ' : ' FAIL '} ${'Docker Compose'.padEnd(22)} ${compose ?? 'not installed'}`,
      ].join('\n');

      return {
        data: { dependencies: list, compose, missing: [...new Set(missing)], ready: missing.length === 0 },
        text,
      };
    },
  },
  {
    id: 'provision_install_dependencies',
    summary: 'Step 2 — install the missing required packages with apt',
    category: 'provision',
    // Installing packages changes the machine outside KAIROS's own footprint.
    danger: true,
    confirmPhrase: 'INSTALL PACKAGES',
    timeoutMs: 20 * 60_000,
    async run({ emit }) {
      if (!binaryAvailable('apt_get')) throw new Error('apt-get is not available; install the packages by hand.');

      const [list, compose] = await Promise.all([dependencies(), dockerComposeVersion()]);
      const missing = [...new Set(list.filter((entry) => entry.required && !entry.installed).map((entry) => entry.package))];

      // Docker's packages come from Docker's own repository, which
      // install-server.sh sets up. Installing docker-ce from Ubuntu's archive
      // gets you a different, older thing.
      const fromDockerRepo = missing.filter((pkg) => pkg.startsWith('docker'));
      const fromUbuntu = missing.filter((pkg) => !pkg.startsWith('docker'));

      if (fromUbuntu.length === 0 && fromDockerRepo.length === 0 && compose !== null) {
        return { data: { installed: [], alreadyPresent: true }, text: 'Everything required is already installed.' };
      }

      if (fromUbuntu.length > 0) {
        emit(`Installing: ${fromUbuntu.join(' ')}\n`);
        await run('apt_get', ['update', '-qq'], { timeoutMs: 5 * 60_000, env: { DEBIAN_FRONTEND: 'noninteractive' } });
        const result = await run('apt_get', ['install', '-y', '-qq', ...fromUbuntu], {
          timeoutMs: 15 * 60_000,
          allowNonZeroExit: true,
          env: { DEBIAN_FRONTEND: 'noninteractive' },
        });
        emit(result.stdout + result.stderr);
        if (result.code !== 0) throw new Error(`apt-get install failed with exit code ${result.code}`);
      }

      if (fromDockerRepo.length > 0 || compose === null) {
        emit(
          '\nDocker is not installed, or its compose plugin is missing. It comes from Docker\'s own apt repository\n' +
            'rather than Ubuntu\'s, so run scripts/install-server.sh, which adds the repository key first.\n',
        );
      }

      const after = await dependencies();
      return {
        data: { installed: fromUbuntu, stillMissing: after.filter((e) => e.required && !e.installed).map((e) => e.package) },
        text: 'Package installation finished. Re-run the dependency check to confirm.',
      };
    },
  },
  {
    id: 'provision_check_storage',
    summary: 'Step 3 — the KAIROS data directories',
    category: 'provision',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const result = await checkStorage();
      const text = [
        `Data root: ${result.dataRoot}`,
        '',
        ...result.directories.map(
          (entry) => `${entry.exists ? '  ok  ' : ' miss ' } ${entry.path}${entry.mode ? `  mode ${entry.mode}` : ''}`,
        ),
        ...(result.insecure.length ? ['', ...result.insecure.map((path) => `  ! ${path} is readable by other users on this machine`)] : []),
      ].join('\n');
      return { data: result, text };
    },
  },
  {
    id: 'provision_apply_storage',
    summary: 'Step 3 — create the KAIROS data directories',
    category: 'provision',
    danger: false,
    timeoutMs: 60_000,
    async run({ emit }) {
      emit(`Creating directories under ${config.dataRoot}\n`);
      const result = await applyStorage(emit);
      return {
        data: result,
        text: result.ready ? 'All directories exist.' : 'Some directories could not be created — check the agent has write access.',
      };
    },
  },
  {
    id: 'provision_check_firewall',
    summary: 'Step 4 — firewall posture',
    category: 'provision',
    danger: false,
    timeoutMs: 40_000,
    async run() {
      const status = await firewallStatus();
      return {
        data: status,
        text: [
          `Backend      ${status.backend}`,
          `Active       ${status.active ? 'yes' : 'no'}`,
          `Inbound      ${status.defaultPolicy ?? 'unknown'}`,
          `KAIROS rules ${status.kairosTable ? 'installed' : 'not installed'}`,
          ...(status.exposure.length ? ['', ...status.exposure.map((f) => `  ! ${f.message}`)] : []),
        ].join('\n'),
      };
    },
  },
  {
    id: 'provision_check_docker',
    summary: 'Step 5 — the KAIROS Docker network',
    category: 'provision',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const result = await checkDockerNetwork();
      return { data: result, text: result.detail };
    },
  },
  {
    id: 'provision_apply_docker',
    summary: 'Step 5 — create the internal Docker network',
    category: 'provision',
    danger: false,
    timeoutMs: 60_000,
    async run({ emit }) {
      if (!binaryAvailable('docker')) throw new Error('Docker is not installed.');
      const existing = await checkDockerNetwork();
      if (existing.exists) return { data: existing, text: `${DOCKER_NETWORK} already exists.` };

      emit(`Creating ${DOCKER_NETWORK}\n`);
      // Not --internal: the API needs outbound access for webhooks and ACME.
      // Containers on this network are reachable from each other and from the
      // host, and from nowhere else, which is the property that matters.
      await run('docker', ['network', 'create', '--driver', 'bridge', DOCKER_NETWORK], { timeoutMs: 45_000 });
      const after = await checkDockerNetwork();
      return { data: after, text: `${DOCKER_NETWORK} created.` };
    },
  },
  {
    id: 'provision_check_postgres',
    summary: 'Step 6 — PostgreSQL, and the settings this hardware wants',
    category: 'provision',
    danger: false,
    timeoutMs: 45_000,
    async run() {
      const [health, tuning] = await Promise.all([
        postgresHealth(),
        Promise.resolve(tunePostgres(totalmem(), cpus().length)),
      ]);
      return {
        data: { health, tuning, conf: renderPostgresConf(tuning) },
        text: [
          `PostgreSQL   ${health.state.toUpperCase()}`,
          health.version ? `Version      ${health.version}` : '',
          '',
          'Settings derived from this machine:',
          `  max_connections        ${tuning.maxConnections}`,
          `  shared_buffers         ${tuning.sharedBuffers}`,
          `  effective_cache_size   ${tuning.effectiveCacheSize}`,
          `  work_mem               ${tuning.workMem}`,
          `  maintenance_work_mem   ${tuning.maintenanceWorkMem}`,
          '',
          ...tuning.rationale.map((line) => `  ${line}`),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  },
  {
    id: 'provision_write_postgres_conf',
    summary: 'Step 6 — write the tuned PostgreSQL configuration',
    category: 'provision',
    danger: false,
    timeoutMs: 30_000,
    async run({ emit }) {
      const tuning = tunePostgres(totalmem(), cpus().length);
      const path = join(config.configRoot, 'postgresql.kairos.conf');
      await mkdir(config.configRoot, { recursive: true, mode: 0o750 });
      await writeFile(path, renderPostgresConf(tuning), { mode: 0o644 });
      emit(`Wrote ${path}\n`);
      return {
        data: { path, tuning },
        // Deliberately does not restart PostgreSQL. Applying it is a separate,
        // disruptive decision the operator makes when they are ready.
        text: [
          `Wrote ${path}`,
          '',
          'Nothing has changed yet. To apply it:',
          `  include it from postgresql.conf, or copy it into conf.d, then restart PostgreSQL.`,
          '',
          'shared_buffers and max_connections need a full restart, not a reload.',
        ].join('\n'),
      };
    },
  },
  {
    id: 'provision_check_redis',
    summary: 'Step 7 — Redis, and whether it is internal-only',
    category: 'provision',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const health = await redisHealth();
      return {
        data: health,
        text: [
          `Redis        ${health.state.toUpperCase()}`,
          `Reachable    ${health.reachable === null ? 'unknown' : health.reachable ? 'yes' : 'no'}`,
          health.version ? `Version      ${health.version}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  },
  {
    id: 'provision_check_nginx',
    summary: 'Step 8 — NGINX and its configuration',
    category: 'provision',
    danger: false,
    timeoutMs: 40_000,
    async run() {
      const health = await nginxHealth();
      return {
        data: health,
        text: [
          `NGINX        ${health.state.toUpperCase()}`,
          `Config       ${health.configValid === null ? 'not checked' : health.configValid ? 'valid' : 'INVALID'}`,
          health.configDetail ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  },
  {
    id: 'provision_check_backups',
    summary: 'Step 10 — the backup directory',
    category: 'provision',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const path = join(config.dataRoot, 'backups');
      let exists = false;
      let mode: string | null = null;
      try {
        const stats = await stat(path);
        exists = stats.isDirectory();
        mode = (stats.mode & 0o7777).toString(8).padStart(4, '0');
      } catch {
        exists = false;
      }
      return {
        data: { path, exists, mode, sharedWith: ['agent backup_create', 'API backup worker', 'scripts/backup-rotate.sh'] },
        text: exists
          ? `${path} exists (mode ${mode}).\n\nThe agent, the API's backup worker and the rotation script all write here — one directory, so a restore finds the newest archive whichever wrote it.`
          : `${path} does not exist. Run the storage step.`,
      };
    },
  },
  {
    id: 'provision_health_check',
    summary: 'Step 11 — run every health check against the host',
    category: 'provision',
    danger: false,
    timeoutMs: 120_000,
    async run() {
      const { healthy, checks } = await runDoctor();
      const width = Math.max(...checks.map((check) => check.name.length));
      return {
        data: { healthy, checks },
        text: checks
          .map((check) => `${check.ok ? '  ok  ' : check.severity === 'critical' ? ' FAIL ' : ' warn '} ${check.name.padEnd(width)}  ${check.detail}`)
          .join('\n'),
      };
    },
  },
);

export { renderPostgresConf, DOCKER_NETWORK };
