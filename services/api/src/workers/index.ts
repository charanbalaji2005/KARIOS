import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker, type Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { many, query } from '../db/platform.js';
import { poolManager } from '../db/pool-manager.js';
import { decrypt } from '../lib/crypto.js';
import { storage } from '../lib/storage/index.js';
import { sampleAllProjects } from '../lib/usage-sampler.js';
import { fetchVetted, vetOutboundUrl } from '../lib/ssrf.js';
import { verifyBackup } from '../lib/backup-verify.js';
import { sendMail } from '../lib/mailer.js';

const connection = { url: env.REDIS_URL };

interface WebhookJob {
  projectId: string;
  event: string;
  payload: Record<string, unknown>;
  onlyWebhookId?: string;
}

/**
 * Webhook delivery. Each subscribed endpoint gets an HMAC-SHA256 signature over
 * the exact body, so receivers can verify the call came from this platform.
 * BullMQ owns the retry schedule; we only decide what counts as a failure.
 */
const webhookWorker = new Worker<WebhookJob>(
  'webhooks',
  async (job: Job<WebhookJob>) => {
    const { projectId, event, payload, onlyWebhookId } = job.data;

    const hooks = await many<{ id: string; url: string; secret_enc: string }>(
      `SELECT id, url, secret_enc FROM webhooks
        WHERE project_id = $1 AND active = TRUE AND $2 = ANY(events)
          AND ($3::uuid IS NULL OR id = $3::uuid)`,
      [projectId, event, onlyWebhookId ?? null],
    );
    if (hooks.length === 0) return { delivered: 0 };

    let delivered = 0;
    let lastError: Error | null = null;

    for (const hook of hooks) {
      const body = JSON.stringify({ event, payload, projectId, deliveredAt: new Date().toISOString() });
      const signature = createHmac('sha256', decrypt(hook.secret_enc)).update(body).digest('hex');

      try {
        // Re-vetted on every delivery, not only at creation. DNS is mutable:
        // a hostname that resolved publicly when the webhook was saved can
        // point at 127.0.0.1 by the time it fires. The fetch is then pinned to
        // the address that was just checked, so there is no second lookup for
        // an attacker to answer differently.
        const target = await vetOutboundUrl(hook.url);
        const response = await fetchVetted(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kairos-signature': `sha256=${signature}`,
            'x-kairos-event': event,
            'x-kairos-delivery': String(job.id),
          },
          body,
          timeoutMs: 10_000,
        });

        const text = (await response.text().catch(() => '')).slice(0, 2000);
        await query(
          `INSERT INTO webhook_deliveries (webhook_id, event, payload, attempt, status_code, response_body, succeeded)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [hook.id, event, JSON.stringify(payload), job.attemptsMade + 1, response.status, text, response.ok],
        );

        if (response.ok) delivered += 1;
        else lastError = new Error(`${hook.url} responded ${response.status}`);
      } catch (err) {
        lastError = err as Error;
        await query(
          `INSERT INTO webhook_deliveries (webhook_id, event, payload, attempt, error, succeeded)
           VALUES ($1,$2,$3,$4,$5,FALSE)`,
          [hook.id, event, JSON.stringify(payload), job.attemptsMade + 1, (err as Error).message.slice(0, 1000)],
        );
      }
    }

    // Throwing hands the job back to BullMQ's exponential backoff.
    if (lastError && delivered === 0) throw lastError;
    return { delivered };
  },
  { connection, concurrency: 10 },
);

interface BackupJob {
  backupId: string;
  projectId: string;
  projectRef: string;
}

/** Streams pg_dump straight into object storage; nothing lands on local disk. */
const backupWorker = new Worker<BackupJob>(
  'backups',
  async (job: Job<BackupJob>) => {
    const { backupId, projectId, projectRef } = job.data;
    await query(`UPDATE database_backups SET status = 'running', started_at = NOW() WHERE id = $1`, [backupId]);

    try {
      const creds = await poolManager.credentials(projectId);
      const key = `backups/${projectRef}/${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;

      const dump = spawn('pg_dump', [
        '--format=custom', '--no-owner', '--no-acl',
        '--host', creds.host, '--port', String(creds.port),
        '--username', creds.user, '--dbname', creds.database,
      ], { env: { ...process.env, PGPASSWORD: creds.password } });

      let stderr = '';
      dump.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 4000); });

      const exited = new Promise<number>((resolve, reject) => {
        dump.on('error', reject);
        dump.on('close', resolve);
      });

      // pg_dump's stdout goes straight into the storage driver. Nothing is
      // staged on local disk, so a 40 GB database does not need 40 GB free
      // before the backup can start.
      const { size } = await storage.put(projectRef, key, dump.stdout, 'application/octet-stream');

      const code = await exited;
      // Check the exit code AFTER the write: a dump that failed halfway still
      // produces a plausible-looking object, and treating that as a backup is
      // how people discover at restore time that they have nothing.
      if (code !== 0) throw new Error(`pg_dump exited with ${code}: ${stderr}`);

      // A zero exit code proves pg_dump did not crash. It does not prove the
      // bytes that reached storage are a readable archive — a truncated
      // upload, a disk that filled at the last block, or a silently corrupted
      // object all pass the exit-code check and fail at restore time, which is
      // the worst possible moment to find out.
      await query(`UPDATE database_backups SET status = 'verifying' WHERE id = $1`, [backupId]);
      const verification = await verifyBackup(projectRef, key);

      if (!verification.ok) {
        throw new Error(`backup verification failed: ${verification.reason}`);
      }

      await query(
        `UPDATE database_backups
            SET status = 'completed', storage_key = $2, size_bytes = $3,
                checksum = $4, verified_at = NOW(), table_count = $5, finished_at = NOW()
          WHERE id = $1`,
        [backupId, key, size, verification.checksum, verification.tableCount],
      );
      logger.info({ backupId, key, size, tables: verification.tableCount }, 'Backup completed and verified');
      return { key, size, verified: true, tableCount: verification.tableCount };
    } catch (err) {
      await query(
        `UPDATE database_backups SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
        [backupId, (err as Error).message.slice(0, 2000)],
      );
      throw err;
    }
  },
  { connection, concurrency: 2 },
);

const emailWorker = new Worker<{ to: string; subject: string; text: string }>(
  'email',
  async (job) => sendMail(job.data),
  { connection, concurrency: 5 },
);

for (const worker of [webhookWorker, backupWorker, emailWorker]) {
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, queue: worker.name, err: err.message }, 'Job failed'));
  worker.on('completed', (job) => logger.debug({ jobId: job.id, queue: worker.name }, 'Job completed'));
}

/**
 * Usage sampling.
 *
 * Quota enforcement reads project_usage, so this timer is what keeps quotas
 * meaningful. It lives in the worker rather than the API because it opens a
 * connection to every project database in turn — acceptable in a background
 * process, unacceptable in a request path.
 *
 * A plain interval rather than a BullMQ repeatable job: there is exactly one
 * worker process here, the work is idempotent, and a missed run costs nothing
 * beyond a staler figure until the next one.
 */
const USAGE_SAMPLE_INTERVAL_MS = Number(process.env['USAGE_SAMPLE_INTERVAL_MS'] ?? 5 * 60_000);

let sampling = false;
const sampleUsage = async () => {
  // Skip rather than queue. On a laptop with many projects a sampling pass can
  // outlast the interval, and overlapping passes would compound the problem
  // they are meant to measure.
  if (sampling) {
    logger.warn('usage sampling still running from the previous tick — skipping');
    return;
  }
  sampling = true;
  try {
    await sampleAllProjects();
  } catch (error) {
    logger.error({ err: error }, 'usage sampling pass failed');
  } finally {
    sampling = false;
  }
};

const usageTimer = setInterval(() => void sampleUsage(), USAGE_SAMPLE_INTERVAL_MS);
usageTimer.unref();
void sampleUsage(); // one pass at startup so quotas are not enforced on stale data

logger.info({ usageSampleIntervalMs: USAGE_SAMPLE_INTERVAL_MS }, 'Workers running: webhooks, backups, email, usage sampler');

const shutdown = async () => {
  clearInterval(usageTimer);
  await Promise.all([webhookWorker.close(), backupWorker.close(), emailWorker.close()]);
  await poolManager.closeAll();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
