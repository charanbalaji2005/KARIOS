-- =============================================================================
-- 0002 — per-project resource quotas
--
-- The laptop is shared infrastructure. Without limits, one project's runaway
-- import fills the disk and every other project stops accepting writes; one
-- badly-written client opens 200 connections and nobody else can connect.
-- `statement_timeout` bounds a single query and nothing else.
--
-- Limits live in their own table rather than as columns on `projects` so that
-- a plan change is one row, the defaults are visible in one place, and a NULL
-- can mean "unlimited" without overloading the meaning of a project column.
-- =============================================================================

CREATE TABLE project_quotas (
    project_id            UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,

    -- NULL in any of these means unlimited. Zero means "blocked", which is a
    -- real state: it is how a project gets suspended without being deleted.
    database_bytes        BIGINT,
    storage_bytes         BIGINT,
    max_file_bytes        BIGINT,
    max_connections       INTEGER,
    max_tables            INTEGER,
    api_requests_per_hour INTEGER,
    realtime_connections  INTEGER,
    background_jobs_per_day INTEGER,

    -- Set when an operator deliberately raises a limit, so that a support
    -- conversation six months later can find out who agreed to what.
    note                  TEXT,
    updated_by            UUID REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT quota_values_non_negative CHECK (
        COALESCE(database_bytes, 0)          >= 0 AND
        COALESCE(storage_bytes, 0)           >= 0 AND
        COALESCE(max_file_bytes, 0)          >= 0 AND
        COALESCE(max_connections, 0)         >= 0 AND
        COALESCE(max_tables, 0)              >= 0 AND
        COALESCE(api_requests_per_hour, 0)   >= 0 AND
        COALESCE(realtime_connections, 0)    >= 0 AND
        COALESCE(background_jobs_per_day, 0) >= 0
    )
);

-- -----------------------------------------------------------------------------
-- Usage snapshots.
--
-- Counting bytes on demand means walking the filesystem or asking
-- pg_database_size on every upload, which is fine at ten projects and not at a
-- thousand. The usage worker samples periodically and writes here; enforcement
-- reads this table and treats it as a recent-but-not-live figure.
--
-- The consequence is honest and worth stating: a project can overshoot its
-- quota by whatever it can write between two samples. That is the trade for
-- not making every upload pay for a full recount. Hard limits that must not be
-- crossed (max_file_bytes) are checked live instead.
-- -----------------------------------------------------------------------------
CREATE TABLE project_usage (
    project_id           UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    database_bytes       BIGINT  NOT NULL DEFAULT 0,
    storage_bytes        BIGINT  NOT NULL DEFAULT 0,
    object_count         INTEGER NOT NULL DEFAULT 0,
    table_count          INTEGER NOT NULL DEFAULT 0,
    active_connections   INTEGER NOT NULL DEFAULT 0,
    sampled_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX project_usage_sampled_idx ON project_usage(sampled_at);

-- -----------------------------------------------------------------------------
-- Quota violations, recorded rather than only refused.
--
-- A project sitting at its ceiling for a week is a conversation to have, not
-- an error to swallow. Without this row the only trace is a 429 the client saw
-- and nobody else did.
-- -----------------------------------------------------------------------------
CREATE TABLE quota_violations (
    id          BIGSERIAL PRIMARY KEY,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    resource    TEXT NOT NULL,
    limit_value BIGINT NOT NULL,
    actual      BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX quota_violations_project_idx ON quota_violations(project_id, created_at DESC);

-- Every existing project gets the defaults. New projects get a row at
-- provisioning time; this backfills anything created before this migration.
INSERT INTO project_quotas (project_id)
SELECT id FROM projects WHERE deleted_at IS NULL
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO project_usage (project_id)
SELECT id FROM projects WHERE deleted_at IS NULL
ON CONFLICT (project_id) DO NOTHING;
