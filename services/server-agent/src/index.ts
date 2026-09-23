#!/usr/bin/env node
/**
 * kairos-server-agent
 *
 * The privileged half of the KAIROS admin panel. Runs on the Ubuntu host under
 * systemd, listens on a Unix domain socket, and performs a fixed set of named
 * operations on behalf of an authenticated admin request that arrived through
 * the API.
 *
 *   Browser ──HTTPS──▶ NGINX ──▶ KAIROS API ──unix socket──▶ this ──▶ Ubuntu
 *
 * It never receives a command to run. It receives an operation id.
 *
 * Start it by hand for development:
 *   KAIROS_AGENT_SOCKET=/tmp/kairos-agent.sock pnpm --filter @kairosdb/server-agent dev
 */
import { unlink } from 'node:fs/promises';
import { config } from './config.js';
import { log } from './log.js';
import { createAgentServer, listen } from './server.js';
import { listOperations } from './registry.js';
import { ensureIdentity } from './ops/identity.js';

/*
 * Importing an ops module is what registers its operations, so the imports
 * below are the agent's capability list. Removing one removes the ability.
 */
import './ops/system.js';
import './ops/services.js';
import './ops/database.js';
import './ops/storage.js';
import './ops/network.js';
import './ops/firewall.js';
import './ops/logs.js';
import './ops/backup.js';
import './ops/power.js';
import './ops/health.js';
import './ops/provision.js';

async function main(): Promise<void> {
  if (process.platform !== 'linux') {
    // Be blunt. Half of this agent reads /proc and /sys, and a version that
    // silently returned nulls on macOS would be worse than one that refuses.
    log.error('The server agent manages an Ubuntu host and only runs on Linux.', { platform: process.platform });
    process.exit(1);
  }

  if (process.getuid?.() !== 0) {
    log.warn(
      'not running as root — service control, firewall changes and package installs will fail. ' +
        'systemd normally starts this as root.',
      { uid: process.getuid?.() },
    );
  }

  if (config.tokenIsEphemeral) {
    log.warn(
      'no agent token found, so a random one was generated for this process only. The API will not be able to ' +
        'authenticate until /etc/kairos/agent.token exists and both sides read the same value. ' +
        'scripts/install-server.sh creates it.',
    );
  }

  const identity = await ensureIdentity();

  const server = createAgentServer();
  await listen(server);

  log.info('agent ready', {
    version: config.version,
    serverId: identity.serverId,
    operations: listOperations().length,
    socket: config.socketPath,
    dataRoot: config.dataRoot,
  });

  /*
   * Shut down cleanly so the socket file does not outlive the process. A stale
   * socket is the difference between "systemctl restart" working and failing
   * with EADDRINUSE on a machine nobody is looking at.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    // Give in-flight operations a moment, then stop regardless — a hung
    // `du` over a large storage directory must not block a restart.
    const force = setTimeout(() => {
      log.warn('forcing exit; an operation did not finish in time');
      process.exit(0);
    }, 10_000);
    force.unref();

    server.close(() => {
      void unlink(config.socketPath)
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    // Log and keep serving. An agent that dies on one bad request takes the
    // operator's only remote tooling with it, which is the worst moment for it
    // to be unavailable.
    log.error('uncaught exception', { message: error.message, stack: error.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
}

void main().catch((error: Error) => {
  log.error('agent failed to start', { message: error.message, stack: error.stack });
  process.exit(1);
});
