/**
 * Registry coherence.
 *
 * The allowlist is the security boundary of the whole server console, so these
 * check that it is internally consistent rather than that any one operation
 * works. Importing the ops modules is itself part of the test: `register()`
 * throws on a duplicate id and on a dangerous operation with no confirmation
 * phrase, so a module that violates either fails at import.
 */
import { describe, expect, it } from 'vitest';

import { describeOperations, getOperation, listOperations } from '../../services/server-agent/src/registry.js';
import { parse as parseShell, helpText, operationsText } from '../../services/server-agent/src/shell.js';

// Importing is registering. This list is the agent's capability surface.
import '../../services/server-agent/src/ops/system.js';
import '../../services/server-agent/src/ops/services.js';
import '../../services/server-agent/src/ops/database.js';
import '../../services/server-agent/src/ops/storage.js';
import '../../services/server-agent/src/ops/network.js';
import '../../services/server-agent/src/ops/firewall.js';
import '../../services/server-agent/src/ops/logs.js';
import '../../services/server-agent/src/ops/backup.js';
import '../../services/server-agent/src/ops/power.js';
import '../../services/server-agent/src/ops/health.js';
import '../../services/server-agent/src/ops/provision.js';
import '../../services/server-agent/src/ops/identity.js';

describe('operation registry', () => {
  it('registers every module without a duplicate id', () => {
    const operations = listOperations();
    expect(operations.length).toBeGreaterThan(30);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(operations.length);
  });

  it('gives every dangerous operation a confirmation phrase', () => {
    for (const operation of listOperations().filter((entry) => entry.danger)) {
      expect(operation.confirmPhrase, operation.id).toBeTruthy();
      // The phrase is typed by a human under pressure. Upper case and short
      // enough to retype is the difference between a control and an obstacle.
      expect(operation.confirmPhrase, operation.id).toBe(operation.confirmPhrase!.toUpperCase());
      expect(operation.confirmPhrase!.length, operation.id).toBeLessThanOrEqual(30);
    }
  });

  it('marks the operations that can take the platform down as dangerous', () => {
    // If one of these ever stops being dangerous, it stops asking for a typed
    // confirmation, and that is not a change anyone should make by accident.
    for (const id of [
      'service_stop',
      'service_restart',
      'server_reboot',
      'server_shutdown',
      'backup_restore',
      'backup_prune',
      'firewall_apply_baseline',
      'firewall_close_https',
      'firewall_configure_ssh',
      'provision_install_dependencies',
    ]) {
      expect(getOperation(id)?.danger, id).toBe(true);
    }
  });

  it('does not mark read-only operations as dangerous', () => {
    for (const id of [
      'kairos_status',
      'kairos_doctor',
      'system_info',
      'service_list',
      'database_status',
      'storage_status',
      'firewall_status',
      'network_ports',
      'logs_read',
      'backup_list',
    ]) {
      expect(getOperation(id)?.danger, id).toBe(false);
    }
  });

  it('gives every operation a timeout', () => {
    // "Wait forever" is not an option: an operation with no ceiling holds a
    // connection and, for a PTY-adjacent one, a process.
    for (const operation of listOperations()) {
      expect(operation.timeoutMs, operation.id).toBeGreaterThan(0);
      expect(operation.timeoutMs, operation.id).toBeLessThanOrEqual(60 * 60_000);
    }
  });

  it('exposes no operation that takes a free-form path or command', () => {
    for (const operation of describeOperations()) {
      for (const arg of operation.args) {
        // Enums and bounded ints are safe by construction. A `string`
        // argument is the only shape that could carry a path or a command, and
        // there are exactly two — both pattern-constrained identifiers.
        if (arg.type === 'string') {
          expect(
            ['backup', 'source', 'challenge'].includes(arg.name),
            `${operation.id}.${arg.name} is a free-form string`,
          ).toBe(true);
        }
        expect(['command', 'cmd', 'path', 'file', 'script', 'sql', 'unit'], `${operation.id}.${arg.name}`).not.toContain(
          arg.name,
        );
      }
    }
  });
});

describe('shell grammar and registry agree', () => {
  const LINES = [
    'kairos status',
    'kairos doctor',
    'kairos services',
    'kairos service status postgres',
    'kairos service start redis',
    'kairos service stop nginx',
    'kairos service restart api',
    'kairos database status',
    'kairos redis status',
    'kairos nginx status',
    'kairos nginx reload',
    'kairos storage status',
    'kairos storage usage backups',
    'kairos firewall status',
    'kairos firewall rules',
    'kairos network status',
    'kairos network ports',
    'kairos docker ps',
    'kairos docker stats',
    'kairos docker health',
    'kairos backup list',
    'kairos backup create',
    'kairos logs sources',
    'kairos logs api',
    'kairos logs postgres 500',
    'kairos system info',
    'kairos system disk',
    'kairos system processes',
    'kairos system dependencies',
    // Bare-command aliases, for the reflexes people actually have.
    'df',
    'free',
    'uptime',
    'ps',
    'top',
    'ss',
    'systemctl',
    'nft',
  ];

  it('resolves every documented command to a registered operation', () => {
    for (const line of LINES) {
      const parsed = parseShell(line);
      if (parsed.operation.startsWith('__')) continue;
      expect(getOperation(parsed.operation), `"${line}" → ${parsed.operation}`).toBeDefined();
    }
  });

  it('validates shell arguments against the operation schema', () => {
    // The shell resolves `kairos logs postgres 500` to logs_read with
    // {source, lines}; those must be names the operation declares, or the
    // agent rejects its own shell's output.
    const parsed = parseShell('kairos logs postgres 500');
    const operation = getOperation(parsed.operation)!;
    for (const key of Object.keys(parsed.args)) {
      expect(Object.keys(operation.args ?? {}), `${parsed.operation}.${key}`).toContain(key);
    }
  });

  it('prints help and the full allowlist', () => {
    expect(helpText()).toContain('kairos status');
    expect(helpText()).toContain('Ubuntu Terminal');
    const listing = operationsText();
    for (const operation of listOperations()) {
      expect(listing, operation.id).toContain(operation.id);
    }
  });
});
