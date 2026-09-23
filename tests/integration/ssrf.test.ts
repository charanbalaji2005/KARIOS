/**
 * SSRF guard tests.
 *
 * Every case here is a request a webhook could legitimately be configured to
 * make on a self-hosted box, and every one of them would have reached a
 * private service before this guard existed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => dns);
vi.mock('../../services/api/src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { isBlockedAddress, vetOutboundUrl } = await import('../../services/api/src/lib/ssrf.js');

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['WEBHOOK_ALLOWED_HOSTS'];
  delete process.env['WEBHOOK_ALLOW_HTTP'];
});
afterEach(() => {
  delete process.env['WEBHOOK_ALLOWED_HOSTS'];
  delete process.env['WEBHOOK_ALLOW_HTTP'];
});

describe('isBlockedAddress', () => {
  const blocked = [
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the rest of 127/8, which people forget'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC1918'],
    ['172.17.0.2', 'the default Docker bridge — where postgres actually lives'],
    ['172.31.255.255', 'top of the 172.16/12 range'],
    ['192.168.1.1', 'the home router'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.1.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback — the same host by another spelling'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
  ] as const;

  for (const [address, why] of blocked) {
    it(`blocks ${address} (${why})`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111'];
  for (const address of allowed) {
    it(`allows the public address ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }

  it('refuses anything that is not an IP literal', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('vetOutboundUrl', () => {
  it('requires https by default', async () => {
    await expect(vetOutboundUrl('http://example.com/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects non-http protocols outright', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      await expect(vetOutboundUrl(url)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('rejects credentials embedded in the URL', async () => {
    dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(vetOutboundUrl('https://user:pass@example.com/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects a hostname that resolves to a private address', async () => {
    dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(vetOutboundUrl('https://localtest.me/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects when ANY resolved address is private', async () => {
    // A name with one public and one private address is an attack, not a
    // misconfiguration — a naive check that looks at the first record passes.
    dns.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(vetOutboundUrl('https://sneaky.example.com/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects a bare private IP in the URL without consulting DNS', async () => {
    await expect(vetOutboundUrl('https://10.0.0.5/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('rejects the platform reaching its own internal service names', async () => {
    dns.lookup.mockResolvedValue([{ address: '172.18.0.3', family: 4 }]);
    await expect(vetOutboundUrl('https://postgres:5432/')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('returns the vetted address so the caller can pin the connection', async () => {
    // Pinning is what defeats DNS rebinding: without the address travelling
    // back to the caller, fetch() would resolve the name a second time and the
    // attacker answers that one differently.
    dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const target = await vetOutboundUrl('https://example.com/hook');
    expect(target.address).toBe('93.184.216.34');
    expect(target.url.hostname).toBe('example.com');
  });

  it('honours an explicit allow-list for a deliberate LAN webhook', async () => {
    process.env['WEBHOOK_ALLOWED_HOSTS'] = 'nas.local';
    dns.lookup.mockResolvedValue([{ address: '192.168.1.50', family: 4 }]);
    const target = await vetOutboundUrl('https://nas.local/hook');
    expect(target.address).toBe('192.168.1.50');
  });

  it('does not treat the allow-list as a wildcard', async () => {
    process.env['WEBHOOK_ALLOWED_HOSTS'] = 'nas.local';
    dns.lookup.mockResolvedValue([{ address: '192.168.1.51', family: 4 }]);
    await expect(vetOutboundUrl('https://evil.nas.local/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('allows http only when explicitly enabled', async () => {
    process.env['WEBHOOK_ALLOW_HTTP'] = 'true';
    dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(vetOutboundUrl('http://example.com/hook')).resolves.toMatchObject({
      address: '93.184.216.34',
    });
  });

  it('rejects a hostname that does not resolve', async () => {
    dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(vetOutboundUrl('https://nope.invalid/hook')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
