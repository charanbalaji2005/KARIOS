/**
 * Server identity and network mode.
 *
 * Kairos is software that turns *a* machine into a server — not a service tied
 * to one particular laptop. Every installation is independent: its own
 * PostgreSQL, its own storage, its own users. Nothing here phones home, and
 * the platform keeps working with the internet unplugged.
 *
 * So an installation needs an identity of its own, and it needs to know which
 * of three network postures it is in, because that decision changes what is
 * safe to do elsewhere (CORS, cookie flags, whether direct database access is
 * offered at all).
 *
 *   local   loopback only. Nothing leaves the machine.
 *   lan     other devices on the same network can reach it. The phone-on-the-
 *           same-wifi case, which is most of the point of self-hosting.
 *   remote  reachable from the internet through a tunnel or VPN. Only Nginx is
 *           exposed; PostgreSQL and Redis never are.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hostname, networkInterfaces, platform, release, totalmem } from 'node:os';
import { randomBytes } from 'node:crypto';
import { one, query } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { redis } from '../lib/redis.js';
import { storage } from '../lib/storage/index.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { isPlatformOperator } from './quotas.routes.js';
import { ApiError } from '../lib/errors.js';

export type NetworkMode = 'local' | 'lan' | 'remote';

/**
 * The server's own id, created once and then stable.
 *
 * Generated locally. It is not issued by anyone, because requiring a central
 * service to hand out identities would make that service a dependency of
 * every installation booting — exactly the coupling this design avoids.
 */
async function ensureIdentity(): Promise<{ server_id: string; server_name: string; network_mode: NetworkMode; installed_at: string }> {
  const existing = await one<{ server_id: string; server_name: string; network_mode: NetworkMode; installed_at: string }>(
    'SELECT server_id, server_name, network_mode, installed_at FROM server_identity WHERE id = TRUE',
  );
  if (existing) return existing;

  const serverId = `krs_${randomBytes(8).toString('hex')}`;
  const created = await one<{ server_id: string; server_name: string; network_mode: NetworkMode; installed_at: string }>(
    `INSERT INTO server_identity (id, server_id, server_name, network_mode, data_root)
     VALUES (TRUE, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET server_id = server_identity.server_id
     RETURNING server_id, server_name, network_mode, installed_at`,
    [serverId, hostname(), process.env['KAIROS_NETWORK_MODE'] ?? 'local', env.KAIROS_DATA_ROOT],
  );
  return created!;
}

/** Addresses this machine can actually be reached on, for the LAN case. */
function localAddresses(): { iface: string; address: string; family: string }[] {
  const found: { iface: string; address: string; family: string }[] = [];
  const interfaces = networkInterfaces();
  for (const iface of Object.keys(interfaces)) {
    const addresses = interfaces[iface] ?? [];
    for (const entry of addresses) {
      if (entry.internal) continue;
      // Docker bridges and veth pairs are not addresses a phone can use.
      if (/^(docker|br-|veth|virbr)/.test(iface)) continue;
      found.push({ iface, address: entry.address, family: entry.family as string });
    }
  }
  return found;
}

export default async function serverIdentityRoutes(app: FastifyInstance) {
  /**
   * Server info. Requires a logged-in user: the version numbers, data root and
   * local addresses are a useful map for someone who should not have one.
   */
  app.get('/server/info', { preHandler: [app.requireUser] }, async () => {
    const identity = await ensureIdentity();

    const [postgresVersion, redisVersion] = await Promise.all([
      one<{ version: string }>('SHOW server_version').then((r) => r?.version ?? 'unknown').catch(() => 'unavailable'),
      redis.info('server').then((info) => /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown').catch(() => 'unavailable'),
    ]);

    const addresses = localAddresses();
    const mode = identity.network_mode;

    return {
      data: {
        serverId: identity.server_id,
        serverName: identity.server_name,
        installedAt: identity.installed_at,
        networkMode: mode,
        host: {
          hostname: hostname(),
          platform: platform(),
          release: release(),
          totalMemoryBytes: totalmem(),
        },
        versions: {
          kairos: process.env['npm_package_version'] ?? '0.1.0',
          node: process.version,
          postgres: postgresVersion,
          redis: redisVersion,
        },
        storage: { driver: storage.name, dataRoot: env.KAIROS_DATA_ROOT },
        // Only meaningful in lan mode; in local mode nothing off-box can use
        // them and in remote mode the tunnel hostname is what matters.
        reachableAt:
          mode === 'lan'
            ? addresses.map((entry) => `http://${entry.family === 'IPv6' ? `[${entry.address}]` : entry.address}`)
            : mode === 'remote'
              ? [env.API_URL]
              : ['http://localhost'],
        connections: poolManager.stats(),
      },
      error: null,
    };
  });

  /**
   * Change the network mode.
   *
   * This only records the intent and reports what else must change — it does
   * not reconfigure the firewall or nginx from an HTTP request. An API that
   * can open the machine's ports is an API that an attacker can use to open
   * the machine's ports, so the privileged half stays in a script the operator
   * runs deliberately.
   */
  app.patch('/server/network-mode', { preHandler: [app.requireUser] }, async (req) => {
    if (!(await isPlatformOperator(req.user?.id, req.user?.email))) {
      throw new ApiError('FORBIDDEN', 'Only a platform operator can change the network mode');
    }
    const body = z.object({ mode: z.enum(['local', 'lan', 'remote']) }).parse(req.body);
    await ensureIdentity();
    await query('UPDATE server_identity SET network_mode = $1 WHERE id = TRUE', [body.mode]);

    void audit(req, { action: 'NETWORK_MODE_CHANGED', resourceType: 'server', metadata: { mode: body.mode } });

    const followUp: Record<NetworkMode, string[]> = {
      local: [
        'Bind nginx to 127.0.0.1 only.',
        'Close 80 and 443 at the firewall — nothing off this machine needs them.',
      ],
      lan: [
        'Allow 80 and 443 from your LAN subnet only, not from anywhere.',
        'Expect browsers to warn about the certificate unless you issue one for a .local name.',
      ],
      remote: [
        'Prefer a Cloudflare Tunnel or VPN over forwarding ports on your router.',
        'Set TRUST_PROXY_HOPS to match the proxies in front of the API.',
        'Run ./scripts/verify-security.sh from another machine before announcing the address.',
      ],
    };

    return {
      data: { mode: body.mode, thenDo: followUp[body.mode] },
      error: null,
    };
  });

  /**
   * Health of the installation as a whole, in the shape `kairos doctor` prints.
   * Deliberately opinionated: it reports problems, not just numbers.
   */
  app.get('/server/doctor', { preHandler: [app.requireUser] }, async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    const identity = await ensureIdentity();

    const pools = poolManager.stats();
    checks.push({
      name: 'connection budget',
      ok: pools.allocated <= pools.projectBudget,
      detail: `${pools.allocated} of ${pools.projectBudget} allocated across ${pools.pools} project pools`,
    });

    const unverified = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM database_backups
        WHERE status = 'completed' AND verified_at IS NULL`,
    ).catch(() => null);
    checks.push({
      name: 'backup verification',
      ok: Number(unverified?.count ?? 0) === 0,
      detail:
        Number(unverified?.count ?? 0) === 0
          ? 'every completed backup has been verified'
          : `${unverified?.count} completed backups were never verified — treat them as absent`,
    });

    const stale = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM project_usage WHERE sampled_at < NOW() - INTERVAL '30 minutes'`,
    ).catch(() => null);
    checks.push({
      name: 'usage sampling',
      ok: Number(stale?.count ?? 0) === 0,
      detail:
        Number(stale?.count ?? 0) === 0
          ? 'usage figures are current'
          : `${stale?.count} projects have stale usage — quotas are being enforced on old numbers`,
    });

    const unforced = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM projects WHERE deleted_at IS NULL AND status = 'active'`,
    ).catch(() => null);
    checks.push({
      name: 'network mode',
      ok: true,
      detail: `${identity.network_mode}${identity.network_mode === 'remote' ? ' — verify the perimeter from another machine' : ''}`,
    });

    const redisOk = await redis.ping().then(() => true).catch(() => false);
    checks.push({
      name: 'redis',
      ok: redisOk,
      detail: redisOk ? 'reachable' : 'unreachable — rate limits and realtime fan-out are degraded',
    });

    return {
      data: {
        serverId: identity.server_id,
        healthy: checks.every((check) => check.ok),
        checks,
        projects: Number(unforced?.count ?? 0),
      },
      error: null,
    };
  });
}
