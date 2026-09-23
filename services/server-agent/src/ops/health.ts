/**
 * The aggregate health view — `kairos status` and `kairos doctor`.
 *
 * `status` answers "is it up". `doctor` answers "what is wrong", which is a
 * different question and deserves a different output: it reports problems, not
 * a wall of green, because a wall of green is exactly what nobody can read at
 * 2am. Every check states what is wrong *and* what it means, since "usage
 * sampling is stale" is only actionable once you know it means quotas are
 * being enforced on old numbers.
 */
import { register } from '../registry.js';
import { reportAllServices } from './services.js';
import { postgresHealth, redisHealth, nginxHealth } from './database.js';
import { firewallStatus } from './firewall.js';
import { listeningSockets, assessExposure } from './network.js';
import { listBackups } from './backup.js';
import { systemSnapshot, formatBytes, formatDuration } from './system.js';

export interface Check {
  name: string;
  ok: boolean;
  /** A failing check that does not threaten availability is a warning, not a failure. */
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}

export async function collectStatus() {
  const [system, services, postgres, redis, nginx, firewall, sockets, backups] = await Promise.all([
    systemSnapshot(),
    reportAllServices(),
    postgresHealth(),
    redisHealth(),
    nginxHealth(),
    firewallStatus(),
    listeningSockets(),
    listBackups(),
  ]);

  const exposure = assessExposure(sockets);
  const coreDown = services.filter((service) => service.core && service.state !== 'running');

  return {
    online: coreDown.length === 0,
    system,
    services,
    postgres,
    redis,
    nginx,
    firewall,
    exposure,
    backups: {
      count: backups.length,
      latest: backups[0] ?? null,
      totalBytes: backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
      directory: backups[0]?.path.replace(/\/[^/]+$/, '') ?? null,
    },
    collectedAt: new Date().toISOString(),
  };
}

export async function runDoctor(): Promise<{ healthy: boolean; checks: Check[] }> {
  const status = await collectStatus();
  const checks: Check[] = [];

  /* --- the services that have to be up ----------------------------- */
  for (const service of status.services.filter((entry) => entry.core)) {
    checks.push({
      name: service.label,
      ok: service.state === 'running',
      severity: 'critical',
      detail:
        service.state === 'running'
          ? `running via ${service.managedBy}`
          : service.state === 'not_installed'
            ? 'not installed on this host — run the setup wizard'
            : `${service.state} — the platform is degraded until this is back`,
    });
  }

  /* --- services installed twice ------------------------------------ */
  for (const service of status.services.filter((entry) => entry.conflict)) {
    checks.push({ name: `${service.label} layout`, ok: false, severity: 'critical', detail: service.conflict! });
  }

  /* --- things that should not be enabled on boot but are, or vice versa */
  for (const service of status.services.filter((entry) => entry.core && entry.systemd)) {
    if (service.systemd!.enabled === false && service.systemd!.state === 'running') {
      checks.push({
        name: `${service.label} on boot`,
        ok: false,
        severity: 'warning',
        detail: 'running now but not enabled — it will not come back after a reboot',
      });
    }
  }

  /* --- disk -------------------------------------------------------- */
  const dataDisk = status.system.disk.data;
  checks.push({
    name: 'disk headroom',
    ok: !status.system.disk.warning,
    severity: 'critical',
    detail: dataDisk
      ? `${formatBytes(dataDisk.freeBytes)} free of ${formatBytes(dataDisk.totalBytes)} (${dataDisk.usedPercent}% used)` +
        (status.system.disk.warning ? ' — PostgreSQL stops accepting writes when this fills' : '')
      : 'the data volume is not readable',
  });

  /* --- memory and thermals ----------------------------------------- */
  checks.push({
    name: 'memory',
    ok: status.system.memory.usedPercent < 90,
    severity: 'warning',
    detail: `${formatBytes(status.system.memory.availableBytes)} available of ${formatBytes(status.system.memory.totalBytes)}`,
  });

  if (status.system.cpu.temperatureC !== null) {
    checks.push({
      name: 'cpu temperature',
      ok: !status.system.cpu.throttling,
      severity: 'warning',
      detail: status.system.cpu.throttling
        ? `${status.system.cpu.temperatureC}°C — almost certainly throttling. Queries will look slow for reasons unrelated to their plans.`
        : `${status.system.cpu.temperatureC}°C`,
    });
  }

  /* --- the perimeter ----------------------------------------------- */
  checks.push({
    name: 'firewall',
    ok: status.firewall.active,
    severity: 'critical',
    detail: status.firewall.active
      ? `${status.firewall.backend}, inbound ${status.firewall.defaultPolicy}`
      : 'not denying inbound traffic by default — apply the baseline ruleset',
  });

  const criticalExposure = status.exposure.filter((finding) => finding.severity === 'critical');
  checks.push({
    name: 'internal services',
    ok: criticalExposure.length === 0,
    severity: 'critical',
    detail:
      criticalExposure.length === 0
        ? 'PostgreSQL, Redis and storage are bound to loopback only'
        : criticalExposure.map((finding) => finding.message).join(' '),
  });

  /* --- nginx config ------------------------------------------------- */
  if (status.nginx.configValid !== null) {
    checks.push({
      name: 'nginx config',
      ok: status.nginx.configValid,
      severity: 'critical',
      detail: status.nginx.configValid
        ? 'parses'
        : `does not parse — do not restart nginx until this is fixed: ${status.nginx.configDetail ?? ''}`,
    });
  }

  /* --- backups ------------------------------------------------------ */
  const latest = status.backups.latest;
  const ageHours = latest ? (Date.now() - new Date(latest.createdAt).getTime()) / 3_600_000 : null;
  checks.push({
    name: 'backups',
    ok: latest !== null && ageHours !== null && ageHours < 48,
    severity: latest === null ? 'critical' : 'warning',
    detail:
      latest === null
        ? 'no backups on disk. This laptop is the only copy of the data.'
        : `${status.backups.count} archives, newest ${formatDuration(Math.round((ageHours ?? 0) * 3600))} old`,
  });

  /* --- the agent's own view of PostgreSQL --------------------------- */
  if (status.postgres.connections) {
    const { active, idle, max } = status.postgres.connections;
    checks.push({
      name: 'connection headroom',
      ok: max === 0 || (active + idle) / max < 0.85,
      severity: 'warning',
      detail: `${active + idle} of ${max} connections in use`,
    });
  }

  return { healthy: checks.every((check) => check.ok || check.severity === 'info'), checks };
}

/* ---------------------------------------------------------- operations */

function glyph(state: string): string {
  return state === 'running' ? '●' : state === 'failed' ? '✕' : '○';
}

register(
  {
    id: 'kairos_status',
    summary: 'Is the KAIROS server up',
    category: 'system',
    danger: false,
    timeoutMs: 90_000,
    async run() {
      const status = await collectStatus();
      const width = Math.max(...status.services.map((service) => service.label.length));

      const lines = [
        `KAIROS SERVER  ${status.online ? 'ONLINE' : 'DEGRADED'}`,
        '',
        ...status.services
          .filter((service) => service.state !== 'not_installed')
          .map((service) => `${glyph(service.state)} ${service.label.padEnd(width)}  ${service.state.toUpperCase()}`),
        '',
        `Firewall${' '.repeat(Math.max(1, width - 6))}  ${status.firewall.active ? 'ACTIVE' : 'INACTIVE'}`,
      ];

      if (status.system.disk.data) {
        lines.push(
          `Disk${' '.repeat(Math.max(1, width - 2))}  ${status.system.disk.data.usedPercent}% used, ` +
            `${formatBytes(status.system.disk.data.freeBytes)} free`,
        );
      }
      lines.push(
        `CPU${' '.repeat(Math.max(1, width - 1))}  ${status.system.cpu.usagePercent}%`,
        `Memory${' '.repeat(Math.max(1, width - 4))}  ${status.system.memory.usedPercent}%`,
        `Uptime${' '.repeat(Math.max(1, width - 4))}  ${formatDuration(status.system.host.uptimeSeconds)}`,
      );

      const critical = status.exposure.filter((finding) => finding.severity === 'critical');
      if (critical.length > 0) {
        lines.push('', 'CRITICAL', ...critical.map((finding) => `  ${finding.message}`));
      }

      return { data: status, text: lines.join('\n') };
    },
  },
  {
    id: 'kairos_doctor',
    summary: 'Report what is wrong with this installation',
    category: 'system',
    danger: false,
    timeoutMs: 120_000,
    async run() {
      const { healthy, checks } = await runDoctor();
      const width = Math.max(...checks.map((check) => check.name.length));

      const lines = checks.map((check) => {
        const mark = check.ok ? '  ok  ' : check.severity === 'critical' ? ' FAIL ' : ' warn ';
        return `${mark} ${check.name.padEnd(width)}  ${check.detail}`;
      });

      lines.push('');
      lines.push(healthy ? 'No problems found.' : `${checks.filter((check) => !check.ok).length} checks need attention.`);

      return { data: { healthy, checks }, text: lines.join('\n'), exitCode: healthy ? 0 : 1 };
    },
  },
);
