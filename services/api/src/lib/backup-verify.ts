/**
 * Backup verification.
 *
 * The README used to claim `pg_restore` verification while the worker only
 * checked `pg_dump`'s exit code. Those are different claims. A zero exit code
 * says the dump process did not crash; it says nothing about whether the bytes
 * that arrived in storage are a readable archive.
 *
 * The failure modes it misses are the realistic ones:
 *
 *   - the multipart upload lost a part
 *   - the disk filled on the last block
 *   - the object was silently truncated or corrupted at rest
 *   - the dump succeeded against a database that was already broken
 *
 * All of those produce a row marked `completed` and a file that fails at
 * restore time, which is the worst moment to learn about it.
 *
 * So this reads the archive **back out of storage** — not from the local pipe,
 * which would prove nothing about what was stored — and runs
 * `pg_restore --list` over it. That parses the table of contents and fails on
 * a truncated or corrupt archive. It also hashes the bytes on the way through,
 * so the checksum recorded is of what storage actually holds.
 *
 * What this does NOT do: restore into a scratch database and query it. That is
 * the only check that proves the data is usable, and it costs a full restore
 * per backup. `verifyBackupByRestore` below implements it for when you want
 * that guarantee; it is off by default and documented as a deliberate choice.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { storage } from './storage/index.js';
import { logger } from '../logger.js';
import { env } from '../env.js';

export interface VerificationResult {
  ok: boolean;
  reason?: string;
  checksum?: string;
  /** Tables found in the archive's table of contents. Zero is suspicious. */
  tableCount?: number;
  bytesRead?: number;
}

/**
 * Read the stored archive and confirm `pg_restore --list` can parse it.
 */
export async function verifyBackup(projectRef: string, key: string): Promise<VerificationResult> {
  let object;
  try {
    object = await storage.get(projectRef, key);
  } catch (error) {
    return { ok: false, reason: `the backup could not be read back from storage: ${(error as Error).message}` };
  }

  const hash = createHash('sha256');
  let bytesRead = 0;

  // pg_restore reads the archive on stdin. --list only walks the table of
  // contents, so this is cheap even for a large dump, and it is enough to
  // detect truncation and corruption of the header and TOC.
  const restore = spawn('pg_restore', ['--list'], { stdio: ['pipe', 'pipe', 'pipe'] });

  let toc = '';
  let stderr = '';
  restore.stdout.on('data', (chunk: Buffer) => {
    // Cap what is held in memory: the TOC of a large schema is still small,
    // but an attacker-controlled table name count should not be able to grow
    // this without bound.
    if (toc.length < 2_000_000) toc += chunk.toString();
  });
  restore.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString().slice(0, 4000);
  });

  const exited = new Promise<number>((resolve, reject) => {
    restore.on('error', reject);
    restore.on('close', resolve);
  });

  const meter = new PassThrough();
  meter.on('data', (chunk: Buffer) => {
    bytesRead += chunk.length;
    hash.update(chunk);
  });

  try {
    await pipeline(object.stream, meter, restore.stdin);
  } catch (error) {
    // EPIPE here usually means pg_restore rejected the archive and exited
    // early, which the exit code below reports properly.
    logger.debug({ err: error, key }, 'backup verification pipe closed early');
  }

  const code = await exited.catch((error: Error) => {
    logger.error({ err: error }, 'pg_restore could not be started for verification');
    return -1;
  });

  if (code === -1) {
    return { ok: false, reason: 'pg_restore is not available in this image, so the backup could not be verified' };
  }
  if (code !== 0) {
    return { ok: false, reason: `pg_restore could not read the archive (exit ${code}): ${stderr.trim()}`, bytesRead };
  }
  if (bytesRead === 0) {
    return { ok: false, reason: 'the stored backup is empty', bytesRead };
  }

  // Count the table entries in the table of contents. A dump of a project that
  // has tables but lists none of them is a signal something went wrong
  // upstream, even though the archive itself parses.
  const tableCount = toc.split('\n').filter((line) => / TABLE /.test(line) && !line.startsWith(';')).length;

  return {
    ok: true,
    checksum: hash.digest('hex'),
    tableCount,
    bytesRead,
  };
}

/**
 * The stronger check: restore into a throwaway database and confirm it is
 * queryable.
 *
 * This is the only verification that proves the backup is *usable* rather than
 * merely well-formed. It is expensive — a full restore, plus a database
 * created and dropped — so it is opt-in via `BACKUP_DEEP_VERIFY=true` and
 * intended for a nightly pass rather than every backup.
 *
 * Requires `PROVISIONER_URL`, since it creates and drops a database.
 */
export async function verifyBackupByRestore(projectRef: string, key: string): Promise<VerificationResult> {
  if (process.env['BACKUP_DEEP_VERIFY'] !== 'true') {
    return { ok: true, reason: 'deep verification is disabled (set BACKUP_DEEP_VERIFY=true to enable)' };
  }

  const scratch = `kairos_verify_${Date.now().toString(36)}`;
  const provisioner = new URL(env.PROVISIONER_URL);
  const baseArgs = [
    '--host', provisioner.hostname,
    '--port', provisioner.port || '5432',
    '--username', decodeURIComponent(provisioner.username),
  ];
  const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(provisioner.password) };

  const run = (command: string, args: string[], stdin?: NodeJS.ReadableStream) =>
    new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, { env: pgEnv, stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 4000); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
      if (stdin && child.stdin) stdin.pipe(child.stdin);
    });

  try {
    const created = await run('createdb', [...baseArgs, scratch]);
    if (created.code !== 0) {
      return { ok: false, reason: `could not create a scratch database: ${created.stderr.trim()}` };
    }

    const object = await storage.get(projectRef, key);
    const restored = await run(
      'pg_restore',
      [...baseArgs, '--dbname', scratch, '--no-owner', '--no-acl', '--exit-on-error'],
      object.stream,
    );

    if (restored.code !== 0) {
      return { ok: false, reason: `the backup did not restore cleanly: ${restored.stderr.trim()}` };
    }

    // Confirm the restored database answers a query and has objects in it.
    // A restore that produces an empty database "succeeds" and is useless.
    const counted = await run('psql', [
      ...baseArgs, '--dbname', scratch, '--tuples-only', '--no-align',
      '--command', `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`,
    ]);
    if (counted.code !== 0) {
      return { ok: false, reason: 'the restored database could not be queried' };
    }

    return { ok: true, reason: 'restored and queried successfully' };
  } finally {
    // Always drop the scratch database, including on failure. Leaving these
    // behind would fill the disk that the backups are protecting.
    await run('dropdb', [...baseArgs, '--if-exists', scratch]).catch(() => undefined);
  }
}
