/**
 * Development seed. Creates one account, one organization, one fully
 * provisioned project and a small sample schema, so the dashboard is usable the
 * moment it loads. The credentials below are development-only by design — the
 * script refuses to run against NODE_ENV=production.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import { one, query, transaction } from './platform.js';
import { poolManager } from './pool-manager.js';
import { platformPool } from './platform.js';
import { encrypt, hashPassword, projectRef, randomToken, sha256 } from '../lib/crypto.js';
import { provisionProjectDatabase, storeConnection } from '../modules/provisioner.js';

const DEV_EMAIL = 'dev@kairosdb.local';
const DEV_PASSWORD = 'kairosdb-dev-password';

async function seed() {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production environment');
  }

  const existing = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [DEV_EMAIL]);
  if (existing) {
    logger.info('Seed data already present, nothing to do');
    return;
  }

  const { userId, organizationId } = await transaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, email_verified, is_platform_admin)
       VALUES ($1,$2,'Dev User',TRUE,TRUE) RETURNING id`,
      [DEV_EMAIL, await hashPassword(DEV_PASSWORD)],
    );
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, created_by) VALUES ('Dev Org','dev-org',$1) RETURNING id`,
      [user.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')`,
      [org.rows[0]!.id, user.rows[0]!.id],
    );
    return { userId: user.rows[0]!.id, organizationId: org.rows[0]!.id };
  });

  const ref = projectRef();
  const project = await one<{ id: string }>(
    `INSERT INTO projects (organization_id, name, ref, status, jwt_secret_enc, created_by)
     VALUES ($1,'Demo Project',$2,'provisioning',$3,$4) RETURNING id`,
    [organizationId, ref, encrypt(randomToken(32)), userId],
  );
  await query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')`, [project!.id, userId]);

  const provision = await provisionProjectDatabase(ref);
  await storeConnection(project!.id, provision);
  await query(`UPDATE projects SET status = 'active' WHERE id = $1`, [project!.id]);

  const anonKey = `krs_anon_${ref}_${randomToken(24)}`;
  const serviceKey = `krs_srv_${ref}_${randomToken(24)}`;
  await query(
    `INSERT INTO api_keys (project_id, name, kind, prefix, key_hash, created_by)
     VALUES ($1,'anon','anon',$2,$3,$6), ($1,'service_role','service_role',$4,$5,$6)`,
    [project!.id, anonKey.slice(0, 16), sha256(anonKey), serviceKey.slice(0, 16), sha256(serviceKey), userId],
  );
  await query(`INSERT INTO storage_buckets (project_id, name, public) VALUES ($1,'public',TRUE)`, [project!.id]);

  // Sample schema inside the project's own database.
  const pool = await poolManager.get(project!.id);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL,
      username   TEXT UNIQUE NOT NULL,
      bio        TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      body       TEXT,
      published  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author_id);

    ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE posts    ENABLE ROW LEVEL SECURITY;
  `);

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Public profiles are readable') THEN
        CREATE POLICY "Public profiles are readable" ON profiles FOR SELECT USING (true);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users manage their own profile') THEN
        CREATE POLICY "Users manage their own profile" ON profiles FOR ALL
          USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'posts' AND policyname = 'Published posts are readable') THEN
        CREATE POLICY "Published posts are readable" ON posts FOR SELECT USING (published = true);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'posts' AND policyname = 'Authors manage their own posts') THEN
        CREATE POLICY "Authors manage their own posts" ON posts FOR ALL
          USING (author_id = auth.uid()) WITH CHECK (author_id = auth.uid());
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TRIGGER kairos_realtime_posts
      AFTER INSERT OR UPDATE OR DELETE ON posts
      FOR EACH ROW EXECUTE FUNCTION public.kairos_notify_change();
  `).catch(() => undefined);

  const profile = await pool.query<{ id: string }>(
    `INSERT INTO profiles (user_id, username, bio) VALUES ($1,'devuser','Seeded account') RETURNING id`,
    [crypto.randomUUID()],
  );
  await pool.query(
    `INSERT INTO posts (author_id, title, body, published) VALUES
       ($1,'Hello from KairosDB','This row came from the seed script.',TRUE),
       ($1,'A draft post','Not published yet, so anonymous reads will not see it.',FALSE)`,
    [profile.rows[0]!.id],
  );

  // Tables have ENABLE ROW LEVEL SECURITY set above. We leave FORCE ROW LEVEL SECURITY off
  // so the project owner role can manage data in the dashboard table editor.
  await pool.query(`
    ALTER TABLE profiles NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE posts    NO FORCE ROW LEVEL SECURITY;
  `);

  logger.info(
    {
      email: DEV_EMAIL,
      password: DEV_PASSWORD,
      projectRef: ref,
      anonKey,
      serviceKey,
    },
    'Seed complete — these credentials are for local development only',
  );
}

seed()
  .then(async () => {
    await poolManager.closeAll();
    await platformPool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Seed failed');
    await platformPool.end().catch(() => undefined);
    process.exit(1);
  });
