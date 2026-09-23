import { bootstrapAdmins } from './modules/admin.routes.js';
import { buildApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { platformPool } from './db/platform.js';
import { poolManager } from './db/pool-manager.js';
import { shutdownRealtime, startRealtimeBridge } from './modules/realtime.js';

async function main() {
  await runMigrations();

  const app = await buildApp();
  await bootstrapAdmins();
  await startRealtimeBridge();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(`KairosDB API listening on ${env.API_URL}`);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    // Stop accepting first, then drain: in-flight requests still need their pools.
    await app.close().catch((err) => logger.error({ err }, 'Error closing server'));
    await shutdownRealtime();
    await poolManager.closeAll();
    await platformPool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
