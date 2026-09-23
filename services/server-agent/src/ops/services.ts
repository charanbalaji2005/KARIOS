/**
 * Service inspection and control.
 *
 * A KAIROS install may run PostgreSQL as a systemd unit or as a container in
 * the compose stack, and on a laptop that has been through a few iterations it
 * may have both installed with only one of them running. So every service is
 * probed both ways and the agent reports what it actually found, including the
 * ambiguous case — telling the operator "postgres is running" when a stopped
 * host unit is shadowing a running container is how someone spends an hour
 * restarting the wrong thing.
 */
import { register } from '../registry.js';
import { run, tryRun, binaryAvailable } from '../exec.js';
import {
  MANAGED_SERVICES,
  CONTROLLABLE_SERVICE_IDS,
  SERVICE_IDS,
  findService,
  type ManagedService,
} from '../units.js';
import { formatDuration } from './system.js';

export type ServiceState = 'running' | 'stopped' | 'failed' | 'not_installed' | 'unknown';

export interface ServiceReport {
  id: string;
  label: string;
  description: string;
  core: boolean;
  disruptive: boolean;
  /** The state the operator should act on: the running layer if either is running. */
  state: ServiceState;
  /** Which layer the reported state came from. */
  managedBy: 'systemd' | 'docker' | 'none';
  systemd: { unit: string; state: ServiceState; enabled: boolean | null; activeSince: string | null; detail: string } | null;
  docker: { container: string; state: ServiceState; status: string; health: string | null; image: string | null } | null;
  /** Set when systemd and Docker disagree, which is nearly always a misconfiguration. */
  conflict: string | null;
}

/* -------------------------------------------------------------- systemd */

/**
 * `systemctl show` rather than `systemctl status`: it is machine-readable,
 * exits zero for a missing unit, and does not try to page its output.
 */
async function systemdReport(unit: string): Promise<ServiceReport['systemd']> {
  if (!binaryAvailable('systemctl')) return null;

  const raw = await tryRun(
    'systemctl',
    ['show', unit, '--no-pager', '--property=LoadState,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,Result'],
    { timeoutMs: 10_000 },
  );
  if (!raw) return null;

  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
  }

  const loadState = fields.get('LoadState') ?? 'not-found';
  if (loadState === 'not-found' || loadState === 'masked') {
    return {
      unit,
      state: 'not_installed',
      enabled: null,
      activeSince: null,
      detail: loadState === 'masked' ? 'unit is masked' : 'no such unit on this host',
    };
  }

  const activeState = fields.get('ActiveState') ?? 'unknown';
  const subState = fields.get('SubState') ?? '';
  const unitFileState = fields.get('UnitFileState') ?? '';
  const since = fields.get('ActiveEnterTimestamp') ?? '';

  const state: ServiceState =
    activeState === 'active' ? 'running'
    : activeState === 'failed' ? 'failed'
    : activeState === 'inactive' || activeState === 'deactivating' ? 'stopped'
    : 'unknown';

  return {
    unit,
    state,
    enabled: unitFileState === 'enabled' || unitFileState === 'enabled-runtime'
      ? true
      : unitFileState === 'disabled' || unitFileState === 'masked'
        ? false
        : null,
    activeSince: since && since !== 'n/a' ? since : null,
    detail: `${activeState}${subState ? ` (${subState})` : ''}`,
  };
}

/* --------------------------------------------------------------- docker */

async function dockerReport(container: string): Promise<ServiceReport['docker']> {
  if (!binaryAvailable('docker')) return null;

  // A format string, not a shell pipeline. `docker inspect` exits non-zero for
  // a container that does not exist, which is a normal answer here.
  const raw = await tryRun(
    'docker',
    [
      'inspect',
      container,
      '--format',
      '{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.Config.Image}}\t{{.State.StartedAt}}',
    ],
    { timeoutMs: 12_000 },
  );
  if (!raw) return null;

  const [status = 'unknown', health = 'none', image = '', startedAt = ''] = raw.trim().split('\t');
  const state: ServiceState =
    status === 'running' ? 'running'
    : status === 'exited' || status === 'created' || status === 'paused' ? 'stopped'
    : status === 'dead' ? 'failed'
    : 'unknown';

  return {
    container,
    // A container that is "running" but failing its healthcheck is not up, and
    // reporting it as up is how an outage stays invisible for twenty minutes.
    state: state === 'running' && health === 'unhealthy' ? 'failed' : state,
    status: startedAt ? `${status} since ${startedAt}` : status,
    health: health === 'none' ? null : health,
    image: image || null,
  };
}

/* -------------------------------------------------------------- combine */

export async function reportService(service: ManagedService): Promise<ServiceReport> {
  const [systemd, docker] = await Promise.all([
    service.unit ? systemdReport(service.unit) : Promise.resolve(null),
    service.container ? dockerReport(service.container) : Promise.resolve(null),
  ]);

  const rawLayers: Array<{ layer: 'systemd' | 'docker'; state: ServiceState } | null> = [
    systemd && systemd.state !== 'not_installed' ? { layer: 'systemd', state: systemd.state } : null,
    docker && docker.state !== 'not_installed' ? { layer: 'docker', state: docker.state } : null,
  ];
  const layers = rawLayers.filter((entry): entry is { layer: 'systemd' | 'docker'; state: ServiceState } => Boolean(entry));

  const running = layers.find((entry) => entry.state === 'running');
  const failed = layers.find((entry) => entry.state === 'failed');
  const chosen = running ?? failed ?? layers[0] ?? null;

  let conflict: string | null = null;
  if (layers.length === 2 && layers[0]!.state !== layers[1]!.state) {
    conflict =
      `Installed both as a systemd unit (${systemd!.state}) and as a container (${docker!.state}). ` +
      'Pick one — two PostgreSQL instances on one data directory will corrupt it.';
  }

  return {
    id: service.id,
    label: service.label,
    description: service.description,
    core: service.core,
    disruptive: service.disruptive,
    state: chosen?.state ?? 'not_installed',
    managedBy: chosen?.layer ?? 'none',
    systemd,
    docker,
    conflict,
  };
}

export async function reportAllServices(): Promise<ServiceReport[]> {
  return await Promise.all(MANAGED_SERVICES.map(reportService));
}

/* -------------------------------------------------------------- control */

type Action = 'start' | 'stop' | 'restart';

async function control(service: ManagedService, action: Action): Promise<{ layer: string; output: string }> {
  const report = await reportService(service);

  // Act on the layer the service is actually installed on. Guessing wrong
  // produces a confident "restarted" message and a service that never moved.
  if (report.managedBy === 'systemd' && service.unit) {
    const result = await run('systemctl', [action, service.unit], { timeoutMs: 90_000, allowNonZeroExit: true });
    if (result.code !== 0) {
      throw new Error(`systemctl ${action} ${service.unit} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { layer: `systemd:${service.unit}`, output: result.stdout.trim() || `${service.unit} ${action} issued` };
  }

  if (report.managedBy === 'docker' && service.container) {
    const result = await run('docker', [action, service.container], { timeoutMs: 120_000, allowNonZeroExit: true });
    if (result.code !== 0) {
      throw new Error(`docker ${action} ${service.container} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { layer: `docker:${service.container}`, output: result.stdout.trim() || `${service.container} ${action} issued` };
  }

  // Starting something that is installed but currently stopped is the common
  // case for `start`, and reportService reports it as not_installed only when
  // neither layer knows about it at all.
  if (action === 'start') {
    if (service.unit && binaryAvailable('systemctl')) {
      const probe = await systemdReport(service.unit);
      if (probe && probe.state !== 'not_installed') {
        const result = await run('systemctl', ['start', service.unit], { timeoutMs: 90_000, allowNonZeroExit: true });
        if (result.code === 0) return { layer: `systemd:${service.unit}`, output: `${service.unit} start issued` };
      }
    }
    if (service.container && binaryAvailable('docker')) {
      const result = await run('docker', ['start', service.container], { timeoutMs: 120_000, allowNonZeroExit: true });
      if (result.code === 0) return { layer: `docker:${service.container}`, output: `${service.container} started` };
    }
  }

  throw new Error(
    `${service.label} is not installed on this host, either as a systemd unit or as a container. ` +
      'Run the server setup wizard first.',
  );
}

/* ---------------------------------------------------------- operations */

function stateGlyph(state: ServiceState): string {
  return state === 'running' ? '●' : state === 'failed' ? '✕' : state === 'stopped' ? '○' : '·';
}

function stateWord(state: ServiceState): string {
  return state === 'running' ? 'RUNNING'
    : state === 'failed' ? 'FAILED'
    : state === 'stopped' ? 'STOPPED'
    : state === 'not_installed' ? 'NOT INSTALLED'
    : 'UNKNOWN';
}

function renderServices(reports: ServiceReport[]): string {
  const width = Math.max(...reports.map((report) => report.label.length));
  const lines = reports.map(
    (report) =>
      `${stateGlyph(report.state)} ${report.label.padEnd(width)}  ${stateWord(report.state)}` +
      (report.managedBy !== 'none' ? `  (${report.managedBy})` : ''),
  );
  const conflicts = reports.filter((report) => report.conflict);
  if (conflicts.length > 0) {
    lines.push('');
    for (const report of conflicts) lines.push(`! ${report.label}: ${report.conflict}`);
  }
  return lines.join('\n');
}

register(
  {
    id: 'service_list',
    summary: 'State of every KAIROS-managed service',
    category: 'services',
    danger: false,
    timeoutMs: 45_000,
    async run() {
      const reports = await reportAllServices();
      const coreDown = reports.filter((report) => report.core && report.state !== 'running');
      return {
        data: {
          services: reports,
          healthy: coreDown.length === 0,
          coreDown: coreDown.map((report) => report.id),
        },
        text: renderServices(reports),
      };
    },
  },
  {
    id: 'service_status',
    summary: 'State of one service',
    category: 'services',
    danger: false,
    timeoutMs: 20_000,
    args: {
      service: { type: 'enum', values: SERVICE_IDS, required: true, describe: 'Which managed service' },
    },
    async run({ args }) {
      const service = findService(String(args['service']))!;
      const report = await reportService(service);
      const lines = [
        `${report.label}  ${stateWord(report.state)}`,
        report.description,
        '',
        report.systemd
          ? `systemd  ${report.systemd.unit}: ${report.systemd.detail}` +
            (report.systemd.enabled === null ? '' : report.systemd.enabled ? ' · enabled on boot' : ' · NOT enabled on boot')
          : 'systemd  no unit configured',
        report.docker
          ? `docker   ${report.docker.container}: ${report.docker.status}` +
            (report.docker.health ? ` · health ${report.docker.health}` : '')
          : 'docker   no container configured',
      ];
      if (report.conflict) lines.push('', `! ${report.conflict}`);
      return { data: report, text: lines.join('\n') };
    },
  },
  {
    id: 'service_start',
    summary: 'Start a managed service',
    category: 'services',
    danger: false,
    timeoutMs: 120_000,
    args: { service: { type: 'enum', values: CONTROLLABLE_SERVICE_IDS, required: true } },
    async run({ args }) {
      const service = findService(String(args['service']))!;
      const result = await control(service, 'start');
      const after = await reportService(service);
      return {
        data: { service: service.id, action: 'start', layer: result.layer, state: after.state },
        text: `${result.output}\n${service.label} is now ${stateWord(after.state)}`,
      };
    },
  },
  {
    id: 'service_stop',
    summary: 'Stop a managed service',
    category: 'services',
    // Stopping anything in this list takes part of the platform offline.
    danger: true,
    confirmPhrase: 'STOP SERVICE',
    timeoutMs: 120_000,
    args: { service: { type: 'enum', values: CONTROLLABLE_SERVICE_IDS, required: true } },
    async run({ args }) {
      const service = findService(String(args['service']))!;
      const result = await control(service, 'stop');
      const after = await reportService(service);
      return {
        data: { service: service.id, action: 'stop', layer: result.layer, state: after.state },
        text: `${result.output}\n${service.label} is now ${stateWord(after.state)}`,
      };
    },
  },
  {
    id: 'service_restart',
    summary: 'Restart a managed service',
    category: 'services',
    danger: true,
    confirmPhrase: 'RESTART SERVICE',
    timeoutMs: 180_000,
    args: { service: { type: 'enum', values: CONTROLLABLE_SERVICE_IDS, required: true } },
    async run({ args, emit }) {
      const service = findService(String(args['service']))!;
      emit(`Restarting ${service.label}...\n`);
      const result = await control(service, 'restart');

      // systemd and docker both return as soon as the restart is *issued*.
      // Reporting the state immediately would report the old one, so give it a
      // moment and then read it for real.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await reportService(service);

      return {
        data: { service: service.id, action: 'restart', layer: result.layer, state: after.state },
        text: `${result.output}\n${service.label} is now ${stateWord(after.state)}`,
      };
    },
  },
  {
    id: 'docker_ps',
    summary: 'Containers on this host',
    category: 'docker',
    danger: false,
    timeoutMs: 20_000,
    async run() {
      if (!binaryAvailable('docker')) {
        return { data: { available: false, containers: [] }, text: 'Docker is not installed on this host.' };
      }
      const raw = await tryRun(
        'docker',
        ['ps', '--all', '--no-trunc', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'],
        { timeoutMs: 15_000 },
      );
      const containers = (raw ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name = '', image = '', state = '', status = '', ports = ''] = line.split('\t');
          return { name, image, state, status, ports };
        });
      const text = containers.length
        ? containers.map((c) => `${c.state === 'running' ? '●' : '○'} ${c.name.padEnd(24)} ${c.status}`).join('\n')
        : 'No containers.';
      return { data: { available: true, containers }, text };
    },
  },
  {
    id: 'docker_stats',
    summary: 'Live CPU and memory per container',
    category: 'docker',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      if (!binaryAvailable('docker')) {
        return { data: { available: false, stats: [] }, text: 'Docker is not installed on this host.' };
      }
      // --no-stream, or it runs until the heat death of the universe.
      const raw = await tryRun(
        'docker',
        ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}'],
        { timeoutMs: 25_000 },
      );
      const stats = (raw ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name = '', cpu = '', memory = '', memoryPercent = '', network = '', block = ''] = line.split('\t');
          return { name, cpu, memory, memoryPercent, network, block };
        });
      const text = stats.length
        ? stats.map((s) => `${s.name.padEnd(24)} cpu ${s.cpu.padStart(7)}  mem ${s.memory}`).join('\n')
        : 'No running containers.';
      return { data: { available: true, stats }, text };
    },
  },
  {
    id: 'docker_health',
    summary: 'Docker daemon status and disk usage',
    category: 'docker',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      if (!binaryAvailable('docker')) {
        return { data: { available: false }, text: 'Docker is not installed on this host.' };
      }
      const [info, usage] = await Promise.all([
        tryRun('docker', ['info', '--format', '{{.ServerVersion}}\t{{.Driver}}\t{{.ContainersRunning}}\t{{.Containers}}\t{{.Images}}'], { timeoutMs: 20_000 }),
        tryRun('docker', ['system', 'df', '--format', '{{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}'], { timeoutMs: 25_000 }),
      ]);
      const [version = '', driver = '', running = '0', total = '0', images = '0'] = (info ?? '').split('\t');
      const disk = (usage ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [type = '', count = '', size = '', reclaimable = ''] = line.split('\t');
          return { type, count, size, reclaimable };
        });
      return {
        data: {
          available: info !== null,
          version,
          storageDriver: driver,
          containersRunning: Number(running),
          containersTotal: Number(total),
          images: Number(images),
          disk,
        },
        text: info
          ? [`Docker ${version} (${driver})`, `${running} of ${total} containers running, ${images} images`, '', ...disk.map((d) => `${d.type.padEnd(16)} ${d.size.padStart(10)}  ${d.reclaimable} reclaimable`)].join('\n')
          : 'Docker daemon is not responding.',
      };
    },
  },
);

export { formatDuration };
