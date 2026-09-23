import { z } from 'zod';
import { existsSync } from 'node:fs';

for (const path of ['.env', '../../.env', '../.env']) {
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
      break;
    } catch {}
  }
}

/**
 * Fail fast on boot rather than at 3am on the first request that needs a secret.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),
  PROVISIONER_URL: z.string().url(),
  PROJECT_DB_HOST: z.string().default('localhost'),
  PROJECT_DB_PORT: z.coerce.number().default(5432),

  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 32 bytes of hex'),

  /**
   * Where project files live. 'local' uses the laptop's own disk under
   * KAIROS_DATA_ROOT; 's3' uses MinIO / S3 / R2. See lib/storage/index.ts.
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),

  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('unset'),
  S3_SECRET_KEY: z.string().default('unset'),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  API_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('no-reply@kairosdb.local'),

  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  SQL_STATEMENT_TIMEOUT_MS: z.coerce.number().default(15_000),
  MAX_UPLOAD_BYTES: z.coerce.number().default(50 * 1024 * 1024),

  /**
   * Plain-text security event log that fail2ban tails. Must be on a volume
   * the fail2ban container can also read — see docker-compose.prod.yml.
   */
  SECURITY_LOG_PATH: z.string().default('/var/log/kairos/security.log'),

  /**
   * Number of reverse proxies in front of the API. Fastify uses this to decide
   * how far back in X-Forwarded-For to look for the real client address.
   * Getting this wrong is not cosmetic: too low and every client shares nginx's
   * IP so rate limits are useless; too high and a client can spoof its own IP
   * by sending X-Forwarded-For, which lets it dodge limits and frame others
   * for a ban. nginx alone = 1. Cloudflare + nginx = 2.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  /** Where the laptop keeps project data, for the server metrics page. */
  KAIROS_DATA_ROOT: z.string().default('/var/lib/kairos'),

  /* ------------------------------------------------------ server agent */

  /**
   * Where the privileged server agent listens.
   *
   * A socket path, not a host and port. The API has no privilege of its own on
   * the host; everything it does to the machine goes through this socket to a
   * process that holds the allowlist. See lib/agent-client.ts.
   */
  KAIROS_AGENT_SOCKET: z.string().default('/run/kairos/server-agent.sock'),

  /**
   * The shared secret the API signs agent requests with. Prefer the file:
   * an environment variable is readable in /proc/<pid>/environ by anything
   * running as the same user and gets copied into crash dumps.
   */
  KAIROS_AGENT_TOKEN: z.string().optional(),
  KAIROS_AGENT_TOKEN_FILE: z.string().default('/etc/kairos/agent.token'),

  /**
   * Loopback fallback, for the case where the API runs in a container that
   * cannot see the host's filesystem. Unset by default — the socket is the
   * supported path, and this is 127.0.0.1 only on both ends.
   */
  KAIROS_AGENT_TCP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),

  /**
   * How long an "Enable Ubuntu Terminal" grant lasts.
   *
   * Short on purpose. A real root shell on the host is the highest privilege
   * this product can hand out, and the grant expiring on its own is what makes
   * forgetting to turn it off a non-event rather than a standing door.
   */
  KAIROS_UBUNTU_TERMINAL_TTL_MINUTES: z.coerce.number().int().min(5).max(480).default(30),

  /**
   * How recently the operator must have authenticated before they may enable
   * the Ubuntu Terminal. A session left open on an unlocked laptop should not
   * be enough.
   */
  KAIROS_RECENT_AUTH_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
