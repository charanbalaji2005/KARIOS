/**
 * KAIROS Shell — the default terminal mode.
 *
 * This looks like a shell and is not one. A line typed here is tokenised and
 * matched against a fixed grammar; the result is an operation id and a set of
 * named arguments, which then go through exactly the same validation and
 * allowlist as a button in the dashboard. There is no branch that assembles a
 * command string, so `kairos status; rm -rf /` is not two commands — it is one
 * unrecognised command, and the reply says so.
 *
 * The grammar is small on purpose. It is not trying to be bash with training
 * wheels; it is trying to be the twenty things an operator actually needs at
 * 2am, spelled the way they would guess.
 */
import { getOperation, listOperations } from './registry.js';
import { SERVICE_IDS, CONTROLLABLE_SERVICE_IDS, LOG_SOURCE_IDS, MANAGED_DIRECTORIES } from './units.js';

export interface ParsedCommand {
  operation: string;
  args: Record<string, unknown>;
  /** What the operator typed, normalised, for the audit log. */
  display: string;
}

export class ShellError extends Error {
  constructor(message: string, readonly suggestions: string[] = []) {
    super(message);
    this.name = 'ShellError';
  }
}

/**
 * Tokenise.
 *
 * Quotes are honoured so a phrase argument works, and that is the entire
 * extent of the syntax. No pipes, no redirection, no substitution, no
 * globbing — none of it is implemented, so none of it can be exploited. A `|`
 * in a line is just a character that will fail to match a keyword.
 */
function tokenise(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** One rule in the grammar: a literal path, then how to read what is left. */
interface Rule {
  /** Literal words that must match, in order. */
  path: string[];
  operation: string;
  /** Positional arguments after the literal path, in order. */
  positional?: { name: string; values?: readonly string[]; kind?: 'int'; required?: boolean }[];
  help: string;
}

const RULES: Rule[] = [
  { path: ['status'], operation: 'kairos_status', help: 'kairos status' },
  { path: ['doctor'], operation: 'kairos_doctor', help: 'kairos doctor' },
  { path: ['system', 'info'], operation: 'system_info', help: 'kairos system info' },
  { path: ['system', 'disk'], operation: 'system_disk', help: 'kairos system disk' },
  { path: ['system', 'processes'], operation: 'system_processes', help: 'kairos system processes' },
  { path: ['system', 'dependencies'], operation: 'system_dependencies', help: 'kairos system dependencies' },

  { path: ['services'], operation: 'service_list', help: 'kairos services' },
  {
    path: ['service', 'status'],
    operation: 'service_status',
    positional: [{ name: 'service', values: SERVICE_IDS, required: true }],
    help: 'kairos service status <service>',
  },
  {
    path: ['service', 'start'],
    operation: 'service_start',
    positional: [{ name: 'service', values: CONTROLLABLE_SERVICE_IDS, required: true }],
    help: 'kairos service start <service>',
  },
  {
    path: ['service', 'stop'],
    operation: 'service_stop',
    positional: [{ name: 'service', values: CONTROLLABLE_SERVICE_IDS, required: true }],
    help: 'kairos service stop <service>',
  },
  {
    path: ['service', 'restart'],
    operation: 'service_restart',
    positional: [{ name: 'service', values: CONTROLLABLE_SERVICE_IDS, required: true }],
    help: 'kairos service restart <service>',
  },

  { path: ['database', 'status'], operation: 'database_status', help: 'kairos database status' },
  { path: ['redis', 'status'], operation: 'redis_status', help: 'kairos redis status' },
  { path: ['nginx', 'status'], operation: 'nginx_status', help: 'kairos nginx status' },
  { path: ['nginx', 'reload'], operation: 'nginx_reload', help: 'kairos nginx reload' },

  { path: ['storage', 'status'], operation: 'storage_status', help: 'kairos storage status' },
  {
    path: ['storage', 'usage'],
    operation: 'storage_usage',
    positional: [{ name: 'directory', values: MANAGED_DIRECTORIES.map((entry) => entry.id), required: true }],
    help: 'kairos storage usage <directory>',
  },

  { path: ['firewall', 'status'], operation: 'firewall_status', help: 'kairos firewall status' },
  { path: ['firewall', 'rules'], operation: 'firewall_rules', help: 'kairos firewall rules' },

  { path: ['network', 'status'], operation: 'network_status', help: 'kairos network status' },
  { path: ['network', 'ports'], operation: 'network_ports', help: 'kairos network ports' },

  { path: ['docker', 'ps'], operation: 'docker_ps', help: 'kairos docker ps' },
  { path: ['docker', 'stats'], operation: 'docker_stats', help: 'kairos docker stats' },
  { path: ['docker', 'health'], operation: 'docker_health', help: 'kairos docker health' },

  { path: ['backup', 'list'], operation: 'backup_list', help: 'kairos backup list' },
  { path: ['backup', 'create'], operation: 'backup_create', help: 'kairos backup create' },
  {
    path: ['backup', 'verify'],
    operation: 'backup_verify',
    positional: [{ name: 'backup', required: true }],
    help: 'kairos backup verify <archive>',
  },

  { path: ['logs'], operation: 'logs_read', positional: [{ name: 'source', values: LOG_SOURCE_IDS, required: true }, { name: 'lines', kind: 'int' }], help: 'kairos logs <source> [lines]' },
  { path: ['logs', 'sources'], operation: 'logs_sources', help: 'kairos logs sources' },
];

/**
 * Bare diagnostics.
 *
 * Someone who has just opened a terminal types `df`, not `kairos storage
 * status`. Rather than refusing, map the handful of reflexes onto the
 * equivalent operation — which keeps the allowlist intact while not making the
 * operator feel like the tool is fighting them.
 */
const ALIASES: Record<string, { operation: string; note: string }> = {
  df: { operation: 'system_disk', note: 'df → kairos system disk' },
  free: { operation: 'system_info', note: 'free → kairos system info' },
  uptime: { operation: 'system_info', note: 'uptime → kairos system info' },
  uname: { operation: 'system_info', note: 'uname → kairos system info' },
  top: { operation: 'system_processes', note: 'top → kairos system processes (non-interactive)' },
  ps: { operation: 'system_processes', note: 'ps → kairos system processes' },
  ss: { operation: 'network_ports', note: 'ss → kairos network ports' },
  netstat: { operation: 'network_ports', note: 'netstat → kairos network ports' },
  systemctl: { operation: 'service_list', note: 'systemctl → kairos services' },
  nft: { operation: 'firewall_rules', note: 'nft → kairos firewall rules' },
  iptables: { operation: 'firewall_rules', note: 'iptables → kairos firewall rules' },
  lsblk: { operation: 'system_disk', note: 'lsblk → kairos system disk' },
  journalctl: { operation: 'logs_sources', note: 'journalctl → kairos logs <source>' },
};

export function parse(line: string): ParsedCommand {
  const tokens = tokenise(line);
  if (tokens.length === 0) throw new ShellError('');

  const head = tokens[0]!.toLowerCase();

  if (head === 'help' || head === '?') {
    return { operation: '__help', args: {}, display: 'help' };
  }
  if (head === 'clear') {
    return { operation: '__clear', args: {}, display: 'clear' };
  }
  if (head === 'exit' || head === 'quit' || head === 'logout') {
    return { operation: '__exit', args: {}, display: head };
  }
  if (head === 'operations' || head === 'commands') {
    return { operation: '__operations', args: {}, display: head };
  }

  if (head !== 'kairos') {
    const alias = ALIASES[head];
    if (alias) {
      return { operation: alias.operation, args: {}, display: tokens.join(' ') };
    }
    throw new ShellError(
      `${head}: not a KAIROS command.`,
      [
        'This is the KAIROS shell, not bash. It runs a fixed set of operations, nothing else.',
        'Type `help` for the list, or switch to the Ubuntu Terminal for a real shell.',
      ],
    );
  }

  const rest = tokens.slice(1).map((token) => token.toLowerCase());
  if (rest.length === 0) return { operation: '__help', args: {}, display: 'kairos' };

  // Longest literal path first, so `kairos logs sources` beats `kairos logs`.
  const candidates = RULES.filter((rule) => rule.path.every((word, index) => rest[index] === word)).sort(
    (a, b) => b.path.length - a.path.length,
  );

  const rule = candidates[0];
  if (!rule) {
    const near = RULES.filter((entry) => entry.path[0] === rest[0]).map((entry) => entry.help);
    throw new ShellError(
      `kairos ${rest.join(' ')}: unknown command.`,
      near.length > 0 ? ['Did you mean:', ...near.map((help) => `  ${help}`)] : ['Type `help` for the list of commands.'],
    );
  }

  const positionalTokens = tokens.slice(1 + rule.path.length);
  const args: Record<string, unknown> = {};

  for (const [index, spec] of (rule.positional ?? []).entries()) {
    const raw = positionalTokens[index];
    if (raw === undefined) {
      if (spec.required) {
        throw new ShellError(
          `Missing <${spec.name}>.`,
          [
            `Usage: ${rule.help}`,
            ...(spec.values ? [`Valid values: ${spec.values.join(', ')}`] : []),
          ],
        );
      }
      continue;
    }
    if (spec.kind === 'int') {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) throw new ShellError(`<${spec.name}> must be a whole number.`, [`Usage: ${rule.help}`]);
      args[spec.name] = parsed;
      continue;
    }
    if (spec.values && !spec.values.includes(raw.toLowerCase())) {
      throw new ShellError(`"${raw}" is not a valid <${spec.name}>.`, [`Valid values: ${spec.values.join(', ')}`]);
    }
    args[spec.name] = spec.values ? raw.toLowerCase() : raw;
  }

  const extra = positionalTokens.slice((rule.positional ?? []).length);
  if (extra.length > 0) {
    throw new ShellError(`Unexpected extra input: ${extra.join(' ')}`, [`Usage: ${rule.help}`]);
  }

  return { operation: rule.operation, args, display: tokens.join(' ') };
}

/* ------------------------------------------------------------ help text */

export function helpText(): string {
  const groups: [string, string[]][] = [
    ['Overview', ['kairos status', 'kairos doctor', 'kairos system info', 'kairos system dependencies']],
    ['Services', ['kairos services', 'kairos service status <service>', 'kairos service start|stop|restart <service>']],
    ['Data', ['kairos database status', 'kairos redis status', 'kairos storage status', 'kairos storage usage <directory>']],
    ['Network', ['kairos nginx status', 'kairos nginx reload', 'kairos network status', 'kairos network ports']],
    ['Firewall', ['kairos firewall status', 'kairos firewall rules']],
    ['Containers', ['kairos docker ps', 'kairos docker stats', 'kairos docker health']],
    ['Backups', ['kairos backup list', 'kairos backup create', 'kairos backup verify <archive>']],
    ['Logs', ['kairos logs sources', 'kairos logs <source> [lines]']],
    ['Session', ['help', 'operations', 'clear', 'exit']],
  ];

  const lines = ['KAIROS Shell — a fixed set of operations against this host.', ''];
  for (const [title, commands] of groups) {
    lines.push(`  ${title}`);
    for (const command of commands) lines.push(`    ${command}`);
    lines.push('');
  }
  lines.push(`  Services:  ${SERVICE_IDS.join(', ')}`);
  lines.push(`  Log sources: ${LOG_SOURCE_IDS.join(', ')}`);
  lines.push('');
  lines.push('  Destructive operations (stop, restart, firewall changes, restore, reboot) are');
  lines.push('  available from the dashboard, where they ask for typed confirmation first.');
  lines.push('  For anything outside this list, enable the Ubuntu Terminal.');
  return lines.join('\n');
}

export function operationsText(): string {
  const operations = listOperations();
  const width = Math.max(...operations.map((operation) => operation.id.length));
  return [
    'Every operation this agent can perform. Nothing outside this list exists.',
    '',
    ...operations.map(
      (operation) => `  ${operation.id.padEnd(width)}  ${operation.danger ? '[danger] ' : ''}${operation.summary}`,
    ),
  ].join('\n');
}

export { getOperation };
