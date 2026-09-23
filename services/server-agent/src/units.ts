/**
 * The services KAIROS manages, and the only ones it will act on.
 *
 * Everything that starts, stops, restarts or reads logs goes through this
 * table. An operator can restart PostgreSQL because `postgres` is here; they
 * cannot restart `ssh` from the dashboard, because it is not — and the way to
 * change that is to edit this file on the host and restart the agent, which is
 * a deliberate act performed by someone with root, not an HTTP request.
 *
 * Each entry names both a systemd unit and a Docker container because a given
 * installation may run PostgreSQL either way. The agent reports on whichever
 * it finds, which is how the dashboard tells the truth on both layouts rather
 * than assuming one.
 */

export interface ManagedService {
  /** Stable id used by the API, the UI and the audit log. */
  id: string;
  label: string;
  description: string;
  /** systemd unit, when the service runs on the host directly. */
  unit?: string;
  /** Docker container name, when the service runs in the compose stack. */
  container?: string;
  /** Core services are what `kairos status` reports and what health checks gate on. */
  core: boolean;
  /**
   * Restarting this drops live connections. The UI asks for typed confirmation
   * on these rather than a single click.
   */
  disruptive: boolean;
}

export const MANAGED_SERVICES: readonly ManagedService[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    description: 'The database itself. Restarting it drops every open connection and every in-flight query.',
    unit: 'postgresql',
    container: 'kairos_postgres',
    core: true,
    disruptive: true,
  },
  {
    id: 'redis',
    label: 'Redis',
    description: 'Rate limits, realtime fan-out and the job queue. Restarting loses queued jobs that were not persisted.',
    unit: 'redis-server',
    container: 'kairos_redis',
    core: true,
    disruptive: true,
  },
  {
    id: 'api',
    label: 'KAIROS API',
    description: 'The REST, storage and auth surface.',
    unit: 'kairos-api',
    container: 'kairos_api',
    core: true,
    disruptive: true,
  },
  {
    id: 'realtime',
    label: 'Realtime',
    description: 'WebSocket fan-out. Restarting disconnects every subscriber; clients reconnect on their own.',
    unit: 'kairos-realtime',
    container: 'kairos_realtime',
    core: false,
    disruptive: false,
  },
  {
    id: 'worker',
    label: 'Worker',
    description: 'Backups, webhooks and background jobs.',
    unit: 'kairos-worker',
    container: 'kairos_worker',
    core: false,
    disruptive: false,
  },
  {
    id: 'storage',
    label: 'Storage',
    description: 'Object storage for project files.',
    unit: 'kairos-storage',
    container: 'kairos_minio',
    core: false,
    disruptive: false,
  },
  {
    id: 'nginx',
    label: 'NGINX',
    description: 'TLS termination and the reverse proxy. A bad config means nothing is reachable from outside.',
    unit: 'nginx',
    container: 'kairos_nginx',
    core: true,
    disruptive: true,
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'The admin panel you are looking at. Restarting it ends this page, not the database.',
    unit: 'kairos-dashboard',
    container: 'kairos_dashboard',
    core: false,
    disruptive: false,
  },
  {
    id: 'agent',
    label: 'Server Agent',
    description: 'This agent. It can report on itself but will not restart itself from a request it is serving.',
    unit: 'kairos-server-agent',
    core: true,
    disruptive: true,
  },
  {
    id: 'cloudflared',
    label: 'Cloudflare Tunnel',
    description: 'The outbound tunnel that makes this server reachable without opening a router port.',
    unit: 'cloudflared',
    container: 'kairos_cloudflared',
    core: false,
    disruptive: false,
  },
  {
    id: 'docker',
    label: 'Docker',
    description: 'The container runtime everything else may be running inside.',
    unit: 'docker',
    core: false,
    disruptive: true,
  },
] as const;

export const SERVICE_IDS = MANAGED_SERVICES.map((service) => service.id);

export function findService(id: string): ManagedService | undefined {
  return MANAGED_SERVICES.find((service) => service.id === id);
}

/**
 * Services the agent will start/stop/restart.
 *
 * `agent` and `docker` are readable but not controllable: an agent that
 * restarts itself mid-request cannot report the outcome, and stopping Docker
 * from inside a container that Docker is running is a way to lose the
 * dashboard and the means to bring it back at the same time.
 */
export const CONTROLLABLE_SERVICE_IDS = SERVICE_IDS.filter((id) => id !== 'agent' && id !== 'docker');

/**
 * Log sources. Same shape as services plus the two host logs that matter and
 * belong to no single unit.
 */
export interface LogSource {
  id: string;
  label: string;
  /** systemd unit to read with journalctl. */
  unit?: string;
  /** Docker container to read with `docker logs`. */
  container?: string;
  /** A file under a KAIROS-owned directory. Resolved against the data root, never user-supplied. */
  file?: string;
}

export const LOG_SOURCES: readonly LogSource[] = [
  { id: 'api', label: 'KAIROS API', unit: 'kairos-api', container: 'kairos_api' },
  { id: 'realtime', label: 'Realtime', unit: 'kairos-realtime', container: 'kairos_realtime' },
  { id: 'worker', label: 'Worker', unit: 'kairos-worker', container: 'kairos_worker' },
  { id: 'postgres', label: 'PostgreSQL', unit: 'postgresql', container: 'kairos_postgres' },
  { id: 'redis', label: 'Redis', unit: 'redis-server', container: 'kairos_redis' },
  { id: 'nginx', label: 'NGINX', unit: 'nginx', container: 'kairos_nginx' },
  { id: 'storage', label: 'Storage', unit: 'kairos-storage', container: 'kairos_minio' },
  { id: 'dashboard', label: 'Dashboard', unit: 'kairos-dashboard', container: 'kairos_dashboard' },
  { id: 'agent', label: 'Server Agent', unit: 'kairos-server-agent' },
  { id: 'cloudflared', label: 'Cloudflare Tunnel', unit: 'cloudflared', container: 'kairos_cloudflared' },
  { id: 'firewall', label: 'Firewall', unit: 'nftables' },
  { id: 'security', label: 'Security events', file: 'logs/security.log' },
] as const;

export const LOG_SOURCE_IDS = LOG_SOURCES.map((source) => source.id);

export function findLogSource(id: string): LogSource | undefined {
  return LOG_SOURCES.find((source) => source.id === id);
}

/**
 * Directories the agent will report on, relative to the data root.
 *
 * This is the whole of the filesystem as far as the dashboard is concerned.
 * There is no "browse" operation and no path argument anywhere, so there is
 * nothing for a traversal attempt to traverse.
 */
export const MANAGED_DIRECTORIES = [
  { id: 'postgres', path: 'postgres', label: 'Database' },
  { id: 'storage', path: 'storage', label: 'Project files' },
  { id: 'backups', path: 'backups', label: 'Backups' },
  { id: 'logs', path: 'logs', label: 'Logs' },
  { id: 'config', path: 'config', label: 'Configuration' },
  { id: 'metrics', path: 'metrics', label: 'Metrics' },
  { id: 'redis', path: 'redis', label: 'Redis persistence' },
] as const;
