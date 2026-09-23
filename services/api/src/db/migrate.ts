import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformPool } from './platform.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

/**
 * Migrations are applied in filename order, each inside its own transaction,
 * with a checksum recorded so an edited-after-the-fact migration is caught.
 */
export async function runMigrations(): Promise<void> {
  await platformPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map<string, string>(
    (await platformPool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations'))
      .rows.map((r) => [r.name, r.checksum]),
  );

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied. Write a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    const client = await platformPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
      logger.info({ migration: file }, 'Applied migration');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isEntrypoint) {
  runMigrations()
    .then(() => { logger.info('Migrations up to date'); return platformPool.end(); })
    .then(() => process.exit(0))
    .catch((err) => { logger.error({ err }, 'Migration failed'); process.exit(1); });
}
