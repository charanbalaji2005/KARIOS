'use client';

/**
 * Types and helpers for the server console.
 *
 * The shapes here mirror what the agent reports. They are written out rather
 * than loosely typed because the whole point of this surface is that the
 * numbers are real: if the agent stops sending `temperatureC`, a type error is
 * a better outcome than a page that renders `undefined°C`.
 */

import { api, ApiError } from './api';

/* ----------------------------------------------------------------- host */

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface SystemSnapshot {
  host: { hostname: string; platform: string; kernel: string; architecture: string; uptimeSeconds: number; bootedAt: string };
  os: { name: string; version: string; versionId: string; prettyName: string; isUbuntu: boolean; isLts: boolean } | null;
  cpu: {
    cores: number;
    model: string;
    speedMhz: number;
    usagePercent: number;
    loadAverage: number[];
    temperatureC: number | null;
    throttling: boolean;
    architecture: string;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disk: { data: DiskUsage | null; root: DiskUsage | null; warning: boolean };
  network: { counters: { rxBytes: number; txBytes: number } | null; rxBytesPerSec: number | null; txBytesPerSec: number | null };
  dataRoot: string;
  dataRootExists: boolean;
  agentVersion: string;
  collectedAt: string;
}

export type ServiceState = 'running' | 'stopped' | 'failed' | 'not_installed' | 'unknown';

export interface ServiceReport {
  id: string;
  label: string;
  description: string;
  core: boolean;
  disruptive: boolean;
  state: ServiceState;
  managedBy: 'systemd' | 'docker' | 'none';
  systemd: { unit: string; state: ServiceState; enabled: boolean | null; activeSince: string | null; detail: string } | null;
  docker: { container: string; state: ServiceState; status: string; health: string | null; image: string | null } | null;
  conflict: string | null;
}

export interface ExposureFinding {
  port: number;
  service: string;
  address: string;
  severity: 'critical' | 'warning' | 'ok';
  message: string;
}

export interface FirewallStatus {
  backend: 'nftables' | 'ufw' | 'none';
  active: boolean;
  defaultPolicy: string | null;
  kairosTable: boolean;
  intent: { httpsOpen: boolean; httpOpen: boolean; sshFrom: string | null; updatedAt: string };
  exposure: ExposureFinding[];
  blockedByDesign: { port: number; service: string }[];
  open: { port: number; service: string }[];
}

export interface BackupFile {
  id: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ServerStatus {
  online: boolean;
  system: SystemSnapshot;
  services: ServiceReport[];
  postgres: {
    state: ServiceState;
    managedBy: string;
    accepting: boolean | null;
    version: string | null;
    sizeBytes: number | null;
    databases: number | null;
    connections: { active: number; idle: number; max: number } | null;
    detail: string | null;
  };
  redis: {
    state: ServiceState;
    reachable: boolean | null;
    version: string | null;
    usedMemoryBytes: number | null;
    clients: number | null;
    uptimeSeconds: number | null;
    keyspaceHits: number | null;
    keyspaceMisses: number | null;
    detail: string | null;
  };
  nginx: { state: ServiceState; configValid: boolean | null; configDetail: string | null };
  firewall: FirewallStatus;
  exposure: ExposureFinding[];
  backups: { count: number; latest: BackupFile | null; totalBytes: number; directory: string | null };
  collectedAt: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}

export interface AgentStatus {
  configured: boolean;
  reachable: boolean;
  detail: string;
  socket: string;
  transport: string;
  health: { version: string; uptimeSeconds: number; operations: number; dataRoot: string } | null;
}

export interface OperationDescriptor {
  id: string;
  summary: string;
  category: string;
  danger: boolean;
  confirmPhrase: string | null;
  streaming: boolean;
  args: { name: string; type: string; required: boolean; values?: string[]; describe?: string }[];
}

/* ------------------------------------------------------------ operations */

export interface OperationOutcome<T = unknown> {
  ok: boolean;
  data: T | null;
  output: string;
  error: string | null;
}

/**
 * POST to a server-console endpoint and normalise the result.
 *
 * A failed operation is a result, not an exception: the dashboard needs the
 * text the agent produced on the way to failing, because that text is the
 * explanation. Only "could not reach the server at all" throws.
 */
export async function runServerAction<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<OperationOutcome<T>> {
  try {
    const data = await api<T & { output?: string }>(path, {
      method: body === undefined ? 'POST' : 'POST',
      body: JSON.stringify(body ?? {}),
    });
    return { ok: true, data: data as T, output: (data as { output?: string })?.output ?? '', error: null };
  } catch (error) {
    if (error instanceof ApiError) {
      const details = error.details as { output?: string } | undefined;
      return { ok: false, data: null, output: details?.output ?? '', error: error.message };
    }
    throw error;
  }
}

/* --------------------------------------------------------------- labels */

/** Service ids the UI offers actions for, in the order they matter. */
export const SERVICE_ORDER = [
  'postgres',
  'redis',
  'api',
  'realtime',
  'worker',
  'storage',
  'nginx',
  'dashboard',
  'cloudflared',
  'agent',
  'docker',
];

export function sortServices(services: ServiceReport[]): ServiceReport[] {
  return [...services].sort((a, b) => {
    const left = SERVICE_ORDER.indexOf(a.id);
    const right = SERVICE_ORDER.indexOf(b.id);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
}
