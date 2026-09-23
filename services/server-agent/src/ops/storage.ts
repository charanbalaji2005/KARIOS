/**
 * Storage reporting.
 *
 * Note what this file does not contain: a `path` argument. The dashboard shows
 * usage for a fixed set of KAIROS-owned directories, named by id, resolved
 * against the data root here. There is no operation that lists an arbitrary
 * directory, so "browse the filesystem from the browser" is not a capability
 * that exists to be abused, and path traversal has nothing to traverse.
 */
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { register } from '../registry.js';
import { run, binaryAvailable } from '../exec.js';
import { config } from '../config.js';
import { MANAGED_DIRECTORIES } from '../units.js';
import { diskUsage, formatBytes } from './system.js';

export interface DirectoryUsage {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  /** Permissions as a four-digit octal string, so the wizard can flag a world-readable backup directory. */
  mode: string | null;
  owner: { uid: number; gid: number } | null;
}

/**
 * Resolve a managed directory id to an absolute path, and prove the result is
 * still inside the data root.
 *
 * The ids come from a constant table so this can never fail today. It is here
 * because the check costs nothing and the day someone adds a config-driven
 * directory is the day it starts mattering.
 */
function resolveManaged(id: string): { path: string; label: string } | null {
  const entry = MANAGED_DIRECTORIES.find((directory) => directory.id === id);
  if (!entry) return null;

  const root = resolve(config.dataRoot);
  const target = resolve(join(root, entry.path));
  if (target !== root && !target.startsWith(root + sep)) return null;

  return { path: target, label: entry.label };
}

/**
 * `du -sb` rather than walking the tree in Node.
 *
 * A storage directory can hold hundreds of thousands of files; a recursive
 * `readdir` would block the event loop for seconds and the agent would stop
 * answering health checks while it counted.
 */
async function directorySize(path: string): Promise<number | null> {
  if (!binaryAvailable('du')) return null;
  const result = await run('du', ['-sb', '--one-file-system', path], {
    timeoutMs: 60_000,
    allowNonZeroExit: true,
  }).catch(() => null);
  if (!result) return null;
  const bytes = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(bytes) ? bytes : null;
}

export async function directoryUsage(): Promise<DirectoryUsage[]> {
  return await Promise.all(
    MANAGED_DIRECTORIES.map(async (entry) => {
      const resolved = resolveManaged(entry.id)!;
      let exists = false;
      let mode: string | null = null;
      let owner: { uid: number; gid: number } | null = null;

      try {
        const stats = await stat(resolved.path);
        exists = stats.isDirectory();
        mode = (stats.mode & 0o7777).toString(8).padStart(4, '0');
        owner = { uid: stats.uid, gid: stats.gid };
      } catch {
        exists = false;
      }

      return {
        id: entry.id,
        label: resolved.label,
        path: resolved.path,
        exists,
        sizeBytes: exists ? await directorySize(resolved.path) : null,
        mode,
        owner,
      };
    }),
  );
}

/* ---------------------------------------------------------- operations */

register(
  {
    id: 'storage_status',
    summary: 'Disk usage across the KAIROS data directories',
    category: 'storage',
    danger: false,
    timeoutMs: 120_000,
    async run() {
      const [directories, disk] = await Promise.all([directoryUsage(), diskUsage(config.dataRoot)]);

      const accounted = directories.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0);
      const width = Math.max(...directories.map((entry) => entry.label.length));

      const lines = directories.map((entry) => {
        if (!entry.exists) return `  ${entry.label.padEnd(width)}  not created`;
        return `  ${entry.label.padEnd(width)}  ${(entry.sizeBytes === null ? 'unreadable' : formatBytes(entry.sizeBytes)).padStart(10)}`;
      });

      if (disk) {
        lines.push('', `  ${'Free on volume'.padEnd(width)}  ${formatBytes(disk.freeBytes).padStart(10)}`);
        lines.push(`  ${'Volume size'.padEnd(width)}  ${formatBytes(disk.totalBytes).padStart(10)}`);
      }

      // Directories that exist but are world-writable are a real finding on a
      // machine that also serves the public internet.
      const loose = directories.filter((entry) => entry.exists && entry.mode !== null && /[2367]$/.test(entry.mode));
      if (loose.length > 0) {
        lines.push('', ...loose.map((entry) => `  ! ${entry.path} is mode ${entry.mode} — world-writable`));
      }

      return {
        data: {
          directories,
          disk,
          accountedBytes: accounted,
          // What the volume holds that is not ours: the OS, Docker images,
          // someone's downloads folder.
          otherBytes: disk ? Math.max(0, disk.usedBytes - accounted) : null,
        },
        text: lines.join('\n'),
      };
    },
  },
  {
    id: 'storage_usage',
    summary: 'Size of one KAIROS data directory',
    category: 'storage',
    danger: false,
    timeoutMs: 90_000,
    args: {
      directory: {
        type: 'enum',
        values: MANAGED_DIRECTORIES.map((entry) => entry.id),
        required: true,
        describe: 'Which KAIROS directory',
      },
    },
    async run({ args }) {
      const id = String(args['directory']);
      const resolved = resolveManaged(id);
      if (!resolved) throw new Error(`Unknown directory: ${id}`);

      const size = await directorySize(resolved.path);
      return {
        data: { id, path: resolved.path, sizeBytes: size },
        text: `${resolved.label}  ${size === null ? 'unreadable' : formatBytes(size)}  (${resolved.path})`,
      };
    },
  },
);
