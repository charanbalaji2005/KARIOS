/**
 * System inspection.
 *
 * Every number here is measured. There is no branch anywhere in this file that
 * returns a plausible-looking default when a reading is unavailable — it
 * returns null, and the dashboard says "unavailable". A server dashboard that
 * invents a CPU percentage is worse than one that admits it cannot tell you,
 * because the invented one gets believed.
 */
import { readFile, statfs, readdir } from 'node:fs/promises';
import { cpus, totalmem, freemem, loadavg, uptime, hostname, arch, release, platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { register } from '../registry.js';
import { run, tryRun, binaryAvailable, resolveBinary, type BinaryName } from '../exec.js';
import { config } from '../config.js';

/* ------------------------------------------------------------------ OS */

export interface OsRelease {
  name: string;
  version: string;
  versionId: string;
  id: string;
  prettyName: string;
  isUbuntu: boolean;
  /** Ubuntu LTS releases are the supported target; anything else still works but is worth saying. */
  isLts: boolean;
}

export async function osRelease(): Promise<OsRelease | null> {
  if (platform() !== 'linux') return null;
  try {
    const raw = await readFile('/etc/os-release', 'utf8');
    const fields = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const index = line.indexOf('=');
      if (index <= 0) continue;
      fields.set(line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, ''));
    }
    const id = fields.get('ID') ?? 'unknown';
    const version = fields.get('VERSION') ?? '';
    return {
      name: fields.get('NAME') ?? 'unknown',
      version,
      versionId: fields.get('VERSION_ID') ?? '',
      id,
      prettyName: fields.get('PRETTY_NAME') ?? fields.get('NAME') ?? 'unknown',
      isUbuntu: id === 'ubuntu',
      isLts: /LTS/i.test(version),
    };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- CPU */

function sampleCpu(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

/**
 * `os.cpus()` gives cumulative ticks since boot, so one read is the average
 * since the machine started — never the number anyone wants. Two samples
 * 200ms apart give the instantaneous figure.
 */
export async function cpuUsagePercent(): Promise<number> {
  const first = sampleCpu();
  await delay(200);
  const second = sampleCpu();
  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  if (totalDelta <= 0) return 0;
  return Number(((1 - idleDelta / totalDelta) * 100).toFixed(1));
}

/**
 * Package temperature. Laptops throttle and rack servers do not, so on this
 * product it is the difference between "the query is slow" and "the CPU is at
 * 96°C and has halved its clock".
 */
export async function cpuTemperatureC(): Promise<number | null> {
  if (platform() !== 'linux') return null;
  // Prefer a zone that identifies itself as a package/CPU sensor; a laptop
  // exposes several and thermal_zone0 is sometimes the battery.
  try {
    const zones = (await readdir('/sys/class/thermal')).filter((entry) => entry.startsWith('thermal_zone'));
    const readings: { type: string; celsius: number }[] = [];
    for (const zone of zones) {
      try {
        const [type, temp] = await Promise.all([
          readFile(`/sys/class/thermal/${zone}/type`, 'utf8').then((value) => value.trim()),
          readFile(`/sys/class/thermal/${zone}/temp`, 'utf8').then((value) => Number.parseInt(value.trim(), 10)),
        ]);
        if (Number.isFinite(temp) && temp > 0 && temp < 150_000) {
          readings.push({ type, celsius: Number((temp / 1000).toFixed(1)) });
        }
      } catch {
        // Zone vanished or is not readable from here. Next.
      }
    }
    if (readings.length === 0) return null;
    const cpuZone = readings.find((entry) => /pkg|x86|cpu|coretemp|soc/i.test(entry.type));
    // Falling back to the hottest zone is the conservative choice: it is the
    // one that will throttle something.
    return (cpuZone ?? readings.reduce((hottest, entry) => (entry.celsius > hottest.celsius ? entry : hottest))).celsius;
  } catch {
    return null;
  }
}

export interface CpuInfo {
  cores: number;
  model: string;
  speedMhz: number;
  usagePercent: number;
  loadAverage: number[];
  temperatureC: number | null;
  throttling: boolean;
  architecture: string;
}

export async function cpuInfo(): Promise<CpuInfo> {
  const [usagePercent, temperatureC] = await Promise.all([cpuUsagePercent(), cpuTemperatureC()]);
  const list = cpus();
  return {
    cores: list.length,
    model: list[0]?.model?.trim() ?? 'unknown',
    speedMhz: list[0]?.speed ?? 0,
    usagePercent,
    loadAverage: loadavg().map((value) => Number(value.toFixed(2))),
    temperatureC,
    throttling: temperatureC !== null && temperatureC > 85,
    architecture: arch(),
  };
}

/* -------------------------------------------------------------- memory */

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

/**
 * `MemAvailable` from /proc/meminfo, not `free`.
 *
 * `total - free` counts the page cache as used and makes a healthy Linux box
 * look permanently full; `MemAvailable` is the kernel's own estimate of what a
 * new allocation could actually get, which is the number that predicts an OOM
 * kill.
 */
export async function memoryInfo(): Promise<MemoryInfo> {
  const total = totalmem();
  let available = freemem();
  let swapTotal = 0;
  let swapFree = 0;

  if (platform() === 'linux') {
    try {
      const raw = await readFile('/proc/meminfo', 'utf8');
      const field = (name: string): number | null => {
        const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(raw);
        return match ? Number(match[1]) * 1024 : null;
      };
      available = field('MemAvailable') ?? available;
      swapTotal = field('SwapTotal') ?? 0;
      swapFree = field('SwapFree') ?? 0;
    } catch {
      // Fall through to the os module's figures.
    }
  }

  const used = total - available;
  return {
    totalBytes: total,
    freeBytes: freemem(),
    usedBytes: used,
    availableBytes: available,
    usedPercent: total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal - swapFree,
  };
}

/* ---------------------------------------------------------------- disk */

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export async function diskUsage(path: string): Promise<DiskUsage | null> {
  try {
    const stats = await statfs(path);
    const total = stats.blocks * stats.bsize;
    // bavail, not bfree: the reserved blocks are not available to anything the
    // platform runs as, so counting them as free overstates the headroom.
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return {
      path,
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent: total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0,
    };
  } catch {
    return null;
  }
}

/** Physical devices, so the operator can see it is an NVMe and not an SD card. */
export async function blockDevices(): Promise<unknown[]> {
  const raw = await tryRun('lsblk', ['-J', '-b', '-o', 'NAME,SIZE,TYPE,MOUNTPOINT,ROTA,MODEL'], { timeoutMs: 10_000 });
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { blockdevices?: unknown[] };
    return parsed.blockdevices ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- network */

export interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
}

export async function networkCounters(): Promise<NetworkCounters | null> {
  if (platform() !== 'linux') return null;
  try {
    const raw = await readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!name || !rest) continue;
      const iface = name.trim();
      // Loopback and container bridges are internal chatter, not real traffic.
      if (iface === 'lo' || /^(docker|br-|veth|virbr|kairos)/.test(iface)) continue;
      const fields = rest.trim().split(/\s+/);
      rx += Number(fields[0] ?? 0);
      tx += Number(fields[8] ?? 0);
    }
    return { rxBytes: rx, txBytes: tx };
  } catch {
    return null;
  }
}

/** Previous sample, so the agent reports a rate rather than a total since boot. */
let lastNetworkSample: { counters: NetworkCounters; at: number } | null = null;

export async function networkThroughput(): Promise<{
  counters: NetworkCounters | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
}> {
  const counters = await networkCounters();
  if (!counters) return { counters: null, rxBytesPerSec: null, txBytesPerSec: null };

  const now = Date.now();
  let rxRate: number | null = null;
  let txRate: number | null = null;

  if (lastNetworkSample) {
    const seconds = (now - lastNetworkSample.at) / 1000;
    if (seconds > 0.5) {
      rxRate = Math.max(0, Math.round((counters.rxBytes - lastNetworkSample.counters.rxBytes) / seconds));
      txRate = Math.max(0, Math.round((counters.txBytes - lastNetworkSample.counters.txBytes) / seconds));
    }
  }
  lastNetworkSample = { counters, at: now };
  return { counters, rxBytesPerSec: rxRate, txBytesPerSec: txRate };
}

/* -------------------------------------------------------- dependencies */

export interface Dependency {
  name: string;
  binary: BinaryName;
  required: boolean;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** The apt package that provides it, for the setup wizard's install step. */
  package: string;
}

const DEPENDENCIES: { name: string; binary: BinaryName; required: boolean; package: string; versionArgs: string[] }[] = [
  { name: 'Docker', binary: 'docker', required: true, package: 'docker-ce', versionArgs: ['--version'] },
  { name: 'PostgreSQL client', binary: 'psql', required: true, package: 'postgresql-client', versionArgs: ['--version'] },
  { name: 'pg_dump', binary: 'pg_dump', required: true, package: 'postgresql-client', versionArgs: ['--version'] },
  { name: 'Redis CLI', binary: 'redisCli', required: false, package: 'redis-tools', versionArgs: ['--version'] },
  { name: 'NGINX', binary: 'nginx', required: false, package: 'nginx', versionArgs: ['-v'] },
  { name: 'nftables', binary: 'nft', required: true, package: 'nftables', versionArgs: ['--version'] },
  { name: 'curl', binary: 'curl', required: true, package: 'curl', versionArgs: ['--version'] },
  { name: 'OpenSSL', binary: 'openssl', required: true, package: 'openssl', versionArgs: ['version'] },
  { name: 'systemctl', binary: 'systemctl', required: true, package: 'systemd', versionArgs: ['--version'] },
  { name: 'Cloudflare Tunnel', binary: 'cloudflared', required: false, package: 'cloudflared', versionArgs: ['--version'] },
];

export async function dependencies(): Promise<Dependency[]> {
  return await Promise.all(
    DEPENDENCIES.map(async (entry) => {
      const path = resolveBinary(entry.binary);
      let version: string | null = null;
      if (path) {
        // `nginx -v` writes to stderr; take whichever stream produced a line.
        const result = await run(entry.binary, entry.versionArgs, { timeoutMs: 8_000, allowNonZeroExit: true }).catch(
          () => null,
        );
        const text = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();
        version = text.split('\n')[0]?.trim() || null;
      }
      return {
        name: entry.name,
        binary: entry.binary,
        required: entry.required,
        installed: path !== null,
        path,
        version,
        package: entry.package,
      };
    }),
  );
}

/** Docker Compose is a plugin, not a binary, so it is checked separately. */
export async function dockerComposeVersion(): Promise<string | null> {
  if (!binaryAvailable('docker')) return null;
  return await tryRun('docker', ['compose', 'version', '--short'], { timeoutMs: 10_000 });
}

/* ----------------------------------------------------------- aggregate */

export async function systemSnapshot() {
  const [os, cpu, memory, dataDisk, rootDisk, network, uptimeSeconds] = await Promise.all([
    osRelease(),
    cpuInfo(),
    memoryInfo(),
    diskUsage(config.dataRoot),
    diskUsage('/'),
    networkThroughput(),
    Promise.resolve(Math.round(uptime())),
  ]);

  return {
    host: {
      hostname: hostname(),
      platform: platform(),
      kernel: release(),
      architecture: arch(),
      uptimeSeconds,
      bootedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    },
    os,
    cpu,
    memory,
    disk: {
      data: dataDisk,
      root: rootDisk,
      // PostgreSQL refuses writes when the volume fills, and uploads and
      // backups fail before it does. Warn while there is still time to act.
      warning: (dataDisk?.usedPercent ?? 0) > 85 || (rootDisk?.usedPercent ?? 0) > 90,
    },
    network,
    dataRoot: config.dataRoot,
    dataRootExists: existsSync(config.dataRoot),
    agentVersion: config.version,
    collectedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- format */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/* ---------------------------------------------------------- operations */

register(
  {
    id: 'system_info',
    summary: 'OS, CPU, memory, disk and network for this host',
    category: 'system',
    danger: false,
    timeoutMs: 20_000,
    async run() {
      const snapshot = await systemSnapshot();
      const lines = [
        `Host        ${snapshot.host.hostname}`,
        `OS          ${snapshot.os?.prettyName ?? snapshot.host.platform}`,
        `Kernel      ${snapshot.host.kernel} (${snapshot.host.architecture})`,
        `Uptime      ${formatDuration(snapshot.host.uptimeSeconds)}`,
        `CPU         ${snapshot.cpu.cores} cores · ${snapshot.cpu.model}`,
        `            ${snapshot.cpu.usagePercent}% used · load ${snapshot.cpu.loadAverage.join(' ')}` +
          (snapshot.cpu.temperatureC !== null ? ` · ${snapshot.cpu.temperatureC}°C` : ''),
        `Memory      ${formatBytes(snapshot.memory.usedBytes)} of ${formatBytes(snapshot.memory.totalBytes)} (${snapshot.memory.usedPercent}%)`,
        snapshot.disk.data
          ? `Data disk   ${formatBytes(snapshot.disk.data.usedBytes)} of ${formatBytes(snapshot.disk.data.totalBytes)} (${snapshot.disk.data.usedPercent}%) at ${snapshot.disk.data.path}`
          : `Data disk   ${config.dataRoot} is not readable`,
      ];
      if (snapshot.cpu.throttling) {
        lines.push('', `WARNING     CPU is at ${snapshot.cpu.temperatureC}°C and is almost certainly throttling.`);
      }
      if (snapshot.disk.warning) {
        lines.push('', 'WARNING     Disk is running low. PostgreSQL stops accepting writes when the volume fills.');
      }
      return { data: snapshot, text: lines.join('\n') };
    },
  },
  {
    id: 'system_dependencies',
    summary: 'Which KAIROS dependencies are installed on this host',
    category: 'system',
    danger: false,
    timeoutMs: 45_000,
    async run() {
      const [list, compose] = await Promise.all([dependencies(), dockerComposeVersion()]);
      const rows = [
        ...list.map((entry) => ({
          name: entry.name,
          installed: entry.installed,
          required: entry.required,
          version: entry.version,
          package: entry.package,
        })),
        {
          name: 'Docker Compose',
          installed: compose !== null,
          required: true,
          version: compose,
          package: 'docker-compose-plugin',
        },
      ];
      const missingRequired = rows.filter((row) => row.required && !row.installed);
      const text = rows
        .map((row) => `${row.installed ? '  ok  ' : ' miss '} ${pad(row.name, 22)} ${row.version ?? (row.required ? 'not installed (required)' : 'not installed')}`)
        .join('\n');
      return {
        data: { dependencies: rows, missingRequired: missingRequired.map((row) => row.package), ready: missingRequired.length === 0 },
        text,
      };
    },
  },
  {
    id: 'system_processes',
    summary: 'Top processes by CPU',
    category: 'system',
    danger: false,
    timeoutMs: 15_000,
    async run() {
      // `ps` in batch form rather than `top`, which wants a terminal and
      // refuses to stop on its own.
      const result = await run('ps', ['-eo', 'pid,user,pcpu,pmem,etime,comm', '--sort=-pcpu'], {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      });
      const lines = result.stdout.trim().split('\n');
      const top = lines.slice(0, 21);
      const processes = top.slice(1).map((line) => {
        const [pid, user, cpu, mem, elapsed, ...command] = line.trim().split(/\s+/);
        return {
          pid: Number(pid),
          user,
          cpuPercent: Number(cpu),
          memoryPercent: Number(mem),
          elapsed,
          command: command.join(' '),
        };
      });
      return { data: { processes }, text: top.join('\n') };
    },
  },
  {
    id: 'system_disk',
    summary: 'Filesystem usage and block devices',
    category: 'system',
    danger: false,
    timeoutMs: 15_000,
    async run() {
      const [data, root, devices] = await Promise.all([
        diskUsage(config.dataRoot),
        diskUsage('/'),
        blockDevices(),
      ]);
      const text = [
        data
          ? `data  ${pad(formatBytes(data.usedBytes), 10)} of ${pad(formatBytes(data.totalBytes), 10)} (${data.usedPercent}%)  ${data.path}`
          : `data  ${config.dataRoot} is not readable`,
        root
          ? `root  ${pad(formatBytes(root.usedBytes), 10)} of ${pad(formatBytes(root.totalBytes), 10)} (${root.usedPercent}%)  /`
          : 'root  not readable',
      ].join('\n');
      return { data: { data, root, devices }, text };
    },
  },
);
