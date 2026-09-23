/**
 * SSRF protection for outbound requests.
 *
 * Webhook URLs are user-supplied and the worker fetches them. On a normal
 * cloud that is a nuisance; on a self-hosted box it is a way to reach things
 * the internet cannot:
 *
 *   http://localhost:4000/api/v1/...     the platform's own API
 *   http://postgres:5432                 the database, on the internal network
 *   http://redis:6379                    Redis, no auth from inside
 *   http://minio:9000                    object storage
 *   http://169.254.169.254/...           cloud metadata, if ever moved to a VPS
 *   http://192.168.1.1                   the user's router
 *
 * The whole point of `internal: true` on the data-plane network is that the
 * internet cannot route there. A webhook fetch runs *inside* that boundary,
 * so it can — which makes the worker a proxy into the private network unless
 * this module stops it.
 *
 * Two checks, both necessary:
 *
 *  1. Validate the URL and resolve its hostname, rejecting private addresses.
 *  2. **Connect to the address that was checked**, not to the hostname.
 *
 * Step 2 is what defeats DNS rebinding. Checking `evil.com` resolves to a
 * public address and then calling `fetch('https://evil.com/...')` lets the
 * attacker answer the second lookup with 127.0.0.1. The gap between the two
 * lookups is the entire attack, so the request is pinned to the vetted IP.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from './errors.js';
import { logger } from '../logger.js';

/** Blocked IPv4 ranges, as [network, prefix length]. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918 private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local — includes cloud metadata at 169.254.169.254
  ['172.16.0.0', 12],    // RFC1918 private, and the default Docker bridge range
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC1918 private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, includes 255.255.255.255
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isBlockedV4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true; // unparseable: refuse
  for (const [network, prefix] of BLOCKED_V4) {
    const base = ipv4ToInt(network);
    if (base === null) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) === (base & mask)) return true;
  }
  return false;
}

function isBlockedV6(address: string): boolean {
  const normalised = address.toLowerCase().split('%')[0] ?? '';

  if (normalised === '::' || normalised === '::1') return true;          // unspecified, loopback
  if (normalised.startsWith('fe80')) return true;                         // link-local
  if (/^f[cd]/.test(normalised)) return true;                             // unique local fc00::/7
  if (normalised.startsWith('ff')) return true;                           // multicast

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible addresses reach the
  // same hosts as their v4 form, so unwrap and apply the v4 rules.
  const mapped = normalised.match(/::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);

  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true; // not an IP literal: refuse
}

export interface VettedTarget {
  url: URL;
  /** The address the request must actually connect to. */
  address: string;
  family: 4 | 6;
}

export interface SsrfOptions {
  /**
   * Allow plain HTTP. Off by default: a webhook carries an HMAC signature and
   * often a payload worth reading, and sending it in clear text over someone
   * else's network defeats the signature's purpose.
   */
  allowHttp?: boolean;
  /**
   * Hostnames explicitly permitted despite resolving privately. For an
   * operator deliberately wiring a webhook to a service on their own LAN.
   * Exact matches only — no wildcards, because a wildcard allow-list here is
   * how the protection quietly stops protecting.
   */
  allowlist?: string[];
}

function configuredAllowlist(): string[] {
  return (process.env['WEBHOOK_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validate a user-supplied URL and resolve it to an address safe to connect to.
 *
 * Throws `ApiError` with a message the user can act on. The message names the
 * category of problem but never the resolved address — telling a caller that
 * `internal.example.com` resolved to `10.0.4.17` is a free internal network
 * map.
 */
export async function vetOutboundUrl(rawUrl: string, options: SsrfOptions = {}): Promise<VettedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'That is not a valid URL');
  }

  const allowHttp = options.allowHttp ?? process.env['WEBHOOK_ALLOW_HTTP'] === 'true';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ApiError(
      'VALIDATION_ERROR',
      allowHttp ? 'Webhook URLs must use http or https' : 'Webhook URLs must use https',
    );
  }

  // file:, gopher:, ftp: and friends are excluded by the protocol check above.
  // Credentials in the URL are refused: they get written to delivery logs and
  // they are a common way to smuggle a different host past naive parsers.
  if (url.username || url.password) {
    throw new ApiError('VALIDATION_ERROR', 'Webhook URLs must not contain credentials');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowlist = [...(options.allowlist ?? []), ...configuredAllowlist()];
  const explicitlyAllowed = allowlist.includes(hostname);

  // Resolve every address the name maps to. A hostname with one public and one
  // private address is an attack, not a misconfiguration, so all must pass.
  let resolved: { address: string; family: number }[];
  if (isIP(hostname)) {
    resolved = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      resolved = await lookup(hostname, { all: true });
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'That hostname could not be resolved');
    }
  }

  if (resolved.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'That hostname could not be resolved');
  }

  if (!explicitlyAllowed) {
    for (const entry of resolved) {
      if (isBlockedAddress(entry.address)) {
        logger.warn({ hostname, url: url.origin }, 'refused outbound request to a private address');
        throw new ApiError(
          'VALIDATION_ERROR',
          'That URL resolves to a private or reserved address. Webhooks must point at a publicly reachable host.',
        );
      }
    }
  }

  const chosen = resolved[0]!;
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * Fetch a vetted target, pinned to the address that was checked.
 *
 * The connection goes to `target.address` while the `Host` header and TLS SNI
 * keep the original hostname, so virtual hosting and certificate validation
 * still work. Between vetting and connecting there is no second DNS lookup for
 * an attacker to answer differently.
 *
 * Redirects are **not** followed. A 302 to `http://169.254.169.254/` would
 * walk straight past everything above, and a webhook receiver has no
 * legitimate need to redirect.
 */
export async function fetchVetted(
  target: VettedTarget,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, headers, ...rest } = init;

  const pinnedUrl = new URL(target.url.toString());
  const isDefaultPort = !target.url.port;
  pinnedUrl.hostname = target.family === 6 ? `[${target.address}]` : target.address;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(pinnedUrl, {
      ...rest,
      headers: {
        ...(headers as Record<string, string> | undefined),
        // Preserve virtual hosting on the pinned connection.
        host: isDefaultPort ? target.url.hostname : target.url.host,
      },
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
