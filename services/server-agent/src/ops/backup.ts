/**
 * Backups.
 *
 * On a hosted platform a lost backup is embarrassing. Here the laptop *is* the
 * cloud, so the backup directory is frequently the only other copy of the
 * data, and a backup that was never verified is not a backup — it is a file
 * that will disappoint someone during an incident. So every archive written
 * here is read back out and parsed before it is called complete.
 *
 * One physical directory, `<data root>/backups`, used by this agent, by the
 * API's backup worker and by the rotation script. Two directories both called
 * "backups" is how a restore finds yesterday's file and not this morning's.
 */
import { readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { register } from '../registry.js';
import { run, binaryAvailable } from '../exec.js';
import { config } from '../config.js';
import { PATTERNS } from '../validate.js';
import { formatBytes } from './system.js';
import { DATABASE_URL } from './database.js';

const BACKUP_DIR = join(config.dataRoot, 'backups');

export interface BackupFile {
  id: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  /** Present once the archive has been read back and parsed. */
  verified: boolean;
  checksum: string | null;
}

/**
 * Resolve a backup id to a path and prove the result is inside the backup
 * directory.
 *
 * The id is already constrained to `[A-Za-z0-9_-]` by the argument schema, so
 * it cannot contain a slash or a `..` — but a restore operation is exactly
 * where a defence-in-depth check earns its keep, so the containment is proven
 * rather than assumed.
 */
function resolveBackup(id: string): string {
  if (!PATTERNS.backupId.test(id)) throw new Error('Malformed backup id');
  const root = resolve(BACKUP_DIR);
  const target = resolve(join(root, id));
  if (!target.startsWith(root + sep)) throw new Error('Backup id resolved outside the backup directory');
  return target;
}

async function checksum(path: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * `pg_restore` ships in the same package as `pg_dump` and sits beside it, but
 * it is not in the exec allowlist because nothing else needs it. Resolve it
 * from the same fixed candidate list the allowlist uses for `pg_dump`.
 */
function resolvePgRestore(): string | null {
  return (
    [
      '/usr/bin/pg_restore',
      '/usr/lib/postgresql/17/bin/pg_restore',
      '/usr/lib/postgresql/16/bin/pg_restore',
    ].find((candidate) => existsSync(candidate)) ?? null
  );
}

/**
 * Confirm the archive is readable as an archive.
 *
 * `pg_restore --list` parses the table of contents. A truncated dump, a dump
 * written to a full disk, or a dump of a database the role could not fully
 * read all fail here — which is the entire point, because all three exit
 * pg_dump with status zero.
 */
async function verifyArchive(path: string): Promise<{ ok: boolean; tables: number; detail: string }> {
  const binary = resolvePgRestore();
  if (!binary) {
    return { ok: false, tables: 0, detail: 'pg_restore is not installed, so the archive could not be verified' };
  }

  return await new Promise((resolvePromise) => {
    const child = spawn(binary, ['--list', path], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    timer.unref();
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolvePromise({ ok: false, tables: 0, detail: stderr.trim().split('\n').slice(-1)[0] ?? 'pg_restore failed' });
        return;
      }
      const tables = stdout.split('\n').filter((line) => / TABLE DATA /.test(line)).length;
      resolvePromise({ ok: true, tables, detail: `table of contents parsed, ${tables} tables` });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, tables: 0, detail: error.message });
    });
  });
}

export async function listBackups(): Promise<BackupFile[]> {
  try {
    const entries = await readdir(BACKUP_DIR);
    const files = await Promise.all(
      entries
        .filter((name) => name.endsWith('.dump'))
        .map(async (name) => {
          const path = join(BACKUP_DIR, name);
          const stats = await stat(path).catch(() => null);
          if (!stats || !stats.isFile()) return null;
          return {
            id: name,
            path,
            sizeBytes: stats.size,
            createdAt: stats.mtime.toISOString(),
            verified: false,
            checksum: null,
          } as BackupFile;
        }),
    );
    const validFiles = files.filter((f): f is BackupFile => Boolean(f));
    return validFiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------- operations */

register(
  {
    id: 'backup_list',
    summary: 'Backups on disk, newest first',
    category: 'backup',
    danger: false,
    timeoutMs: 30_000,
    async run() {
      const backups = await listBackups();
      const total = backups.reduce((sum, backup) => sum + backup.sizeBytes, 0);
      const text = backups.length
        ? [
            ...backups.map((backup) => `${backup.createdAt}  ${formatBytes(backup.sizeBytes).padStart(10)}  ${backup.id}`),
            '',
            `${backups.length} archives, ${formatBytes(total)} total, in ${BACKUP_DIR}`,
          ].join('\n')
        : `No backups in ${BACKUP_DIR}.`;
      return { data: { backups, directory: BACKUP_DIR, totalBytes: total }, text };
    },
  },
  {
    id: 'backup_create',
    summary: 'Dump the platform database and verify the archive',
    category: 'backup',
    danger: false,
    timeoutMs: 30 * 60_000,
    async run({ emit }) {
      if (!DATABASE_URL) {
        throw new Error('No database URL is configured for the agent, so it cannot take a backup.');
      }
      if (!binaryAvailable('pg_dump')) {
        throw new Error('pg_dump is not installed. Install it with: apt-get install postgresql-client');
      }

      await mkdir(BACKUP_DIR, { recursive: true, mode: 0o750 });

      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const name = `kairos-platform-${stamp}.dump`;
      const path = join(BACKUP_DIR, name);

      emit(`Dumping to ${path}\n`);

      // Custom format, so pg_restore can list it — which is what makes
      // verification possible at all. A plain SQL dump cannot be checked
      // without replaying it.
      const result = await run(
        'pg_dump',
        ['--format=custom', '--compress=6', '--no-owner', '--no-privileges', '--file', path, DATABASE_URL],
        { timeoutMs: 25 * 60_000, allowNonZeroExit: true, env: { PGCONNECT_TIMEOUT: '10' } },
      );

      if (result.code !== 0) {
        await unlink(path).catch(() => undefined);
        throw new Error(`pg_dump failed: ${result.stderr.trim().split('\n').slice(-1)[0] ?? `exit ${result.code}`}`);
      }

      const stats = await stat(path);
      emit(`Wrote ${formatBytes(stats.size)}. Verifying...\n`);

      const verification = await verifyArchive(path);
      const digest = await checksum(path);

      if (!verification.ok) {
        // Leave the file for inspection but be unambiguous that it is not a
        // backup. Deleting it would destroy the evidence of why it failed.
        return {
          data: { id: name, path, sizeBytes: stats.size, verified: false, checksum: digest, detail: verification.detail },
          text: `Archive written but NOT verified: ${verification.detail}\nTreat ${name} as absent until this is understood.`,
          exitCode: 1,
        };
      }

      return {
        data: {
          id: name,
          path,
          sizeBytes: stats.size,
          verified: true,
          tables: verification.tables,
          checksum: digest,
          createdAt: stats.mtime.toISOString(),
        },
        text: [
          `Backup complete: ${name}`,
          `  size      ${formatBytes(stats.size)}`,
          `  tables    ${verification.tables}`,
          `  sha256    ${digest}`,
          '',
          'Verified by reading the archive back and parsing its table of contents.',
        ].join('\n'),
      };
    },
  },
  {
    id: 'backup_verify',
    summary: 'Read an archive back and confirm it parses',
    category: 'backup',
    danger: false,
    timeoutMs: 10 * 60_000,
    args: { backup: { type: 'string', pattern: PATTERNS.backupId, maxLength: 128, required: true } },
    async run({ args, emit }) {
      const path = resolveBackup(String(args['backup']));
      emit(`Verifying ${path}\n`);
      const [verification, digest] = await Promise.all([verifyArchive(path), checksum(path)]);
      return {
        data: { backup: args['backup'], verified: verification.ok, tables: verification.tables, checksum: digest },
        text: verification.ok
          ? `Verified. ${verification.tables} tables.\nsha256 ${digest}`
          : `NOT verified: ${verification.detail}`,
        exitCode: verification.ok ? 0 : 1,
      };
    },
  },
  {
    id: 'backup_restore',
    summary: 'Restore an archive over the live platform database',
    category: 'backup',
    // The most destructive operation the agent exposes. It overwrites the
    // database that every project's metadata and credentials live in.
    danger: true,
    confirmPhrase: 'RESTORE DATABASE',
    timeoutMs: 60 * 60_000,
    args: { backup: { type: 'string', pattern: PATTERNS.backupId, maxLength: 128, required: true } },
    async run({ args, emit }) {
      if (!DATABASE_URL) throw new Error('No database URL is configured for the agent.');
      const path = resolveBackup(String(args['backup']));

      emit('Verifying the archive before touching the live database...\n');
      const verification = await verifyArchive(path);
      if (!verification.ok) {
        // Restoring an unverifiable archive is how a recoverable incident
        // becomes an unrecoverable one.
        throw new Error(`Refusing to restore: the archive does not parse (${verification.detail})`);
      }

      const binary = resolvePgRestore();
      if (!binary) throw new Error('pg_restore is not installed.');

      emit(`Archive parses (${verification.tables} tables). Restoring...\n`);

      const code = await new Promise<number>((resolvePromise) => {
        const child: any = spawn(
          binary,
          ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', DATABASE_URL || '', path],
          { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout?.on('data', (chunk: Buffer) => emit(chunk.toString('utf8')));
        child.stderr?.on('data', (chunk: Buffer) => emit(chunk.toString('utf8')));
        child.on('close', (exit: number | null) => resolvePromise(exit ?? -1));
        child.on('error', () => resolvePromise(-1));
      });

      return {
        data: { backup: args['backup'], exitCode: code },
        text:
          code === 0
            ? 'Restore complete.'
            : `Restore finished with exit code ${code}. Review the output above — --clean reports harmless notices this way, but confirm the data is what you expect.`,
        exitCode: code,
      };
    },
  },
  {
    id: 'backup_prune',
    summary: 'Delete backups older than a retention window',
    category: 'backup',
    danger: true,
    confirmPhrase: 'DELETE OLD BACKUPS',
    timeoutMs: 60_000,
    args: { keepDays: { type: 'int', min: 1, max: 3_650, default: 30, describe: 'Keep archives newer than this' } },
    async run({ args, emit }) {
      const keepDays = Number(args['keepDays']);
      const cutoff = Date.now() - keepDays * 86_400_000;
      const backups = await listBackups();
      const stale = backups.filter((backup) => new Date(backup.createdAt).getTime() < cutoff);

      // Never delete the last archive, whatever the retention window says. A
      // retention policy that can empty the directory is a retention policy
      // that will, on the day someone sets keepDays to 1 to free space.
      const keepNewest = backups[0]?.id;
      const removable = stale.filter((backup) => backup.id !== keepNewest);

      if (removable.length === 0) {
        return { data: { deleted: [], keptNewest: keepNewest ?? null }, text: 'Nothing to prune.' };
      }

      const deleted: string[] = [];
      for (const backup of removable) {
        await unlink(backup.path);
        deleted.push(backup.id);
        emit(`deleted ${backup.id}\n`);
      }

      return {
        data: { deleted, keptNewest: keepNewest ?? null },
        text: `Deleted ${deleted.length} archives older than ${keepDays} days. The newest archive was kept regardless.`,
      };
    },
  },
);

export { BACKUP_DIR };
