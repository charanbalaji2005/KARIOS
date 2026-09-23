import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { encrypt } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { quoteIdent, quoteLiteral } from '../lib/sql.js';
import { query } from '../db/platform.js';

const { Client } = pg;

/**
 * Runs a statement on the provisioner connection (a superuser-ish role that can
 * CREATE DATABASE / CREATE ROLE). Deliberately separate from the request-path
 * pools so a bug in a route handler cannot reach these privileges.
 */
async function withProvisioner<T>(fn: (client: pg.Client) => Promise<T>, database?: string): Promise<T> {
  let connectionString = env.PROVISIONER_URL;
  if (database) {
    const url = new URL(connectionString);
    url.pathname = `/${database}`;
    connectionString = url.toString();
  }
  const client = new Client({
    connectionString,
    application_name: 'kairosdb-provisioner',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface ProvisionResult {
  dbName: string;
  dbUser: string;
  password: string;
  host: string;
  port: number;
}

/**
 * The project database gets:
 *  - its own database and login role (no access to any other project)
 *  - a public schema owned by that role
 *  - an auth schema exposing auth.uid() / auth.role() / auth.jwt(), which read
 *    from a request-local GUC that only the API sets from a verified token
 *  - a realtime trigger function that NOTIFYs row changes
 */
export async function provisionProjectDatabase(projectRef: string): Promise<ProvisionResult> {
  const dbName = `kairos_${projectRef}`;
  const dbUser = `kairos_${projectRef}_user`;
  const password = randomBytes(24).toString('base64url');

  await withProvisioner(async (client) => {
    // CREATE DATABASE cannot run inside a transaction block, so these are sequential.
    await client.query(`CREATE ROLE ${quoteIdent(dbUser)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(dbUser)}`);
    await client.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
    await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(dbUser)}`);
  });

  await withProvisioner(async (client) => {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    await client.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(dbUser)}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdent(dbUser)}`);

    // --- identity helpers used by Row Level Security policies -----------------
    await client.query(`CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ${quoteIdent(dbUser)}`);
    await client.query(`
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb
      $$;`);
    await client.query(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid
      $$;`);
    await client.query(`
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(auth.jwt() ->> 'role', 'anon')
      $$;`);

    // --- realtime change capture ---------------------------------------------
    // NOTIFY is capped at 8000 bytes, so oversized rows are announced without
    // their payload and the client re-reads if it cares.
    await client.query(`
      CREATE OR REPLACE FUNCTION public.kairos_notify_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER AS $$
      DECLARE
        payload jsonb;
        body    text;
      BEGIN
        payload := jsonb_build_object(
          'schema', TG_TABLE_SCHEMA,
          'table',  TG_TABLE_NAME,
          'type',   TG_OP,
          'commit_timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ'),
          'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
          'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
        );
        body := payload::text;
        IF octet_length(body) > 7500 THEN
          body := jsonb_build_object(
            'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'type', TG_OP, 'truncated', true
          )::text;
        END IF;
        PERFORM pg_notify('kairos_realtime', body);
        RETURN COALESCE(NEW, OLD);
      END;
      $$;`);
    await client.query(`ALTER FUNCTION public.kairos_notify_change() OWNER TO ${quoteIdent(dbUser)}`);

    // --- migration bookkeeping inside the project database --------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        id         BIGSERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await client.query(`ALTER TABLE public.schema_migrations OWNER TO ${quoteIdent(dbUser)}`);
  }, dbName);

  logger.info({ dbName, dbUser }, 'Provisioned project database');

  return { dbName, dbUser, password, host: env.PROJECT_DB_HOST, port: env.PROJECT_DB_PORT };
}

export async function storeConnection(projectId: string, result: ProvisionResult): Promise<void> {
  await query(
    `INSERT INTO database_connections (project_id, host, port, db_name, db_user, password_enc)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id) DO UPDATE
       SET host = EXCLUDED.host, port = EXCLUDED.port,
           db_name = EXCLUDED.db_name, db_user = EXCLUDED.db_user,
           password_enc = EXCLUDED.password_enc`,
    [projectId, result.host, result.port, result.dbName, result.dbUser, encrypt(result.password)],
  );
}

/** Tears a project's database down. Irreversible; callers must confirm first. */
export async function deprovisionProjectDatabase(dbName: string, dbUser: string): Promise<void> {
  try {
    await withProvisioner(async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(dbUser)}`);
    });
  } catch (err) {
    logger.error({ err, dbName }, 'Deprovisioning failed');
    throw new ApiError('PROVISIONING_ERROR', 'Could not remove the project database');
  }
}

export function connectionStrings(conn: {
  host: string; port: number; database: string; user: string; password: string;
}) {
  const safe = (withPassword: boolean) =>
    `postgresql://${conn.user}:${withPassword ? encodeURIComponent(conn.password) : '[YOUR-PASSWORD]'}@${conn.host}:${conn.port}/${conn.database}`;
  return {
    direct: safe(false),
    directWithPassword: safe(true),
    psql: `psql "${safe(false)}"`,
    psqlWithPassword: `psql "${safe(true)}"`,
    password: conn.password,
    user: conn.user,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    node: `new Pool({ connectionString: process.env.DATABASE_URL })`,
    prisma: `datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}`,
  };
}
