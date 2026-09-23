/**
 * Network inspection, and the exposure check that matters most on this product.
 *
 * The promise KAIROS makes is that your laptop becomes a database server whose
 * *API* is reachable and whose PostgreSQL is not. That promise is either true
 * of the running kernel or it is marketing, so this file goes and looks: it
 * reads the listening sockets, works out which of them are bound to something
 * other than loopback, and says plainly which ones should not be.
 */
import { networkInterfaces } from 'node:os';
import { register } from '../registry.js';
import { run, tryRun, binaryAvailable } from '../exec.js';

/**
 * Ports that must never face anything but loopback.
 *
 * Not a style preference: an exposed 5432 is a database on the internet with
 * whatever password the provisioner generated, and an exposed 6379 is
 * historically the single most reliable way to have a machine mine currency
 * for somebody else.
 */
export const MUST_STAY_INTERNAL: { port: number; service: string; why: string }[] = [
  { port: 5432, service: 'PostgreSQL', why: 'Direct database access. Clients go through the KAIROS API, never this.' },
  { port: 6379, service: 'Redis', why: 'Unauthenticated by default and trivially turned into remote code execution.' },
  { port: 9000, service: 'Object storage', why: 'The storage backend. The API proxies it; nothing else should reach it.' },
  { port: 9001, service: 'Storage console', why: 'The storage admin UI. There is no reason for this to be reachable.' },
  { port: 4000, service: 'KAIROS API (direct)', why: 'Should sit behind NGINX so TLS, rate limits and headers apply.' },
  { port: 3000, service: 'Dashboard (direct)', why: 'Should sit behind NGINX for the same reasons.' },
];

/** Ports that are expected to be reachable when the server is in remote mode. */
export const EXPECTED_PUBLIC = new Set([80, 443, 22]);

export interface ListeningSocket {
  protocol: string;
  address: string;
  port: number;
  process: string | null;
  /** True when the bind address is not loopback — i.e. reachable from off the machine. */
  exposed: boolean;
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '[::1]' ||
    address.startsWith('127.') ||
    address === 'localhost'
  );
}

/**
 * Parse `ss -tulnpH`.
 *
 * The address column is the awkward part: it can be `0.0.0.0:5432`,
 * `[::]:443`, `*:80`, `[::ffff:127.0.0.1]:4000` or a named interface. Split on
 * the last colon, because IPv6 addresses are full of the others.
 */
export async function listeningSockets(): Promise<ListeningSocket[]> {
  if (!binaryAvailable('ss')) return [];
  // -H omits the header; -p needs root, which the agent has.
  const raw = await tryRun('ss', ['-tulnpH'], { timeoutMs: 15_000 });
  if (!raw) return [];

  const sockets: ListeningSocket[] = [];
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const [protocol = '', state = '', , , local = '', ...rest] = fields;
    // UDP rows show UNCONN rather than LISTEN; both mean "bound".
    if (state !== 'LISTEN' && state !== 'UNCONN') continue;

    const split = local.lastIndexOf(':');
    if (split < 0) continue;
    const address = local.slice(0, split).replace(/^\[|\]$/g, '');
    const port = Number(local.slice(split + 1));
    if (!Number.isFinite(port)) continue;

    const processField = rest.join(' ');
    const name = /users:\(\("([^"]+)"/.exec(processField)?.[1] ?? null;

    sockets.push({
      protocol,
      address,
      port,
      process: name,
      // `*` and `0.0.0.0` and `::` all mean every interface.
      exposed: !isLoopback(address),
    });
  }
  return sockets;
}

export interface ExposureFinding {
  port: number;
  service: string;
  address: string;
  severity: 'critical' | 'warning' | 'ok';
  message: string;
}

/**
 * Compare what is listening against what is allowed to listen.
 *
 * A bind to 0.0.0.0 is not automatically a breach — the firewall may still be
 * dropping it — so the wording distinguishes "bound wide" from "reachable".
 * Whether packets actually arrive is the firewall check's job, and the two are
 * reported side by side.
 */
export function assessExposure(sockets: ListeningSocket[]): ExposureFinding[] {
  const findings: ExposureFinding[] = [];

  for (const rule of MUST_STAY_INTERNAL) {
    const offending = sockets.filter((socket) => socket.port === rule.port && socket.exposed);
    if (offending.length === 0) {
      findings.push({
        port: rule.port,
        service: rule.service,
        address: 'loopback only',
        severity: 'ok',
        message: `${rule.service} is not bound to a public interface.`,
      });
      continue;
    }
    for (const socket of offending) {
      findings.push({
        port: rule.port,
        service: rule.service,
        address: `${socket.address}:${socket.port}`,
        severity: 'critical',
        message: `${rule.service} is bound to ${socket.address}. ${rule.why}`,
      });
    }
  }

  // Anything else listening wide that we did not expect is worth a mention,
  // without pretending to know whether it is wrong.
  const known = new Set(MUST_STAY_INTERNAL.map((rule) => rule.port));
  for (const socket of sockets) {
    if (!socket.exposed || known.has(socket.port) || EXPECTED_PUBLIC.has(socket.port)) continue;
    findings.push({
      port: socket.port,
      service: socket.process ?? 'unknown',
      address: `${socket.address}:${socket.port}`,
      severity: 'warning',
      message: `${socket.process ?? 'Something'} is listening on ${socket.address}:${socket.port}. If KAIROS did not open this, find out what did.`,
    });
  }

  return findings;
}

export interface InterfaceAddress {
  iface: string;
  address: string;
  family: string;
  internal: boolean;
  mac: string;
}

export function addresses(): InterfaceAddress[] {
  const found: InterfaceAddress[] = [];
  const interfaces = networkInterfaces();
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      found.push({
        iface,
        address: entry.address,
        family: String(entry.family),
        internal: entry.internal,
        mac: entry.mac,
      });
    }
  }
  return found;
}

/** Addresses another device on the same network could actually reach. */
export function lanAddresses(): InterfaceAddress[] {
  return addresses().filter(
    (entry) => !entry.internal && entry.family === 'IPv4' && !/^(docker|br-|veth|virbr|kairos)/.test(entry.iface),
  );
}

/* ---------------------------------------------------------- operations */

register(
  {
    id: 'network_status',
    summary: 'Interfaces, addresses, routes and default gateway',
    category: 'network',
    danger: false,
    timeoutMs: 25_000,
    async run() {
      const [routes, lan] = await Promise.all([
        tryRun('ip', ['-json', 'route', 'show'], { timeoutMs: 10_000 }),
        Promise.resolve(lanAddresses()),
      ]);

      let parsedRoutes: unknown[] = [];
      try {
        parsedRoutes = routes ? (JSON.parse(routes) as unknown[]) : [];
      } catch {
        parsedRoutes = [];
      }

      const gateway =
        (parsedRoutes.find((route) => (route as { dst?: string }).dst === 'default') as { gateway?: string } | undefined)
          ?.gateway ?? null;

      const lines = [
        ...lan.map((entry) => `${entry.iface.padEnd(12)} ${entry.address}`),
        '',
        `gateway      ${gateway ?? 'none'}`,
      ];

      return {
        data: { addresses: addresses(), lan, routes: parsedRoutes, gateway },
        text: lines.join('\n'),
      };
    },
  },
  {
    id: 'network_ports',
    summary: 'What is listening, and whether anything internal is exposed',
    category: 'network',
    danger: false,
    timeoutMs: 25_000,
    async run() {
      const sockets = await listeningSockets();
      const findings = assessExposure(sockets);
      const critical = findings.filter((finding) => finding.severity === 'critical');

      const lines = sockets
        .filter((socket) => socket.protocol.startsWith('tcp'))
        .sort((a, b) => a.port - b.port)
        .map(
          (socket) =>
            `${socket.exposed ? '!' : ' '} ${String(socket.port).padEnd(6)} ${socket.address.padEnd(20)} ${socket.process ?? ''}`,
        );

      if (critical.length > 0) {
        lines.push('', 'CRITICAL', ...critical.map((finding) => `  ${finding.message}`));
      } else {
        lines.push('', 'No internal service is bound to a public interface.');
      }

      return {
        data: { sockets, findings, secure: critical.length === 0 },
        text: lines.join('\n'),
      };
    },
  },
);
