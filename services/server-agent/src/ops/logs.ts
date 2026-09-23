/**
 * Log reading.
 *
 * Sources are named by id and resolved against the table in units.ts, so there
 * is no unit name or file path arriving from a request. `journalctl -u` with a
 * caller-supplied unit would otherwise be a way to read any unit on the host,
 * and a caller-supplied file path would be a way to read /etc/shadow.
 *
 * Following is streamed rather than polled: the whole point of a log viewer is
 * seeing the line that explains the outage as it is written, and a five-second
 * poll on a busy service means scrolling back through a wall of text to find it.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { register } from '../registry.js';
import { run, stream, tryRun, binaryAvailable } from '../exec.js';
import { config } from '../config.js';
import { LOG_SOURCE_IDS, findLogSource, type LogSource } from '../units.js';

/**
 * Where a source's lines actually come from on this host.
 *
 * A service installed as a systemd unit logs to the journal; the same service
 * in a container logs to Docker. Probing both and choosing means the log
 * viewer works on both layouts without the operator having to know which one
 * they built.
 */
type Reader =
  | { kind: 'journal'; unit: string }
  | { kind: 'docker'; container: string }
  | { kind: 'file'; path: string }
  | { kind: 'none'; reason: string };

async function resolveReader(source: LogSource): Promise<Reader> {
  if (source.file) {
    const root = resolve(config.dataRoot);
    const target = resolve(join(root, source.file));
    // The path comes from a constant, but proving containment costs nothing
    // and keeps the property true if the table ever becomes configurable.
    if (target !== root && !target.startsWith(root + sep)) {
      return { kind: 'none', reason: 'log path resolved outside the data root' };
    }
    try {
      await stat(target);
      return { kind: 'file', path: target };
    } catch {
      return { kind: 'none', reason: `${target} does not exist yet` };
    }
  }

  if (source.unit && binaryAvailable('journalctl')) {
    // `journalctl -u` on an unknown unit succeeds with no output, so ask
    // systemd whether the unit is loaded before believing an empty log.
    const loaded = await tryRun('systemctl', ['show', source.unit, '--property=LoadState', '--no-pager'], {
      timeoutMs: 8_000,
    });
    if (loaded && !/LoadState=not-found/.test(loaded)) {
      return { kind: 'journal', unit: source.unit };
    }
  }

  if (source.container && binaryAvailable('docker')) {
    const exists = await tryRun('docker', ['inspect', source.container, '--format', '{{.Name}}'], { timeoutMs: 10_000 });
    if (exists) return { kind: 'docker', container: source.container };
  }

  return { kind: 'none', reason: `${source.label} is not installed on this host` };
}

export async function describeLogSources() {
  return await Promise.all(
    LOG_SOURCE_IDS.map(async (id) => {
      const source = findLogSource(id)!;
      const reader = await resolveReader(source);
      return {
        id: source.id,
        label: source.label,
        available: reader.kind !== 'none',
        via: reader.kind,
        detail: reader.kind === 'none' ? reader.reason : null,
      };
    }),
  );
}

/** Read the last N lines from a source, without following. */
async function readTail(reader: Reader, lines: number, since: string | null): Promise<string> {
  switch (reader.kind) {
    case 'journal': {
      const args = ['-u', reader.unit, '-n', String(lines), '--no-pager', '--output=short-iso'];
      if (since) args.push('--since', since);
      const result = await run('journalctl', args, { timeoutMs: 30_000, allowNonZeroExit: true });
      return result.stdout;
    }
    case 'docker': {
      const args = ['logs', '--tail', String(lines), '--timestamps'];
      if (since) args.push('--since', since);
      args.push(reader.container);
      // Docker writes container stderr to our stderr; both are the log.
      const result = await run('docker', args, { timeoutMs: 30_000, allowNonZeroExit: true });
      return result.stdout + result.stderr;
    }
    case 'file': {
      return await readFileTail(reader.path, lines);
    }
    case 'none':
      return '';
  }
}

/**
 * Tail a file without loading it.
 *
 * A security log that has been running for a month is not something to read
 * into a string just to show the last hundred lines, so read the final chunk
 * and split that.
 */
async function readFileTail(path: string, lines: number): Promise<string> {
  const stats = await stat(path);
  const window = Math.min(stats.size, 512 * 1024);
  const start = Math.max(0, stats.size - window);

  return await new Promise<string>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(path, { start })
      .on('data', (chunk) => chunks.push(chunk as Buffer))
      .on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const all = text.split('\n');
        // The first line is probably a fragment when we did not start at zero.
        const usable = start > 0 ? all.slice(1) : all;
        resolvePromise(usable.slice(-lines).join('\n'));
      })
      .on('error', reject);
  });
}

/* ---------------------------------------------------------- operations */

const SINCE_VALUES = ['5 minutes ago', '15 minutes ago', '1 hour ago', '6 hours ago', '1 day ago', '7 days ago'] as const;

register(
  {
    id: 'logs_sources',
    summary: 'Which log sources exist on this host',
    category: 'logs',
    danger: false,
    timeoutMs: 45_000,
    async run() {
      const sources = await describeLogSources();
      return {
        data: { sources },
        text: sources
          .map((source) => `${source.available ? '  ok  ' : ' none '} ${source.id.padEnd(12)} ${source.detail ?? `via ${source.via}`}`)
          .join('\n'),
      };
    },
  },
  {
    id: 'logs_read',
    summary: 'Read recent log lines from a service',
    category: 'logs',
    danger: false,
    timeoutMs: 45_000,
    args: {
      source: { type: 'enum', values: LOG_SOURCE_IDS, required: true, describe: 'Which service' },
      lines: { type: 'int', min: 1, max: 5_000, default: 200, describe: 'How many lines' },
      since: { type: 'enum', values: SINCE_VALUES, required: false, describe: 'Only lines newer than this' },
    },
    async run({ args }) {
      const source = findLogSource(String(args['source']))!;
      const reader = await resolveReader(source);
      if (reader.kind === 'none') {
        return { data: { source: source.id, available: false, lines: [] }, text: reader.reason };
      }

      const text = await readTail(reader, Number(args['lines']), args['since'] ? String(args['since']) : null);
      const lines = text.split('\n').filter((line) => line.length > 0);
      return {
        data: { source: source.id, available: true, via: reader.kind, lines },
        text: text.trimEnd() || `No log lines for ${source.label}.`,
      };
    },
  },
  {
    id: 'logs_follow',
    summary: 'Stream log lines as they are written',
    category: 'logs',
    danger: false,
    streaming: true,
    // Bounded, because a terminal left open on a follow is a process left
    // running forever. The UI reconnects.
    timeoutMs: 30 * 60_000,
    args: {
      source: { type: 'enum', values: LOG_SOURCE_IDS, required: true },
      lines: { type: 'int', min: 0, max: 1_000, default: 50, describe: 'Backfill before following' },
    },
    async run({ args, emit, signal }) {
      const source = findLogSource(String(args['source']))!;
      const reader = await resolveReader(source);
      if (reader.kind === 'none') {
        return { data: { source: source.id, available: false }, text: reader.reason };
      }

      const backfill = Number(args['lines']);

      if (reader.kind === 'file') {
        // No `tail -f` binary in the allowlist, and adding one to follow a
        // file KAIROS itself writes would be a strange place to spend
        // privilege. Poll the file's own size instead — it only grows.
        if (backfill > 0) emit(await readFileTail(reader.path, backfill));
        let offset = (await stat(reader.path)).size;
        await new Promise<void>((resolvePromise) => {
          const timer = setInterval(async () => {
            try {
              const size = (await stat(reader.path)).size;
              if (size <= offset) return;
              const from = offset;
              offset = size;
              const chunks: Buffer[] = [];
              createReadStream(reader.path, { start: from, end: size - 1 })
                .on('data', (chunk) => chunks.push(chunk as Buffer))
                .on('end', () => emit(Buffer.concat(chunks).toString('utf8')))
                .on('error', () => undefined);
            } catch {
              // File rotated out from under us; pick it up on the next tick.
              offset = 0;
            }
          }, 1_000);
          const stop = () => {
            clearInterval(timer);
            resolvePromise();
          };
          signal.addEventListener('abort', stop, { once: true });
        });
        return { data: { source: source.id, followed: true } };
      }

      const handle =
        reader.kind === 'journal'
          ? stream(
              'journalctl',
              ['-u', reader.unit, '-n', String(backfill), '--no-pager', '--follow', '--output=short-iso'],
              (chunk) => emit(chunk),
            )
          : stream('docker', ['logs', '--tail', String(backfill), '--timestamps', '--follow', reader.container], (chunk) =>
              emit(chunk),
            );

      signal.addEventListener('abort', () => handle.kill('SIGTERM'), { once: true });
      const code = await handle.done;
      return { data: { source: source.id, followed: true }, exitCode: code };
    },
  },
);
