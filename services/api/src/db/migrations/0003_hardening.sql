-- =============================================================================
-- 0003 — backup verification, and the columns the P0 fixes need
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Backups now pass through a 'verifying' state, and record proof.
--
-- Previously a backup was marked 'completed' on pg_dump's exit code alone. A
-- truncated upload or a corrupt object passed that check and failed at restore
-- time. These columns record what was actually confirmed about the stored
-- bytes, so "we have a backup" is a statement someone checked rather than
-- assumed.
-- ----------------------------------------------------------------------------
ALTER TABLE database_backups DROP CONSTRAINT IF EXISTS database_backups_status_check;
ALTER TABLE database_backups
    ADD CONSTRAINT database_backups_status_check
    CHECK (status IN ('pending','running','verifying','completed','failed'));

ALTER TABLE database_backups ADD COLUMN IF NOT EXISTS checksum    TEXT;
ALTER TABLE database_backups ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE database_backups ADD COLUMN IF NOT EXISTS table_count INTEGER;

COMMENT ON COLUMN database_backups.checksum IS
    'SHA-256 of the archive as read back out of storage, not as written.';
COMMENT ON COLUMN database_backups.verified_at IS
    'When pg_restore --list last parsed this archive successfully. NULL means unverified — treat it as not a backup.';

-- An unverified backup is worse than no backup, because it invites the wrong
-- decision during an incident. Make them easy to find.
CREATE INDEX IF NOT EXISTS database_backups_unverified_idx
    ON database_backups(project_id, created_at DESC)
    WHERE verified_at IS NULL AND status = 'completed';

-- ----------------------------------------------------------------------------
-- Per-project allowed browser origins.
--
-- CORS was effectively open for data-plane requests. An API key in a browser
-- is public by definition, so the key alone is not the boundary — RLS is — but
-- a reflected origin with credentials is still worth closing. Projects declare
-- the origins their frontends run on; anything else gets no CORS headers.
-- ----------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN projects.allowed_origins IS
    'Browser origins permitted to call this project''s data-plane API. Empty means any origin may call with an API key, but never with cookies.';

-- ----------------------------------------------------------------------------
-- Server identity.
--
-- Kairos is software that turns *a* machine into a server, not a service tied
-- to one particular laptop. An installation needs a stable identity of its own
-- so a dashboard, a CLI and a backup can all say which server they mean.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_identity (
    id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- exactly one row
    server_id       TEXT NOT NULL,
    server_name     TEXT NOT NULL DEFAULT 'kairos',
    installed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network_mode    TEXT NOT NULL DEFAULT 'local'
                    CHECK (network_mode IN ('local','lan','remote')),
    data_root       TEXT,
    notes           TEXT
);
