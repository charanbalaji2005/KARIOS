-- KAIROSDB control plane schema.
-- Everything here describes *tenants*; tenant data itself lives in per-project databases.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- identities

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           CITEXT      NOT NULL UNIQUE,
    password_hash   TEXT        NOT NULL,
    full_name       TEXT,
    email_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
    is_platform_admin BOOLEAN   NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT     NOT NULL,
    user_agent      TEXT,
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE UNIQUE INDEX sessions_refresh_hash_idx ON sessions(refresh_token_hash);

CREATE TABLE email_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'invitation')),
    token_hash  TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX email_tokens_hash_idx ON email_tokens(token_hash);

CREATE TABLE oauth_accounts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL CHECK (provider IN ('google', 'github')),
    provider_uid TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_uid)
);

-- ------------------------------------------------------------- organizations

CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TYPE member_role AS ENUM ('owner', 'admin', 'developer', 'viewer');

CREATE TABLE organization_members (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            member_role NOT NULL DEFAULT 'developer',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, user_id)
);

-- ------------------------------------------------------------------ projects

CREATE TYPE project_status AS ENUM ('provisioning', 'active', 'paused', 'failed', 'deleting');

CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    ref             TEXT NOT NULL UNIQUE,          -- short public identifier, e.g. "qxfzabcdlmno"
    region          TEXT NOT NULL DEFAULT 'local',
    status          project_status NOT NULL DEFAULT 'provisioning',
    jwt_secret_enc  TEXT,                          -- per-project signing key, encrypted at rest
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX projects_org_idx ON projects(organization_id);

CREATE TABLE project_members (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       member_role NOT NULL DEFAULT 'developer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
);

-- The connection details for a project's own database. Password is encrypted,
-- never returned to a browser unless the caller explicitly asks and is an owner.
CREATE TABLE database_connections (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    db_name      TEXT NOT NULL,
    db_user      TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------ api keys

CREATE TYPE api_key_kind AS ENUM ('anon', 'service_role', 'secret');

CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        api_key_kind NOT NULL,
    prefix      TEXT NOT NULL,        -- first 12 chars, shown in listings
    key_hash    TEXT NOT NULL,        -- sha256 of the full key
    last_used_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys(key_hash);
CREATE INDEX api_keys_project_idx ON api_keys(project_id);

-- ------------------------------------------------------------------- storage

CREATE TABLE storage_buckets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    public      BOOLEAN NOT NULL DEFAULT FALSE,
    file_size_limit BIGINT,                 -- bytes, NULL = platform default
    allowed_mime_types TEXT[],
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE TABLE storage_objects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id   UUID NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    size        BIGINT NOT NULL,
    mime_type   TEXT,
    checksum    TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    uploaded_by UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bucket_id, path)
);
CREATE INDEX storage_objects_bucket_idx ON storage_objects(bucket_id);

-- ------------------------------------------------------------------ webhooks

CREATE TABLE webhooks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    events      TEXT[] NOT NULL,
    secret_enc  TEXT NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id    UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event         TEXT NOT NULL,
    payload       JSONB NOT NULL,
    attempt       INTEGER NOT NULL DEFAULT 1,
    status_code   INTEGER,
    response_body TEXT,
    error         TEXT,
    succeeded     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries(webhook_id, created_at DESC);

-- ---------------------------------------------------- migrations and backups

CREATE TABLE project_migrations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    up_sql      TEXT NOT NULL,
    down_sql    TEXT,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE TABLE database_backups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
    storage_key TEXT,
    size_bytes  BIGINT,
    error       TEXT,
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------- audit and telemetry

CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        UUID REFERENCES users(id),
    organization_id UUID,
    project_id      UUID,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_logs_project_idx ON audit_logs(project_id, created_at DESC);

CREATE TABLE query_logs (
    id          BIGSERIAL PRIMARY KEY,
    project_id  UUID NOT NULL,
    user_id     UUID,
    statement   TEXT NOT NULL,
    duration_ms NUMERIC(12,3) NOT NULL,
    row_count   INTEGER,
    succeeded   BOOLEAN NOT NULL,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX query_logs_project_idx ON query_logs(project_id, created_at DESC);

CREATE TABLE usage_metrics (
    id          BIGSERIAL PRIMARY KEY,
    project_id  UUID NOT NULL,
    metric      TEXT NOT NULL,
    value       NUMERIC NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX usage_metrics_project_idx ON usage_metrics(project_id, metric, recorded_at DESC);
